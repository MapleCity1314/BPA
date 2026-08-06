import { describe, expect, it } from "vitest";
import {
  DraftRevisionConflictError,
  InvalidDraftOperationError,
  MemoryWorkflowDraftStore,
  applyDraftOperation,
  applyDraftOperations,
  createWorkflowCandidate,
  createWorkflowDraft,
  diffWorkflowDrafts,
  recipeIssues,
  scoreCatalogEntry,
  searchCatalog,
  validateWorkflowCandidateDraft,
  workflowDraftIssues,
  type CapabilityGap,
  type CatalogEntry,
  type CatalogQuery,
  type DraftOperation,
  type Recipe
} from "./index.js";

const now = "2026-07-28T01:00:00.000Z";

function stepAdd(
  operationId: string,
  key: string,
  nodeRef: string
): Extract<DraftOperation, { type: "step.add" }> {
  return {
    operationId,
    type: "step.add",
    step: { key, nodeRef, config: {}, inputBindings: {} }
  };
}

describe("incremental Workflow Draft", () => {
  it("applies immutable CAS operations and increments one revision per edit", () => {
    const original = createWorkflowDraft({
      draftId: "priority-item-check",
      title: "重点项检查",
      description: "只读检查商品页面",
      now
    });
    const withSteps = applyDraftOperations(
      original,
      0,
      [
        stepAdd(
          "add-context",
          "read-context",
          "doudian.shop.context.read@1.0.0"
        ),
        stepAdd(
          "add-collect",
          "collect-products",
          "doudian.product.scope.collect@1.0.0"
        ),
        {
          operationId: "connect-steps",
          type: "edge.set",
          edge: {
            from: "read-context",
            outcome: "success",
            to: "collect-products"
          }
        }
      ],
      "2026-07-28T01:01:00.000Z"
    );
    expect(original.revision).toBe(0);
    expect(withSteps.revision).toBe(3);
    expect(withSteps.edges).toHaveLength(1);

    const configured = applyDraftOperation(
      withSteps,
      3,
      {
        operationId: "configure-collect",
        type: "step.configure",
        stepKey: "collect-products",
        patch: { config: { reconciliationRounds: 3 } }
      },
      "2026-07-28T01:02:00.000Z"
    );
    expect(configured.steps["collect-products"]?.config).toEqual({
      reconciliationRounds: 3
    });
  });

  it("rejects stale revisions, duplicate operations and unpinned Nodes", () => {
    const draft = createWorkflowDraft({
      draftId: "priority-item-check",
      title: "重点项检查",
      description: "只读检查商品页面",
      now
    });
    const changed = applyDraftOperation(
      draft,
      0,
      stepAdd(
        "add-context",
        "read-context",
        "doudian.shop.context.read@1.0.0"
      ),
      now
    );
    expect(() =>
      applyDraftOperation(
        changed,
        0,
        stepAdd(
          "add-collect",
          "collect-products",
          "doudian.product.scope.collect@1.0.0"
        ),
        now
      )
    ).toThrow(DraftRevisionConflictError);
    expect(() =>
      applyDraftOperation(
        changed,
        1,
        stepAdd(
          "add-context",
          "another-step",
          "doudian.product.scope.collect@1.0.0"
        ),
        now
      )
    ).toThrow(/already applied/);
    expect(() =>
      applyDraftOperation(
        draft,
        0,
        stepAdd(
          "add-unpinned",
          "collect-products",
          "doudian.product.scope.collect@latest"
        ),
        now
      )
    ).toThrow(/exact capability Node SemVer/);
  });

  it("keeps selectors, XPath, coordinates and JavaScript out of Workflow data", () => {
    const draft = createWorkflowDraft({
      draftId: "safe-authoring",
      title: "Safe authoring",
      description: "Only semantic Nodes belong in a Workflow",
      now
    });
    for (const config of [
      { selector: "#save" },
      { xpath: "//button" },
      { coordinates: [10, 20] },
      { action: "javascript:window.save()" }
    ]) {
      expect(() =>
        applyDraftOperation(
          draft,
          0,
          {
            ...stepAdd(
              "unsafe-operation",
              "unsafe-step",
              "platform.product.read@1.0.0"
            ),
            step: {
              ...stepAdd(
                "unsafe-operation",
                "unsafe-step",
                "platform.product.read@1.0.0"
              ).step,
              config
            }
          } as DraftOperation,
          now
        )
      ).toThrow(/Workflow cannot contain/);
    }
  });

  it("records and resolves a CapabilityGap before creating a Candidate", () => {
    const gap: CapabilityGap = {
      gapId: "product-inspection",
      capabilityId: "doudian.product.inspect",
      summary: "Published inspection Node is missing",
      platform: "doudian",
      requiredInputs: ["product-ref"],
      requiredOutputs: ["issue-list"],
      maximumRisk: "R0",
      status: "open"
    };
    const base = createWorkflowDraft({
      draftId: "priority-item-check",
      title: "重点项检查",
      description: "只读检查商品页面",
      now
    });
    const withGap = applyDraftOperations(
      base,
      0,
      [
        stepAdd(
          "add-inspect",
          "inspect-product",
          "doudian.editor.priority-items.inspect@1.0.0"
        ),
        {
          operationId: "add-test",
          type: "test.add",
          test: {
            testId: "healthy-product",
            title: "健康商品没有问题",
            scenario: "success",
            input: { productId: "100" },
            expected: { issues: [] }
          }
        },
        {
          operationId: "record-gap",
          type: "gap.record",
          gap
        }
      ],
      now
    );
    expect(() =>
      createWorkflowCandidate(withGap, 3, {
        candidateId: "priority-item-check-v1",
        now
      })
    ).toThrow(InvalidDraftOperationError);

    const resolved = applyDraftOperation(
      withGap,
      3,
      {
        operationId: "resolve-gap",
        type: "gap.resolve",
        gapId: "product-inspection",
        resolution: {
          kind: "catalog-entry",
          reference: "doudian.editor.priority-items.inspect@1.0.0",
          resolvedAt: now
        }
      },
      now
    );
    const candidate = createWorkflowCandidate(resolved, 4, {
      candidateId: "priority-item-check-v1",
      now
    });
    expect(candidate).toMatchObject({
      sourceRevision: 4,
      status: "candidate"
    });
    expect(candidate.content.steps).not.toBe(resolved.steps);
  });

  it("does not remove a step while an edge still references it", () => {
    const draft = applyDraftOperations(
      createWorkflowDraft({
        draftId: "edge-safety",
        title: "Edge safety",
        description: "Reject dangling edges",
        now
      }),
      0,
      [
        stepAdd("add-a", "step-a", "platform.first.read@1.0.0"),
        stepAdd("add-b", "step-b", "platform.second.read@1.0.0"),
        {
          operationId: "edge-a-b",
          type: "edge.set",
          edge: { from: "step-a", outcome: "success", to: "step-b" }
        }
      ],
      now
    );
    expect(() =>
      applyDraftOperation(
        draft,
        3,
        { operationId: "remove-b", type: "step.remove", stepKey: "step-b" },
        now
      )
    ).toThrow(/still referenced/);
  });

  it("rejects arbitrary graph cycles when saving a Candidate", () => {
    const draft = applyDraftOperations(
      createWorkflowDraft({
        draftId: "cycle-safety",
        title: "Cycle safety",
        description: "Use structured iterations instead of graph back edges",
        now
      }),
      0,
      [
        stepAdd("cycle-add-a", "step-a", "platform.first.read@1.0.0"),
        stepAdd("cycle-add-b", "step-b", "platform.second.read@1.0.0"),
        {
          operationId: "cycle-edge-a-b",
          type: "edge.set",
          edge: { from: "step-a", outcome: "success", to: "step-b" }
        },
        {
          operationId: "cycle-edge-b-a",
          type: "edge.set",
          edge: { from: "step-b", outcome: "success", to: "step-a" }
        },
        {
          operationId: "cycle-test",
          type: "test.add",
          test: {
            testId: "cycle-test",
            title: "Cycle is invalid",
            scenario: "business",
            input: {},
            expected: {}
          }
        }
      ],
      now
    );
    expect(() =>
      createWorkflowCandidate(draft, 5, {
        candidateId: "cycle-candidate",
        now
      })
    ).toThrow(/structured bounded iteration/);
  });

  it("supports metadata, edge, test and step removal operations", () => {
    const base = applyDraftOperations(
      createWorkflowDraft({
        draftId: "operation-coverage",
        title: "Operations",
        description: "Exercise reversible draft edits",
        now
      }),
      0,
      [
        stepAdd("operations-add-a", "step-a", "platform.first.read@1.0.0"),
        stepAdd("operations-add-b", "step-b", "platform.second.read@1.0.0"),
        {
          operationId: "operations-edge",
          type: "edge.set",
          edge: { from: "step-a", outcome: "success", to: "step-b" }
        },
        {
          operationId: "operations-test",
          type: "test.add",
          test: {
            testId: "operations-test",
            title: "Operations work",
            scenario: "success",
            input: [],
            expected: null
          }
        },
        {
          operationId: "operations-metadata",
          type: "metadata.update",
          patch: { title: "Updated operations" }
        },
        {
          operationId: "operations-bindings",
          type: "step.configure",
          stepKey: "step-a",
          patch: { inputBindings: { product: "${input.product}" } }
        }
      ],
      now
    );
    const removed = applyDraftOperations(
      base,
      6,
      [
        {
          operationId: "operations-edge-remove",
          type: "edge.remove",
          from: "step-a",
          outcome: "success"
        },
        {
          operationId: "operations-step-remove",
          type: "step.remove",
          stepKey: "step-b"
        },
        {
          operationId: "operations-test-remove",
          type: "test.remove",
          testId: "operations-test"
        }
      ],
      now
    );
    expect(removed).toMatchObject({
      revision: 9,
      title: "Updated operations",
      edges: [],
      tests: {}
    });
    expect(removed.steps["step-a"]?.inputBindings).toEqual({
      product: "${input.product}"
    });
  });

  it("fails closed for malformed or conflicting incremental operations", () => {
    const empty = createWorkflowDraft({
      draftId: "operation-errors",
      title: "Operation errors",
      description: "Validate every CAS mutation",
      now
    });
    expect(applyDraftOperations(empty, 0, [], now)).toEqual(empty);
    expect(() => applyDraftOperations(empty, 1, [], now)).toThrow(
      DraftRevisionConflictError
    );
    expect(() =>
      createWorkflowDraft({
        draftId: "operation-errors-two",
        title: "",
        description: "Invalid",
        now
      })
    ).toThrow(/title/);
    for (const operation of [
      {
        operationId: "empty-metadata",
        type: "metadata.update",
        patch: {}
      },
      {
        operationId: "blank-metadata",
        type: "metadata.update",
        patch: { title: "" }
      },
      {
        operationId: "missing-configure",
        type: "step.configure",
        stepKey: "missing",
        patch: { config: {} }
      },
      {
        operationId: "missing-edge-remove",
        type: "edge.remove",
        from: "missing",
        outcome: "success"
      },
      {
        operationId: "missing-test-remove",
        type: "test.remove",
        testId: "missing"
      }
    ] as DraftOperation[]) {
      expect(() => applyDraftOperation(empty, 0, operation, now)).toThrow();
    }

    const withStep = applyDraftOperation(
      empty,
      0,
      stepAdd("error-add-step", "step-a", "platform.first.read@1.0.0"),
      now
    );
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "empty-configure",
          type: "step.configure",
          stepKey: "step-a",
          patch: {}
        },
        now
      )
    ).toThrow(/patch cannot be empty/i);
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "self-edge",
          type: "edge.set",
          edge: { from: "step-a", outcome: "success", to: "step-a" }
        },
        now
      )
    ).toThrow(/self-loop/);
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "invalid-test-title",
          type: "test.add",
          test: {
            testId: "bad-test",
            title: "",
            scenario: "failure",
            input: {},
            expected: {}
          }
        },
        now
      )
    ).toThrow(/title/);
    expect(() =>
      createWorkflowCandidate(withStep, 0, {
        candidateId: "stale-candidate",
        now
      })
    ).toThrow(DraftRevisionConflictError);
  });

  it("validates CapabilityGap state and resolution transitions", () => {
    const draft = createWorkflowDraft({
      draftId: "gap-errors",
      title: "Gap errors",
      description: "Validate gap lifecycle",
      now
    });
    const invalidGaps: CapabilityGap[] = [
      {
        gapId: "blank-summary",
        capabilityId: "product.inspect",
        summary: "",
        requiredInputs: [],
        requiredOutputs: [],
        maximumRisk: "R0",
        status: "open"
      },
      {
        gapId: "open-with-resolution",
        capabilityId: "product.inspect",
        summary: "Invalid open state",
        requiredInputs: [],
        requiredOutputs: [],
        maximumRisk: "R0",
        status: "open",
        resolution: {
          kind: "candidate",
          reference: "candidate-a",
          resolvedAt: now
        }
      },
      {
        gapId: "resolved-without-resolution",
        capabilityId: "product.inspect",
        summary: "Invalid resolved state",
        requiredInputs: [],
        requiredOutputs: [],
        maximumRisk: "R0",
        status: "resolved"
      }
    ];
    for (const [index, gap] of invalidGaps.entries()) {
      expect(() =>
        applyDraftOperation(
          draft,
          0,
          {
            operationId: `invalid-gap-${index}`,
            type: "gap.record",
            gap
          },
          now
        )
      ).toThrow();
    }
  });

  it("reports tampered Draft graph and test invariants", () => {
    const draft = createWorkflowDraft({
      draftId: "tampered-draft",
      title: "Tampered draft",
      description: "Persistence validation remains fail-closed",
      now
    });
    draft.steps["bad-step"] = {
      key: "bad-step",
      nodeRef: "platform.read@latest",
      config: {},
      inputBindings: {}
    };
    draft.edges.push({
      from: "bad-step",
      outcome: "success",
      to: "missing-step"
    });
    expect(workflowDraftIssues(draft)).toEqual(
      expect.arrayContaining([
        "Step bad-step does not pin an exact Node SemVer",
        "Edge bad-step:success->missing-step references a missing step",
        "Draft must contain at least one test"
      ])
    );
    expect(
      workflowDraftIssues({ ...draft, steps: {}, edges: [] })
    ).toContain("Draft must contain at least one step");
  });
});

