import { randomUUID } from "node:crypto";
import {
  createAssistanceTask,
  toAssistanceTaskPersistenceAggregate
} from "@bpa/assistance-core";
import {
  DeterministicWorkflowEngine,
  dispatchRuntimeEffect,
  type EngineDependencies,
  type EngineEffect,
  type EngineState,
  type EngineTransition
} from "@bpa/engine";
import { contentDigest } from "@bpa/compiler";
import { RuntimeProviderRegistry, type RuntimeOutcome } from "@bpa/node-runtime";
import type {
  AssistanceTaskRecord,
  EngineCheckpointRecord,
  ExecutionEventRecord,
  InboxMessageRecord,
  OutboxMessage,
  Persistence,
  RunRecord,
  RunStatus
} from "@bpa/persistence";
import type { ExecutionPlan, JsonValue } from "@bpa/workflow-ir";

export interface Ir2RuntimeOptions {
  now?: () => number;
  id?: () => string;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export type RuntimeResultDisposition = "advanced" | "duplicate" | "stale";

function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("IR2 state must be JSON serializable");
  }
  return JSON.parse(serialized) as JsonValue;
}

function runStatus(state: EngineState): RunStatus {
  if (state.status === "waiting_assistance") {
    return state.active?.kind === "assistance" &&
      state.active.request.taskKind !== "ai_review"
      ? "waiting_human"
      : "waiting_assistance";
  }
  if (state.status === "waiting_runtime") {
    return state.active?.kind === "call" &&
      state.active.invocation.providerId === "browser"
      ? "waiting_browser"
      : "running";
  }
  return state.status;
}

function currentStep(state: EngineState): string | undefined {
  return state.cursor?.stepKey;
}

export class Ir2WorkflowRuntime {
  readonly #persistence: Persistence;
  readonly #providers: RuntimeProviderRegistry;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #random: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;

