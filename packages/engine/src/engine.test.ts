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
      inputSchema: { type: "object" },
      outputSchema: {},
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
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
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
      inputSchema: { type: "object" },
      outputSchema: {},
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
          },
          timing: {
            dispatchJitter: {
              minMs: 0,
              maxMs: 0,
              distribution: "uniform"
            },
            retryBackoff: {
              strategy: "exponential",
              baseMs: 1000,
              maxMs: 5000,
              jitterRatio: 0
            }
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
    expect(
      persistence
        .listEvents(waiting.id)
        .filter((event) => event.type === "NODE_SCHEDULED")
        .at(-1)?.payload
    ).toMatchObject({ attempt: 2, delayMs: 1000 });
    const completed = engine.acceptBrowserResult(retryWorkflow, second, {
      status: "succeeded",
      output: { supported: true },
      fencingToken: 1
    });
    expect(completed.status).toBe("succeeded");
    persistence.close();
  });

  it("records blocking risk signals without retrying the rejected action", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const waiting = engine.start(workflow, {});
    const nodeExecutionId = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_DISPATCHED")!.nodeExecutionId!;
    const completed = engine.acceptBrowserResult(workflow, nodeExecutionId, {
      status: "rejected",
      error: {
        code: "CAPTCHA_REQUIRED",
        message: "Human verification required.",
        retryable: false
      },
      riskSignals: [
        {
          code: "CAPTCHA_REQUIRED",
          category: "challenge",
          severity: "blocking",
          source: "page",
          detected_at: "2026-07-27T00:00:00.000Z"
        }
      ],
      timingObservation: {
        rate_limit_wait_ms: 350,
        readiness_wait_ms: 420,
        stable_for_ms: 300
      },
      fencingToken: 1
    });
    expect(completed.status).toBe("failed");
    expect(
      persistence
        .listEvents(completed.id)
        .find((event) => event.type === "NODE_REJECTED")?.payload
    ).toMatchObject({
      riskSignals: [{ code: "CAPTCHA_REQUIRED", severity: "blocking" }],
      timingObservation: {
        rate_limit_wait_ms: 350,
        readiness_wait_ms: 420
      }
    });
    expect(
      persistence
        .listEvents(completed.id)
        .filter((event) => event.type === "NODE_SCHEDULED")
    ).toHaveLength(2);
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
          inputSchema: {
            type: "object",
            required: ["prompt"],
            properties: { prompt: { type: "string" } }
          },
          outputSchema: { type: "object" },
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

  it("rejects invalid workflow input before creating a run", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    expect(() =>
      engine.start(
        {
          ...workflow,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["shop_id"],
            properties: { shop_id: { type: "string" } }
          }
        },
        { unexpected: true }
      )
    ).toThrow(/Workflow input is invalid/);
    persistence.close();
  });

  it("resolves bindings and executes the default data nodes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const dataWorkflow: CompiledWorkflow = {
      ...workflow,
      inputSchema: {
        type: "object",
        required: ["payload"],
        properties: { payload: { type: "string" } }
      },
      outputSchema: { type: "string" },
      nodes: {
        start: { ...workflow.nodes.start!, next: "constant" },
        constant: {
          key: "constant",
          nodeId: "data.constant",
          nodeVersion: "1.0.0",
          definitionDigest: "sha256:constant",
          runtime: "engine_builtin",
          inputSchema: {
            type: "object",
            required: ["value"],
            properties: { value: {} }
          },
          outputSchema: {},
          input: { value: "${input.payload}" },
          next: "finish",
          on: {},
          timeoutMs: 1000,
          retry: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] }
        },
        finish: {
          ...workflow.nodes.finish!,
          inputSchema: {
            type: "object",
            properties: { output: {} }
          },
          input: { output: "${previous}" }
        }
      }
    };
    const completed = engine.start(dataWorkflow, { payload: "selected" });
    expect(completed.status).toBe("succeeded");
    expect(completed.output).toBe("selected");
    expect(
      persistence
        .listEvents(completed.id)
        .filter((event) => event.type === "NODE_SUCCEEDED")
        .map((event) => (event.payload as { builtin?: string }).builtin)
    ).toContain("data.constant");
    persistence.close();
  });

  it("turns invalid browser output into an auditable non-retryable failure", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const engine = new LocalWorkflowEngine(persistence);
    const { next: _next, ...terminalObserve } = workflow.nodes.observe!;
    const strictWorkflow: CompiledWorkflow = {
      ...workflow,
      nodes: {
        ...workflow.nodes,
        observe: {
          ...terminalObserve,
          outputSchema: {
            type: "object",
            required: ["supported"],
            properties: { supported: { const: true } }
          }
        }
      }
    };
    const waiting = engine.start(strictWorkflow, {});
    const executionId = persistence
      .listEvents(waiting.id)
      .find((event) => event.type === "NODE_DISPATCHED")!.nodeExecutionId!;
    const failed = engine.acceptBrowserResult(strictWorkflow, executionId, {
      status: "succeeded",
      output: { supported: false },
      fencingToken: 1
    });
    expect(failed.status).toBe("failed");
    expect(persistence.getNodeExecution(executionId)?.error?.code).toBe(
      "OUTPUT_SCHEMA_INVALID"
    );
    persistence.close();
  });
});