describe("typed incremental Draft authoring", () => {
  it("upserts a step, sets one binding, and freezes exception policy by CAS", () => {
    const base = createWorkflowDraft({
      draftId: "typed-edits",
      title: "Typed edits",
      description: "Small authoring operations",
      now
    });
    const added = applyDraftOperation(
      base,
      0,
      {
        operationId: "upsert-inspect",
        type: "step.add-or-replace",
        step: {
          key: "inspect",
          nodeRef: "doudian.editor.priority-items.inspect@1.0.0",
          config: {},
          inputBindings: {}
        }
      },
      now
    );
    const replaced = applyDraftOperation(
      added,
      1,
      {
        operationId: "replace-inspect",
        type: "step.add-or-replace",
        step: {
          key: "inspect",
          nodeRef: "doudian.editor.priority-items.inspect@1.1.0",
          config: { platformFillCheck: false },
          inputBindings: {}
        }
      },
      now
    );
    const bound = applyDraftOperation(
      replaced,
      2,
      {
        operationId: "bind-product",
        type: "binding.set",
        stepKey: "inspect",
        bindingKey: "product",
        value: "${item}"
      },
      now
    );
    const policy = applyDraftOperation(
      bound,
      3,
      {
        operationId: "set-exception-policy",
        type: "exception-policy.set",
        stepKey: "inspect",
        policy: {
          failure: "collect",
          timeout: "collect",
          cancelled: "fail",
          uncertain: "stop_uncertain"
        }
      },
      now
    );

    expect(base.steps).toEqual({});
    expect(policy).toMatchObject({
      revision: 4,
      steps: {
        inspect: {
          nodeRef: "doudian.editor.priority-items.inspect@1.1.0",
          inputBindings: { product: "${item}" },
          exceptionPolicy: {
            failure: "collect",
            uncertain: "stop_uncertain"
          }
        }
      }
    });
  });

  it("validates candidates and produces bounded semantic Draft diffs", () => {
    const before = createWorkflowDraft({
      draftId: "candidate-diff",
      title: "Candidate diff",
      description: "Diff small edits",
      now
    });
    const after = applyDraftOperation(
      before,
      0,
      stepAdd(
        "add-inspect-for-diff",
        "inspect",
        "doudian.editor.priority-items.inspect@1.0.0"
      ),
      now
    );
    expect(validateWorkflowCandidateDraft(after, 1)).toEqual({
      draftId: "candidate-diff",
      revision: 1,
      valid: false,
      issues: ["Draft must contain at least one test"]
    });
    const diff = diffWorkflowDrafts(before, after);
    expect(diff).toMatchObject({
      draftId: "candidate-diff",
      fromRevision: 0,
      toRevision: 1,
      truncated: false
    });
    expect(diff.changes).toEqual([
      expect.objectContaining({
        path: "/steps/inspect",
        kind: "added"
      })
    ]);
    expect(diffWorkflowDrafts(before, after, 1).truncated).toBe(false);
    expect(() =>
      diffWorkflowDrafts(
        before,
        { ...after, draftId: "another-draft" },
        200
      )
    ).toThrow(/same draftId/);
  });

  it("provides clone-safe create/get/apply semantics in the reference CAS store", () => {
    const store = new MemoryWorkflowDraftStore();
    const created = store.create({
      draftId: "stored-draft",
      title: "Stored",
      description: "Reference CAS store",
      now
    });
    created.title = "caller mutation";
    expect(store.get("stored-draft")?.title).toBe("Stored");
    const changed = store.apply(
      "stored-draft",
      0,
      stepAdd(
        "store-add-step",
        "inspect",
        "doudian.editor.priority-items.inspect@1.0.0"
      ),
      now
    );
    expect(changed.revision).toBe(1);
    expect(() =>
      store.apply(
        "stored-draft",
        0,
        stepAdd(
          "stale-store-step",
          "collect",
          "doudian.product.scope.collect@1.0.0"
        ),
        now
      )
    ).toThrow(DraftRevisionConflictError);
    expect(() =>
      store.create({
        draftId: "stored-draft",
        title: "Duplicate",
        description: "Duplicate",
        now
      })
    ).toThrow(/already exists/);
    expect(store.get("missing-draft")).toBeUndefined();
  });

  it("rejects unsafe bindings and malformed exception policies", () => {
    const withStep = applyDraftOperation(
      createWorkflowDraft({
        draftId: "typed-errors",
        title: "Typed errors",
        description: "Reject malformed typed edits",
        now
      }),
      0,
      stepAdd(
        "typed-errors-step",
        "inspect",
        "doudian.editor.priority-items.inspect@1.0.0"
      ),
      now
    );
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "unsafe-binding",
          type: "binding.set",
          stepKey: "inspect",
          bindingKey: "target",
          value: { selector: "#save" } as never
        },
        now
      )
    ).toThrow(/locator or executable/);
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "invalid-exception-policy",
          type: "exception-policy.set",
          stepKey: "inspect",
          policy: {
            failure: "collect",
            timeout: "collect",
            cancelled: "fail",
            uncertain: "fail"
          } as never
        },
        now
      )
    ).toThrow(/Invalid exception policy/);
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "legacy-rejected-policy",
          type: "exception-policy.set",
          stepKey: "inspect",
          policy: {
            failure: "collect",
            timeout: "collect",
            rejected: "fail",
            cancelled: "fail",
            uncertain: "stop_uncertain"
          }
        } as never,
        now
      )
    ).toThrow(/must define exactly failure, timeout, cancelled, and uncertain/);
    expect(() =>
      applyDraftOperation(
        withStep,
        1,
        {
          operationId: "legacy-rejected-edge",
          type: "edge.set",
          edge: {
            from: "inspect",
            outcome: "rejected",
            to: "inspect"
          }
        } as never,
        now
      )
    ).toThrow(/Invalid Draft edge outcome: rejected/);

    const legacyDraft = structuredClone(withStep);
    legacyDraft.steps.inspect!.exceptionPolicy = {
      failure: "collect",
      timeout: "collect",
      rejected: "fail",
      cancelled: "fail",
      uncertain: "stop_uncertain"
    } as never;
    legacyDraft.edges = [
      {
        from: "inspect",
        outcome: "rejected",
        to: "inspect"
      } as never
    ];
    expect(validateWorkflowCandidateDraft(legacyDraft, 1)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.stringContaining("invalid exception policy"),
        expect.stringContaining("rejected has an invalid outcome")
      ])
    });
  });
});

