import { readdirSync, readFileSync } from "node:fs";
import {
  compileWorkflowV1Alpha2,
  contentDigest,
  parseWorkflowYaml,
  type CatalogResolver
} from "@bpa/compiler";
import {
  DeterministicWorkflowEngine,
  type EngineDependencies,
  type EngineTransition
} from "@bpa/engine";
import {
  formatValidationErrors,
  validateAssistanceProfile,
  validateNode,
  validateNodeV1Alpha2,
  validateWorkflowV1Alpha2,
  type AssistanceProfileDefinition,
  type NodeDefinition,
  type NodeDefinitionV1Alpha2
} from "@bpa/schemas";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

function loadAsset(path: string): unknown {
  const source = readFileSync(new URL(path, root), "utf8");
  return path.endsWith(".json")
    ? JSON.parse(source)
    : parseWorkflowYaml(source);
}

function catalog(): CatalogResolver {
  const nodes = new Map(
    readdirSync(new URL("nodes/core/", root))
      .filter((name) => name.endsWith(".node.yaml"))
      .map((name) => {
        const node = loadAsset(`nodes/core/${name}`) as
          | NodeDefinition
          | NodeDefinitionV1Alpha2;
        const validator =
          node.apiVersion === "bpa/v1alpha2"
            ? validateNodeV1Alpha2
            : validateNode;
        if (!validator(node)) {
          throw new Error(
            `${name}: ${formatValidationErrors(validator.errors).join("; ")}`
          );
        }
        return [
          `${node.metadata.id}@${node.metadata.version}`,
          node
        ] as const;
      })
  );
  const doudianAdapter: ArtifactRef & { kind: "adapter" } = {
    kind: "adapter",
    id: "doudian",
    version: "1.2.0",
    digest: `sha256:${"a".repeat(64)}`
  };
  const packagingProfile: ArtifactRef & { kind: "dataset_profile" } = {
    kind: "dataset_profile",
    id: "packaging-master-v1",
    version: "1.0.0",
    digest: `sha256:${"b".repeat(64)}`
  };
  const assistanceProfiles = new Map(
    [
      "core/packaging_match_review.assistance-profile.json",
      "core/binding_confirm.assistance-profile.yaml"
    ].map((name) => {
      const profile = loadAsset(
        `assistance-profiles/${name}`
      ) as AssistanceProfileDefinition;
      if (!validateAssistanceProfile(profile)) {
        throw new Error(
          `${name}: ${formatValidationErrors(
            validateAssistanceProfile.errors
          ).join("; ")}`
        );
      }
      return [
        `${profile.metadata.id}@${profile.metadata.version}`,
        profile
      ] as const;
    })
  );
  return {
    getNode: (id, version) => nodes.get(`${id}@${version}`),
    getNodeExecution: (id, version) => {
      const node = nodes.get(`${id}@${version}`);
      if (!node) return undefined;
      return {
        providerId:
          id === "dataset.records.read"
            ? "dataset"
            : node.runtime.replace(/^engine_/, ""),
        adapters: node.runtime === "browser" ? [doudianAdapter] : [],
        policies: [],
        datasetProfiles:
          id === "dataset.records.read" ? [packagingProfile] : []
      };
    },
    getAssistanceProfile: (id, version) => {
      const profile = assistanceProfiles.get(`${id}@${version}`);
      return profile
        ? {
            artifact: {
              kind: "assistance_profile",
              id,
              version,
              digest: contentDigest(profile)
            },
            taskKind: profile.taskKind
          }
        : undefined;
    }
  };
}

function compilePriorityWorkflow() {
  const workflow = loadAsset(
    "workflows/examples/doudian.priority-items-readonly-inspect.workflow.yaml"
  );
  expect(
    validateWorkflowV1Alpha2(workflow),
    formatValidationErrors(validateWorkflowV1Alpha2.errors).join("; ")
  ).toBe(true);
  return compileWorkflowV1Alpha2(workflow, catalog());
}

function dependencies(): EngineDependencies {
  let sequence = 0;
  return {
    clock: { now: () => 1_000 },
    ids: { next: (kind) => `${kind}-${++sequence}` },
    random: { next: () => 0.5 }
  };
}

function succeeded(output: JsonValue) {
  return {
    status: "succeeded" as const,
    output,
    evidence: [],
    riskSignals: []
  };
}

