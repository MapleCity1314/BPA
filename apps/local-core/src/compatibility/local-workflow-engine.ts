import { randomUUID } from "node:crypto";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import {
  contentDigest,
  type CompiledNode,
  type CompiledWorkflow
} from "@bpa/compiler";
import {
  computeDispatchDelayMs,
  computeRetryDelayMs,
  executeBuiltinNode,
  resolveBindings
} from "@bpa/node-runtime";
import type {
  ExecutionEventRecord,
  AttentionDeliveryRecord,
  AttentionRecord,
  NodeExecutionRecord,
  NodeExecutionStatus,
  Persistence,
  RunRecord,
  RunStatus
} from "@bpa/persistence";
import {
  compileDataValidator,
  formatValidationErrors,
  type RiskSignal
} from "@bpa/schemas";
import { createTerminalAttentionDelivery } from "../attention-delivery.js";

/**
 * Compatibility adapter for Runtime 0.3 Workflow IR v1.
 *
 * New execution belongs to @bpa/engine's deterministic IR2 runtime. This
 * adapter remains application-local so the platform engine never depends on
 * Compiler, Persistence, SQLite, browser transport, or Local Core.
 */
export interface LegacyBrowserNodeResult {
  status: Extract<
    NodeExecutionStatus,
    | "succeeded"
    | "rejected"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "uncertain"
  >;
  output?: unknown;
  error?: NodeExecutionRecord["error"];
  riskSignals?: RiskSignal[];
  timingObservation?: {
    rate_limit_wait_ms: number;
    readiness_wait_ms?: number;
    stable_for_ms?: number;
  };
  fencingToken: number;
}

/** @deprecated Runtime 0.3 compatibility only. */
export class LocalWorkflowEngine {
  constructor(readonly persistence: Persistence) {}

