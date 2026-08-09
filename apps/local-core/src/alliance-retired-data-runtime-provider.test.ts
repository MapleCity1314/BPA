import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import type {
  AuditRecord,
  DatasetVersionDefinition,
  OperationalDatasetCoverage,
  OperationalDatasetPublicationLineage,
  OperationalExecutionContext,
  OperationalFactRecord,
  OperationalFactStore,
  PreparedOperationalDatasetPublication
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { AllianceRetiredDataRuntimeProvider } from "./alliance-retired-data-runtime-provider.js";

const observedAt = "2026-08-09T08:00:00.000Z";
const root = new URL("../../../", import.meta.url);

class MemoryFacts implements OperationalFactStore {
  readonly facts = new Map<string, OperationalFactRecord>();
  readonly preparations: Array<{
    publicationIntentId: string;
    runId: string;
    stagingId: string;
    dataset: DatasetVersionDefinition;
    factKeys: readonly string[];
    audit: AuditRecord;
    quality: "complete" | "partial";
    coverage: OperationalDatasetCoverage;
    executionContext: OperationalExecutionContext;
    preparedAt: string;
  }> = [];
  readonly prepared = new Map<string, PreparedOperationalDatasetPublication>();

  putOperationalFact(
    input: Parameters<OperationalFactStore["putOperationalFact"]>[0]
  ) {
    const factKey = `fact:${contentDigest({
      namespace: input.namespace,
      runId: input.executionContext.identity.runId,
      businessDate: "2026-08-09",
      subjectId: input.subjectId,
      schemaVersion: input.schemaVersion
    }).slice(7)}`;
    const record = {
      ...(input.record as Record<string, JsonValue>),
      businessDate: "2026-08-09"
    } as JsonValue;
    const existing = this.facts.get(factKey);
    if (existing) return { status: "duplicate" as const, fact: existing };
    const fact: OperationalFactRecord = {
      factKey,
      namespace: input.namespace,
      runId: input.executionContext.identity.runId,
      businessDate: "2026-08-09",
      businessTimeZone: input.businessTimeZone,
      businessAnchorAt: observedAt,
      subjectId: input.subjectId,
      schemaVersion: input.schemaVersion,
      record,
      recordDigest: contentDigest(record),
      invocationId: input.executionContext.invocationId,
      node: input.executionContext.node,
      identity: input.executionContext.identity,
      idempotencyKey: input.executionContext.idempotencyKey,
      fencingToken: input.executionContext.fencingToken,
      observedAt: input.observedAt,
      persistedAt: input.persistedAt
    };
    this.facts.set(factKey, fact);
    return { status: "accepted" as const, fact };
  }

  getOperationalFact(factKey: string) {
    return this.facts.get(factKey);
  }

  listOperationalFactsForRun(runId: string) {
    return [...this.facts.values()]
      .filter((fact) => fact.runId === runId)
      .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
  }

  getOperationalBusinessContext() {
    return { businessDate: "2026-08-09", anchorAt: observedAt };
  }

  prepareOperationalDatasetPublication(
    input: Parameters<
      OperationalFactStore["prepareOperationalDatasetPublication"]
    >[0]
  ) {
    this.preparations.push(input);
    const existing = this.prepared.get(input.runId);
    if (existing) return existing;
    const result: PreparedOperationalDatasetPublication = {
      publicationIntentId: input.publicationIntentId,
      runId: input.runId,
      stagingId: input.stagingId,
      dataset: input.dataset,
      factKeys: input.factKeys,
      audit: input.audit,
      quality: input.quality,
      businessDate: "2026-08-09",
      coverage: input.coverage,
      preparedBy: input.executionContext,
      preparedAt: input.preparedAt
    };
    this.prepared.set(input.runId, result);
    return result;
  }

  getPreparedOperationalDatasetPublication(runId: string) {
    return this.prepared.get(runId);
  }

  getOperationalDatasetPublicationLineage(
    _datasetId: string,
    _datasetVersion: string
  ): OperationalDatasetPublicationLineage | undefined {
    return undefined;
  }
}

function node(
  id: string,
  version: string
): ArtifactRef & { readonly kind: "node" } {
  return { kind: "node", id, version, digest: contentDigest({ id, version }) };
}

function invocation(input: {
  id: string;
  version: string;
  permission: string;
  riskLevel: "R0" | "R1";
  input: JsonValue;
  runId?: string;
  iterationKey?: string;
  scopePath?: RuntimeInvocation["identity"]["scopePath"];
}): RuntimeInvocation {
  const runId = input.runId ?? "run-retired";
  const iterationKey = input.iterationKey ?? "root";
  return {
    invocationId: `invocation:${runId}:${input.id}:${iterationKey}`,
    identity: {
      runId,
      scopePath: input.scopePath ?? [],
      iterationKey,
      stepKey: input.id,
      attempt: 1
    },
    node: node(input.id, input.version),
    providerId: "alliance-retired-data",
    input: input.input,
    permissionSnapshot: {
      riskLevel: input.riskLevel,
      permissions: [input.permission],
      domains: []
    },
    deadlineAt: Date.parse("2026-08-09T09:00:00.000Z"),
    idempotencyKey: `idempotency:${runId}:${input.id}:${iterationKey}`,
    fencingToken: 7,
    traceId: `trace:${runId}`
  };
}

function scan(shopId: string, productCount = 1): JsonValue {
  return {
    shop: {
      key: `id:${shopId}`,
      id: shopId,
      name: `测试店铺${shopId}`,
      status: "active",
      statusText: "经营中"
    },
    status: "complete",
    retiredCount: productCount,
    updatedAt: "2026-08-09 15:00:00",
    observedAt,
    products: Array.from({ length: productCount }, (_, index) => ({
      treatmentId: `T-${shopId}-${index}`,
      productId: String(90001 + index),
      title: `测试清退商品${index}`,
      status: "已清退",
      processedAt: "2026-08-09",
      reason: "体验分不达标"
    })),
    evidence: {
      pageUrl:
        `https://buyin.jinritemai.com/dashboard/regulation/clear-out?shop=${shopId}&session=private#fragment`,
      capturedAt: observedAt
    },
    diagnostics: ["PRIVATE_DIAGNOSTIC"]
  };
}

async function persist(
  provider: AllianceRetiredDataRuntimeProvider,
  shopId: string,
  productCount = 1,
  runId = "run-retired"
) {
  return provider.invoke(
    invocation({
      id: "doudian.alliance.shop.retired-products.fact.persist",
      version: "1.0.0",
      permission: "alliance.retired.fact.write",
      riskLevel: "R1",
      input: { scan: scan(shopId, productCount) },
      runId,
      iterationKey: `id:${shopId}`,
      scopePath: [{ foreachStepKey: "scan_shops", itemKey: `id:${shopId}` }]
    }),
    new AbortController().signal
  );
}

function discoveredShop(
  id: string,
  status: "active" | "blocked" = "active"
): JsonValue {
  return {
    key: `id:${id}`,
    id,
    name: `测试店铺${id}`,
    status,
    statusText: status === "active" ? "经营中" : "已停业"
  };
}

function aggregateInvocation(
  foreachOutcome: JsonValue,
  discoveredCount: number,
  collectableCount: number,
  runId = "run-retired",
  discoveries: JsonValue[] = Array.from(
    { length: discoveredCount },
    (_, index) =>
      discoveredShop(
        String(10001 + index),
        index < collectableCount ? "active" : "blocked"
      )
  )
) {
  return invocation({
    id: "doudian.alliance.retired-products.aggregate",
    version: "2.0.0",
    permission: "alliance.retired.fact.read",
    riskLevel: "R0",
    runId,
    input: {
      foreachOutcome,
      discoveredShops: discoveries,
      discoveredCount,
      collectableCount
    }
  });
}

function outputOf(
  result: Awaited<ReturnType<AllianceRetiredDataRuntimeProvider["invoke"]>>
) {
  if (result.status !== "succeeded") throw new Error(result.error.message);
  return result.output as Record<string, JsonValue>;
}

function declaredErrors(path: string): string[] {
  const value = parse(readFileSync(new URL(path, root), "utf8")) as {
    errors?: unknown;
  };
  if (!Array.isArray(value.errors)) throw new Error(`${path} has no errors`);
  return value.errors.map(String);
}

function seedLargeFacts(store: MemoryFacts, count: number): void {
  const largeText = "x".repeat(1000);
  for (let index = 0; index < count; index += 1) {
    const subjectId = String(20000 + index);
    const record = {
      id: subjectId,
      businessDate: "2026-08-09",
      status: "complete_with_items",
      shop: { id: subjectId, name: `大数据店铺${subjectId}` },
      observedAt,
      sourceUpdatedAt: "2026-08-09 15:00:00",
      retiredCount: 500,
      products: Array.from({ length: 500 }, (_, productIndex) => ({
        treatmentId: `T-${subjectId}-${productIndex}-${"t".repeat(70)}`,
        productId: String(90000 + productIndex),
        title: "p".repeat(500),
        status: "s".repeat(100),
        processedAt: "d".repeat(100),
        reason: largeText
      })),
      evidence: {
        pageUrl: "https://buyin.jinritemai.com/dashboard/regulation/clear-out",
        capturedAt: observedAt
      }
    } satisfies Record<string, JsonValue>;
    const factKey = `fact:large:${subjectId}`;
    store.facts.set(factKey, {
      factKey,
      namespace: "doudian.alliance.shop-retired-products",
      runId: "run-large-retired",
      businessDate: "2026-08-09",
      businessTimeZone: "Asia/Shanghai",
      businessAnchorAt: observedAt,
      subjectId,
      schemaVersion: "1.0.0",
      record,
      recordDigest: contentDigest(record),
      invocationId: `invocation:${subjectId}`,
      node: node(
        "doudian.alliance.shop.retired-products.fact.persist",
        "1.0.0"
      ),
      identity: {
        runId: "run-large-retired",
        scopePath: [
          { foreachStepKey: "scan_shops", itemKey: `id:${subjectId}` }
        ],
        iterationKey: `id:${subjectId}`,
        stepKey: "persist_fact",
        attempt: 1
      },
      idempotencyKey: `idempotency:${subjectId}`,
      fencingToken: 7,
      observedAt,
      persistedAt: observedAt
    });
  }
}

describe("AllianceRetiredDataRuntimeProvider", () => {
  it("supports only exact refs and exact permission snapshots", async () => {
    const provider = new AllianceRetiredDataRuntimeProvider(new MemoryFacts());
    expect(
      provider.supports(
        node("doudian.alliance.shop.retired-products.fact.persist", "1.0.0")
      )
    ).toBe(true);
    expect(
      provider.supports(
        node("doudian.alliance.shop.retired-products.fact.persist", "1.0.1")
      )
    ).toBe(false);
    expect(
      provider.supports(
        node("doudian.alliance.retired-products.aggregate", "1.0.0")
      )
    ).toBe(false);
    const expanded = invocation({
      id: "doudian.alliance.retired-products.aggregate",
      version: "2.0.0",
      permission: "alliance.retired.fact.read",
      riskLevel: "R0",
      input: {}
    });
    await expect(
      provider.invoke(
        {
          ...expanded,
          permissionSnapshot: {
            ...expanded.permissionSnapshot,
            permissions: ["alliance.retired.fact.read", "browser.dom.read"]
          }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "ALLIANCE_RETIRED_FACT_PERMISSION_MISMATCH" }
    });
  });

  it("maps common rejection codes into each exact Node contract", async () => {
    const provider = new AllianceRetiredDataRuntimeProvider(new MemoryFacts());
    for (const testCase of [
      {
        path: "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml",
        invocation: invocation({
          id: "doudian.alliance.shop.retired-products.fact.persist",
          version: "1.0.0",
          permission: "wrong",
          riskLevel: "R1",
          input: {}
        }),
        code: "ALLIANCE_RETIRED_FACT_PERMISSION_MISMATCH"
      },
      {
        path: "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
        invocation: invocation({
          id: "doudian.alliance.retired-products.aggregate",
          version: "2.0.0",
          permission: "wrong",
          riskLevel: "R0",
          input: {}
        }),
        code: "ALLIANCE_RETIRED_FACT_PERMISSION_MISMATCH"
      },
      {
        path: "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml",
        invocation: invocation({
          id: "doudian.alliance.retired-products.dataset.prepare",
          version: "1.0.0",
          permission: "wrong",
          riskLevel: "R1",
          input: {}
        }),
        code: "ALLIANCE_RETIRED_DATASET_PERMISSION_MISMATCH"
      }
    ]) {
      const result = await provider.invoke(
        testCase.invocation,
        new AbortController().signal
      );
      expect(result).toMatchObject({
        status: "rejected",
        error: { code: testCase.code }
      });
      expect(declaredErrors(testCase.path)).toContain(testCase.code);
    }
  });

  it("persists only the controlled projection and runtime execution context", async () => {
    const store = new MemoryFacts();
    const provider = new AllianceRetiredDataRuntimeProvider(
      store,
      () => new Date("2026-08-09T08:01:00.000Z")
    );
    expect(outputOf(await persist(provider, "10001"))).toMatchObject({
      status: "complete_with_items",
      inserted: true,
      retiredCount: 1
    });
    const fact = [...store.facts.values()][0]!;
    expect(fact).toMatchObject({
      namespace: "doudian.alliance.shop-retired-products",
      persistedAt: "2026-08-09T08:01:00.000Z",
      identity: { runId: "run-retired" },
      node: {
        id: "doudian.alliance.shop.retired-products.fact.persist",
        version: "1.0.0"
      },
      record: {
        id: "10001",
        businessDate: "2026-08-09",
        status: "complete_with_items",
        evidence: {
          pageUrl:
            "https://buyin.jinritemai.com/dashboard/regulation/clear-out",
          capturedAt: observedAt
        }
      }
    });
    const serialized = JSON.stringify(fact.record);
    expect(serialized).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(serialized).not.toContain("session=");
    expect(serialized).not.toContain("#fragment");
  });

  it("rejects more than 50 products before writing a fact", async () => {
    const store = new MemoryFacts();
    const provider = new AllianceRetiredDataRuntimeProvider(store);
    const result = await persist(provider, "10001", 51);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "ALLIANCE_RETIRED_FACT_INVALID", retryable: false }
    });
    expect(store.facts.size).toBe(0);
  });

  it("rejects swapped subjects and forged foreach markers without writes", async () => {
    const store = new MemoryFacts();
    const provider = new AllianceRetiredDataRuntimeProvider(store);
    const swapped = await provider.invoke(
      invocation({
        id: "doudian.alliance.shop.retired-products.fact.persist",
        version: "1.0.0",
        permission: "alliance.retired.fact.write",
        riskLevel: "R1",
        input: { scan: scan("10002") },
        iterationKey: "id:10001",
        scopePath: [{ foreachStepKey: "scan_shops", itemKey: "id:10001" }]
      }),
      new AbortController().signal
    );
    expect(swapped).toMatchObject({
      status: "rejected",
      error: { code: "ALLIANCE_RETIRED_FACT_SCOPE_MISMATCH" }
    });
    expect(store.facts.size).toBe(0);

    const persisted = outputOf(await persist(provider, "10001"));
    const forged = await provider.invoke(
      aggregateInvocation(
        {
          total: 2,
          succeeded: {
            count: 2,
            items: [
              { itemKey: "id:10002", output: persisted },
              { itemKey: "id:10001", output: { status: "skipped" } }
            ]
          },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        },
        2,
        1
      ),
      new AbortController().signal
    );
    expect(forged).toMatchObject({
      status: "rejected",
      error: { code: "ALLIANCE_RETIRED_FACT_SCOPE_MISMATCH" }
    });
    expect(store.preparations).toEqual([]);
  });

  it("derives complete empty, skipped coverage, partial, and zero-fact failure", async () => {
    const store = new MemoryFacts();
    const provider = new AllianceRetiredDataRuntimeProvider(store);
    const emptyFact = outputOf(await persist(provider, "10001", 0));
    const complete = outputOf(
      await provider.invoke(
        aggregateInvocation(
          {
            total: 2,
            succeeded: {
              count: 2,
              items: [
                { itemKey: "id:10001", output: emptyFact },
                { itemKey: "id:10002", output: { status: "skipped" } }
              ]
            },
            failed: { count: 0, items: [] },
            unresolved: { count: 0, items: [] }
          },
          2,
          1
        ),
        new AbortController().signal
      )
    );
    expect(complete).toMatchObject({
      status: "complete_empty",
      discoveredCount: 2,
      collectableCount: 1,
      persistedCount: 1,
      failedCount: 0,
      skippedCount: 1,
      retiredProductCount: 0
    });

    const itemFact = outputOf(await persist(provider, "10002", 1));
    const partial = outputOf(
      await provider.invoke(
        aggregateInvocation(
          {
            total: 3,
            succeeded: {
              count: 2,
              items: [
                { itemKey: "id:10001", output: emptyFact },
                { itemKey: "id:10002", output: itemFact }
              ]
            },
            failed: { count: 1, items: [{ itemKey: "id:10003" }] },
            unresolved: { count: 0, items: [] }
          },
          3,
          3
        ),
        new AbortController().signal
      )
    );
    expect(partial).toMatchObject({
      status: "partial",
      persistedCount: 2,
      failedCount: 1,
      affectedShopCount: 1,
      retiredProductCount: 1
    });

    const emptyProvider = new AllianceRetiredDataRuntimeProvider(
      new MemoryFacts()
    );
    const zero = outputOf(
      await emptyProvider.invoke(
        aggregateInvocation(
          {
            total: 1,
            succeeded: { count: 0, items: [] },
            failed: { count: 1, items: [{ itemKey: "id:10001" }] },
            unresolved: { count: 0, items: [] }
          },
          1,
          1,
          "run-zero"
        ),
        new AbortController().signal
      )
    );
    expect(zero).toMatchObject({
      status: "failed",
      businessDate: "2026-08-09",
      observedAt,
      persistedCount: 0,
      failedCount: 1
    });
  });

  it("prepares one deterministic intent without publishing before terminal", async () => {
    const store = new MemoryFacts();
    const provider = new AllianceRetiredDataRuntimeProvider(store);
    const persisted = outputOf(await persist(provider, "10001"));
    const daily = outputOf(
      await provider.invoke(
        aggregateInvocation(
          {
            total: 1,
            succeeded: {
              count: 1,
              items: [{ itemKey: "id:10001", output: persisted }]
            },
            failed: { count: 0, items: [] },
            unresolved: { count: 0, items: [] }
          },
          1,
          1
        ),
        new AbortController().signal
      )
    );
    const prepare = invocation({
      id: "doudian.alliance.retired-products.dataset.prepare",
      version: "1.0.0",
      permission: "alliance.retired.dataset.prepare",
      riskLevel: "R1",
      input: { daily }
    });
    const first = outputOf(
      await provider.invoke(prepare, new AbortController().signal)
    );
    const second = outputOf(
      await provider.invoke(prepare, new AbortController().signal)
    );
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "prepared",
      datasetStatus: "complete",
      datasetId: "doudian-alliance-retired-products-daily",
      recordCount: 1,
      version: expect.stringMatching(/^2026\.8\.9-run\.[0-9a-f]{32}$/u),
      recordsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    const prepared = store.getPreparedOperationalDatasetPublication(
      "run-retired"
    )!;
    expect(prepared.dataset.profile).toEqual({
      id: "doudian-alliance-retired-products-v1",
      version: "1.0.0"
    });
    expect(prepared.dataset.source.digest).toBe(
      prepared.dataset.recordsDigest
    );
    expect(
      store.getOperationalDatasetPublicationLineage(
        prepared.dataset.metadata.id,
        prepared.dataset.metadata.version
      )
    ).toBeUndefined();
  });

  it("keeps facts but rejects a Dataset source above the 16 MiB bound", async () => {
    const store = new MemoryFacts();
    seedLargeFacts(store, 20);
    const facts = store.listOperationalFactsForRun("run-large-retired");
    const provider = new AllianceRetiredDataRuntimeProvider(store);
    const result = await provider.invoke(
      invocation({
        id: "doudian.alliance.retired-products.dataset.prepare",
        version: "1.0.0",
        permission: "alliance.retired.dataset.prepare",
        riskLevel: "R1",
        runId: "run-large-retired",
        input: {
          daily: {
            status: "complete_with_items",
            businessDate: "2026-08-09",
            observedAt,
            discoveredCount: facts.length,
            collectableCount: facts.length,
            attemptedCount: facts.length,
            persistedCount: facts.length,
            failedCount: 0,
            skippedCount: 0,
            affectedShopCount: facts.length,
            retiredProductCount: facts.length * 500,
            factRefs: facts.map((fact) => ({
              factKey: fact.factKey,
              businessDate: fact.businessDate,
              subjectId: fact.subjectId,
              recordDigest: fact.recordDigest
            })),
            shops: [],
            foreachOutcome: {}
          }
        }
      }),
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "ALLIANCE_RETIRED_DATASET_TOO_LARGE" }
    });
    expect(declaredErrors(
      "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml"
    )).toContain("ALLIANCE_RETIRED_DATASET_TOO_LARGE");
    expect(store.facts.size).toBe(20);
    expect(store.preparations).toEqual([]);
    expect(
      store.getPreparedOperationalDatasetPublication("run-large-retired")
    ).toBeUndefined();
  });
});
