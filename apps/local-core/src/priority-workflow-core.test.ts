import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import { RuntimeProviderRegistry } from "@bpa/node-runtime";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { LocalCoreService } from "./control.js";

const root = new URL("../../../", import.meta.url);
const timestamp = "2026-07-28T00:00:00.000Z";

function source(path: string): unknown {
  const content = readFileSync(new URL(path, root), "utf8");
  return path.endsWith(".json") ? JSON.parse(content) : parse(content);
}

function success(output: unknown): RuntimeOutcome {
  return {
    status: "succeeded",
    output: JSON.parse(JSON.stringify(output)) as JsonValue,
    evidence: [],
    riskSignals: []
  };
}

class FixtureProvider implements RuntimeProvider {
  constructor(
    readonly id: string,
    readonly invokeNode: (
      nodeId: string,
      input: JsonValue
    ) => RuntimeOutcome
  ) {}

  supports(_node: ArtifactRef & { readonly kind: "node" }): boolean {
    return true;
  }

  async invoke(
    invocation: RuntimeInvocation,
    _signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    return this.invokeNode(invocation.node.id, invocation.input);
  }
}

function publishDataset(store: SqlitePersistence): void {
  store.stageDataset({
    stagingId: "staging-priority",
    profileId: "packaging-master-v1",
    profileVersion: "1.0.0",
    sourceDigest: `sha256:${"1".repeat(64)}`,
    state: "staged",
    validationReport: {},
    createdAt: timestamp,
    updatedAt: timestamp
  });
  store.transitionDatasetStaging({
    stagingId: "staging-priority",
    expectedState: "staged",
    nextState: "validated",
    validationReport: { valid: true },
    updatedAt: timestamp
  });
  store.publishDataset({
    stagingId: "staging-priority",
    expectedState: "validated",
    dataset: {
      apiVersion: "bpa.data/v1alpha1",
      kind: "DatasetVersion",
      metadata: {
        id: "packaging-master",
        version: "1.0.0",
        title: "Packaging master"
      },
      profile: { id: "packaging-master-v1", version: "1.0.0" },
      source: {
        fileName: "packaging.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 100,
        digest: `sha256:${"1".repeat(64)}`
      },
      recordSchema: { type: "object" },
      recordCount: 1,
      recordsDigest: `sha256:${"2".repeat(64)}`
    },
    normalizedRecords: [
      {
        id: "record-1",
        recordDigest: `sha256:${"3".repeat(64)}`,
        productName: "包装记录"
      }
    ],
    audit: {
      id: "audit-priority",
      action: "dataset.publish",
      actor: "test",
      target: "dataset:packaging-master@1.0.0",
      detail: {},
      occurredAt: timestamp
    }
  });
}

function publish(
  service: LocalCoreService,
  assetType: string,
  path: string
): void {
  const response = service.handle({
    id: `publish:${path}`,
    method: "asset.publish",
    params: { assetType, content: source(path), actor: "test" }
  });
  expect(response, path).toMatchObject({ ok: true });
}