  start(workflow: CompiledWorkflow, input: unknown): RunRecord {
    const inputIssues = this.#validationIssues(
      workflow.inputSchema,
      input,
      "workflow input"
    );
    if (inputIssues.length > 0) {
      throw new Error(`Workflow input is invalid: ${inputIssues.join("; ")}`);
    }
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    let sequence = 1;
    let run = this.persistence.createRun({
      run: {
        id: runId,
        workflowId: workflow.workflowId,
        workflowVersion: workflow.workflowVersion,
        workflowDigest: workflow.workflowDigest,
        status: "queued",
        revision: 0,
        input,
        createdAt,
        updatedAt: createdAt
      },
      event: this.#event(runId, sequence++, "RUN_CREATED", {
        workflowId: workflow.workflowId,
        workflowVersion: workflow.workflowVersion,
        workflowDigest: workflow.workflowDigest
      })
    });
    run = this.persistence.commitRunTransition({
      runId,
      expectedRevision: run.revision,
      nextStatus: "running",
      event: this.#event(runId, sequence++, "RUN_STARTED", {})
    });
    return this.#schedule(workflow, run, workflow.start, sequence, undefined);
  }

  acceptBrowserResult(
    workflow: CompiledWorkflow,
    nodeExecutionId: string,
    result: LegacyBrowserNodeResult
  ): RunRecord {
    const nodeExecution =
      this.persistence.getNodeExecution(nodeExecutionId);
    if (!nodeExecution) {
      throw new Error(`Node execution not found: ${nodeExecutionId}`);
    }
    if (nodeExecution.fencingToken !== result.fencingToken) {
      throw new Error(
        `Stale fencing token ${result.fencingToken}; expected ${nodeExecution.fencingToken}`
      );
    }
    if (
      [
        "succeeded",
        "rejected",
        "failed",
        "timed_out",
        "cancelled",
        "uncertain"
      ].includes(nodeExecution.status)
    ) {
      return this.persistence.getRun(nodeExecution.runId)!;
    }
    const run = this.persistence.getRun(nodeExecution.runId)!;
    const compiledNode = workflow.nodes[nodeExecution.nodeKey];
    if (!compiledNode) {
      throw new Error(`Compiled node not found: ${nodeExecution.nodeKey}`);
    }
    let effectiveResult = result;
    if (result.status === "succeeded") {
      const outputIssues = this.#validationIssues(
        compiledNode.outputSchema,
        result.output,
        `${compiledNode.nodeId} output`
      );
      if (outputIssues.length > 0) {
        effectiveResult = {
          ...result,
          status: "failed",
          error: {
            code: "OUTPUT_SCHEMA_INVALID",
            message: outputIssues.join("; "),
            retryable: false
          }
        };
      }
    }
    let sequence = this.#nextSequence(run.id);
    this.persistence.commitNodeTransition({
      nodeExecutionId,
      expectedRevision: nodeExecution.revision,
      nextStatus: effectiveResult.status,
      ...(effectiveResult.output === undefined
        ? {}
        : { output: effectiveResult.output }),
      ...(effectiveResult.error === undefined
        ? {}
        : { error: effectiveResult.error }),
      event: this.#event(
        run.id,
        sequence++,
        `NODE_${effectiveResult.status.toUpperCase()}`,
        {
          fencingToken: effectiveResult.fencingToken,
          ...(effectiveResult.error ? { error: effectiveResult.error } : {}),
          ...(effectiveResult.riskSignals?.length
            ? { riskSignals: effectiveResult.riskSignals }
            : {}),
          ...(effectiveResult.timingObservation
            ? { timingObservation: effectiveResult.timingObservation }
            : {})
        },
        nodeExecutionId
      ),
      idempotencyResult: {
        key: nodeExecution.idempotencyKey,
        status: effectiveResult.status,
        result: effectiveResult
      }
    });
    const retryable =
      nodeExecution.attempt < compiledNode.retry.maxAttempts &&
      (effectiveResult.status === "timed_out" ||
        (effectiveResult.status === "failed" &&
          (effectiveResult.error?.retryable === true ||
            (effectiveResult.error?.code != null &&
              compiledNode.retry.retryableErrors.includes(
                effectiveResult.error.code
              )))));
    if (retryable) {
      const nextAttempt = nodeExecution.attempt + 1;
      return this.#schedule(
        workflow,
        this.persistence.getRun(run.id)!,
        nodeExecution.nodeKey,
        sequence,
        effectiveResult.output,
        nextAttempt,
        computeRetryDelayMs({
          policy: compiledNode.timing,
          nextAttempt,
          seed: `${run.id}:${nodeExecution.nodeKey}:retry:${nextAttempt}`,
          fallbackBaseMs: compiledNode.retry.backoffMs
        })
      );
    }
    let target: string | undefined;
    if (effectiveResult.status === "succeeded") {
      target = compiledNode.next ?? compiledNode.on.success;
    } else if (effectiveResult.status !== "rejected") {
      const transitionKey:
        | "failure"
        | "timeout"
        | "cancelled"
        | "uncertain" =
        effectiveResult.status === "timed_out"
          ? "timeout"
          : effectiveResult.status === "failed"
            ? "failure"
            : effectiveResult.status;
      target = compiledNode.on[transitionKey] ?? compiledNode.on.failure;
    }
    if (target) {
      return this.#schedule(
        workflow,
        this.persistence.getRun(run.id)!,
        target,
        sequence,
        effectiveResult.output
      );
    }
    const terminalStatus: RunStatus =
      effectiveResult.status === "rejected" ||
      effectiveResult.status === "uncertain"
        ? effectiveResult.status
        : effectiveResult.status === "cancelled"
          ? "cancelled"
          : effectiveResult.status === "succeeded"
            ? "succeeded"
            : "failed";
    return this.#finishRun(
      workflow,
      this.persistence.getRun(run.id)!,
      sequence,
      terminalStatus,
      effectiveResult.output,
      nodeExecutionId,
      effectiveResult.error
    );
  }

  acceptHumanResult(
    workflow: CompiledWorkflow,
    nodeExecutionId: string,
    approved: boolean,
    output?: unknown
  ): RunRecord {
    const execution = this.persistence.getNodeExecution(nodeExecutionId);
    if (!execution) {
      throw new Error(`Node execution not found: ${nodeExecutionId}`);
    }
    return this.acceptBrowserResult(workflow, nodeExecutionId, {
      status: approved ? "succeeded" : "rejected",
      ...(output === undefined ? {} : { output }),
      ...(!approved
        ? {
            error: {
              code: "HUMAN_REJECTED",
              message: "A human reviewer rejected this step.",
              retryable: false
            }
          }
        : {}),
      fencingToken: execution.fencingToken
    });
  }

  #schedule(
    workflow: CompiledWorkflow,
    currentRun: RunRecord,
    nodeKey: string,
    initialSequence: number,
    previousOutput: unknown,
    attempt = 1,
    delayMs?: number
  ): RunRecord {
    let run = currentRun;
    let sequence = initialSequence;
    const compiledNode = workflow.nodes[nodeKey];
    if (!compiledNode) throw new Error(`Compiled node not found: ${nodeKey}`);
    const scheduledDelayMs =
      compiledNode.runtime === "browser"
        ? delayMs ??
          computeDispatchDelayMs(
            compiledNode.timing,
            `${currentRun.id}:${nodeKey}:dispatch:${attempt}`
          )
        : 0;
    const createdAt = new Date().toISOString();
    let resolvedInput: unknown = compiledNode.input;
    let localInputError: NodeExecutionRecord["error"] | undefined;
    try {
      resolvedInput = resolveBindings(compiledNode.input, {
        input: currentRun.input,
        previous: previousOutput
      });
      const inputIssues = this.#validationIssues(
        compiledNode.inputSchema,
        resolvedInput,
        `${compiledNode.nodeId} input`
      );
      if (inputIssues.length > 0) {
        localInputError = {
          code: "INPUT_SCHEMA_INVALID",
          message: inputIssues.join("; "),
          retryable: false
        };
      }
    } catch (error) {
      localInputError = {
        code: "BINDING_RESOLUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      };
    }
    const nodeExecution: NodeExecutionRecord = {
      id: randomUUID(),
      runId: run.id,
      nodeKey,
      nodeId: compiledNode.nodeId,
      nodeVersion: compiledNode.nodeVersion,
      status: "scheduled",
      revision: 0,
      attempt,
      idempotencyKey: contentDigest({
        runId: run.id,
        nodeKey,
        attempt
      }),
      fencingToken: 1,
      input: resolvedInput,
      createdAt,
      updatedAt: createdAt
    };
    this.persistence.createNodeExecution(
      nodeExecution,
      this.#event(
        run.id,
        sequence++,
        "NODE_SCHEDULED",
        {
          nodeKey,
          nodeId: compiledNode.nodeId,
          nodeVersion: compiledNode.nodeVersion,
          attempt,
          delayMs: scheduledDelayMs,
          timingPolicy: compiledNode.timing
        },
        nodeExecution.id
      )
    );
    run = this.persistence.commitRunTransition({
      runId: run.id,
      expectedRevision: run.revision,
      nextStatus: "running",
      currentNodeKey: nodeKey,
      event: this.#event(run.id, sequence++, "RUN_NODE_SELECTED", { nodeKey })
    });

    if (localInputError) {
      return this.#completeLocalFailure(
        workflow,
        run,
        nodeExecution,
        compiledNode,
        sequence,
        localInputError
      );
    }

    if (compiledNode.runtime === "engine_builtin") {
      return this.#executeBuiltin(
        workflow,
        run,
        nodeExecution,
        compiledNode,
        sequence,
        previousOutput
      );
    }
    if (compiledNode.runtime === "browser") {
      this.persistence.commitNodeTransition({
        nodeExecutionId: nodeExecution.id,
        expectedRevision: nodeExecution.revision,
        nextStatus: "dispatched",
        event: this.#event(
          run.id,
          sequence++,
          "NODE_DISPATCHED",
          { nodeKey, fencingToken: nodeExecution.fencingToken },
          nodeExecution.id
        ),
        outbox: {
          id: randomUUID(),
          topic: "browser.command.requested",
          aggregateId: nodeExecution.id,
          payload: this.#browserCommandPayload(
            workflow,
            nodeExecution,
            compiledNode
          ),
          createdAt: new Date(Date.now() + scheduledDelayMs).toISOString()
        }
      });
      return this.persistence.commitRunTransition({
        runId: run.id,
        expectedRevision: run.revision,
        nextStatus: "waiting_browser",
        currentNodeKey: nodeKey,
        event: this.#event(run.id, sequence, "RUN_WAITING_BROWSER", {
          nodeExecutionId: nodeExecution.id
        })
      });
    }
    if (compiledNode.runtime === "human") {
      this.persistence.commitNodeTransition({
        nodeExecutionId: nodeExecution.id,
        expectedRevision: nodeExecution.revision,
        nextStatus: "accepted",
        event: this.#event(
          run.id,
          sequence++,
          "NODE_WAITING_HUMAN",
          { nodeKey, input: nodeExecution.input },
          nodeExecution.id
        )
      });
      return this.persistence.commitRunTransition({
        runId: run.id,
        expectedRevision: run.revision,
        nextStatus: "waiting_human",
        currentNodeKey: nodeKey,
        event: this.#event(run.id, sequence, "RUN_WAITING_HUMAN", {
          nodeExecutionId: nodeExecution.id
        })
      });
    }
    throw new Error(
      `Runtime ${compiledNode.runtime} is not enabled in the local milestone`
    );
  }

  #executeBuiltin(
    workflow: CompiledWorkflow,
    run: RunRecord,
    nodeExecution: NodeExecutionRecord,
    node: CompiledNode,
    sequence: number,
    previousOutput: unknown
  ): RunRecord {
    let result = executeBuiltinNode({
      nodeId: node.nodeId,
      nodeInput: nodeExecution.input,
      workflowInput: run.input,
      previousOutput,
      ...(node.condition ? { condition: node.condition } : {})
    });
    if (result.status === "succeeded") {
      const outputIssues = this.#validationIssues(
        node.outputSchema,
        result.output,
        `${node.nodeId} output`
      );
      if (outputIssues.length > 0) {
        result = {
          status: "failed",
          error: {
            code: "OUTPUT_SCHEMA_INVALID",
            message: outputIssues.join("; "),
            retryable: false
          }
        };
      }
    }
    this.persistence.commitNodeTransition({
      nodeExecutionId: nodeExecution.id,
      expectedRevision: nodeExecution.revision,
      nextStatus: result.status,
      ...("output" in result ? { output: result.output } : {}),
      ...(result.status === "failed" ? { error: result.error } : {}),
      event: this.#event(
        run.id,
        sequence++,
        `NODE_${result.status.toUpperCase()}`,
        {
          builtin: node.nodeId,
          ...(result.status === "failed" ? { error: result.error } : {})
        },
        nodeExecution.id
      ),
      idempotencyResult: {
        key: nodeExecution.idempotencyKey,
        status: result.status,
        result
      }
    });
    if (result.status === "failed") {
      const target = node.on.failure;
      if (target) {
        return this.#schedule(
          workflow,
          run,
          target,
          sequence,
          "output" in result ? result.output : undefined
        );
      }
      return this.#finishRun(
        workflow,
        run,
        sequence,
        "failed",
        "output" in result ? result.output : undefined,
        nodeExecution.id,
        result.error
      );
    }
    const target =
      result.branch === "failure"
        ? node.on.failure
        : node.next ?? node.on.success;
    if (target) {
      return this.#schedule(workflow, run, target, sequence, result.output);
    }
    return this.#finishRun(
      workflow,
      run,
      sequence,
      "succeeded",
      result.output,
      nodeExecution.id
    );
  }

  #completeLocalFailure(
    workflow: CompiledWorkflow,
    run: RunRecord,
    nodeExecution: NodeExecutionRecord,
    node: CompiledNode,
    sequence: number,
    error: NonNullable<NodeExecutionRecord["error"]>
  ): RunRecord {
    this.persistence.commitNodeTransition({
      nodeExecutionId: nodeExecution.id,
      expectedRevision: nodeExecution.revision,
      nextStatus: "failed",
      error,
      event: this.#event(
        run.id,
        sequence++,
        "NODE_FAILED",
        { error, localValidation: true },
        nodeExecution.id
      ),
      idempotencyResult: {
        key: nodeExecution.idempotencyKey,
        status: "failed",
        result: { status: "failed", error }
      }
    });
    if (node.on.failure) {
      return this.#schedule(
        workflow,
        run,
        node.on.failure,
        sequence,
        undefined
      );
    }
    return this.#finishRun(
      workflow,
      run,
      sequence,
      "failed",
      undefined,
      nodeExecution.id,
      error
    );
  }

  #browserCommandPayload(
    workflow: CompiledWorkflow,
    execution: NodeExecutionRecord,
    node: CompiledNode
  ): Record<string, unknown> {
    return {
      run_id: execution.runId,
      workflow_id: workflow.workflowId,
      workflow_version: workflow.workflowVersion,
      node_execution_id: execution.id,
      idempotency_key: execution.idempotencyKey,
      fencing_token: execution.fencingToken,
      attempt: execution.attempt,
      node: { id: node.nodeId, version: node.nodeVersion },
      input: execution.input,
      timeout_ms: node.timeoutMs,
      ...(node.timing ? { timing_policy: node.timing } : {})
    };
  }

  #finishRun(
    workflow: CompiledWorkflow,
    run: RunRecord,
    sequence: number,
    requestedStatus: RunStatus,
    output: unknown,
    nodeExecutionId: string,
    error?: NodeExecutionRecord["error"]
  ): RunRecord {
    let status = requestedStatus;
    let terminalError = error;
    if (status === "succeeded") {
      const outputIssues = this.#validationIssues(
        workflow.outputSchema,
        output,
        "workflow output"
      );
      if (outputIssues.length > 0) {
        status = "failed";
        terminalError = {
          code: "WORKFLOW_OUTPUT_INVALID",
          message: outputIssues.join("; "),
          retryable: false
        };
      }
    }
    const event = this.#event(run.id, sequence, `RUN_${status.toUpperCase()}`, {
      nodeExecutionId,
      ...(terminalError ? { error: terminalError } : {})
    });
    const terminalAttention = this.#terminalAttention(run, status, event);
    return this.persistence.commitRunTransition({
      runId: run.id,
      expectedRevision: this.persistence.getRun(run.id)!.revision,
      nextStatus: status,
      ...(output === undefined ? {} : { output }),
      ...(terminalAttention ?? {}),
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

  #validationIssues(
    schema: Record<string, unknown>,
    value: unknown,
    label: string
  ): string[] {
    try {
      const validate = compileDataValidator(schema);
      return validate(value)
        ? []
        : formatValidationErrors(validate.errors).map(
            (issue) => `${label}${issue}`
          );
    } catch (error) {
      return [
        `${label} schema cannot be compiled: ${
          error instanceof Error ? error.message : String(error)
        }`
      ];
    }
  }

  #nextSequence(runId: string): number {
    const events = this.persistence.listEvents(runId);
    return (events.at(-1)?.sequence ?? 0) + 1;
  }

  #event(
    runId: string,
    sequence: number,
    type: string,
    payload: unknown,
    nodeExecutionId?: string
  ): ExecutionEventRecord {
    return {
      id: randomUUID(),
      runId,
      ...(nodeExecutionId ? { nodeExecutionId } : {}),
      sequence,
      type,
      payload,
      occurredAt: new Date().toISOString()
    };
  }
}