const inspectEntry: CatalogEntry = {
  kind: "node",
  id: "doudian.editor.priority-items.inspect",
  version: "1.0.0",
  title: "Inspect priority items",
  capabilityIds: ["product.inspect", "issue.collect"],
  aliases: ["priority-item-check"],
  platforms: ["doudian"],
  runtime: "browser",
  inputTypes: ["product-ref"],
  outputTypes: ["issue-list"],
  riskLevel: "R0",
  permissions: ["browser.dom.read"],
  adapter: { id: "doudian", version: "2.0.0" },
  verifiedAt: now
};

const query: CatalogQuery = {
  capabilityIds: ["product.inspect"],
  platform: "doudian",
  runtime: "browser",
  availableInputTypes: ["product-ref", "packaging-match"],
  requiredOutputTypes: ["issue-list"],
  maximumRisk: "R0",
  allowedPermissions: ["browser.dom.read"],
  adapter: { id: "doudian", version: "2.0.0" }
};

describe("Catalog v2 domain scoring", () => {
  it("scores capability, platform, IO, risk, permission and Adapter version", () => {
    const result = scoreCatalogEntry(query, inspectEntry);
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.components).toMatchObject({
      capability: 1,
      platform: 1,
      input: 1,
      output: 1,
      permission: 1,
      adapter: 1
    });
  });

  it("excludes entries with excessive risk, permission or Adapter drift", () => {
    const unsafe: CatalogEntry = {
      ...inspectEntry,
      id: "doudian.product.publish",
      riskLevel: "R3",
      permissions: ["browser.dom.write"],
      adapter: { id: "doudian", version: "3.0.0" }
    };
    const result = scoreCatalogEntry(query, unsafe);
    expect(result.eligible).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "risk R3 exceeds maximum R0",
        "entry requires permissions outside the allowed set",
        "adapter version does not match"
      ])
    );
    expect(searchCatalog(query, [unsafe, inspectEntry])).toHaveLength(1);
  });

  it("uses aliases for capability discovery and deterministic tie-breaking", () => {
    const aliasQuery = { ...query, capabilityIds: ["priority-item-check"] };
    const alternate = {
      ...inspectEntry,
      id: "doudian.editor.alternate-inspect"
    };
    expect(
      searchCatalog(aliasQuery, [inspectEntry, alternate]).map(
        (result) => result.entry.id
      )
    ).toEqual([
      "doudian.editor.alternate-inspect",
      "doudian.editor.priority-items.inspect"
    ]);
    expect(
      searchCatalog(
        { ...query, capabilityIds: ["capability.does-not-exist"] },
        [inspectEntry]
      )
    ).toEqual([]);
  });

  it("explains runtime, platform and IO incompatibilities", () => {
    const incompatible = scoreCatalogEntry(
      query,
      {
        ...inspectEntry,
        runtime: "team",
        platforms: ["other"],
        inputTypes: ["unknown-input"],
        outputTypes: ["unknown-output"],
        capabilityIds: ["unknown-capability"],
        aliases: []
      }
    );
    expect(incompatible.eligible).toBe(false);
    expect(incompatible.reasons).toEqual(
      expect.arrayContaining([
        "runtime team does not match browser",
        "platform doudian is not supported",
        "required input types are unavailable",
        "required output types are not produced",
        "no requested capability matched"
      ])
    );

    const broadQuery: CatalogQuery = {
      capabilityIds: [],
      availableInputTypes: ["product-ref"],
      requiredOutputTypes: [],
      maximumRisk: "R4",
      allowedPermissions: ["browser.dom.read"]
    };
    expect(scoreCatalogEntry(broadQuery, inspectEntry)).toMatchObject({
      eligible: true,
      components: {
        capability: 1,
        platform: 1,
        output: 1,
        adapter: 1
      }
    });
  });
});

