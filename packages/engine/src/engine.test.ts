import { describe, expect, it } from "vitest";
import type {
  ArtifactRef,
  CallRoutes,
  ExecutionPlan,
  ExecutionStep,
  ForeachStep,
  PermissionSnapshot
} from "@bpa/workflow-ir";
import {
  ResourceValidatedRuntimeDispatcher,
  RuntimeProviderRegistry
} from "@bpa/node-runtime";
import {
  DeterministicWorkflowEngine,
  dispatchRuntimeEffect,
  evaluateCondition,
  resolveBinding,
  type EngineDependencies,
  type EngineState
} from "./index.js";

const digest = (character: string): string => character.repeat(64);
const node: ArtifactRef & { kind: "node" } = {
  kind: "node",
  id: "test.inspect",
  version: "1.0.0",
  digest: digest("a")
};
const profile: ArtifactRef & { kind: "assistance_profile" } = {
  kind: "assistance_profile",
  id: "test.review",
  version: "1.0.0",
  digest: digest("b")
};
const permissions: PermissionSnapshot = {
  riskLevel: "R0",
  permissions: [],
  domains: []
};

function call(key: string, routes: CallRoutes): ExecutionStep {
  return {
    kind: "call",
    key,
    node,
    schemaContract: {
      nodeDigest: node.digest,
      inputSchema: { type: "object" },
      inputSchemaDigest: digest("1"),
      outputSchema: { type: "object" },
      outputSchemaDigest: digest("2")
    },
    providerId: "test",
    permissionSnapshot: permissions,
    dependencies: {
      adapters: [],
      policies: [],
      datasetProfiles: []
    },
    timeoutMs: 1_000,
    retry: {
      maxAttempts: 2,
      retryableOutcomes: ["failed", "timed_out"],
      retryableErrorCodes: ["RETRY"],
      backoff: {
        strategy: "fixed",
        baseDelayMs: 100,
        maxDelayMs: 100,
        jitterRatio: 0
      }
    },
    timing: {},
    input: {
      kind: "object",
      entries: {
        item: { kind: "reference", source: "scope_item", path: [] }
      }
    },
    routes
  };
}

function planWithForeach(count = 2): ExecutionPlan {
  const inspectRoutes: CallRoutes = {
    succeeded: "item_ok",
    failed: "item_failed",
    timed_out: "item_failed",
    rejected: "item_rejected",
    cancelled: "item_failed",
    uncertain: "item_uncertain"
  };
  const foreach: ForeachStep = {
    kind: "foreach",
    key: "items",
    items: {
      kind: "reference",
      source: "run_input",
      path: ["items"]
    },
    itemKey: { path: ["id"], valueType: "string" },
    limits: {
      maxItems: Math.max(500, count),
      maxDurationMs: 60_000,
      maxDepth: 0,
      maxStepExecutions: 2_000
    },
    onItemError: "collect",
    body: {
      entry: "inspect",
      steps: {
        inspect: call("inspect", inspectRoutes),
        item_ok: {
          kind: "terminal",
          key: "item_ok",
          status: "succeeded"
        },
        item_failed: {
          kind: "terminal",
          key: "item_failed",
          status: "failed",
          errorCode: "ITEM_FAILED"
        },
        item_rejected: {
          kind: "terminal",
          key: "item_rejected",
          status: "rejected"
        },
        item_uncertain: {
          kind: "terminal",
          key: "item_uncertain",
          status: "uncertain"
        }
      }
    },
    aggregation: { mode: "outcome_summary", outputKey: "items.output" },
    routes: {
      completed: "review_detached",
      stopped: "failed",
      uncertain: "uncertain"
    }
  };
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "test.foreach",
      version: "1.0.0",
      digest: digest("c")
    },
    artifactClosure: { entries: [node, profile] },
    riskSnapshot: [],
    limits: { maxDepth: 1, maxStepExecutions: 3_000 },
    entry: "items",
    steps: {
      items: foreach,
      review_detached: {
        kind: "wait.assistance",
        key: "review_detached",
        taskKind: "ai_review",
        profile,
        deadlineMs: 1_000,
        onUnavailable: "continue_unresolved",
        blocking: false,
        next: "done"
      },
      done: {
        kind: "terminal",
        key: "done",
        status: "succeeded"
      },
      failed: {
        kind: "terminal",
        key: "failed",
        status: "failed",
        errorCode: "FAILED"
      },
      uncertain: {
        kind: "terminal",
        key: "uncertain",
        status: "uncertain"
      }
    }
  };
}