  constructor(
    persistence: Persistence,
    providers: RuntimeProviderRegistry,
    options: Ir2RuntimeOptions = {}
  ) {
    this.#persistence = persistence;
    this.#providers = providers;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#random = options.random ?? Math.random;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  start(plan: ExecutionPlan, input: JsonValue): RunRecord {
    const runId = this.#id();
    const transition = this.#engine(plan).start(runId, input);
    const timestamp = new Date(this.#now()).toISOString();
    const effects = this.#persistableEffects(transition.effects, timestamp);
    const stepKey = currentStep(transition.state);
    const run: RunRecord = {
      id: runId,
      workflowId: plan.workflow.id,
      workflowVersion: plan.workflow.version,
      workflowDigest: plan.workflow.digest,
      status: runStatus(transition.state),
      revision: 0,
      input,
      ...(transition.state.output === undefined
        ? {}
        : { output: transition.state.output }),
      ...(stepKey ? { currentNodeKey: stepKey } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.#persistence.createRecoverableRun({
      run,
      planSnapshot: {
        runId,
        irVersion: plan.irVersion,
        planDigest: contentDigest(plan),
        workflowSourceDigest: plan.workflow.digest,
        artifactClosureDigest: contentDigest(plan.artifactClosure),
        planJson: plan,
        riskSnapshot: jsonValue(plan.riskSnapshot),
        createdAt: timestamp
      },
      checkpoint: this.#checkpoint(transition.state, timestamp),
      outbox: effects.outbox,
      assistanceTasks: effects.tasks,
      event: this.#event(runId, 1, "RUN_IR2_STARTED", {
        stateRevision: transition.state.revision,
        effectCount: transition.effects.length
      }, timestamp)
    });
  }

  recover(runId: string): EngineState {
    const plan = this.#persistence.getRunPlanSnapshot(runId);
    const checkpoint = this.#persistence.getEngineCheckpoint(runId);
    if (!plan || !checkpoint) {
      throw new Error(`Recoverable IR2 Run not found: ${runId}`);
    }
    const state = checkpoint.state as unknown as EngineState;
    return this.#engine(plan.planJson).resume(state).state;
  }

  async drainOnce(): Promise<number> {
    let processed = 0;
    for (const message of this.#persistence.listPendingEngineOutbox()) {
      if (message.topic !== "runtime.invoke") continue;
      const effect = message.payload as unknown as EngineEffect;
      if (effect.kind !== "runtime.invoke" || effect.notBefore > this.#now()) {
        continue;
      }
      const timeoutMs = Math.max(
        1,
        effect.invocation.deadlineAt - this.#now()
      );
      const controller = new AbortController();
      const timer = this.#schedule(() => controller.abort(), timeoutMs);
      let outcome: RuntimeOutcome;
      try {
        outcome = await dispatchRuntimeEffect(
          this.#providers,
          effect,
          controller.signal
        );
      } catch (error) {
        outcome = {
          status: controller.signal.aborted ? "timed_out" : "failed",
          error: {
            code: controller.signal.aborted
              ? "RUNTIME_DEADLINE_EXCEEDED"
              : "RUNTIME_PROVIDER_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: !controller.signal.aborted
          },
          evidence: [],
          riskSignals: []
        };
      } finally {
        this.#cancelScheduled(timer);
      }
      const disposition = this.acceptRuntimeResult({
        runId: effect.invocation.identity.runId,
        outboxId: message.id,
        inboxMessageId: `result:${effect.invocation.invocationId}`,
        invocationId: effect.invocation.invocationId,
        fencingToken: effect.invocation.fencingToken,
        outcome
      });
      if (disposition !== "stale") processed += 1;
    }
    return processed;
  }

  acceptRuntimeResult(input: {
    runId: string;
    outboxId: string;
    inboxMessageId: string;
    invocationId: string;
    fencingToken: number;
    outcome: RuntimeOutcome;
  }): RuntimeResultDisposition {
    if (this.#persistence.getInboxMessage(input.inboxMessageId)) {
      return "duplicate";
    }
    const run = this.#persistence.getRun(input.runId);
    const plan = this.#persistence.getRunPlanSnapshot(input.runId);
    const checkpoint = this.#persistence.getEngineCheckpoint(input.runId);
    if (!run || !plan || !checkpoint) return "stale";
    const transition = this.#engine(plan.planJson).acceptRuntimeOutcome({
      state: checkpoint.state as unknown as EngineState,
      invocationId: input.invocationId,
      fencingToken: input.fencingToken,
      outcome: input.outcome
    });
    if (transition.disposition !== "advanced") return transition.disposition;
    this.#commitTransition({
      run,
      checkpoint,
      transition,
      eventType: "RUNTIME_RESULT_APPLIED",
      inbox: {
        id: input.inboxMessageId,
        topic: "runtime.result",
        aggregateId: input.invocationId,
        payload: jsonValue(input.outcome),
        receivedAt: new Date(this.#now()).toISOString(),
        appliedAt: new Date(this.#now()).toISOString()
      },
      acknowledgeOutboxIds: [input.outboxId]
    });
    return "advanced";
  }

  #engine(plan: ExecutionPlan): DeterministicWorkflowEngine {
    const dependencies: EngineDependencies = {
      clock: { now: this.#now },
      ids: { next: () => this.#id() },
      random: { next: this.#random }
    };
    return new DeterministicWorkflowEngine(plan, dependencies);
  }

  #commitTransition(input: {
    run: RunRecord;
    checkpoint: EngineCheckpointRecord;
    transition: EngineTransition;
    eventType: string;
    inbox?: InboxMessageRecord;
    acknowledgeOutboxIds?: readonly string[];
  }): RunRecord {
    const timestamp = new Date(this.#now()).toISOString();
    const effects = this.#persistableEffects(
      input.transition.effects,
      timestamp
    );
    const stepKey = currentStep(input.transition.state);
    const sequence = this.#persistence.listEvents(input.run.id).length + 1;
    return this.#persistence.commitRecoverableTransition({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      nextStatus: runStatus(input.transition.state),
      ...(stepKey ? { currentNodeKey: stepKey } : {}),
      ...(input.transition.state.output === undefined
        ? {}
        : { output: input.transition.state.output }),
      checkpoint: this.#checkpoint(input.transition.state, timestamp),
      expectedCheckpointRevision: input.checkpoint.stateRevision,
      outbox: effects.outbox,
      assistanceTasks: effects.tasks,
      ...(input.inbox ? { inbox: [input.inbox] } : {}),
      ...(input.acknowledgeOutboxIds
        ? { acknowledgeOutboxIds: input.acknowledgeOutboxIds }
        : {}),
      event: this.#event(
        input.run.id,
        sequence,
        input.eventType,
        {
          stateRevision: input.transition.state.revision,
          status: input.transition.state.status
        },
        timestamp
      )
    });
  }

  #persistableEffects(
    effects: readonly EngineEffect[],
    timestamp: string
  ): {
    outbox: OutboxMessage[];
    tasks: AssistanceTaskRecord[];
  } {
    const outbox: OutboxMessage[] = [];
    const tasks: AssistanceTaskRecord[] = [];
    for (const effect of effects) {
      if (effect.kind === "runtime.invoke") {
        outbox.push({
          id: `effect:${effect.invocation.invocationId}`,
          topic: "runtime.invoke",
          aggregateId: effect.invocation.invocationId,
          payload: jsonValue(effect),
          createdAt: timestamp
        });
        continue;
      }
      const profileArtifact = this.#persistence.getPublished(
        "policy",
        effect.request.profile.id,
        effect.request.profile.version
      );
      if (
        profileArtifact &&
        profileArtifact.digest !== effect.request.profile.digest
      ) {
        throw new Error("Assistance Profile digest does not match the plan");
      }
      const profile = (profileArtifact?.content ?? {}) as {
        riskLevel?: "R0" | "R1" | "R2" | "R3" | "R4";
        outputSchema?: Record<string, unknown>;
        policySnapshot?: {
          autoContinue: boolean;
          r1ProfileApproved: boolean;
          durableDecision: boolean;
          onUnavailable: "continue_unresolved" | "human_action" | "fail";
        };
      };
      const task = createAssistanceTask({
        taskId: effect.request.taskId,
        runId: effect.request.identity.runId,
        stepInstanceId: `step-${contentDigest(effect.request.identity).slice(
          "sha256:".length
        )}`,
        profile: {
          ...effect.request.profile,
          digest: effect.request.profile.digest.startsWith("sha256:")
            ? effect.request.profile.digest
            : `sha256:${effect.request.profile.digest}`
        },
        mode: effect.request.taskKind,
        riskLevel: profile.riskLevel ?? "R1",
        input: effect.request.input,
        outputSchema: profile.outputSchema ?? {},
        policySnapshot: profile.policySnapshot ?? {
          autoContinue: false,
          r1ProfileApproved: false,
          durableDecision: false,
          onUnavailable: effect.request.onUnavailable
        },
        deadline: new Date(effect.request.deadlineAt).toISOString(),
        now: timestamp
      });
      const aggregate = toAssistanceTaskPersistenceAggregate(task);
      tasks.push({
        task: aggregate.definition,
        fencingCounter: aggregate.privateState.fencingCounter,
        privateState: aggregate.privateState
      });
      outbox.push({
        id: `effect:${effect.request.taskId}`,
        topic: "assistance.requested",
        aggregateId: effect.request.taskId,
        payload: jsonValue(effect),
        createdAt: timestamp
      });
    }
    return { outbox, tasks };
  }

  #checkpoint(state: EngineState, updatedAt: string): EngineCheckpointRecord {
    return {
      runId: state.runId,
      stateVersion: state.stateVersion,
      stateRevision: state.revision,
      state: jsonValue(state),
      updatedAt
    };
  }

  #event(
    runId: string,
    sequence: number,
    type: string,
    payload: JsonValue,
    occurredAt: string
  ): ExecutionEventRecord {
    return {
      id: this.#id(),
      runId,
      sequence,
      type,
      payload,
      occurredAt
    };
  }
}
