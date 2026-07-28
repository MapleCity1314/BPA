import { describe, expect, it } from "vitest";
import type { CompiledWorkflow } from "@bpa/compiler";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalWorkflowEngine } from "./local-workflow-engine.js";

const workflow: CompiledWorkflow = {
  format: "bpa.workflow-ir/1",
  workflowId: "compatibility.browser-check",
  workflowVersion: "1.0.0",
  workflowDigest: "sha256:workflow",
  riskLevel: "R0",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  start: "start",
  nodes: {
    start: {
      key: "start",
      nodeId: "control.start",
      nodeVersion: "1.0.0",
      definitionDigest: "sha256:start",
      runtime: "engine_builtin",
      inputSchema: { type: "object" },
      outputSchema: {},
      input: {},
      next: "observe",
      on: {},
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    },
    observe: {
      key: "observe",
      nodeId: "doudian.shop.context.read",
      nodeVersion: "1.0.0",
      definitionDigest: "sha256:observe",
      runtime: "browser",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
      next: "finish",
      on: {},
      timeoutMs: 10_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    },
    finish: {
      key: "finish",
      nodeId: "control.succeed",
      nodeVersion: "1.0.0",
      definitionDigest: "sha256:finish",
      runtime: "engine_builtin",
      inputSchema: { type: "object" },
      outputSchema: {},
      input: {},
      on: {},
      timeoutMs: 1_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    }
  }
};

function dispatchedExecution(
  persistence: SqlitePersistence,
  runId: string
): string {
  return persistence
    .listEvents(runId)
    .find((event) => event.type === "NODE_DISPATCHED")!.nodeExecutionId!;
}

describe("Runtime 0.3 Local Core compatibility engine", () => {
  it("runs builtins, waits for the browser, and completes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const waiting = engine.start(workflow, {});
    expect(waiting.status).toBe("waiting_browser");

    const completed = engine.acceptBrowserResult(
      workflow,
      dispatchedExecution(persistence, waiting.id),
      {
        status: "succeeded",
        output: { shop: { id: "shop-1" }, supported: true },
        fencingToken: 1
      }
    );
    expect(completed).toMatchObject({
      status: "succeeded",
      output: { shop: { id: "shop-1" }, supported: true }
    });
    const sequences = persistence
      .listEvents(completed.id)
      .map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    persistence.close();
  });

  it("rejects stale browser fencing tokens", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const waiting = engine.start(workflow, {});
    expect(() =>
      engine.acceptBrowserResult(
        workflow,
        dispatchedExecution(persistence, waiting.id),
        {
          status: "succeeded",
          fencingToken: 0
        }
      )
    ).toThrow(/Stale fencing token/);
    persistence.close();
  });

  it("preserves the finite retry limit and deterministic backoff", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const retryWorkflow: CompiledWorkflow = {
      ...workflow,
      nodes: {
        ...workflow.nodes,
        observe: {
          ...workflow.nodes.observe!,
          retry: {
            maxAttempts: 2,
            backoffMs: 0,
            retryableErrors: ["PAGE_LOADING"]
          },
          timing: {
            dispatchJitter: {
              minMs: 0,
              maxMs: 0,
              distribution: "uniform"
            },
            retryBackoff: {
              strategy: "exponential",
              baseMs: 1_000,
              maxMs: 5_000,
              jitterRatio: 0
            }
          }
        }
      }
    };
    const waiting = engine.start(retryWorkflow, {});
    const retrying = engine.acceptBrowserResult(
      retryWorkflow,
      dispatchedExecution(persistence, waiting.id),
      {
        status: "failed",
        error: {
          code: "PAGE_LOADING",
          message: "Loading",
          retryable: true
        },
        fencingToken: 1
      }
    );
    expect(retrying.status).toBe("waiting_browser");
    const dispatches = persistence
      .listEvents(waiting.id)
      .filter((event) => event.type === "NODE_DISPATCHED");
    expect(dispatches).toHaveLength(2);
    expect(
      persistence.getNodeExecution(dispatches[1]!.nodeExecutionId!)?.attempt
    ).toBe(2);
    expect(
      persistence
        .listEvents(waiting.id)
        .filter((event) => event.type === "NODE_SCHEDULED")
        .at(-1)?.payload
    ).toMatchObject({ attempt: 2, delayMs: 1_000 });
    persistence.close();
  });
});