function planWithNestedForeach(): ExecutionPlan {
  const base = planWithForeach();
  const inner = base.steps.items;
  if (inner?.kind !== "foreach") throw new Error("fixture changed");
  const innerInspect = inner.body.steps.inspect;
  if (innerInspect?.kind !== "call") throw new Error("fixture changed");
  const outer: ForeachStep = {
    kind: "foreach",
    key: "groups",
    items: {
      kind: "reference",
      source: "run_input",
      path: ["groups"]
    },
    itemKey: { path: ["id"], valueType: "string" },
    limits: {
      maxItems: 10,
      maxDurationMs: 50,
      maxDepth: 1,
      maxStepExecutions: 2_000
    },
    onItemError: "collect",
    body: {
      entry: "nested_items",
      steps: {
        nested_items: {
          ...inner,
          key: "nested_items",
          items: {
            kind: "reference",
            source: "scope_item",
            path: ["items"]
          },
          limits: { ...inner.limits, maxDurationMs: 10_000 },
          body: {
            ...inner.body,
            steps: {
              ...inner.body.steps,
              inspect: {
                ...innerInspect,
                retry: { ...innerInspect.retry, maxAttempts: 1 }
              }
            }
          },
          routes: {
            completed: "group_ok",
            stopped: "group_failed",
            uncertain: "group_uncertain"
          }
        },
        group_ok: {
          kind: "terminal",
          key: "group_ok",
          status: "succeeded"
        },
        group_failed: {
          kind: "terminal",
          key: "group_failed",
          status: "failed",
          errorCode: "GROUP_FAILED"
        },
        group_uncertain: {
          kind: "terminal",
          key: "group_uncertain",
          status: "uncertain"
        }
      }
    },
    aggregation: { mode: "outcome_summary", outputKey: "groups.output" },
    routes: {
      completed: "done",
      stopped: "failed",
      uncertain: "uncertain"
    }
  };
  return {
    ...base,
    entry: "groups",
    steps: {
      groups: outer,
      done: base.steps.done!,
      failed: base.steps.failed!,
      uncertain: base.steps.uncertain!
    }
  };
}

function dependencies(): EngineDependencies & {
  now: { value: number };
} {
  let sequence = 0;
  const now = { value: 1_000 };
  return {
    now,
    clock: { now: () => now.value },
    ids: {
      next: (kind) => `${kind}-${++sequence}`
    },
    random: { next: () => 0.5 }
  };
}

function succeeded(output: unknown) {
  return {
    status: "succeeded" as const,
    output: output as never,
    evidence: [],
    riskSignals: []
  };
}

