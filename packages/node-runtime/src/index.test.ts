import { describe, expect, it } from "vitest";
import {
  AdaptiveReadinessGate,
  computeDispatchDelayMs,
  computeRetryDelayMs,
  evaluateConditionExpression,
  executeBuiltinNode,
  firstBlockingRiskSignal,
  mergeTimingPolicy,
  resolveBindings,
  reserveRateLimit,
  timingPolicyIssues
} from "./index.js";

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
