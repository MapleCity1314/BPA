import { describe, expect, it } from "vitest";
import {
  appendScope,
  ARTIFACT_KINDS,
  createExecutionIdentity,
  createExecutionPlan,
  estimateMaxDepth,
  estimateMaxStepExecutions,
  executionIdentityKey,
  executionPlanIssues,
  InvalidExecutionPlanError,
  normalizeExecutionPlan,
  WORKFLOW_IR_VERSION,
  type ArtifactRef,
  type BindingValue,
  type CallRoutes,
  type CallStep,
  type ExecutionPlan,
  type ForeachAggregationResult
} from "./index.js";

const digest = (character: string): string => character.repeat(64);

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const node: ArtifactRef & { kind: "node" } = {
  kind: "node",
  id: "doudian.shop.context.read",
  version: "1.0.0",
  digest: digest("a")
};

const assistanceProfile: ArtifactRef & {
  kind: "assistance_profile";
} = {
  kind: "assistance_profile",
  id: "scope_review",
  version: "1.0.0",
  digest: digest("b")
};

const adapter: ArtifactRef & { kind: "adapter" } = {
  kind: "adapter",
  id: "doudian",
  version: "1.0.0",
  digest: digest("d")
};

const policy: ArtifactRef & { kind: "policy" } = {
  kind: "policy",
  id: "read-only-browser",
  version: "1.0.0",
  digest: digest("e")
};

const datasetProfile: ArtifactRef & { kind: "dataset_profile" } = {
  kind: "dataset_profile",
  id: "packaging-master-v1",
  version: "1.0.0",
  digest: digest("f")
};

function callStep(
  key: string,
  routes: CallRoutes
): DeepMutable<CallStep> {
  return {
    kind: "call",
    key,
    node,
    providerId: "browser",
    permissionSnapshot: {
      riskLevel: "R0",
      permissions: ["browser.dom.read"],
      domains: ["https://fxg.jinritemai.com"]
    },
    dependencies: {
      adapters: [adapter],
      policies: [policy],
      datasetProfiles: [datasetProfile]
    },
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 3,
      retryableOutcomes: ["timed_out", "failed"],
      retryableErrorCodes: ["PAGE_NOT_READY"],
      backoff: {
        strategy: "exponential",
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.1
      }
    },
    timing: {
      readiness: {
        timeoutMs: 10_000,
        stableForMs: 500,
        pollIntervalMs: 100
      },
      dispatchJitter: {
        minMs: 0,
        maxMs: 50,
        distribution: "uniform"
      },
      rateLimit: {
        scope: "shop",
        minIntervalMs: 100,
        maxQueueMs: 10_000
      }
    },
    routes
  } as DeepMutable<CallStep>;
}

function validPlan(): ExecutionPlan {
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "priority-check",
      version: "1.0.0",
      digest: digest("c")
    },
    artifactClosure: {
      entries: [
        assistanceProfile,
        node,
        adapter,
        policy,
        datasetProfile
      ]
    },
    riskSnapshot: [
      {
        code: "READ_ONLY",
        level: "R0",
        source: node,
        details: { write: false }
      }
    ],
    limits: {
      maxDepth: 3,
      maxStepExecutions: 30
    },
    entry: "collect",
    steps: {
      collect: {
        ...callStep("collect", {
          succeeded: "review",
          failed: "failed",
          timed_out: "failed",
          rejected: "failed",
          cancelled: "cancelled",
          uncertain: "uncertain"
        }),
        input: {
          kind: "object",
          entries: {
            shopId: {
              kind: "reference",
              source: "run_input",
              path: ["shopId"]
            }
          }
        }
      },
      review: {
        kind: "wait.assistance",
        key: "review",
        taskKind: "ai_review",
        profile: assistanceProfile,
        deadlineMs: 60_000,
        onUnavailable: "continue_unresolved",
        blocking: true,
        routes: {
          resolved: "items",
          escalated: "items",
          expired: "items",
          unavailable: "items"
        }
      },
      items: {
        kind: "foreach",
        key: "items",
        items: {
          kind: "reference",
          source: "previous_output",
          path: ["products"]
        },
        itemKey: { path: ["productId"], valueType: "string" },
        limits: {
          maxItems: 5,
          maxDurationMs: 120_000,
          maxDepth: 1,
          maxStepExecutions: 20
        },
        onItemError: "collect",
        body: {
          entry: "inspect",
          steps: {
            inspect: {
              ...callStep("inspect", {
                succeeded: "item-succeeded",
                failed: "item-failed",
                timed_out: "item-failed",
                rejected: "item-failed",
                cancelled: "item-failed",
                uncertain: "item-uncertain"
              })
            },
            "item-succeeded": {
              kind: "terminal",
              key: "item-succeeded",
              status: "succeeded"
            },
            "item-failed": {
              kind: "terminal",
              key: "item-failed",
              status: "failed",
              errorCode: "ITEM_FAILED"
            },
            "item-uncertain": {
              kind: "terminal",
              key: "item-uncertain",
              status: "uncertain"
            }
          }
        },
        aggregation: {
          mode: "outcome_summary",
          outputKey: "inspectionResults"
        },
        routes: {
          completed: "done",
          stopped: "failed",
          uncertain: "uncertain"
        }
      },
      done: {
        kind: "terminal",
        key: "done",
        status: "succeeded",
        output: {
          kind: "reference",
          source: "previous_output",
          path: []
        }
      },
      failed: {
        kind: "terminal",
        key: "failed",
        status: "failed",
        errorCode: "WORKFLOW_FAILED"
      },
      cancelled: {
        kind: "terminal",
        key: "cancelled",
        status: "cancelled"
      },
      uncertain: {
        kind: "terminal",
        key: "uncertain",
        status: "uncertain"
      }
    }
  };
}