describe("Local Core priority inspection workflow", () => {
  it("runs an unmatched healthy product to a report without assistance", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    publishDataset(store);
    const providers = new RuntimeProviderRegistry();
    const invocationOrder: string[] = [];
    providers.register(
      new FixtureProvider("browser", (nodeId, input) => {
        invocationOrder.push(nodeId);
        if (nodeId === "doudian.shop.context.read") {
          return success({
            supported: true,
            shop: {
              id: "shop-1",
              name: "测试店",
              identity_confirmed: true
            },
            tab_ref: {
              browser_instance_id: "browser-1",
              tab_id: 1,
              window_id: 1,
              origin: "https://fxg.jinritemai.com"
            },
            page_epoch: "epoch-1"
          });
        }
        if (nodeId === "doudian.product.scope.collect") {
          const product = {
            id: "10001",
            title: "健康但未匹配包装的商品",
            editorUrl:
              "https://fxg.jinritemai.com/ffa/g/create?product_id=10001"
          };
          return success({
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
            products: [product],
            inspectionQueue: [product],
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
        }
        if (nodeId === "doudian.product.editor.open") {
          return success({ status: "ready" });
        }
        if (nodeId === "doudian.product.scope.restore") {
          expect(input).toEqual({
            listUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0",
            page: 1,
            scrollTop: 0,
            shopId: "shop-1",
            shopName: "测试店",
            scopeDigest: "abcdef12",
            required: true
          });
          return success({
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
          });
        }
        return success({
          status: "complete",
          inspectorVersion: "1.0.0",
          productId: "10001",
          packagingMatchStatus: "unmatched",
          baselineInspectionPerformed: true,
          issues: [],
          anomalies: [],
          domMutations: 0
        });
      })
    );
    providers.register(
      new FixtureProvider("team", (nodeId, input) => {
        invocationOrder.push(nodeId);
        const value = input as Record<string, JsonValue>;
        if (nodeId === "packaging.products.normalize") {
          const product = (value.products as JsonValue[])[0] as Record<
            string,
            JsonValue
          >;
          return success({
            products: [
              {
                shopId: value.shopId,
                productId: product.id,
                title: product.title,
                editorUrl: product.editorUrl
              }
            ]
          });
        }
        if (nodeId === "packaging.master.match.batch") {
          const product = (value.products as JsonValue[])[0] as Record<
            string,
            JsonValue
          >;
          return success({
            matcherVersion: "packaging-smart-v1",
            matched: [],
            ambiguous: [],
            unmatched: [{ product, outcome: { status: "unmatched" } }],
            inspectionQueue: [
              {
                product: {
                  id: product.productId,
                  title: product.title,
                  editorUrl: product.editorUrl
                },
                packagingMatch: { status: "unmatched" }
              }
            ],
            ambiguityReview: {
              batchRef: `sha256:${"4".repeat(64)}`,
              items: []
            }
          });
        }
        if (nodeId === "issues.reconcile") {
          return success({
            reconciliationVersion: "1.0.0",
            products: [
              {
                productId: "10001",
                packagingMatchStatus: "unmatched",
                issues: [],
                anomalies: []
              }
            ],
            summary: {
              totalProducts: 1,
              inspectedProducts: 1,
              affectedProducts: 0,
              pageIssueCount: 0,
              platformReminderCount: 0,
              inspectionAnomalyCount: 0,
              matchStatusCounts: { unmatched: 1 }
            }
          });
        }
        return success({
          schemaVersion: "bpa.issue-report/1",
          reportVersion: "1.0.0",
          summary: {
            totalProducts: 1,
            affectedProducts: 0,
            pageIssueCount: 0
          },
          products: [],
          issueFingerprint: `sha256:${"5".repeat(64)}`,
          reportDigest: `sha256:${"6".repeat(64)}`
        });
      })
    );
    const service = new LocalCoreService(store, undefined, providers);

    for (const id of [
      "control.noop",
      "dataset.records.read",
      "doudian.shop.context.read",
      "doudian.product.scope.collect",
      "doudian.product.scope.restore",
      "doudian.product.editor.open",
      "doudian.editor.priority-items.inspect",
      "packaging.products.normalize",
      "packaging.master.match.batch",
      "issues.reconcile",
      "report.issue.build"
    ]) {
      const versionedPath = ({
        "doudian.shop.context.read":
          "nodes/core/doudian.shop.context.read@1.3.0.node.yaml",
        "doudian.product.scope.collect":
          "nodes/core/doudian.product.scope.collect@1.1.0.node.yaml",
        "doudian.product.editor.open":
          "nodes/core/doudian.product.editor.open@1.1.0.node.yaml",
        "doudian.editor.priority-items.inspect":
          "nodes/core/doudian.editor.priority-items.inspect@1.1.0.node.yaml"
      } as Record<string, string>)[id];
      publish(
        service,
        "node",
        versionedPath ?? `nodes/core/${id}.node.yaml`
      );
    }
    publish(service, "adapter", "adapters/doudian/doudian.adapter.yaml");
    publish(
      service,
      "policy",
      "policies/core/packaging_match_review.validator.policy.json"
    );
    publish(
      service,
      "assistance_profile",
      "assistance-profiles/core/packaging_match_review.assistance-profile.json"
    );
    publish(
      service,
      "assistance_profile",
      "assistance-profiles/core/binding_confirm.assistance-profile.yaml"
    );
    publish(
      service,
      "workflow",
      "workflows/examples/doudian.priority-items-readonly-inspect.workflow.yaml"
    );

    const created = service.handle({
      id: "run",
      method: "run.create",
      params: {
        workflowId: "doudian.priority-items-readonly-inspect",
        workflowVersion: "0.3.0",
        input: {
          dataset: { id: "packaging-master", version: "1.0.0" },
          platformFillCheck: false
        }
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: { status: "waiting_browser" }
    });
    const runId = String(
      (created.result as { id: string }).id
    );
    for (let turn = 0; turn < 20; turn += 1) {
      await service.ir2Runtime.drainOnce();
      if (store.getRun(runId)?.status === "succeeded") break;
    }

    expect(store.getRun(runId)).toMatchObject({
      status: "succeeded",
      output: {
        report: {
          summary: { affectedProducts: 0, pageIssueCount: 0 }
        },
        matching: {
          unmatched: [{ product: { productId: "10001" } }]
        }
      }
    });
    expect(invocationOrder.indexOf("report.issue.build")).toBeGreaterThan(-1);
    expect(
      invocationOrder.indexOf("doudian.product.scope.restore")
    ).toBeGreaterThan(invocationOrder.indexOf("report.issue.build"));
    expect(
      store
        .listAssistanceTasks({ limit: 20 })
        .filter((task) => task.task.runId === runId)
    ).toEqual([]);
    expect(store.listEvents(runId).at(-1)).toMatchObject({
      type: "RUNTIME_RESULT_APPLIED"
    });
    store.close();
  });
});
