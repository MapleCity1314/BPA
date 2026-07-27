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
});