function mutablePlan(): DeepMutable<ExecutionPlan> {
  return structuredClone(validPlan()) as DeepMutable<ExecutionPlan>;
}

describe("execution identity", () => {
  it("constructs a stable identity from caller-provided IDs", () => {
    const scopePath = appendScope([], "items", "product-42");
    const identity = createExecutionIdentity({
      runId: "run-1",
      scopePath,
      iterationKey: "product-42",
      stepKey: "inspect",
      attempt: 2
    });

    expect(identity).toEqual({
      runId: "run-1",
      scopePath: [
        { foreachStepKey: "items", itemKey: "product-42" }
      ],
      iterationKey: "product-42",
      stepKey: "inspect",
      attempt: 2
    });
    expect(executionIdentityKey(identity)).toBe(
      '["run-1",[["items","product-42"]],"product-42","inspect",2]'
    );
  });

  it("rejects invalid attempts and scope keys", () => {
    expect(() =>
      createExecutionIdentity({
        runId: "run",
        scopePath: [],
        iterationKey: "item",
        stepKey: "call",
        attempt: 0
      })
    ).toThrow("positive safe integer");
    expect(() => appendScope([], "items", "has\u0000control")).toThrow(
      "scopePath[0].itemKey"
    );
    expect(appendScope([], "items", "包装 规格一")).toEqual([
      { foreachStepKey: "items", itemKey: "包装 规格一" }
    ]);
  });
});

