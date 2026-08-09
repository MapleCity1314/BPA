import { randomUUID } from "node:crypto";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import {
  createAssistanceTask,
  fromAssistanceTaskPersistenceAggregate,
  terminateAssistanceTask,
  toAssistanceTaskPersistenceAggregate,
  type AssistanceRunOutcome,
  type AssistanceTask
} from "@bpa/assistance-core";
import {
  assistanceDeadlineTimerId,
  DeterministicWorkflowEngine,
  dispatchRuntimeEffect,
  type EngineDependencies,
  type EngineEffect,
  type EngineState,
  type EngineTransition,
  type TimerRequest
} from "@bpa/engine";
import { contentDigest } from "@bpa/compiler";
import {
  ResourceValidatedRuntimeDispatcher,
  RuntimeProviderRegistry,
  type RuntimeBrowserSessionResolver,
  type RuntimeInvocation,
  type RuntimeOutcome
} from "@bpa/node-runtime";
import type {
  AssistanceTaskRecord,
  AttentionDeliveryRecord,
  AttentionRecord,
  CommitAssistanceTaskRequestResult,
  EngineCheckpointRecord,
  ExecutionEventRecord,
  InboxMessageRecord,
  OutboxMessage,
  Persistence,
  RunRecord,
  RunStatus
} from "@bpa/persistence";
import type {
  ExecutionPlan,
  InvocationResourceBinding,
  JsonValue,
  ResourceBindingSnapshot
} from "@bpa/workflow-ir";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import {
  resolveRuntimeNodeSchemaContract,
  runtimeSchemaErrors,
  runtimeSchemaFailure
} from "./runtime-schema-contract.js";

export interface Ir2RuntimeOptions {
  now?: () => number;
  id?: () => string;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  browserSessions?: RuntimeBrowserSessionResolver;
  resolveResourceBindingSnapshot?: (
    runId: string
  ) => ResourceBindingSnapshot | undefined;
}

export type RuntimeResultDisposition = "advanced" | "duplicate" | "stale";

export interface Ir2CancelResult {
  readonly disposition: RuntimeResultDisposition;
  readonly run: RunRecord;
}

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

function operationalDatasetPublicationIntentId(
  state: EngineState
): string | undefined {
  if (state.status !== "succeeded" && state.status !== "uncertain") {
    return undefined;
  }
  const output = state.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  if (!("operationalDatasetPublicationIntentId" in output)) {
    return undefined;
  }
  const value = output.operationalDatasetPublicationIntentId;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(
      "Operational Dataset publication marker must be a 1-200 character string"
    );
  }
  return value;
}

function assistanceRequestOutboxId(taskId: string): string {
  return `effect:${taskId}`;
}

function assistanceDeadlineOutboxId(taskId: string): string {
  return `effect:${assistanceDeadlineTimerId(taskId)}`;
}

function assistanceTaskRecord(task: AssistanceTask): AssistanceTaskRecord {
  const aggregate = toAssistanceTaskPersistenceAggregate(task);
  return {
    task: aggregate.definition,
    fencingCounter: aggregate.privateState.fencingCounter,
    privateState: aggregate.privateState
  };
}

