import { describe, expect, it } from "vitest";
import {
  AdaptiveReadinessGate,
  BuiltinRuntimeProvider,
  computeDispatchDelayMs,
  computeRetryDelayMs,
  evaluateConditionExpression,
  executeBuiltinNode,
  firstBlockingRiskSignal,
  mergeTimingPolicy,
  resolveBindings,
  reserveRateLimit,
  ResourceValidatedRuntimeDispatcher,
  RuntimeProviderRegistry,
  timingPolicyIssues
} from "./index.js";
import type { RuntimeProvider } from "./index.js";

const policy = mergeTimingPolicy(
  {
    dispatchJitter: { minMs: 100, maxMs: 500, distribution: "uniform" },
    retryBackoff: {
      strategy: "exponential",
      baseMs: 1000,
      maxMs: 10000,
      jitterRatio: 0.2
    },
    rateLimit: { scope: "tab", minIntervalMs: 500, maxQueueMs: 2000 }
  },
  undefined
);

describe("runtime provider registry", () => {
  const provider = (id: string, supported = true): RuntimeProvider => ({
    id,
    supports: () => supported,
    invoke: async () => ({
      status: "succeeded",
      output: null,
      evidence: [],
      riskSignals: []
    })
  });

  it("registers providers without adding runtime branches to the engine", () => {
    const registry = new RuntimeProviderRegistry();
    registry.register(provider("browser"));
    registry.register(provider("builtin"));
    expect(registry.list()).toEqual(["browser", "builtin"]);
    expect(
      registry.resolve("browser", {
        kind: "node",
        id: "doudian.shop.context.read",
        version: "1.0.0",
        digest: "a".repeat(64)
      }).id
    ).toBe("browser");
    expect(() => registry.register(provider("browser"))).toThrow(
      "already registered"
    );
  });

  it("runs builtins through the same provider contract", async () => {
    const provider = new BuiltinRuntimeProvider();
    const invocation = {
      invocationId: "invocation-1",
      identity: {
        runId: "run-1",
        scopePath: [],
        iterationKey: "root",
        stepKey: "constant",
        attempt: 1
      },
      node: {
        kind: "node" as const,
        id: "data.constant",
        version: "1.0.0",
        digest: "a".repeat(64)
      },
      providerId: "builtin",
      input: { value: { ready: true } },
      permissionSnapshot: {
        riskLevel: "R0" as const,
        permissions: [],
        domains: []
      },
      deadlineAt: 1000,
      idempotencyKey: "run-1:root:constant:1",
      fencingToken: 1,
      traceId: "trace-1"
    };
    await expect(
      provider.invoke(invocation, new AbortController().signal)
    ).resolves.toEqual({
      status: "succeeded",
      output: { ready: true },
      evidence: [],
      riskSignals: []
    });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.invoke(invocation, controller.signal)).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" }
    });
  });

  it("rejects unknown and unsupported provider selections", () => {
    const registry = new RuntimeProviderRegistry();
    registry.register(provider("team", false));
    const node = {
      kind: "node" as const,
      id: "packaging.master.match.batch",
      version: "1.0.0",
      digest: "b".repeat(64)
    };
    expect(() => registry.resolve("missing", node)).toThrow("not registered");
    expect(() => registry.resolve("team", node)).toThrow("does not support");
  });

  it("validates frozen Resource Bindings before provider dispatch", async () => {
    let calls = 0;
    const registry = new RuntimeProviderRegistry();
    registry.register({
      ...provider("browser"),
      invoke: async () => {
        calls += 1;
        return {
          status: "succeeded",
          output: null,
          evidence: [],
          riskSignals: []
        };
      }
    });
    const session = {
      sessionId: "session-1",
      capabilityDigest: "a".repeat(64),
      capabilities: ["browser.dom.read"],
      origin: "https://www.chanmama.com",
      authentication: "authenticated" as const,
      state: "available" as const
    };
    const dispatcher = new ResourceValidatedRuntimeDispatcher(registry, {
      getBrowserSession: () => session
    });
    const invocation = {
      invocationId: "invocation-resource-1",
      identity: {
        runId: "run-1",
        scopePath: [],
        iterationKey: "root",
        stepKey: "metrics",
        attempt: 1
      },
      node: {
        kind: "node" as const,
        id: "chanmama.product.metrics.read",
        version: "1.0.0",
        digest: "b".repeat(64)
      },
      providerId: "browser",
      input: { untrustedSessionId: "other-session" },
      permissionSnapshot: {
        riskLevel: "R1" as const,
        permissions: ["browser.dom.read"],
        domains: ["https://www.chanmama.com"]
      },
      resourceBindings: {
        page_session: {
          requirementName: "page_session",
          slotName: "metrics_source",
          requirement: {
            kind: "browser" as const,
            capabilities: ["browser.dom.read"],
            allowedOrigins: ["https://www.chanmama.com"],
            authentication: "authenticated" as const,
            purpose: "Read metrics"
          },
          requirementDigest: "c".repeat(64),
          binding: {
            bindingId: "binding-1",
            revision: 1,
            slotName: "metrics_source",
            sessionId: "session-1",
            capabilityDigest: "a".repeat(64),
            origin: "https://www.chanmama.com",
            authentication: "authenticated" as const,
            frozenAt: 1_000,
            approvedBy: "user:test"
          }
        }
      },
      resourceMappings: {
        page_session: {
          requirementName: "page_session",
          slotName: "metrics_source",
          requirement: {
            kind: "browser" as const,
            capabilities: ["browser.dom.read"],
            allowedOrigins: ["https://www.chanmama.com"],
            authentication: "authenticated" as const,
            purpose: "Read metrics"
          },
          requirementDigest: "c".repeat(64)
        }
      },
      deadlineAt: 2_000,
      idempotencyKey: "run-1:root:metrics:1",
      fencingToken: 1,
      traceId: "trace-resource-1"
    };
    await expect(
      dispatcher.invoke(invocation, new AbortController().signal)
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toBe(1);

    const changedDispatcher = new ResourceValidatedRuntimeDispatcher(
      registry,
      {
        getBrowserSession: () => ({
          ...session,
          capabilityDigest: "d".repeat(64)
        })
      }
    );
    await expect(
      changedDispatcher.invoke(invocation, new AbortController().signal)
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "RESOURCE_BINDING_INVALID", retryable: false }
    });
    expect(calls).toBe(1);
  });
});