describe("priority-items readonly workflow asset", () => {
  it("keeps every legacy Browser Node identity immutable beside the new closure", () => {
    for (const [path, expectedDigest] of [
      [
        "nodes/core/doudian.shop.context.read.node.yaml",
        "sha256:7c29706f4ad7c3b7c66c2829749878e26794b1857236e49b5e8c2aec39716708"
      ],
      [
        "nodes/core/doudian.product.scope.collect.node.yaml",
        "sha256:e8cabcb29dffb5b3961773ab0b4061a43d2c8c6b6521d826448ebfabb42cc91b"
      ],
      [
        "nodes/core/doudian.product.editor.open.node.yaml",
        "sha256:7baf05b6613e6a2d0acf1d9c9404178c0725ff3bdeb07eff78ea13d986c423c7"
      ],
      [
        "nodes/core/doudian.editor.priority-items.inspect.node.yaml",
        "sha256:fce76c2d447adbc09600bb787ba9d920ea5bb0a2011fd4a6e0e4a1312a9aec6d"
      ]
    ] as const) {
      expect(contentDigest(loadAsset(path)), path).toBe(expectedDigest);
    }
    const assets = catalog();
    expect(
      assets.getNode("doudian.product.scope.collect", "1.0.0")
    ).toBeDefined();
    expect(
      assets.getNode("doudian.product.scope.collect", "1.1.0")
    ).toBeDefined();
  });

  it("compiles into a closed IR2 plan with stable foreach aggregation", () => {
    const plan = compilePriorityWorkflow();
    expect(plan.steps.shop_identity_uncertain).toMatchObject({
      kind: "terminal",
      status: "uncertain",
      errorCode: "SHOP_IDENTITY_UNCONFIRMED"
    });
    expect(plan.workflow).toMatchObject({
      id: "doudian.priority-items-readonly-inspect",
      version: "0.3.0"
    });
    expect(plan.workflow.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.entry).toBe("read_shop");
    expect(plan.steps.shop_identity_gate).toMatchObject({
      kind: "decision",
      branches: [{ target: "shop_identity_confirmed" }],
      defaultTarget: "shop_identity_uncertain"
    });
    expect(plan.artifactClosure.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dataset_profile",
          id: "packaging-master-v1"
        }),
        expect.objectContaining({ kind: "adapter", id: "doudian" }),
        expect.objectContaining({
          kind: "node",
          id: "dataset.records.read"
        }),
        expect.objectContaining({
          kind: "node",
          id: "packaging.products.normalize"
        }),
        expect.objectContaining({
          kind: "node",
          id: "doudian.product.scope.restore",
          version: "1.0.0"
        }),
        expect.objectContaining({
          kind: "assistance_profile",
          id: "packaging_match_review"
        }),
        expect.objectContaining({
          kind: "assistance_profile",
          id: "binding_confirm"
        })
      ])
    );
    const inspect = Object.values(plan.steps).find(
      (step) => step.key === "inspect_products"
    );
    expect(inspect).toMatchObject({
      kind: "foreach",
      itemKey: { path: ["product", "id"], valueType: "string" },
      onItemError: "collect",
      aggregation: { mode: "outcome_summary" }
    });
    if (inspect?.kind !== "foreach") throw new Error("fixture changed");
    expect(inspect.body.entry).toBe("open_editor");
    expect(inspect.body.steps.open_editor).toMatchObject({
      kind: "call",
      routes: { succeeded: "inspect_priority" }
    });
    expect(inspect.routes.completed).toBe("reconcile_issues");
    expect(plan.steps.ambiguity_tasks).toMatchObject({
      kind: "decision",
      branches: [{ target: "review_ambiguities" }],
      defaultTarget: "no_ambiguities"
    });
    expect(plan.steps.review_ambiguities).toMatchObject({
      kind: "wait.assistance",
      taskKind: "ai_review",
      blocking: false,
      input: {
        kind: "reference",
        source: "step_output",
        stepKey: "match_packaging",
        path: ["ambiguityReview"]
      },
      next: "confirm_bindings"
    });
    expect(plan.steps.confirm_bindings).toMatchObject({
      kind: "wait.assistance",
      taskKind: "human_confirm",
      blocking: false,
      next: "inspect_products"
    });
    const reconcile = plan.steps.reconcile_issues;
    expect(reconcile).toMatchObject({
      kind: "call",
      input: {
        kind: "object",
        entries: {
          foreachOutcome: {
            kind: "reference",
            source: "step_output",
            stepKey: "inspect_products"
          }
        }
      }
    });
    expect(plan.steps.build_report).toMatchObject({
      kind: "call",
      routes: { succeeded: "restore_scope" }
    });
    expect(plan.steps.restore_scope).toMatchObject({
      kind: "call",
      node: {
        id: "doudian.product.scope.restore",
        version: "1.0.0"
      },
      routes: { succeeded: "completed" }
    });
  });

  it("stops before collection when the page has no stable shop identity", () => {
    const plan = compilePriorityWorkflow();
    const engine = new DeterministicWorkflowEngine(plan, dependencies());
    const started = engine.start("run-unconfirmed-shop", {
      dataset: { id: "packaging-master", version: "2026.07.28" },
      platformFillCheck: false
    });
    const active = started.state.active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    const stopped = engine.acceptRuntimeOutcome({
      state: started.state,
      invocationId: active.invocation.invocationId,
      fencingToken: active.invocation.fencingToken,
      outcome: succeeded({
        supported: true,
        shop: {
          id: "name:temporary",
          name: "未确认店铺",
          identity_confirmed: false
        },
        tab_ref: {
          browser_instance_id: "browser-1",
          tab_id: 1,
          window_id: 1,
          origin: "https://fxg.jinritemai.com"
        },
        page_epoch: "epoch-1"
      })
    });
    expect(stopped.state.status).toBe("uncertain");
    expect(stopped.effects).toEqual([]);
  });

  it("executes unmatched products through open, inspect, reconcile and report bindings", () => {
    const plan = compilePriorityWorkflow();
    expect(contentDigest(plan)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const engine = new DeterministicWorkflowEngine(plan, dependencies());
    let transition = engine.start("run-priority", {
      dataset: { id: "packaging-master", version: "2026.07.28" },
      platformFillCheck: false
    });
    const complete = (
      nodeId: string,
      output: JsonValue,
      inspectInput?: (input: JsonValue) => void
    ): void => {
      const active = transition.state.active;
      if (active?.kind !== "call") {
        throw new Error(`Expected active call ${nodeId}`);
      }
      expect(active.invocation.node.id).toBe(nodeId);
      inspectInput?.(active.invocation.input);
      transition = engine.acceptRuntimeOutcome({
        state: transition.state,
        invocationId: active.invocation.invocationId,
        fencingToken: active.invocation.fencingToken,
        outcome: succeeded(output)
      });
    };

    const editorUrl =
      "https://fxg.jinritemai.com/ffa/g/create?product_id=10001";
    const collectedProduct = {
      id: "10001",
      title: "无包装主数据匹配的健康商品",
      editorUrl
    };
    complete("doudian.shop.context.read", {
      supported: true,
      shop: { id: "shop-1", name: "测试店", identity_confirmed: true },
      tab_ref: {
        browser_instance_id: "browser-1",
        tab_id: 1,
        window_id: 1,
        origin: "https://fxg.jinritemai.com"
      },
      page_epoch: "epoch-1"
    });
    complete("control.noop", { status: "confirmed" });
    complete("doudian.product.scope.collect", {
      status: "complete",
      collectorVersion: "1.1.0",
      fingerprint: {
        shopId: "shop-1",
        shopName: "测试店",
        filters: {},
        statusTab: { id: "selling", label: "售卖中" },
        digest: "abcdef12"
      },
      expectedCount: 1,
      scanRounds: 1,
      products: [collectedProduct],
      inspectionQueue: [collectedProduct],
      restore: {
        listUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0",
        page: 1,
        scrollTop: 0,
        shopId: "shop-1",
        shopName: "测试店",
        scopeDigest: "abcdef12",
        required: true
      },
      diagnostics: []
    });
    complete(
      "dataset.records.read",
      {
        dataset: {
          id: "packaging-master",
          version: "2026.07.28",
          recordsDigest: `sha256:${"c".repeat(64)}`,
          recordCount: 0
        },
        records: [],
        hasMore: false
      },
      (input) =>
        expect(input).toEqual({
          id: "packaging-master",
          version: "2026.07.28",
          limit: 500
        })
    );
    const normalizedProduct = {
      shopId: "shop-1",
      productId: "10001",
      title: collectedProduct.title,
      editorUrl
    };
    complete(
      "packaging.products.normalize",
      { products: [normalizedProduct] },
      (input) =>
        expect(input).toEqual({
          shopId: "shop-1",
          products: [collectedProduct]
        })
    );
    const inspectionItem = {
      product: collectedProduct,
      packagingMatch: { status: "unmatched" }
    };
    complete(
      "packaging.master.match.batch",
      {
        matcherVersion: "packaging-smart-v1",
        matched: [],
        ambiguous: [],
        unmatched: [
          {
            product: normalizedProduct,
            outcome: {
              status: "unmatched",
              reason: "没有候选",
              evidence: [],
              candidates: []
            }
          }
        ],
        inspectionQueue: [inspectionItem]
      },
      (input) =>
        expect(input).toEqual({
          products: [normalizedProduct],
          records: []
        })
    );
    expect(
      transition.effects.filter((effect) => effect.kind === "assistance.create")
    ).toEqual([]);
    complete("control.noop", { status: "none" });
    complete(
      "doudian.product.editor.open",
      {
        status: "ready",
        productId: "10001",
        url: editorUrl,
        readiness: {
          stableSamples: 3,
          visibleControls: 1,
          knownAnchors: 1,
          requiredMarkers: 1
        },
        tab_ref: {
          browser_instance_id: "browser-1",
          tab_id: 1,
          window_id: 1,
          origin: "https://fxg.jinritemai.com"
        },
        page_epoch: "epoch-2",
        domMutations: 0
      },
      (input) =>
        expect(input).toEqual({
          productId: "10001",
          editUrl: editorUrl
        })
    );
    const inspection = {
      status: "complete",
      inspectorVersion: "1.0.0",
      productId: "10001",
      packagingMatchStatus: "unmatched",
      baselineInspectionPerformed: true,
      issues: [],
      anomalies: [],
      domMutations: 0
    };
    complete(
      "doudian.editor.priority-items.inspect",
      inspection,
      (input) =>
        expect(input).toEqual({
          product: collectedProduct,
          packagingMatch: { status: "unmatched" },
          platformFillCheck: false
        })
    );
    const reconciliation = {
      reconciliationVersion: "1.0.0",
      products: [],
      summary: {
        totalProducts: 1,
        inspectedProducts: 1,
        affectedProducts: 0,
        pageIssueCount: 0,
        platformReminderCount: 0,
        inspectionAnomalyCount: 0,
        matchStatusCounts: { unmatched: 1 }
      }
    };
    complete("issues.reconcile", reconciliation, (input) => {
      expect(input).toMatchObject({
        foreachOutcome: {
          total: 1,
          succeeded: {
            count: 1,
            items: [{ itemKey: "10001", output: inspection }]
          },
          failed: { count: 0 },
          unresolved: { count: 0 }
        }
      });
    });
    const report = {
      schemaVersion: "bpa.issue-report/1",
      issueFingerprint: `sha256:${"d".repeat(64)}`
    };
    complete("report.issue.build", report, (input) => {
      expect(input).toMatchObject({
        context: {
          shopId: "shop-1",
          shopName: "测试店",
          scopeLabel: "售卖中"
        },
        reconciliation
      });
    });
    complete(
      "doudian.product.scope.restore",
      {
        status: "restored",
        restoreVersion: "1.1.0",
        listUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0",
        page: 1,
        scrollTop: 0,
        fingerprint: {
          shopId: "shop-1",
          shopName: "测试店",
          filters: {},
          statusTab: { id: "selling", label: "售卖中" },
          digest: "abcdef12"
        },
        formMutations: 0
      },
      (input) =>
        expect(input).toEqual({
          listUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0",
          page: 1,
          scrollTop: 0,
          shopId: "shop-1",
          shopName: "测试店",
          scopeDigest: "abcdef12",
          required: true
        })
    );
    expect(transition.state.status).toBe("succeeded");
    expect(transition.state.output).toMatchObject({
      report,
      inspectionSummary: {
        total: 1,
        succeeded: { count: 1 }
      }
    });
    expect(
      (
        transition.state.output as {
          matching: { unmatched: readonly unknown[] };
        }
      ).matching.unmatched[0]
    ).toMatchObject({
      product: { productId: "10001" }
    });
  });
});