describe("deterministic IR2 engine", () => {
  it("runs sequential foreach and emits detached assistance without pausing", () => {
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(planWithForeach(), deps);
    let transition = engine.start("run-1", {
      items: [
        { id: "a", value: 1 },
        { id: "b", value: 2 }
      ]
    });
    expect(transition.state.status).toBe("waiting_runtime");
    expect(transition.state.active?.kind).toBe("call");
    const first = transition.state.active;
    if (first?.kind !== "call") throw new Error("fixture changed");
    expect(first.invocation.identity).toMatchObject({
      runId: "run-1",
      iterationKey: "a",
      stepKey: "inspect",
      attempt: 1
    });
    expect(first.invocation.schemaContract).toMatchObject({
      nodeDigest: node.digest,
      inputSchemaDigest: digest("1"),
      outputSchemaDigest: digest("2")
    });

    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: first.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ checked: "a" })
    });
    const second = transition.state.active;
    if (second?.kind !== "call") throw new Error("fixture changed");
    expect(second.invocation.identity.iterationKey).toBe("b");

    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: second.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ checked: "b" })
    });
    expect(transition.state.status).toBe("succeeded");
    expect(transition.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistance.create" })
      ])
    );
    expect(transition.state.output).toMatchObject({
      total: 2,
      succeeded: { count: 2 },
      failed: { count: 0 },
      unresolved: { count: 0 }
    });
  });

  it("drops completed foreach item intermediates before checkpointing the next item", () => {
    const base = planWithForeach();
    const foreach = base.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const inspect = foreach.body.steps.inspect;
    if (inspect?.kind !== "call") throw new Error("fixture changed");
    const persistRoutes: CallRoutes = {
      succeeded: "item_ok",
      failed: "item_failed",
      timed_out: "item_failed",
      rejected: "item_rejected",
      cancelled: "item_failed",
      uncertain: "item_uncertain"
    };
    const compactPlan: ExecutionPlan = {
      ...base,
      steps: {
        ...base.steps,
        items: {
          ...foreach,
          body: {
            ...foreach.body,
            steps: {
              ...foreach.body.steps,
              inspect: {
                ...inspect,
                routes: { ...inspect.routes, succeeded: "persist" }
              },
              persist: call("persist", persistRoutes)
            }
          }
        }
      }
    };
    const engine = new DeterministicWorkflowEngine(compactPlan, dependencies());
    let transition = engine.start("run-compact", {
      items: [
        { id: "a" },
        { id: "b" }
      ]
    });
    const inspectCall = transition.state.active;
    if (inspectCall?.kind !== "call") throw new Error("fixture changed");
    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: inspectCall.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ large: "private-intermediate".repeat(10_000) })
    });
    expect(JSON.stringify(transition.state)).toContain("private-intermediate");
    const persistCall = transition.state.active;
    if (persistCall?.kind !== "call") throw new Error("fixture changed");
    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: persistCall.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ factKey: "fact:a" })
    });
    expect(transition.state.active).toMatchObject({
      kind: "call",
      invocation: { identity: { iterationKey: "b", stepKey: "inspect" } }
    });
    expect(JSON.stringify(transition.state)).not.toContain(
      "private-intermediate"
    );
    expect(Object.keys(transition.state.stepOutputs)).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(transition.state), "utf8")).toBeLessThan(
      16 * 1024
    );
  });

  it("persists frozen foreach items across recovery and source growth 105→106", () => {
    const deps = dependencies();
    const source = {
      items: Array.from({ length: 105 }, (_, index) => ({
        id: `p-${index}`
      }))
    };
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(500),
      deps
    );
    const waiting = engine.start("run-frozen", source);
    source.items.push({ id: "p-105" });
    const snapshot = structuredClone(waiting.state);
    expect(snapshot.foreachStack[0]?.items).toHaveLength(105);

    const restored = engine.resume(snapshot);
    expect(restored.state).toEqual(snapshot);
    const active = restored.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    const next = engine.acceptRuntimeOutcome({
      state: restored.state,
      invocationId: active.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ ok: true })
    });
    expect(next.state.foreachStack[0]?.items).toHaveLength(105);
    expect(next.state.foreachStack[0]?.index).toBe(1);
  });

  it("retries deterministically and rejects duplicate or late outcomes", () => {
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(planWithForeach(), deps);
    const waiting = engine.start("run-retry", {
      items: [{ id: "a" }]
    });
    const first = waiting.state.active;
    if (first?.kind !== "call") throw new Error("fixture changed");
    const retrying = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: first.invocation.invocationId,
      fencingToken: 1,
      outcome: {
        status: "failed",
        error: { code: "RETRY", message: "retry", retryable: true },
        evidence: [],
        riskSignals: []
      }
    });
    const retry = retrying.state.active;
    if (retry?.kind !== "call") throw new Error("fixture changed");
    expect(retry.invocation.identity.attempt).toBe(2);
    expect(retry.invocation.fencingToken).toBe(2);
    expect(retrying.effects[0]).toMatchObject({ notBefore: 1_100 });

    expect(
      engine.acceptRuntimeOutcome({
        state: retrying.state,
        invocationId: first.invocation.invocationId,
        fencingToken: 1,
        outcome: succeeded(null)
      }).disposition
    ).toBe("duplicate");
    expect(
      engine.acceptRuntimeOutcome({
        state: retrying.state,
        invocationId: "unknown",
        fencingToken: 1,
        outcome: succeeded(null)
      }).disposition
    ).toBe("stale");
  });

  it("never retries a failed outcome marked non-retryable", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    const waiting = engine.start("run-fail-closed", {
      items: [{ id: "a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");

    const failed = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: active.invocation.invocationId,
      fencingToken: active.invocation.fencingToken,
      outcome: {
        status: "failed",
        error: {
          code: "RETRY",
          message: "contract failure",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      }
    });

    expect(failed.state.status).toBe("succeeded");
    expect(failed.state.completedExternalIds).toEqual([
      active.invocation.invocationId
    ]);
    expect(
      failed.effects.filter((effect) => effect.kind === "runtime.invoke")
    ).toEqual([]);
  });

  it("caps an in-flight first item at the earliest ancestor foreach deadline", () => {
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(
      planWithNestedForeach(),
      deps
    );
    const waiting = engine.start("run-ancestor-deadline", {
      groups: [{ id: "group-a", items: [{ id: "item-a" }] }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");

    expect(active.invocation.deadlineAt).toBe(1_050);
    deps.now.value = 1_050;
    const timedOut = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: active.invocation.invocationId,
      fencingToken: active.invocation.fencingToken,
      outcome: {
        status: "timed_out",
        error: {
          code: "RETRY",
          message: "ancestor foreach budget elapsed",
          retryable: true
        },
        evidence: [],
        riskSignals: []
      }
    });

    expect(timedOut.state.status).toBe("failed");
    expect(timedOut.state.foreachStack).toEqual([]);
    expect(timedOut.effects).toEqual([]);
  });

  it("does not dispatch a retry whose backoff crosses foreach budget", () => {
    const base = planWithForeach();
    const foreach = base.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const bounded: ExecutionPlan = {
      ...base,
      steps: {
        ...base.steps,
        items: {
          ...foreach,
          limits: { ...foreach.limits, maxDurationMs: 150 }
        }
      }
    };
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(bounded, deps);
    const waiting = engine.start("run-retry-budget", {
      items: [{ id: "a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    deps.now.value = 1_060;

    const stopped = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: active.invocation.invocationId,
      fencingToken: active.invocation.fencingToken,
      outcome: {
        status: "failed",
        error: { code: "RETRY", message: "retry", retryable: true },
        evidence: [],
        riskSignals: []
      }
    });

    expect(stopped.state.status).toBe("failed");
    expect(stopped.state.foreachStack).toEqual([]);
    expect(stopped.effects).toEqual([]);
  });

  it("does not reset a persisted foreach budget during recovery", () => {
    const base = planWithForeach();
    const foreach = base.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const bounded: ExecutionPlan = {
      ...base,
      steps: {
        ...base.steps,
        items: {
          ...foreach,
          limits: { ...foreach.limits, maxDurationMs: 150 }
        }
      }
    };
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(bounded, deps);
    const waiting = engine.start("run-recovered-budget", {
      items: [{ id: "a" }]
    });
    const snapshot = structuredClone(waiting.state);
    deps.now.value = 1_100;
    const recovered = engine.resume(snapshot);
    const active = recovered.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");

    expect(recovered.state.foreachStack[0]?.startedAt).toBe(1_000);
    expect(active.invocation.deadlineAt).toBe(1_150);
    const stopped = engine.acceptRuntimeOutcome({
      state: recovered.state,
      invocationId: active.invocation.invocationId,
      fencingToken: active.invocation.fencingToken,
      outcome: {
        status: "failed",
        error: { code: "RETRY", message: "retry", retryable: true },
        evidence: [],
        riskSignals: []
      }
    });
    expect(stopped.state.status).toBe("failed");
    expect(stopped.effects).toEqual([]);
  });

  it("cancels a waiting invocation once and rejects its late outcome", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    const waiting = engine.start("run-cancel", {
      items: [{ id: "a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");

    const cancelled = engine.cancel(waiting.state);
    expect(cancelled).toMatchObject({
      disposition: "advanced",
      effects: [],
      state: {
        status: "cancelled",
        cursor: undefined,
        active: undefined,
        error: { code: "RUN_CANCELLED" }
      }
    });
    expect(cancelled.state.completedExternalIds).toContain(
      active.invocation.invocationId
    );
    expect(engine.cancel(cancelled.state)).toMatchObject({
      disposition: "duplicate",
      state: { revision: cancelled.state.revision }
    });
    expect(
      engine.acceptRuntimeOutcome({
        state: cancelled.state,
        invocationId: active.invocation.invocationId,
        fencingToken: active.invocation.fencingToken,
        outcome: succeeded({ tooLate: true })
      })
    ).toMatchObject({
      disposition: "duplicate",
      state: {
        status: "cancelled",
        revision: cancelled.state.revision,
        output: undefined
      }
    });
  });

  it("stops immediately on uncertain outcomes", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    const waiting = engine.start("run-uncertain", {
      items: [{ id: "a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    const stopped = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: active.invocation.invocationId,
      fencingToken: 1,
      outcome: {
        status: "uncertain",
        error: {
          code: "OUTCOME_UNKNOWN",
          message: "Unknown",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      }
    });
    expect(stopped.state.status).toBe("uncertain");
    expect(stopped.state.output).toBeUndefined();
    expect(stopped.effects).toEqual([]);
    expect(stopped.state.cursor).toBeUndefined();
  });

  it("retains controlled output from an uncertain terminal inside foreach", () => {
    const plan = planWithForeach();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const terminal = foreach.body.steps.item_uncertain;
    if (terminal?.kind !== "terminal") throw new Error("fixture changed");
    (foreach.body.steps as unknown as Record<string,typeof terminal>)
      .item_uncertain = {
        ...terminal,
        output:{ kind:"literal",value:{ retainedFacts:3 } }
      };
    const engine = new DeterministicWorkflowEngine(plan,dependencies());
    const waiting = engine.start("run-uncertain-output",{
      items:[{ id:"a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    const stopped = engine.acceptRuntimeOutcome({
      state:waiting.state,
      invocationId:active.invocation.invocationId,
      fencingToken:1,
      outcome:{
        status:"uncertain",
        error:{ code:"OUTCOME_UNKNOWN",message:"Unknown",retryable:false },
        evidence:[],riskSignals:[]
      }
    });
    expect(stopped.state).toMatchObject({
      status:"uncertain",
      output:{ retainedFacts:3 }
    });
  });

  it("preserves the exact error code of a top-level uncertain terminal", () => {
    const source = planWithForeach();
    const uncertain = source.steps.uncertain;
    if (!uncertain || uncertain.kind !== "terminal") {
      throw new Error("fixture changed");
    }
    const engine = new DeterministicWorkflowEngine({
      ...source,
      entry:"uncertain",
      steps:{
        ...source.steps,
        uncertain:{
          ...uncertain,errorCode:"DISCOVERY_IDENTITY_UNCERTAIN"
        }
      }
    },dependencies());
    expect(engine.start("run-terminal-uncertain",{}).state).toMatchObject({
      status:"uncertain",
      error:{ code:"DISCOVERY_IDENTITY_UNCERTAIN" }
    });
  });

  it("stops immediately on rejected outcomes without weakening the reason", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    const waiting = engine.start("run-rejected", {
      items: [{ id: "a" }]
    });
    const active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    const stopped = engine.acceptRuntimeOutcome({
      state: waiting.state,
      invocationId: active.invocation.invocationId,
      fencingToken: 1,
      outcome: {
        status: "rejected",
        error: {
          code: "CAPTCHA_REQUIRED",
          message: "Human verification required.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      }
    });
    expect(stopped).toMatchObject({
      effects: [],
      state: {
        status: "rejected",
        cursor: undefined,
        active: undefined,
        error: {
          code: "CAPTCHA_REQUIRED",
          message: "Human verification required."
        }
      }
    });
    expect(engine.cancel(stopped.state).disposition).toBe("stale");
  });

  it("pauses only for blocking assistance and resumes by explicit route", () => {
    const base = planWithForeach();
    const blocking: ExecutionPlan = {
      ...base,
      entry: "review",
      steps: {
        ...base.steps,
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "human_confirm",
          profile,
          deadlineMs: 2_000,
          onUnavailable: "fail",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "failed",
            expired: "failed",
            unavailable: "failed"
          }
        }
      }
    };
    const engine = new DeterministicWorkflowEngine(
      blocking,
      dependencies()
    );
    const waiting = engine.start("run-assistance", {});
    expect(waiting.state.status).toBe("waiting_assistance");
    expect(waiting.effects.map((effect) => effect.kind)).toEqual([
      "assistance.create",
      "timer.schedule"
    ]);
    expect(waiting.effects[1]).toMatchObject({
      kind: "timer.schedule",
      timer: {
        wakeAt: 3_000,
        signal: { kind: "assistance.expired" }
      }
    });
    const active = waiting.state.active;
    if (active?.kind !== "assistance") throw new Error("fixture changed");
    const completed = engine.acceptAssistanceOutcome({
      state: waiting.state,
      taskId: active.request.taskId,
      fencingToken: 1,
      outcome: { status: "resolved", output: { approved: true } }
    });
    expect(completed.state.status).toBe("succeeded");
    expect(completed.state.output).toEqual({ approved: true });
    expect(
      engine.acceptAssistanceOutcome({
        state: completed.state,
        taskId: active.request.taskId,
        fencingToken: 1,
        outcome: { status: "resolved", output: null }
      }).disposition
    ).toBe("duplicate");
  });

  it("evaluates decisions without executing arbitrary expressions", () => {
    const base = planWithForeach();
    const conditional: ExecutionPlan = {
      ...base,
      entry: "choose",
      steps: {
        choose: {
          kind: "decision",
          key: "choose",
          branches: [
            {
              id: "ready",
              condition: {
                kind: "all",
                conditions: [
                  {
                    kind: "compare",
                    operator: "equals",
                    left: {
                      kind: "reference",
                      source: "run_input",
                      path: ["ready"]
                    },
                    right: { kind: "literal", value: true }
                  },
                  {
                    kind: "not",
                    condition: {
                      kind: "compare",
                      operator: "contains",
                      left: {
                        kind: "reference",
                        source: "run_input",
                        path: ["labels"]
                      },
                      right: { kind: "literal", value: "blocked" }
                    }
                  }
                ]
              },
              target: "done"
            }
          ],
          defaultTarget: "failed"
        },
        done: base.steps.done!,
        failed: base.steps.failed!
      }
    };
    const engine = new DeterministicWorkflowEngine(
      conditional,
      dependencies()
    );
    expect(
      engine.start("run-decision", {
        ready: true,
        labels: ["safe"]
      }).state.status
    ).toBe("succeeded");
    expect(
      engine.start("run-decision-failed", {
        ready: false,
        labels: ["safe"]
      }).state.status
    ).toBe("failed");
  });

  it("collects item failures and rejects duplicate stable item keys", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    let transition = engine.start("run-failure", {
      items: [{ id: "a" }, { id: "b" }]
    });
    const first = transition.state.active;
    if (first?.kind !== "call") throw new Error("fixture changed");
    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: first.invocation.invocationId,
      fencingToken: 1,
      outcome: {
        status: "failed",
        error: { code: "FINAL", message: "failed", retryable: false },
        evidence: [],
        riskSignals: []
      }
    });
    const second = transition.state.active;
    if (second?.kind !== "call") throw new Error("fixture changed");
    transition = engine.acceptRuntimeOutcome({
      state: transition.state,
      invocationId: second.invocation.invocationId,
      fencingToken: 1,
      outcome: succeeded({ ok: true })
    });
    expect(transition.state.output).toMatchObject({
      total: 2,
      succeeded: { count: 1 },
      failed: { count: 1 }
    });

    expect(
      engine.start("run-duplicate", {
        items: [{ id: "same" }, { id: "same" }]
      }).state
    ).toMatchObject({
      status: "failed",
      error: { code: "FOREACH_ITEM_KEY_DUPLICATE" }
    });
  });

  it("routes assistance expiry and rejects snapshots from another plan", () => {
    const base = planWithForeach();
    const blocking: ExecutionPlan = {
      ...base,
      entry: "review",
      steps: {
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "ai_review",
          profile,
          deadlineMs: 100,
          onUnavailable: "fail",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "failed",
            expired: "failed",
            unavailable: "failed"
          }
        },
        done: base.steps.done!,
        failed: base.steps.failed!
      }
    };
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(blocking, deps);
    const waiting = engine.start("run-expired", {});
    const active = waiting.state.active;
    if (active?.kind !== "assistance") throw new Error("fixture changed");
    const timerEffect = waiting.effects.find(
      (effect) => effect.kind === "timer.schedule"
    );
    if (timerEffect?.kind !== "timer.schedule") {
      throw new Error("timer fixture changed");
    }
    expect(
      engine.acceptTimerFire({
        state: waiting.state,
        timer: timerEffect.timer
      }).disposition
    ).toBe("stale");
    deps.now.value = 1_100;
    expect(
      engine.acceptTimerFire({
        state: waiting.state,
        timer: { ...timerEffect.timer, fencingToken: 0 }
      }).disposition
    ).toBe("stale");
    const expired = engine.acceptTimerFire({
      state: waiting.state,
      timer: timerEffect.timer
    });
    expect(expired.state.status).toBe("failed");
    expect(
      engine.acceptTimerFire({
        state: expired.state,
        timer: timerEffect.timer
      }).disposition
    ).toBe("duplicate");

    const mismatched = {
      ...waiting.state,
      workflowDigest: "different"
    } satisfies EngineState;
    expect(() => engine.resume(mismatched)).toThrow(
      "does not belong to this plan"
    );
  });

  it("handles empty, oversized and invalid foreach inputs deterministically", () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    expect(engine.start("run-empty", { items: [] }).state).toMatchObject({
      status: "succeeded",
      output: { total: 0 }
    });
    expect(
      engine.start("run-too-many", {
        items: Array.from({ length: 501 }, (_, id) => ({
          id: String(id)
        }))
      }).state.status
    ).toBe("failed");
    expect(
      engine.start("run-wrong-key", {
        items: [{ id: 1 }]
      }).state
    ).toMatchObject({
      status: "failed",
      error: { code: "FOREACH_ITEM_KEY_INVALID" }
    });
    expect(engine.start("run-not-array", { items: null }).state.status).toBe(
      "failed"
    );
  });

  it("stops foreach on item error or duration exhaustion", () => {
    const baseStopPlan = planWithForeach();
    const foreach = baseStopPlan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const stopPlan: ExecutionPlan = {
      ...baseStopPlan,
      steps: {
        ...baseStopPlan.steps,
        items: { ...foreach, onItemError: "stop" }
      }
    };
    const deps = dependencies();
    const engine = new DeterministicWorkflowEngine(stopPlan, deps);
    let waiting = engine.start("run-stop", { items: [{ id: "a" }] });
    let active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    expect(
      engine.acceptRuntimeOutcome({
        state: waiting.state,
        invocationId: active.invocation.invocationId,
        fencingToken: 1,
        outcome: {
          status: "failed",
          error: { code: "FINAL", message: "failed", retryable: false },
          evidence: [],
          riskSignals: []
        }
      }).state.status
    ).toBe("failed");

    const baseDurationPlan = planWithForeach();
    const durationForeach = baseDurationPlan.steps.items;
    if (durationForeach?.kind !== "foreach") {
      throw new Error("fixture changed");
    }
    const durationPlan: ExecutionPlan = {
      ...baseDurationPlan,
      steps: {
        ...baseDurationPlan.steps,
        items: {
          ...durationForeach,
          limits: { ...durationForeach.limits, maxDurationMs: 1 }
        }
      }
    };
    const durationEngine = new DeterministicWorkflowEngine(
      durationPlan,
      deps
    );
    waiting = durationEngine.start("run-duration", {
      items: [{ id: "a" }]
    });
    active = waiting.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    deps.now.value += 2;
    expect(
      durationEngine.acceptRuntimeOutcome({
        state: waiting.state,
        invocationId: active.invocation.invocationId,
        fencingToken: 1,
        outcome: succeeded(null)
      }).state.status
    ).toBe("failed");
  });

  it("copies immutable Call resource mappings into every invocation", () => {
    const resourcePlan = structuredClone(planWithForeach(1));
    const foreach = resourcePlan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    const inspect = foreach.body.steps.inspect;
    if (inspect?.kind !== "call") throw new Error("fixture changed");
    const resourceMappings = {
      page_session: {
        requirementName: "page_session",
        slotName: "metrics_source",
        requirement: {
          kind: "browser" as const,
          capabilities: ["browser.dom.read"],
          allowedOrigins: ["https://www.chanmama.com"],
          authentication: "authenticated" as const,
          purpose: "Read authenticated metrics"
        },
        requirementDigest: digest("9")
      }
    };
    (
      inspect as unknown as {
        resourceMappings: typeof resourceMappings;
      }
    ).resourceMappings = resourceMappings;
    const engine = new DeterministicWorkflowEngine(
      resourcePlan,
      dependencies()
    );
    const waiting = engine.start("run-resource-mapping", {
      items: [{ id: "a" }]
    });
    const effect = waiting.effects[0];
    if (effect?.kind !== "runtime.invoke") {
      throw new Error("fixture changed");
    }
    expect(effect.invocation.resourceMappings).toEqual(resourceMappings);
    expect(effect.invocation.resourceMappings).not.toBe(resourceMappings);
    expect(
      waiting.state.active?.kind === "call"
        ? waiting.state.active.invocation.resourceMappings
        : undefined
    ).toEqual(resourceMappings);
  });

  it("dispatches effects through the resource-validating dispatcher", async () => {
    const engine = new DeterministicWorkflowEngine(
      planWithForeach(),
      dependencies()
    );
    const waiting = engine.start("run-provider", {
      items: [{ id: "a" }]
    });
    const effect = waiting.effects[0];
    if (effect?.kind !== "runtime.invoke") throw new Error("fixture changed");
    const registry = new RuntimeProviderRegistry();
    registry.register({
      id: "test",
      supports: () => true,
      invoke: async (invocation) =>
        succeeded({ invocationId: invocation.invocationId })
    });
    const dispatcher = new ResourceValidatedRuntimeDispatcher(registry, {
      getBrowserSession: () => undefined
    });
    await expect(
      dispatchRuntimeEffect(
        dispatcher,
        effect,
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { invocationId: effect.invocation.invocationId }
    });
  });
});

describe("binding and condition helpers", () => {
  it("resolves composed bindings and all deterministic comparisons", () => {
    const state: EngineState = {
      stateVersion: "bpa.engine-state/2",
      runId: "run-bindings",
      workflowDigest: digest("f"),
      status: "running",
      revision: 0,
      input: { present: 4 },
      cursor: undefined,
      previousOutput: { count: 5 },
      stepOutputs: {
        "[]:source": { label: "ready" }
      },
      foreachStack: [],
      active: undefined,
      completedExternalIds: [],
      output: undefined,
      error: undefined
    };

    expect(
      resolveBinding(
        {
          kind: "array",
          items: [
            {
              kind: "reference",
              source: "previous_output",
              path: ["count"]
            },
            {
              kind: "reference",
              source: "step_output",
              stepKey: "source",
              path: ["label"]
            }
          ]
        },
        state
      )
    ).toEqual([5, "ready"]);
    expect(() =>
      resolveBinding(
        { kind: "reference", source: "scope_item", path: [] },
        state
      )
    ).toThrow("outside foreach");
    expect(() =>
      resolveBinding(
        {
          kind: "reference",
          source: "step_output",
          stepKey: "missing",
          path: []
        },
        state
      )
    ).toThrow("unavailable");
    expect(() =>
      resolveBinding(
        {
          kind: "reference",
          source: "run_input",
          path: ["missing"]
        },
        state
      )
    ).toThrow("does not exist");

    const compare = (
      operator:
        | "exists"
        | "not_equals"
        | "greater_than"
        | "greater_than_or_equal"
        | "less_than"
        | "less_than_or_equal",
      left: number,
      right?: number
    ) =>
      evaluateCondition(
        {
          kind: "compare",
          operator,
          left: { kind: "literal", value: left },
          ...(right === undefined
            ? {}
            : { right: { kind: "literal" as const, value: right } })
        },
        state
      );

    expect(compare("exists", 1)).toBe(true);
    expect(compare("not_equals", 1, 2)).toBe(true);
    expect(compare("greater_than", 2, 1)).toBe(true);
    expect(compare("greater_than_or_equal", 2, 2)).toBe(true);
    expect(compare("less_than", 1, 2)).toBe(true);
    expect(compare("less_than_or_equal", 2, 2)).toBe(true);
    expect(
      evaluateCondition(
        {
          kind: "any",
          conditions: [
            {
              kind: "compare",
              operator: "equals",
              left: { kind: "literal", value: 1 },
              right: { kind: "literal", value: 2 }
            },
            {
              kind: "compare",
              operator: "equals",
              left: { kind: "literal", value: 1 },
              right: { kind: "literal", value: 1 }
            }
          ]
        },
        state
      )
    ).toBe(true);
  });
});