describe("node timing runtime", () => {
  it("produces bounded deterministic dispatch and retry delays", () => {
    const first = computeDispatchDelayMs(policy, "run:node:1");
    expect(first).toBe(computeDispatchDelayMs(policy, "run:node:1"));
    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThanOrEqual(500);
    const retry = computeRetryDelayMs({
      policy,
      nextAttempt: 4,
      seed: "run:node:4"
    });
    expect(retry).toBeGreaterThanOrEqual(3200);
    expect(retry).toBeLessThanOrEqual(4800);
  });

  it("requires a value to remain stable before becoming ready", () => {
    const gate = new AdaptiveReadinessGate({
      startedAt: 1000,
      timeoutMs: 5000,
      stableForMs: 300
    });
    expect(gate.observe({ at: 1100, ready: true, signature: "a" }).state).toBe(
      "stabilizing"
    );
    expect(gate.observe({ at: 1300, ready: true, signature: "b" }).state).toBe(
      "stabilizing"
    );
    expect(gate.observe({ at: 1600, ready: true, signature: "b" }).state).toBe(
      "ready"
    );
    expect(gate.observe({ at: 6000, ready: true, signature: "b" }).state).toBe(
      "timed_out"
    );
  });

  it("rejects waits that exceed queue or command deadlines", () => {
    expect(
      reserveRateLimit({
        now: 1000,
        lastExecutedAt: 900,
        deadline: 5000,
        policy
      })
    ).toEqual({ accepted: true, executeAt: 1400, waitMs: 400 });
    expect(
      reserveRateLimit({
        now: 1000,
        lastExecutedAt: 3500,
        deadline: 10000,
        policy
      })
    ).toEqual({
      accepted: false,
      reason: "RATE_LIMIT_QUEUE_EXCEEDED"
    });
    expect(
      reserveRateLimit({
        now: 1000,
        lastExecutedAt: 900,
        deadline: 1300,
        policy
      })
    ).toEqual({ accepted: false, reason: "DEADLINE_EXCEEDED" });
  });

  it("validates relational bounds and exposes blocking risk signals", () => {
    expect(
      timingPolicyIssues({
        dispatchJitter: {
          minMs: 500,
          maxMs: 100,
          distribution: "uniform"
        }
      })
    ).toEqual([
      "/timing/dispatchJitter/minMs cannot exceed maxMs"
    ]);
    expect(
      firstBlockingRiskSignal([
        {
          code: "RATE_LIMITED",
          category: "throttle",
          severity: "warning",
          source: "page",
          detected_at: new Date(0).toISOString()
        },
        {
          code: "CAPTCHA_REQUIRED",
          category: "challenge",
          severity: "blocking",
          source: "page",
          detected_at: new Date(0).toISOString()
        }
      ])?.code
    ).toBe("CAPTCHA_REQUIRED");
  });
});

describe("builtin node runtime", () => {
  it("resolves exact input and previous bindings without evaluating code", () => {
    expect(
      resolveBindings(
        {
          shop: "${input.shop}",
          id: "${previous.id}",
          label: "literal"
        },
        {
          input: { shop: { name: "A" } },
          previous: { id: "shop-1" }
        }
      )
    ).toEqual({
      shop: { name: "A" },
      id: "shop-1",
      label: "literal"
    });
    expect(() =>
      resolveBindings("${input.shop + process.exit()}", {
        input: {},
        previous: {}
      })
    ).toThrow(/Unsupported binding expression/);
    expect(() =>
      resolveBindings("${input.__proto__}", {
        input: {},
        previous: {}
      })
    ).toThrow(/Forbidden data path segment/);
  });

  it("evaluates the restricted condition DSL only", () => {
    expect(
      evaluateConditionExpression("input.ready == true", {
        input: { ready: true },
        previous: {}
      })
    ).toBe(true);
    expect(() =>
      evaluateConditionExpression("process.exit() == true", {
        input: {},
        previous: {}
      })
    ).toThrow(/Unsupported condition/);
  });

  it("executes safe data selection, merge and explicit failure nodes", () => {
    expect(
      executeBuiltinNode({
        nodeId: "data.select",
        nodeInput: {
          source: { shop: { id: "shop-1" } },
          path: "shop.id",
          required: true
        },
        workflowInput: {},
        previousOutput: {}
      })
    ).toEqual({ status: "succeeded", output: "shop-1" });
    expect(
      executeBuiltinNode({
        nodeId: "data.merge",
        nodeInput: { values: [{ a: 1 }, { b: 2, a: 3 }] },
        workflowInput: {},
        previousOutput: {}
      })
    ).toEqual({ status: "succeeded", output: { a: 3, b: 2 } });
    expect(
      executeBuiltinNode({
        nodeId: "control.fail",
        nodeInput: { code: "SAFE_STOP", message: "Stop here" },
        workflowInput: {},
        previousOutput: {}
      })
    ).toMatchObject({
      status: "failed",
      output: { code: "SAFE_STOP" },
      error: { code: "WORKFLOW_FAILED", retryable: false }
    });
  });
});
