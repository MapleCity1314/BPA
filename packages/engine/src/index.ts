import { randomUUID } from "node:crypto";
import { contentDigest, type CompiledNode, type CompiledWorkflow } from "@bpa/compiler";
import type {
  ExecutionEventRecord,
  NodeExecutionRecord,
  NodeExecutionStatus,
  Persistence,
  RunRecord,
  RunStatus
} from "@bpa/persistence";

export interface BrowserNodeResult {
  status: Extract<
    NodeExecutionStatus,
    "succeeded" | "rejected" | "failed" | "timed_out" | "cancelled" | "uncertain"
  >;
  output?: unknown;
  error?: NodeExecutionRecord["error"];
  fencingToken: number;
}

export class LocalWorkflowEngine {
  constructor(readonly persistence: Persistence) {}

  start(workflow: CompiledWorkflow, input: unknown): RunRecord {
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
    result: BrowserNodeResult
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
    let sequence = this.#nextSequence(run.id);
    this.persistence.commitNodeTransition({
      nodeExecutionId,
      expectedRevision: nodeExecution.revision,
      nextStatus: result.status,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.error === undefined ? {} : { error: result.error }),
      event: this.#event(
        run.id,
        sequence++,
        `NODE_${result.status.toUpperCase()}`,
        {
          fencingToken: result.fencingToken,
          ...(result.error ? { error: result.error } : {})
        },
        nodeExecutionId
      ),
      idempotencyResult: {
        key: nodeExecution.idempotencyKey,
        status: result.status,
        result
      }
    });

    const compiledNode = workflow.nodes[nodeExecution.nodeKey];
    if (!compiledNode) {
      throw new Error(`Compiled node not found: ${nodeExecution.nodeKey}`);
    }
    const retryable =
      nodeExecution.attempt < compiledNode.retry.maxAttempts &&
      (result.status === "timed_out" ||
        (result.status === "failed" &&
          (result.error?.retryable === true ||
            (result.error?.code != null &&
              compiledNode.retry.retryableErrors.includes(
                result.error.code
              )))));
    if (retryable) {
      return this.#schedule(
        workflow,
        this.persistence.getRun(run.id)!,
        nodeExecution.nodeKey,
        sequence,
        result.output,
        nodeExecution.attempt + 1,
        compiledNode.retry.backoffMs
      );
    }
    let target: string | undefined;
    if (result.status === "succeeded") {
      target = compiledNode.next ?? compiledNode.on.success;
    } else {
      const transitionKey:
        | "failure"
        | "timeout"
        | "rejected"
        | "cancelled"
        | "uncertain" =
        result.status === "timed_out"
          ? "timeout"
          : result.status === "failed"
            ? "failure"
            : result.status;
      target = compiledNode.on[transitionKey] ?? compiledNode.on.failure;
    }
    if (target) {
      return this.#schedule(
        workflow,
        this.persistence.getRun(run.id)!,
        target,
        sequence,
        result.output
      );
    }
    const terminalStatus: RunStatus =
      result.status === "uncertain"
        ? "uncertain"
        : result.status === "cancelled"
          ? "cancelled"
          : result.status === "succeeded"
            ? "succeeded"
            : "failed";
    return this.persistence.commitRunTransition({
      runId: run.id,
      expectedRevision: this.persistence.getRun(run.id)!.revision,
      nextStatus: terminalStatus,
      ...(result.output === undefined ? {} : { output: result.output }),
      event: this.#event(run.id, sequence, `RUN_${terminalStatus.toUpperCase()}`, {
        nodeExecutionId
      })
    });
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
    delayMs = 0
  ): RunRecord {
    let run = currentRun;
    let sequence = initialSequence;
    const compiledNode = workflow.nodes[nodeKey];
    if (!compiledNode) throw new Error(`Compiled node not found: ${nodeKey}`);
    const createdAt = new Date().toISOString();
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
      input: compiledNode.input,
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
          delayMs
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
          createdAt: new Date(Date.now() + delayMs).toISOString()
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
    if (
      !["control.start", "control.succeed", "control.condition"].includes(
        node.nodeId
      )
    ) {
      throw new Error(`Unknown builtin node: ${node.nodeId}`);
    }
    const conditionResult =
      node.nodeId === "control.condition"
        ? this.#evaluateCondition(
            node.condition,
            this.persistence.getRun(run.id)?.input,
            previousOutput
          )
        : undefined;
    const output =
      node.nodeId === "control.succeed"
        ? previousOutput ?? {}
        : node.nodeId === "control.condition"
          ? { matched: conditionResult }
          : {};
    this.persistence.commitNodeTransition({
      nodeExecutionId: nodeExecution.id,
      expectedRevision: nodeExecution.revision,
      nextStatus: "succeeded",
      output,
      event: this.#event(
        run.id,
        sequence++,
        "NODE_SUCCEEDED",
        { builtin: node.nodeId },
        nodeExecution.id
      ),
      idempotencyResult: {
        key: nodeExecution.idempotencyKey,
        status: "succeeded",
        result: output
      }
    });
    const target =
      node.nodeId === "control.condition" && conditionResult === false
        ? node.on.failure
        : node.next ?? node.on.success;
    if (target) {
      return this.#schedule(workflow, run, target, sequence, output);
    }
    return this.persistence.commitRunTransition({
      runId: run.id,
      expectedRevision: run.revision,
      nextStatus: "succeeded",
      output,
      event: this.#event(run.id, sequence, "RUN_SUCCEEDED", {})
    });
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
      timeout_ms: node.timeoutMs
    };
  }

  #evaluateCondition(
    expression: string | undefined,
    input: unknown,
    previous: unknown
  ): boolean {
    if (!expression) {
      throw new Error("control.condition requires a condition expression");
    }
    const match =
      /^(input|previous)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(==|!=)\s*(.+)$/.exec(
        expression
      );
    if (!match) throw new Error(`Unsupported condition: ${expression}`);
    const root = match[1] === "input" ? input : previous;
    const path = (match[2] ?? "")
      .split(".")
      .filter(Boolean);
    let actual = root;
    for (const part of path) {
      actual =
        actual && typeof actual === "object"
          ? (actual as Record<string, unknown>)[part]
          : undefined;
    }
    const expected = JSON.parse(match[4]!);
    const equal = JSON.stringify(actual) === JSON.stringify(expected);
    return match[3] === "==" ? equal : !equal;
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
