import { describe, expect, it } from "vitest";
import type { CompiledWorkflow } from "@bpa/compiler";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalWorkflowEngine } from "./index.js";

const workflow: CompiledWorkflow = {
  format: "bpa.workflow-ir/1",
  workflowId: "doudian.shop-context-observe",
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
      input: {},
      next: "observe",
      on: {},
      timeoutMs: 1000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    },
    observe: {
      key: "observe",
      nodeId: "doudian.shop.context.read",
      nodeVersion: "1.0.0",
      definitionDigest: "sha256:observe",
      runtime: "browser",
      input: {},
      next: "finish",
      on: {},
      timeoutMs: 10000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    },
    finish: {
      key: "finish",
      nodeId: "control.succeed",
      nodeVersion: "1.0.0",
      definitionDigest: "sha256:finish",
      runtime: "engine_builtin",
      input: {},
      on: {},
      timeoutMs: 1000,
      retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
    }
  }
};

describe("local workflow engine", () => {
  it("runs builtins, waits for a browser result and completes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const waiting = engine.start(workflow, {});
    expect(waiting.status).toBe("waiting_browser");
    const dispatched = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_DISPATCHED");
    expect(dispatched?.nodeExecutionId).toBeTruthy();

    const completed = engine.acceptBrowserResult(
      workflow,
      dispatched!.nodeExecutionId!,
      {
        status: "succeeded",
        output: { shop: { id: "shop-1" }, supported: true },
        fencingToken: 1
      }
    );
    expect(completed.status).toBe("succeeded");
    expect(completed.output).toEqual({
      shop: { id: "shop-1" },
      supported: true
    });
    expect(
      persistence.listEvents(completed.id).map((event) => event.sequence)
    ).toEqual(
      persistence
        .listEvents(completed.id)
        .map((_, index) => index + 1)
    );
    persistence.close();
  });

  it("rejects a stale browser fencing token", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const waiting = engine.start(workflow, {});
    const nodeExecutionId = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_DISPATCHED")!.nodeExecutionId!;
    expect(() =>
      engine.acceptBrowserResult(workflow, nodeExecutionId, {
        status: "succeeded",
        fencingToken: 0
      })
    ).toThrow(/Stale fencing token/);
    persistence.close();
  });

  it("retries only up to the compiled finite attempt limit", () => {
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
          }
        }
      }
    };
    const waiting = engine.start(retryWorkflow, {});
    const first = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_DISPATCHED")!.nodeExecutionId!;
    const retrying = engine.acceptBrowserResult(retryWorkflow, first, {
      status: "failed",
      error: {
        code: "PAGE_LOADING",
        message: "Loading",
        retryable: true
      },
      fencingToken: 1
    });
    expect(retrying.status).toBe("waiting_browser");
    const dispatched = persistence
      .listEvents(waiting.id)
      .filter((event) => event.type === "NODE_DISPATCHED");
    expect(dispatched).toHaveLength(2);
    const second = dispatched[1]!.nodeExecutionId!;
    expect(persistence.getNodeExecution(second)?.attempt).toBe(2);
    const completed = engine.acceptBrowserResult(retryWorkflow, second, {
      status: "succeeded",
      output: { supported: true },
      fencingToken: 1
    });
    expect(completed.status).toBe("succeeded");
    persistence.close();
  });

  it("pauses and resumes a human node", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const humanWorkflow: CompiledWorkflow = {
      ...workflow,
      nodes: {
        ...workflow.nodes,
        start: { ...workflow.nodes.start!, next: "review" },
        review: {
          key: "review",
          nodeId: "control.human-approval",
          nodeVersion: "1.0.0",
          definitionDigest: "sha256:human",
          runtime: "human",
          input: { prompt: "确认" },
          next: "finish",
          on: { rejected: "finish" },
          timeoutMs: 60_000,
          retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
        }
      }
    };
    const waiting = engine.start(humanWorkflow, {});
    expect(waiting.status).toBe("waiting_human");
    const executionId = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_WAITING_HUMAN")!
      .nodeExecutionId!;
    const completed = engine.acceptHumanResult(
      humanWorkflow,
      executionId,
      true,
      { reviewer: "test" }
    );
    expect(completed.status).toBe("succeeded");
    expect(completed.output).toEqual({ reviewer: "test" });
    persistence.close();
  });
});