describe("Recipe model", () => {
  it("requires exact capability and Adapter versions", () => {
    const recipe: Recipe = {
      recipeId: "priority-item-check",
      version: "1.0.0",
      title: "Priority item check",
      capabilityIds: ["product.inspect"],
      platforms: ["doudian"],
      inputTypes: ["product-ref"],
      outputTypes: ["issue-list"],
      riskLevel: "R0",
      permissions: ["browser.dom.read"],
      adapterRefs: ["doudian@2.0.0"],
      steps: [
        {
          key: "inspect-product",
          capabilityRef: "doudian.editor.priority-items.inspect@1.0.0",
          inputBindings: {}
        }
      ]
    };
    expect(recipeIssues(recipe)).toEqual([]);
    expect(
      recipeIssues({
        ...recipe,
        adapterRefs: ["doudian@latest"]
      })
    ).toEqual([
      "Recipe adapter reference must pin SemVer: doudian@latest"
    ]);
  });

  it("reports malformed identity, steps and duplicate step keys", () => {
    const invalid: Recipe = {
      recipeId: "Invalid Recipe",
      version: "latest",
      title: "",
      capabilityIds: [],
      platforms: [],
      inputTypes: [],
      outputTypes: [],
      riskLevel: "R0",
      permissions: [],
      adapterRefs: [],
      steps: [
        { key: "Bad Step", capabilityRef: "node@latest", inputBindings: {} },
        { key: "Bad Step", capabilityRef: "node@latest", inputBindings: {} }
      ]
    };
    expect(recipeIssues(invalid)).toEqual(
      expect.arrayContaining([
        "Recipe requires a stable ID, exact SemVer, and title",
        "Recipe step key is duplicated: Bad Step"
      ])
    );
  });
});