export class Ir2WorkflowRuntime {
  readonly #persistence: Persistence;
  readonly #providers: RuntimeProviderRegistry;
  readonly #runtimeDispatcher: ResourceValidatedRuntimeDispatcher;
  readonly #resolveResourceBindingSnapshot: (
    runId: string
  ) => ResourceBindingSnapshot | undefined;
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
    this.#runtimeDispatcher = new ResourceValidatedRuntimeDispatcher(
      providers,
      options.browserSessions ?? {
        getBrowserSession: () => undefined
      }
    );
    this.#resolveResourceBindingSnapshot =
      options.resolveResourceBindingSnapshot ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#random = options.random ?? Math.random;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  start(
    plan: ExecutionPlan,
    input: JsonValue,
    startMetadata?: JsonValue,
    bindResources?: (runId: string) => ResourceBindingSnapshot,
    triggerAttemptId?: string
  ): RunRecord {
    const runId = this.#id();
    const resourceBindingSnapshot = bindResources?.(runId);
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
      ...(triggerAttemptId ? { triggerAttemptId } : {}),
      ...(resourceBindingSnapshot
        ? { resourceBindingSnapshot }
        : {}),
      outbox: effects.outbox,
      assistanceTasks: effects.tasks,
      event: this.#event(runId, 1, "RUN_IR2_STARTED", {
        stateRevision: transition.state.revision,
        effectCount: transition.effects.length,
        ...(startMetadata === undefined
          ? {}
          : { startMetadata: jsonValue(startMetadata) })
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

  cancel(runId: string, actor: string): Ir2CancelResult {
    const run = this.#persistence.getRun(runId);
    const plan = this.#persistence.getRunPlanSnapshot(runId);
    const checkpoint = this.#persistence.getEngineCheckpoint(runId);
    if (!run || !plan || !checkpoint) {
      throw new Error(`Recoverable IR2 Run not found: ${runId}`);
    }
    const state = checkpoint.state as unknown as EngineState;
    const activeInvocation =
      state.active?.kind === "call" ? state.active.invocation : undefined;
    const activeAssistance =
      state.active?.kind === "assistance" ? state.active.request : undefined;
    const transition = this.#engine(plan.planJson).cancel(state);
    if (transition.disposition !== "advanced") {
      return { disposition: transition.disposition, run };
    }
    if (activeAssistance) {
      const timestamp = new Date(this.#now()).toISOString();
      const cancelled = this.#terminateBlockingAssistance({
        run,
        checkpoint,
        transition,
        taskId: activeAssistance.taskId,
        terminalStatus: "cancelled",
        terminalReason: `Run cancelled by ${actor}`,
        inboxId: `cancel:${run.id}:${run.revision}`,
        inboxTopic: "assistance.cancelled",
        inboxPayload: { actor },
        eventType: "RUN_IR2_CANCELLED",
        eventPayload: { actor, taskId: activeAssistance.taskId },
        timestamp
      });
      if (cancelled.status !== "accepted") {
        return {
          disposition:
            cancelled.status === "duplicate" ? "duplicate" : "stale",
          run: this.#persistence.getRun(run.id) ?? run
        };
      }
      return {
        disposition: "advanced",
        run: cancelled.run
      };
    }
    const activeExternalId = activeInvocation?.invocationId;
    const cancelledRun = this.#commitTransition({
      run,
      checkpoint,
      transition,
      eventType: "RUN_IR2_CANCELLED",
      eventPayload: { actor },
      ...(activeExternalId
        ? {
            acknowledgeOutboxIds: this.#pendingOutboxIds([
              `effect:${activeExternalId}`
            ])
          }
        : {})
    });
    if (activeInvocation) {
      this.#requestProviderCancel(activeInvocation);
    }
    return { disposition: "advanced", run: cancelledRun };
  }

  async drainOnce(): Promise<number> {
    let processed = 0;
    for (const message of this.#persistence.listPendingEngineOutbox()) {
      if (message.topic === "timer.scheduled") {
        const effect = message.payload as unknown as EngineEffect;
        if (
          effect.kind !== "timer.schedule" ||
          effect.timer.wakeAt > this.#now()
        ) {
          continue;
        }
        const disposition = this.acceptTimerFire({
          outboxId: message.id,
          inboxMessageId: `timer.fire:${effect.timer.timerId}`,
          timer: effect.timer
        });
        if (disposition !== "stale") processed += 1;
        continue;
      }
      if (message.topic !== "runtime.invoke") continue;
      const effect = message.payload as unknown as EngineEffect;
      if (effect.kind !== "runtime.invoke" || effect.notBefore > this.#now()) {
        continue;
      }
      let outcome: RuntimeOutcome;
      const dispatchStartedAt = this.#now();
      if (dispatchStartedAt >= effect.invocation.deadlineAt) {
        outcome = {
          status: "timed_out",
          error: {
            code: "RUNTIME_DEADLINE_EXCEEDED",
            message:
              "Runtime invocation deadline elapsed before provider dispatch.",
            retryable: false
          },
          evidence: [],
          riskSignals: []
        };
      } else {
        const resolved = resolveRuntimeNodeSchemaContract(
          this.#persistence,
          effect.invocation
        );
        if (!resolved.ok) {
          outcome = runtimeSchemaFailure({
            code: "RUNTIME_NODE_CONTRACT_UNAVAILABLE",
            message:
              "The frozen Runtime Node Schema contract is unavailable or invalid.",
            invocation: effect.invocation,
            errors: resolved.errors
          });
        } else {
          const invocation = this.#bindInvocationResources({
            ...effect.invocation,
            schemaContract: resolved.contract
          });
          const inputErrors = runtimeSchemaErrors(
            resolved.contract.inputSchema,
            invocation.input
          );
          if (inputErrors.length > 0) {
            outcome = runtimeSchemaFailure({
              code: "RUNTIME_INPUT_SCHEMA_INVALID",
              message:
                "Runtime invocation input does not satisfy the frozen Node Schema.",
              invocation,
              schemaDigest: resolved.contract.inputSchemaDigest,
              errors: inputErrors
            });
          } else {
            const timeoutMs =
              invocation.deadlineAt - dispatchStartedAt;
            const controller = new AbortController();
            const timer = this.#schedule(
              () => controller.abort(),
              timeoutMs
            );
            try {
              outcome = await dispatchRuntimeEffect(
                this.#runtimeDispatcher,
                { ...effect, invocation },
                controller.signal
              );
            } catch (error) {
              outcome = {
                status: controller.signal.aborted ? "timed_out" : "failed",
                error: {
                  code: controller.signal.aborted
                    ? "RUNTIME_DEADLINE_EXCEEDED"
                    : "RUNTIME_PROVIDER_FAILED",
                  message:
                    error instanceof Error ? error.message : String(error),
                  retryable: !controller.signal.aborted
                },
                evidence: [],
                riskSignals: []
              };
            } finally {
              this.#cancelScheduled(timer);
            }
          }
        }
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

  #bindInvocationResources(
    invocation: RuntimeInvocation
  ): RuntimeInvocation {
    const mappings = invocation.resourceMappings;
    if (!mappings || Object.keys(mappings).length === 0) {
      return invocation;
    }
    const snapshot = this.#resolveResourceBindingSnapshot(
      invocation.identity.runId
    );
    if (!snapshot || snapshot.runId !== invocation.identity.runId) {
      return invocation;
    }
    const resourceBindings: Record<
      string,
      InvocationResourceBinding
    > = {};
    for (const [name, mapping] of Object.entries(mappings)) {
      const binding = snapshot.bindings[mapping.slotName];
      if (!binding || !snapshot.resourceSlots[mapping.slotName]) continue;
      resourceBindings[name] = {
        requirementName: mapping.requirementName,
        slotName: mapping.slotName,
        requirement: structuredClone(mapping.requirement),
        requirementDigest: mapping.requirementDigest,
        binding: { ...binding }
      };
    }
    return {
      ...invocation,
      resourceBindings
    };
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
    const state = checkpoint.state as unknown as EngineState;
    const active = state.active;
    let outcome = input.outcome;
    if (
      active?.kind === "call" &&
      active.invocation.invocationId === input.invocationId &&
      active.invocation.fencingToken === input.fencingToken &&
      outcome.status === "succeeded"
    ) {
      const resolved = resolveRuntimeNodeSchemaContract(
        this.#persistence,
        active.invocation
      );
      if (!resolved.ok) {
        outcome = runtimeSchemaFailure({
          code: "RUNTIME_NODE_CONTRACT_UNAVAILABLE",
          message:
            "The frozen Runtime Node Schema contract is unavailable or invalid.",
          invocation: active.invocation,
          errors: resolved.errors,
          output: outcome.output
        });
      } else {
        const outputErrors = runtimeSchemaErrors(
          resolved.contract.outputSchema,
          outcome.output
        );
        if (outputErrors.length > 0) {
          outcome = runtimeSchemaFailure({
            code: "RUNTIME_OUTPUT_SCHEMA_INVALID",
            message:
              "Runtime provider output does not satisfy the frozen Node Schema.",
            invocation: active.invocation,
            schemaDigest: resolved.contract.outputSchemaDigest,
            errors: outputErrors,
            output: outcome.output
          });
        }
      }
    }
    const transition = this.#engine(plan.planJson).acceptRuntimeOutcome({
      state,
      invocationId: input.invocationId,
      fencingToken: input.fencingToken,
      outcome
    });
    if (transition.disposition !== "advanced") return transition.disposition;
    const schemaFailureCode =
      outcome.status !== "succeeded" &&
      outcome.error.code.startsWith("RUNTIME_") &&
      (outcome.error.code.includes("_SCHEMA_") ||
        outcome.error.code === "RUNTIME_NODE_CONTRACT_UNAVAILABLE")
        ? outcome.error.code
        : undefined;
    const timestamp = new Date(this.#now()).toISOString();
    this.#commitTransition({
      run,
      checkpoint,
      transition,
      eventType: schemaFailureCode
        ? "RUNTIME_SCHEMA_VALIDATION_FAILED"
        : "RUNTIME_RESULT_APPLIED",
      ...(schemaFailureCode
        ? {
            eventPayload: {
              invocationId: input.invocationId,
              errorCode: schemaFailureCode
            }
          }
        : {
            eventPayload: {
              invocationId: input.invocationId,
              outcomeStatus: outcome.status,
              ...(outcome.status === "succeeded"
                ? {}
                : {
                    errorCode: outcome.error.code,
                    riskSignals: jsonValue(outcome.riskSignals)
                  })
            }
          }),
      inbox: {
        id: input.inboxMessageId,
        topic: "runtime.result",
        aggregateId: input.invocationId,
        payload: jsonValue(outcome),
        receivedAt: timestamp,
        appliedAt: timestamp
      },
      acknowledgeOutboxIds: [input.outboxId]
    });
    return "advanced";
  }

  acceptTimerFire(input: {
    outboxId: string;
    inboxMessageId: string;
    timer: TimerRequest;
  }): RuntimeResultDisposition {
    if (this.#persistence.getInboxMessage(input.inboxMessageId)) {
      return "duplicate";
    }
    if (
      input.outboxId !==
      assistanceDeadlineOutboxId(input.timer.signal.taskId)
    ) {
      return "stale";
    }
    const runId = input.timer.identity.runId;
    const run = this.#persistence.getRun(runId);
    const plan = this.#persistence.getRunPlanSnapshot(runId);
    const checkpoint = this.#persistence.getEngineCheckpoint(runId);
    if (!run || !plan || !checkpoint) return "stale";
    const transition = this.#engine(plan.planJson).acceptTimerFire({
      state: checkpoint.state as unknown as EngineState,
      timer: input.timer
    });
    if (transition.disposition !== "advanced") {
      return transition.disposition;
    }
    const timestamp = new Date(this.#now()).toISOString();
    const result = this.#terminateBlockingAssistance({
      run,
      checkpoint,
      transition,
      taskId: input.timer.signal.taskId,
      terminalStatus: "expired",
      terminalReason: "Assistance deadline elapsed",
      inboxId: input.inboxMessageId,
      inboxTopic: "timer.fire",
      inboxPayload: jsonValue(input.timer),
      eventType: "ASSISTANCE_DEADLINE_EXPIRED",
      eventPayload: {
        taskId: input.timer.signal.taskId,
        timerId: input.timer.timerId,
        stateRevision: transition.state.revision
      },
      timestamp
    });
    return result.status === "accepted"
      ? "advanced"
      : result.status === "duplicate"
        ? "duplicate"
        : "stale";
  }

  commitAssistanceTask(input: {
    requestId: string;
    task: AssistanceTaskRecord;
    expectedRevision: number;
    expectedFencingCounter: number;
    runOutcome?: AssistanceRunOutcome;
  }): CommitAssistanceTaskRequestResult {
    const duplicate = this.#persistence.getAssistanceRequestResult(
      input.requestId
    );
    if (duplicate) return { status: "duplicate", task: duplicate };
    if (!input.runOutcome) {
      return this.#persistence.commitAssistanceTaskRequest({
        requestId: input.requestId,
        task: input.task,
        expectedRevision: input.expectedRevision,
        expectedFencingCounter: input.expectedFencingCounter,
        recordedAt: new Date(this.#now()).toISOString()
      });
    }
    if (input.task.task.status !== "completed") {
      return { status: "stale" };
    }
    const persistedTask = this.#persistence.getAssistanceTask(
      input.task.task.taskId
    );
    if (!persistedTask) return { status: "stale" };
    let detached = persistedTask.privateState.blocking === false;
    if (persistedTask.privateState.blocking === undefined) {
      const legacyCheckpoint = this.#persistence.getEngineCheckpoint(
        input.task.task.runId
      );
      const legacyActive = (
        legacyCheckpoint?.state as unknown as EngineState | undefined
      )?.active;
      detached = !(
        legacyActive?.kind === "assistance" &&
        legacyActive.request.taskId === input.task.task.taskId
      );
    }
    if (detached) {
      const timestamp = new Date(this.#now()).toISOString();
      const detachedTask = {
        ...input.task,
        privateState: {
          ...input.task.privateState,
          blocking: false
        }
      };
      return this.#persistence.completeDetachedAssistanceTask({
        requestId: input.requestId,
        task: detachedTask,
        expectedRevision: input.expectedRevision,
        expectedFencingCounter: input.expectedFencingCounter,
        inbox: {
          id: input.requestId,
          topic: "assistance.detached.result",
          aggregateId: input.task.task.taskId,
          payload: jsonValue({
            task: detachedTask,
            outcome: input.runOutcome
          }),
          receivedAt: timestamp,
          appliedAt: timestamp
        },
        event: {
          id: this.#id(),
          runId: input.task.task.runId,
          type: "ASSISTANCE_DETACHED_RESULT_RECORDED",
          payload: {
            taskId: input.task.task.taskId,
            outcome: input.runOutcome.status,
            reason: input.runOutcome.reason
          },
          occurredAt: timestamp
        },
        acknowledgeOutboxIds: [`effect:${input.task.task.taskId}`]
      });
    }
    const run = this.#persistence.getRun(input.task.task.runId);
    const plan = this.#persistence.getRunPlanSnapshot(input.task.task.runId);
    const checkpoint = this.#persistence.getEngineCheckpoint(
      input.task.task.runId
    );
    if (!run || !plan || !checkpoint) return { status: "stale" };
    const state = checkpoint.state as unknown as EngineState;
    const active = state.active;
    if (
      active?.kind !== "assistance" ||
      active.request.taskId !== input.task.task.taskId
    ) {
      return { status: "stale" };
    }
    const transition = this.#engine(plan.planJson).acceptAssistanceOutcome({
      state,
      taskId: input.task.task.taskId,
      // Task lease fencing and Engine request fencing are separate domains.
      // A task can be reclaimed several times while the frozen Engine request
      // keeps its original token.
      fencingToken: active.request.fencingToken,
      outcome: {
        status: input.runOutcome.status,
        output: jsonValue(input.task.task.resolution?.output ?? null)
      }
    });
    if (transition.disposition !== "advanced") {
      return { status: "stale" };
    }
    const timestamp = new Date(this.#now()).toISOString();
    const effects = this.#persistableEffects(
      transition.effects,
      timestamp
    );
    const stepKey = currentStep(transition.state);
    const nextRunStatus = runStatus(transition.state);
    const wakeEvent = this.#event(
      run.id,
      this.#persistence.listEvents(run.id).length + 1,
      "ASSISTANCE_RESULT_APPLIED",
      {
        taskId: input.task.task.taskId,
        outcome: input.runOutcome.status,
        reason: input.runOutcome.reason,
        stateRevision: transition.state.revision,
        ...(transition.state.error
          ? { error: transition.state.error }
          : {})
      },
      timestamp
    );
    const terminalAttention = this.#terminalAttention(
      run,
      nextRunStatus,
      wakeEvent
    );
    const result = this.#persistence.submitTaskAndWakeRun({
      task: input.task,
      expectedTaskRevision: input.expectedRevision,
      expectedFencingToken: input.expectedFencingCounter,
      expectedRunRevision: run.revision,
      inbox: {
        id: input.requestId,
        topic: "assistance.result",
        aggregateId: input.task.task.taskId,
        payload: jsonValue(input.task),
        receivedAt: timestamp,
        appliedAt: timestamp
      },
      wakeEvent,
      checkpoint: this.#checkpoint(transition.state, timestamp),
      expectedCheckpointRevision: checkpoint.stateRevision,
      nextRunStatus,
      ...(stepKey ? { currentNodeKey: stepKey } : {}),
      ...(transition.state.output === undefined
        ? {}
        : { output: transition.state.output }),
      assistanceTasks: effects.tasks,
      ...(terminalAttention ?? {}),
      additionalOutbox: effects.outbox,
      acknowledgeOutboxIds: this.#pendingOutboxIds([
        assistanceRequestOutboxId(input.task.task.taskId),
        assistanceDeadlineOutboxId(input.task.task.taskId)
      ])
    });
    return result.status === "accepted"
      ? { status: "accepted", task: result.task }
      : result.status === "duplicate"
        ? {
            status: "duplicate",
            task:
              this.#persistence.getAssistanceRequestResult(input.requestId) ??
              input.task
          }
        : { status: "stale" };
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
    eventPayload?: Readonly<Record<string, JsonValue>>;
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
    const nextRunStatus = runStatus(input.transition.state);
    const event = this.#event(
      input.run.id,
      sequence,
      input.eventType,
      {
        stateRevision: input.transition.state.revision,
        status: input.transition.state.status,
        ...(input.transition.state.error
          ? { error: input.transition.state.error }
          : {}),
        ...input.eventPayload
      },
      timestamp
    );
    const terminalAttention = this.#terminalAttention(
      input.run,
      nextRunStatus,
      event
    );
    const publicationIntentId = operationalDatasetPublicationIntentId(
      input.transition.state
    );
    return this.#persistence.commitRecoverableTransition({
      runId: input.run.id,
      expectedRevision: input.run.revision,
      nextStatus: nextRunStatus,
      ...(stepKey ? { currentNodeKey: stepKey } : {}),
      ...(input.transition.state.output === undefined
        ? {}
        : { output: input.transition.state.output }),
      ...(publicationIntentId
        ? { operationalDatasetPublicationIntentId: publicationIntentId }
        : {}),
      checkpoint: this.#checkpoint(input.transition.state, timestamp),
      expectedCheckpointRevision: input.checkpoint.stateRevision,
      outbox: effects.outbox,
      assistanceTasks: effects.tasks,
      ...(terminalAttention ?? {}),
      ...(input.inbox ? { inbox: [input.inbox] } : {}),
      ...(input.acknowledgeOutboxIds
        ? { acknowledgeOutboxIds: input.acknowledgeOutboxIds }
        : {}),
      event
    });
  }

  #terminalAttention(
    run: RunRecord,
    status: RunStatus,
    event: ExecutionEventRecord
  ):
    | {
        attention: AttentionRecord;
        attentionDelivery: AttentionDeliveryRecord;
      }
    | undefined {
    if (status !== "rejected" && status !== "failed" && status !== "uncertain") {
      return undefined;
    }
    const item = projectTerminalRunAttention({
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      status,
      ...(run.currentNodeKey ? { currentNodeKey: run.currentNodeKey } : {}),
      updatedAt: event.occurredAt,
      events: [{ type: event.type, payload: event.payload }]
    });
    return {
      attention: {
        sourceRef: { kind: "workflow-run", runId: run.id },
        deliveryPolicy: "operator-notification",
        item,
        state: "open",
        revision: 0
      },
      attentionDelivery: createTerminalAttentionDelivery({
        attention: item,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion
      })
    };
  }

  #requestProviderCancel(invocation: RuntimeInvocation): void {
    try {
      const provider = this.#providers.get(invocation.providerId);
      const cancellation = provider.cancel?.(
        invocation.invocationId,
        invocation.fencingToken
      );
      void cancellation?.catch(() => undefined);
    } catch {
      // Cancellation state is already durable. Providers reconcile their
      // durable work on recovery rather than rolling the Run back.
    }
  }

  #pendingOutboxIds(candidates: readonly string[]): string[] {
    const pending = new Set(
      this.#persistence.listPendingEngineOutbox().map((message) => message.id)
    );
    return candidates.filter((candidate) => pending.has(candidate));
  }

  #terminateBlockingAssistance(input: {
    run: RunRecord;
    checkpoint: EngineCheckpointRecord;
    transition: EngineTransition;
    taskId: string;
    terminalStatus: "expired" | "cancelled" | "failed";
    terminalReason: string;
    inboxId: string;
    inboxTopic: string;
    inboxPayload: JsonValue;
    eventType: string;
    eventPayload: JsonValue;
    timestamp: string;
  }): ReturnType<Persistence["submitTaskAndWakeRun"]> {
    const currentTask = this.#persistence.getAssistanceTask(input.taskId);
    if (!currentTask || currentTask.privateState.blocking === false) {
      return { status: "stale" };
    }
    const terminated = terminateAssistanceTask(
      fromAssistanceTaskPersistenceAggregate({
        definition: currentTask.task,
        privateState: currentTask.privateState
      }),
      {
        status: input.terminalStatus,
        reason: input.terminalReason,
        now: input.timestamp
      }
    );
    if (!terminated.ok) return { status: "stale" };

    const effects = this.#persistableEffects(
      input.transition.effects,
      input.timestamp
    );
    const stepKey = currentStep(input.transition.state);
    const nextRunStatus = runStatus(input.transition.state);
    const wakeEvent = this.#event(
      input.run.id,
      this.#persistence.listEvents(input.run.id).length + 1,
      input.eventType,
      input.eventPayload,
      input.timestamp
    );
    const terminalAttention = this.#terminalAttention(
      input.run,
      nextRunStatus,
      wakeEvent
    );
    return this.#persistence.submitTaskAndWakeRun({
      task: assistanceTaskRecord(terminated.task),
      expectedTaskRevision: currentTask.task.revision,
      expectedFencingToken: currentTask.fencingCounter,
      expectedRunRevision: input.run.revision,
      inbox: {
        id: input.inboxId,
        topic: input.inboxTopic,
        aggregateId: input.taskId,
        payload: input.inboxPayload,
        receivedAt: input.timestamp,
        appliedAt: input.timestamp
      },
      wakeEvent,
      checkpoint: this.#checkpoint(input.transition.state, input.timestamp),
      expectedCheckpointRevision: input.checkpoint.stateRevision,
      nextRunStatus,
      ...(stepKey ? { currentNodeKey: stepKey } : {}),
      ...(input.transition.state.output === undefined
        ? {}
        : { output: input.transition.state.output }),
      assistanceTasks: effects.tasks,
      ...(terminalAttention ?? {}),
      additionalOutbox: effects.outbox,
      acknowledgeOutboxIds: this.#pendingOutboxIds([
        assistanceRequestOutboxId(input.taskId),
        assistanceDeadlineOutboxId(input.taskId)
      ])
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
      if (effect.kind === "timer.schedule") {
        outbox.push({
          id: `effect:${effect.timer.timerId}`,
          topic: "timer.scheduled",
          aggregateId: effect.timer.timerId,
          payload: jsonValue(effect),
          createdAt: timestamp
        });
        continue;
      }
      const profileArtifact =
        this.#persistence.getPublished(
          "assistance_profile",
          effect.request.profile.id,
          effect.request.profile.version
        ) ??
        this.#persistence.getPublished(
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
        blocking: effect.request.blocking,
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
