import { describe, expect, it } from "vitest";
import {
  appendScope,
  createExecutionIdentity,
  createExecutionPlan,
  estimateMaxDepth,
  estimateMaxStepExecutions,
  executionIdentityKey,
  executionPlanIssues,
  InvalidExecutionPlanError,
  normalizeExecutionPlan,
  type ArtifactRef,
  type BindingValue,
  type ExecutionPlan
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

function validPlan(): ExecutionPlan {
  return {
    irVersion: "2.0",
    workflow: {
      id: "priority-check",
      version: "1.0.0",
      digest: digest("c")
    },
    artifactClosure: {
      entries: [assistanceProfile, node]
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
        kind: "call",
        key: "collect",
        node,
        input: {
          kind: "object",
          entries: {
            shopId: {
              kind: "reference",
              source: "run_input",
              path: ["shopId"]
            }
          }
        },
        next: "review"
      },
      review: {
        kind: "wait.assistance",
        key: "review",
        taskKind: "ai_review",
        profile: assistanceProfile,
        onResolved: "items"
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
          maxDepth: 1,
          maxStepExecutions: 5
        },
        body: {
          entry: "inspect",
          steps: {
            inspect: {
              kind: "call",
              key: "inspect",
              node
            }
          }
        },
        aggregation: {
          mode: "collect",
          outputKey: "inspectionResults",
          include: "all"
        },
        next: "done"
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
  it("normalizes deterministically without changing branch order", () => {
    const input = validPlan();
    const normalized = normalizeExecutionPlan(input);

    expect(Object.keys(normalized.steps)).toEqual([
      "collect",
      "done",
      "items",
      "review"
    ]);
    expect(normalized.artifactClosure.entries.map((entry) => entry.kind)).toEqual([
      "assistance_profile",
      "node"
    ]);
    expect(input.steps).not.toBe(normalized.steps);
    expect(normalizeExecutionPlan(normalized)).toEqual(normalized);
  });

  it("constructs a valid closed plan and estimates bounded work", () => {
    const plan = createExecutionPlan(validPlan());
    expect(executionPlanIssues(plan)).toEqual([]);
    expect(estimateMaxDepth(plan)).toBe(1);
    // Four top-level steps plus five possible body calls.
    expect(estimateMaxStepExecutions(plan)).toBe(9n);
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
  });

  it("rejects arbitrary back edges", () => {
    const plan = mutablePlan();
    plan.steps.done = {
      kind: "call",
      key: "done",
      node,
      next: "collect"
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BACK_EDGE" })
      ])
    );
  });

  it("requires explicit top-level terminals and reports unreachable steps", () => {
    const plan = mutablePlan();
    const foreach = plan.steps.items;
    if (foreach?.kind !== "foreach") throw new Error("test fixture changed");
    delete foreach.next;
    plan.steps.orphan = {
      kind: "terminal",
      key: "orphan",
      status: "cancelled"
    };

    expect(executionPlanIssues(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_STEP",
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
        maxDepth: 1,
        maxStepExecutions: 1
      },
      body: {
        entry: "nested",
        steps: {
          nested: {
            kind: "call",
            key: "nested",
            node
          }
        }
      },
      aggregation: {
        mode: "collect",
        outputKey: "nested",
        include: "succeeded"
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