describe("execution plan", () => {
  it("publishes the canonical IR version and complete closure kinds", () => {
    expect(WORKFLOW_IR_VERSION).toBe("bpa.workflow-ir/2");
    expect(ARTIFACT_KINDS).toEqual([
      "node",
      "adapter",
      "policy",
      "assistance_profile",
      "dataset_profile"
    ]);
  });

  it("normalizes deterministically without changing branch order", () => {
    const input = validPlan();
    const normalized = normalizeExecutionPlan(input);

    expect(Object.keys(normalized.steps)).toEqual([
      "cancelled",
      "collect",
      "done",
      "failed",
      "items",
      "review",
      "uncertain"
    ]);
    expect(normalized.artifactClosure.entries.map((entry) => entry.kind)).toEqual([
      "adapter",
      "assistance_profile",
      "dataset_profile",
      "node",
      "policy"
    ]);
    const collect = normalized.steps.collect;
    expect(collect?.kind).toBe("call");
    if (collect?.kind !== "call") throw new Error("test fixture changed");
    expect(collect.retry.retryableOutcomes).toEqual(["failed", "timed_out"]);
    expect(input.steps).not.toBe(normalized.steps);
    expect(normalizeExecutionPlan(normalized)).toEqual(normalized);
  });

  it("constructs a valid closed plan and estimates bounded work", () => {
    const plan = createExecutionPlan(validPlan());
    expect(executionPlanIssues(plan)).toEqual([]);
    expect(estimateMaxDepth(plan)).toBe(1);
    // Seven top-level steps plus five possible four-step item executions.
    expect(estimateMaxStepExecutions(plan)).toBe(27n);
  });

  it("rejects call assets that are not in the immutable closure", () => {
    const plan = mutablePlan();
    plan.artifactClosure = { entries: [assistanceProfile] };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ARTIFACT_NOT_CLOSED",
          path: "/steps/collect/node"
        }),
        expect.objectContaining({
          code: "ARTIFACT_NOT_CLOSED",
          path: "/steps/items/body/steps/inspect/node"
        })
      ])
    );
    expect(() => createExecutionPlan(plan)).toThrow(InvalidExecutionPlanError);
  });

  it("rejects arbitrary back edges", () => {
    const plan = mutablePlan();
    plan.steps.done = {
      ...callStep("done", {
        succeeded: "collect",
        failed: "failed",
        timed_out: "failed",
        rejected: "failed",
        cancelled: "cancelled",
        uncertain: "uncertain"
      })
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BACK_EDGE" })
      ])
    );
  });

  it("reports missing routes and unreachable steps", () => {
    const plan = mutablePlan();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    foreach.routes.completed = "missing";
    plan.steps.orphan = {
      kind: "terminal",
      key: "orphan",
      status: "cancelled"
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_TARGET",
          path: "/steps/items"
        }),
        expect.objectContaining({
          code: "UNREACHABLE_STEP",
          path: "/steps/done"
        }),
        expect.objectContaining({
          code: "UNREACHABLE_STEP",
          path: "/steps/orphan"
        })
      ])
    );
  });

  it("validates decisions, operands and branch identities", () => {
    const plan = mutablePlan();
    plan.steps.collect = {
      kind: "decision",
      key: "collect",
      branches: [
        {
          id: "same",
          condition: {
            kind: "compare",
            operator: "equals",
            left: { kind: "literal", value: true }
          },
          target: "review"
        },
        {
          id: "same",
          condition: {
            kind: "all",
            conditions: []
          },
          target: "missing"
        }
      ],
      defaultTarget: "review"
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_VALUE",
          path: "/steps/collect/branches/0/condition/right"
        }),
        expect.objectContaining({
          code: "INVALID_STEP",
          path: "/steps/collect/branches/1/id"
        }),
        expect.objectContaining({
          code: "INVALID_VALUE",
          path: "/steps/collect/branches/1/condition/conditions"
        }),
        expect.objectContaining({
          code: "MISSING_TARGET",
          path: "/steps/collect"
        })
      ])
    );
  });

  it("validates safe bindings and step-output references", () => {
    const plan = mutablePlan();
    const call = plan.steps.collect;
    if (call?.kind !== "call") throw new Error("test fixture changed");
    const entries: Record<string, DeepMutable<BindingValue>> = {};
    const forbiddenKey: string = "constructor";
    entries[forbiddenKey] = { kind: "literal", value: "unsafe" };
    entries.output = {
      kind: "reference",
      source: "step_output",
      path: []
    };
    entries.run = {
      kind: "reference",
      source: "run_input",
      path: [],
      stepKey: "collect"
    };
    call.input = {
      kind: "object",
      entries
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/steps/collect/input/entries/constructor"
        }),
        expect.objectContaining({
          path: "/steps/collect/input/entries/output/stepKey"
        }),
        expect.objectContaining({
          path: "/steps/collect/input/entries/run/stepKey"
        })
      ])
    );
  });

  it("rejects duplicate closure identities and unclosed risk sources", () => {
    const plan = mutablePlan();
    plan.artifactClosure.entries.push({ ...node });
    plan.riskSnapshot.push({
      code: "",
      level: "R1",
      source: {
        kind: "policy",
        id: "read-only",
        version: "1.0.0",
        digest: digest("d")
      }
    });

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_ARTIFACT" }),
        expect.objectContaining({
          code: "INVALID_VALUE",
          path: "/riskSnapshot/1/code"
        }),
        expect.objectContaining({
          code: "ARTIFACT_NOT_CLOSED",
          path: "/riskSnapshot/1/source"
        })
      ])
    );
  });

  it("requires a closed assistance profile and failed terminal error code", () => {
    const plan = mutablePlan();
    plan.artifactClosure.entries = [node];
    plan.steps.done = {
      kind: "terminal",
      key: "done",
      status: "failed"
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ARTIFACT_NOT_CLOSED",
          path: "/steps/review/profile"
        }),
        expect.objectContaining({
          code: "INVALID_STEP",
          path: "/steps/done/errorCode"
        })
      ])
    );
  });

  it.each(["parallel", "paginate"] as const)(
    "rejects unsupported %s steps",
    (kind) => {
      const plan = mutablePlan();
      plan.steps.collect = {
        kind,
        key: "collect",
        next: "review"
      } as never;

      expect(executionPlanIssues(plan)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "UNSUPPORTED_STEP_KIND",
            path: "/steps/collect/kind"
          })
        ])
      );
    }
  );

  it("enforces global depth and execution bounds", () => {
    const plan = mutablePlan();
    plan.limits = { maxDepth: 1, maxStepExecutions: 8 };
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    foreach.body.steps.inspect = {
      kind: "foreach",
      key: "inspect",
      items: { kind: "literal", value: [1] },
      itemKey: { path: [], valueType: "number" },
      limits: {
        maxItems: 1,
        maxDurationMs: 1_000,
        maxDepth: 1,
        maxStepExecutions: 1
      },
      onItemError: "stop",
      body: {
        entry: "nested",
        steps: {
          nested: {
            kind: "terminal",
            key: "nested",
            status: "succeeded"
          }
        }
      },
      aggregation: {
        mode: "outcome_summary",
        outputKey: "nested"
      },
      routes: {
        completed: "item-succeeded",
        stopped: "item-failed",
        uncertain: "item-uncertain"
      }
    };

    const issues = executionPlanIssues(plan);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LIMIT_EXCEEDED",
          path: "/limits/maxDepth"
        }),
        expect.objectContaining({
          code: "LIMIT_EXCEEDED",
          path: "/limits/maxStepExecutions"
        })
      ])
    );
  });

  it("enforces foreach stable keys and local limits", () => {
    const plan = mutablePlan();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    foreach.itemKey.path = ["constructor"];
    foreach.limits = {
      maxItems: 0,
      maxDurationMs: 0,
      maxDepth: 1,
      maxStepExecutions: 0
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/steps/items/itemKey/path"
        }),
        expect.objectContaining({
          path: "/steps/items/limits/maxItems"
        }),
        expect.objectContaining({
          path: "/steps/items/limits/maxStepExecutions"
        })
      ])
    );
  });

  it("multiplies local foreach work by maxItems", () => {
    const plan = mutablePlan();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    foreach.limits.maxStepExecutions = 4;

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LIMIT_EXCEEDED",
          path: "/steps/items/limits/maxStepExecutions"
        })
      ])
    );
  });

  it("validates frozen call retry, timing, timeout and exact dependencies", () => {
    const plan = mutablePlan();
    const call = plan.steps.collect;
    if (call?.kind !== "call") throw new Error("test fixture changed");
    call.timeoutMs = 0;
    call.retry.maxAttempts = 0;
    call.retry.retryableOutcomes.push("uncertain" as never);
    call.retry.retryableErrorCodes.push("PAGE_NOT_READY");
    call.retry.backoff.strategy = "random" as never;
    call.retry.backoff.maxDelayMs = 10;
    call.retry.backoff.jitterRatio = 2;
    if (!call.timing.readiness || !call.timing.dispatchJitter) {
      throw new Error("test fixture changed");
    }
    call.timing.readiness.stableForMs =
      call.timing.readiness.timeoutMs + 1;
    call.timing.dispatchJitter.minMs =
      call.timing.dispatchJitter.maxMs + 1;
    call.dependencies.adapters[0] = {
      ...call.dependencies.adapters[0]!,
      digest: digest("9")
    };
    delete (call.routes as Partial<typeof call.routes>).failed;

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/steps/collect/timeoutMs" }),
        expect.objectContaining({
          path: "/steps/collect/retry/maxAttempts"
        }),
        expect.objectContaining({
          path: "/steps/collect/retry/retryableOutcomes/2"
        }),
        expect.objectContaining({
          path: "/steps/collect/retry/retryableErrorCodes/1"
        }),
        expect.objectContaining({
          path: "/steps/collect/retry/backoff/strategy"
        }),
        expect.objectContaining({
          path: "/steps/collect/retry/backoff/maxDelayMs"
        }),
        expect.objectContaining({
          path: "/steps/collect/retry/backoff/jitterRatio"
        }),
        expect.objectContaining({
          path: "/steps/collect/timing/readiness"
        }),
        expect.objectContaining({
          path: "/steps/collect/timing/dispatchJitter"
        }),
        expect.objectContaining({
          code: "ARTIFACT_NOT_CLOSED",
          path: "/steps/collect/dependencies/adapters/0"
        }),
        expect.objectContaining({
          path: "/steps/collect/routes/failed"
        })
      ])
    );
  });

  it("enforces foreach duration, item error, aggregation and uncertain stop", () => {
    const plan = mutablePlan();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    foreach.limits.maxDurationMs = 0;
    foreach.onItemError = "ignore" as never;
    foreach.aggregation.mode = "collect" as never;
    foreach.routes.uncertain = "done";

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/steps/items/limits/maxDurationMs"
        }),
        expect.objectContaining({
          path: "/steps/items/onItemError"
        }),
        expect.objectContaining({
          path: "/steps/items/aggregation/mode"
        }),
        expect.objectContaining({
          code: "INVALID_STEP",
          path: "/steps/items/routes/uncertain"
        })
      ])
    );
  });

  it("defines a fixed succeeded, failed and unresolved aggregation result", () => {
    const result: ForeachAggregationResult = {
      total: 3,
      succeeded: {
        count: 1,
        items: [{ itemKey: "ok", output: { issueCount: 0 } }]
      },
      failed: {
        count: 1,
        items: [
          {
            itemKey: "bad",
            error: { code: "PAGE_INVALID", message: "invalid page" }
          }
        ]
      },
      unresolved: {
        count: 1,
        items: [{ itemKey: "needs-review" }]
      }
    };

    expect(Object.keys(result)).toEqual([
      "total",
      "succeeded",
      "failed",
      "unresolved"
    ]);
  });

  it("normalizes detached assistance with immediate next semantics", () => {
    const plan = mutablePlan();
    plan.steps.review = {
      kind: "wait.assistance",
      key: "review",
      taskKind: "ai_review",
      profile: structuredClone(assistanceProfile),
      deadlineMs: 30_000,
      onUnavailable: "continue_unresolved",
      blocking: false,
      next: "items"
    };

    const normalized = createExecutionPlan(plan);
    const assistance = normalized.steps.review;
    expect(assistance).toEqual(
      expect.objectContaining({ blocking: false, next: "items" })
    );
    expect(
      assistance && "routes" in assistance ? assistance.routes : undefined
    ).toBeUndefined();
  });

  it("rejects blocking/detached assistance semantic overlap", () => {
    const plan = mutablePlan();
    const assistance = plan.steps.review;
    if (
      assistance?.kind !== "wait.assistance" ||
      !assistance.blocking
    ) {
      throw new Error("test fixture changed");
    }
    assistance.deadlineMs = 0;
    assistance.taskKind = "human_action";
    assistance.onUnavailable = "human_action";
    Object.assign(assistance, { next: "items" });

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/steps/review/deadlineMs" }),
        expect.objectContaining({ path: "/steps/review/onUnavailable" }),
        expect.objectContaining({
          code: "INVALID_STEP",
          path: "/steps/review/next"
        })
      ])
    );

    const detachedPlan = mutablePlan();
    detachedPlan.steps.review = {
      kind: "wait.assistance",
      key: "review",
      taskKind: "ai_review",
      profile: structuredClone(assistanceProfile),
      deadlineMs: 30_000,
      onUnavailable: "fail",
      blocking: false,
      next: "items",
      routes: { resolved: "done" }
    } as never;
    expect(executionPlanIssues(detachedPlan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_STEP",
          path: "/steps/review/routes"
        })
      ])
    );
  });

  it("enforces contextual terminal outcomes and the canonical IR version", () => {
    const plan = mutablePlan();
    plan.irVersion = "2.0" as never;
    const done = plan.steps.done;
    if (done?.kind !== "terminal") throw new Error("test fixture changed");
    done.status = "unresolved";
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    const itemTerminal = foreach.body.steps["item-succeeded"];
    if (itemTerminal?.kind !== "terminal") {
      throw new Error("test fixture changed");
    }
    itemTerminal.status = "cancelled";

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/irVersion" }),
        expect.objectContaining({ path: "/steps/done/status" }),
        expect.objectContaining({
          path: "/steps/items/body/steps/item-succeeded/status"
        })
      ])
    );
    expect(() => createExecutionPlan(plan)).toThrow(InvalidExecutionPlanError);
  });

  it("throws a structured error from the constructor", () => {
    const plan = mutablePlan();
    plan.workflow.digest = "not-a-digest";

    expect(() => createExecutionPlan(plan)).toThrow(InvalidExecutionPlanError);
    try {
      createExecutionPlan(plan);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidExecutionPlanError);
      expect((error as InvalidExecutionPlanError).issues[0]).toEqual(
        expect.objectContaining({ path: "/workflow/digest" })
      );
    }
  });
});
