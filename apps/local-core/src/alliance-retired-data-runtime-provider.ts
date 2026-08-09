import { canonicalJson, contentDigest } from "@bpa/compiler";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import {
  OperationalFactConflictError,
  StaleFencingTokenError,
  type OperationalDatasetCoverage,
  type OperationalExecutionContext,
  type OperationalFactRecord,
  type OperationalFactStore
} from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const FACT_NAMESPACE = "doudian.alliance.shop-retired-products";
const FACT_SCHEMA_VERSION = "1.0.0";
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DATASET_ID = "doudian-alliance-retired-products-daily";
const MAX_DATASET_CANONICAL_BYTES = 16 * 1024 * 1024;
const MAX_PRODUCTS_PER_SHOP = 50;
const RETIRED_PAGE_URL =
  "https://buyin.jinritemai.com/dashboard/regulation/clear-out";

export const DOUDIAN_ALLIANCE_RETIRED_DATASET_PROFILE = Object.freeze({
  id: "doudian-alliance-retired-products-v1",
  version: "1.0.0"
});

const RETIRED_RECORD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "businessDate",
    "status",
    "shop",
    "observedAt",
    "sourceUpdatedAt",
    "retiredCount",
    "products",
    "evidence"
  ],
  properties: {
    id: { type: "string", pattern: "^[0-9]{5,30}$" },
    businessDate: { type: "string", format: "date" },
    status: { enum: ["complete_empty", "complete_with_items"] },
    shop: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name"],
      properties: {
        id: { type: "string", pattern: "^[0-9]{5,30}$" },
        name: { type: "string", minLength: 2, maxLength: 80 }
      }
    },
    observedAt: { type: "string", format: "date-time" },
    sourceUpdatedAt: { type: ["string", "null"], maxLength: 100 },
    retiredCount: {
      type: "integer",
      minimum: 0,
      maximum: MAX_PRODUCTS_PER_SHOP
    },
    products: {
      type: "array",
      maxItems: MAX_PRODUCTS_PER_SHOP,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "treatmentId",
          "productId",
          "title",
          "status",
          "processedAt",
          "reason"
        ],
        properties: {
          treatmentId: { type: "string", minLength: 1, maxLength: 100 },
          productId: {
            type: ["string", "null"],
            pattern: "^[0-9]{5,30}$"
          },
          title: { type: "string", minLength: 1, maxLength: 500 },
          status: { type: "string", minLength: 1, maxLength: 100 },
          processedAt: { type: "string", minLength: 1, maxLength: 100 },
          reason: { type: "string", maxLength: 1000 }
        }
      }
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["pageUrl", "capturedAt"],
      properties: {
        pageUrl: { const: RETIRED_PAGE_URL },
        capturedAt: { type: "string", format: "date-time" }
      }
    }
  }
});

type NodeRule = {
  readonly version: string;
  readonly riskLevel: "R0" | "R1";
  readonly permission: string;
  readonly permissionError: string;
};

const NODE_RULES = new Map<string, NodeRule>([
  [
    "doudian.alliance.shop.retired-products.fact.persist",
    {
      version: "1.0.0",
      riskLevel: "R1",
      permission: "alliance.retired.fact.write",
      permissionError: "ALLIANCE_RETIRED_FACT_PERMISSION_MISMATCH"
    }
  ],
  [
    "doudian.alliance.retired-products.aggregate",
    {
      version: "2.0.0",
      riskLevel: "R0",
      permission: "alliance.retired.fact.read",
      permissionError: "ALLIANCE_RETIRED_FACT_PERMISSION_MISMATCH"
    }
  ],
  [
    "doudian.alliance.retired-products.dataset.prepare",
    {
      version: "1.0.0",
      riskLevel: "R1",
      permission: "alliance.retired.dataset.prepare",
      permissionError: "ALLIANCE_RETIRED_DATASET_PERMISSION_MISMATCH"
    }
  ]
]);

type JsonObject = Record<string, JsonValue>;

class AllianceRetiredFactScopeMismatchError extends Error {}

class AllianceRetiredDatasetTooLargeError extends Error {}

function object(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...value];
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function exactKeys(
  value: JsonObject,
  allowed: readonly string[],
  label: string
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
  }
}

function executionContext(
  invocation: RuntimeInvocation
): OperationalExecutionContext {
  return {
    invocationId: invocation.invocationId,
    identity: invocation.identity,
    node: invocation.node,
    idempotencyKey: invocation.idempotencyKey,
    fencingToken: invocation.fencingToken
  };
}

function assertFactScope(
  invocation: RuntimeInvocation,
  subjectId: string
): void {
  const scope = invocation.identity.scopePath.at(-1);
  const expectedItemKey = `id:${subjectId}`;
  if (
    !scope ||
    scope.foreachStepKey !== "scan_shops" ||
    scope.itemKey !== expectedItemKey ||
    invocation.identity.iterationKey !== expectedItemKey
  ) {
    throw new AllianceRetiredFactScopeMismatchError(
      "Retired-products fact subject does not match the scan_shops iteration identity"
    );
  }
}

function failed(code: string, message: string): RuntimeOutcome {
  return {
    status: "failed",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function rejected(code: string, message: string): RuntimeOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function succeeded(output: JsonValue): RuntimeOutcome {
  return { status: "succeeded", output, evidence: [], riskSignals: [] };
}

function permissionMatches(
  invocation: RuntimeInvocation,
  rule: NodeRule
): boolean {
  return (
    invocation.permissionSnapshot.riskLevel === rule.riskLevel &&
    invocation.permissionSnapshot.permissions.length === 1 &&
    invocation.permissionSnapshot.permissions[0] === rule.permission &&
    invocation.permissionSnapshot.domains.length === 0
  );
}

function safePageUrl(value: JsonValue | undefined): string {
  const candidate = text(value, "scan.evidence.pageUrl");
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://buyin.jinritemai.com" ||
    url.pathname !== "/dashboard/regulation/clear-out" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("scan.evidence.pageUrl is outside the retired-products page");
  }
  return `${url.origin}${url.pathname}`;
}

function projectProduct(value: JsonValue): JsonObject {
  const product = object(value, "retired product");
  exactKeys(
    product,
    ["treatmentId", "productId", "title", "status", "processedAt", "reason"],
    "retired product"
  );
  const productId =
    product.productId === undefined
      ? null
      : text(product.productId, "retired product.productId");
  return {
    treatmentId: text(product.treatmentId, "retired product.treatmentId"),
    productId,
    title: text(product.title, "retired product.title"),
    status: text(product.status, "retired product.status"),
    processedAt: text(product.processedAt, "retired product.processedAt"),
    reason:
      typeof product.reason === "string"
        ? product.reason
        : text(product.reason, "retired product.reason")
  };
}

function projectScan(value: JsonValue): {
  readonly subjectId: string;
  readonly observedAt: string;
  readonly record: JsonObject;
} {
  const scan = object(value, "retired-products scan");
  exactKeys(
    scan,
    [
      "shop",
      "status",
      "retiredCount",
      "updatedAt",
      "observedAt",
      "products",
      "evidence",
      "diagnostics"
    ],
    "retired-products scan"
  );
  if (text(scan.status, "scan.status") !== "complete") {
    throw new Error("Only complete retired-products scans are persistable");
  }
  const shop = object(scan.shop ?? null, "scan.shop");
  const subjectId = text(shop.id, "scan.shop.id");
  const shopName = text(shop.name, "scan.shop.name");
  const observedAt = text(scan.observedAt, "scan.observedAt");
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("scan.observedAt must be a timestamp");
  }
  const products = array(scan.products, "scan.products")
    .map(projectProduct)
    .sort((left, right) =>
      String(left.treatmentId).localeCompare(String(right.treatmentId))
    );
  const retiredCount = integer(scan.retiredCount, "scan.retiredCount");
  if (
    retiredCount > MAX_PRODUCTS_PER_SHOP ||
    retiredCount !== products.length ||
    new Set(products.map((product) => product.treatmentId)).size !== products.length
  ) {
    throw new Error("scan products and retiredCount do not conserve");
  }
  const evidence = object(scan.evidence ?? null, "scan.evidence");
  return {
    subjectId,
    observedAt,
    record: {
      id: subjectId,
      status: retiredCount > 0 ? "complete_with_items" : "complete_empty",
      shop: { id: subjectId, name: shopName },
      observedAt,
      sourceUpdatedAt: scan.updatedAt ?? null,
      retiredCount,
      products,
      evidence: {
        pageUrl: safePageUrl(evidence.pageUrl),
        capturedAt: text(evidence.capturedAt, "scan.evidence.capturedAt")
      }
    }
  };
}

type ForeachBucket = {
  readonly count: number;
  readonly items: readonly JsonObject[];
};

type ForeachOutcome = {
  readonly total: number;
  readonly succeeded: ForeachBucket;
  readonly failed: ForeachBucket;
  readonly unresolved: ForeachBucket;
};

type DiscoveredShop = {
  readonly key: string;
  readonly id?: string;
  readonly status: "active" | "blocked";
};

function normalizedShopName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function discoveredShops(value: JsonValue | undefined): DiscoveredShop[] {
  const shops = array(value, "discoveredShops").map((entry) => {
    const shop = object(entry, "discovered shop");
    exactKeys(
      shop,
      ["key", "id", "name", "status", "statusText"],
      "discovered shop"
    );
    const key = text(shop.key, "discovered shop.key");
    const name = text(shop.name, "discovered shop.name");
    const status = text(shop.status, "discovered shop.status");
    if (status !== "active" && status !== "blocked") {
      throw new Error("discovered shop.status is invalid");
    }
    const id = shop.id === undefined
      ? undefined
      : text(shop.id, "discovered shop.id");
    if (status === "active" && !id) {
      throw new AllianceRetiredFactScopeMismatchError(
        "An active discovered shop requires a stable numeric id"
      );
    }
    const expectedKey = id ? `id:${id}` : `name:${normalizedShopName(name)}`;
    if (key !== expectedKey) {
      throw new Error("discovered shop.key does not match its identity");
    }
    return { key, ...(id ? { id } : {}), status } satisfies DiscoveredShop;
  });
  if (
    shops.length === 0 ||
    new Set(shops.map((shop) => shop.key)).size !== shops.length
  ) {
    throw new Error("discoveredShops must contain unique shops");
  }
  return shops;
}

function foreachBucket(
  value: JsonValue | undefined,
  label: string
): ForeachBucket {
  const bucket = object(value ?? null, label);
  exactKeys(bucket, ["count", "items"], label);
  const items = array(bucket.items, `${label}.items`).map((item) =>
    object(item, `${label} item`)
  );
  const count = integer(bucket.count, `${label}.count`);
  if (count !== items.length) {
    throw new Error(`${label}.count does not match items`);
  }
  return { count, items };
}

function foreachOutcome(value: JsonValue): ForeachOutcome {
  const outcome = object(value, "foreachOutcome");
  exactKeys(
    outcome,
    ["total", "succeeded", "failed", "unresolved"],
    "foreachOutcome"
  );
  const result = {
    total: integer(outcome.total, "foreachOutcome.total"),
    succeeded: foreachBucket(outcome.succeeded, "foreachOutcome.succeeded"),
    failed: foreachBucket(outcome.failed, "foreachOutcome.failed"),
    unresolved: foreachBucket(outcome.unresolved, "foreachOutcome.unresolved")
  };
  if (
    result.succeeded.count + result.failed.count + result.unresolved.count !==
    result.total
  ) {
    throw new Error("foreachOutcome counts do not conserve");
  }
  const itemKeys = [
    ...result.succeeded.items,
    ...result.failed.items,
    ...result.unresolved.items
  ].map((item) => text(item.itemKey, "foreach itemKey"));
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error("foreachOutcome itemKey values must be unique");
  }
  return result;
}

function retiredFacts(
  store: OperationalFactStore,
  runId: string
): OperationalFactRecord[] {
  const runFacts = store.listOperationalFactsForRun(runId);
  const facts = runFacts.filter(
    (fact) =>
      fact.namespace === FACT_NAMESPACE &&
      fact.schemaVersion === FACT_SCHEMA_VERSION &&
      fact.businessTimeZone === BUSINESS_TIME_ZONE
  );
  if (facts.length !== runFacts.length) {
    throw new Error("Run contains an unexpected operational fact namespace");
  }
  if (new Set(facts.map((fact) => fact.subjectId)).size !== facts.length) {
    throw new Error("Run contains duplicate retired-products subjects");
  }
  return facts;
}

function factRef(fact: OperationalFactRecord): JsonObject {
  return {
    factKey: fact.factKey,
    businessDate: fact.businessDate,
    subjectId: fact.subjectId,
    recordDigest: fact.recordDigest
  };
}

function aggregateOutput(
  store: OperationalFactStore,
  invocation: RuntimeInvocation
): JsonValue {
  const input = object(invocation.input, "aggregate input");
  exactKeys(
    input,
    ["foreachOutcome", "discoveredShops", "discoveredCount", "collectableCount"],
    "aggregate input"
  );
  const outcome = foreachOutcome(input.foreachOutcome ?? null);
  const discoveries = discoveredShops(input.discoveredShops);
  const discovered = integer(input.discoveredCount, "discoveredCount");
  const collectable = integer(input.collectableCount, "collectableCount");
  if (
    outcome.total !== discovered ||
    discoveries.length !== discovered ||
    discoveries.filter((shop) => shop.status === "active").length !== collectable
  ) {
    throw new Error("Discovery and foreach coverage do not match");
  }
  const discoveriesByKey = new Map(discoveries.map((shop) => [shop.key, shop]));
  const allOutcomeItems = [
    ...outcome.succeeded.items,
    ...outcome.failed.items,
    ...outcome.unresolved.items
  ];
  const outcomeItemKeys = allOutcomeItems.map((item) =>
    text(item.itemKey, "foreach itemKey")
  );
  if (
    outcomeItemKeys.some((itemKey) => !discoveriesByKey.has(itemKey)) ||
    new Set(outcomeItemKeys).size !== discoveriesByKey.size
  ) {
    throw new AllianceRetiredFactScopeMismatchError(
      "foreachOutcome does not cover the controlled discovery list"
    );
  }
  const facts = retiredFacts(store, invocation.identity.runId);
  const factsByKey = new Map(facts.map((fact) => [fact.factKey, fact]));
  const persistedMarkers: Array<{ itemKey: string; factKey: string }> = [];
  const skippedMarkers: string[] = [];
  for (const item of outcome.succeeded.items) {
    const itemKey = text(item.itemKey, "succeeded itemKey");
    const output = object(item.output ?? null, "succeeded item output");
    if (output.status === "skipped") {
      if (discoveriesByKey.get(itemKey)?.status !== "blocked") {
        throw new AllianceRetiredFactScopeMismatchError(
          "Only a blocked discovered shop can be skipped"
        );
      }
      skippedMarkers.push(itemKey);
      continue;
    }
    const reference = object(output.factRef ?? null, "persisted factRef");
    const factKey = text(reference.factKey, "persisted factRef.factKey");
    const fact = factsByKey.get(factKey);
    const record = fact
      ? object(fact.record, "persisted retired-products fact")
      : undefined;
    if (
      !fact ||
      reference.businessDate !== fact.businessDate ||
      reference.subjectId !== fact.subjectId ||
      output.businessDate !== fact.businessDate ||
      output.recordDigest !== fact.recordDigest ||
      output.status !== record?.status ||
      itemKey !== `id:${fact.subjectId}` ||
      discoveriesByKey.get(itemKey)?.status !== "active"
    ) {
      throw new AllianceRetiredFactScopeMismatchError(
        "A successful foreach marker does not reference a current Run fact"
      );
    }
    persistedMarkers.push({ itemKey, factKey });
  }
  if (
    new Set(persistedMarkers.map((marker) => marker.factKey)).size !== facts.length ||
    persistedMarkers.length !== facts.length
  ) {
    throw new Error("Current Run facts and successful foreach markers differ");
  }
  const nonCollectable = discovered - collectable;
  if (skippedMarkers.length !== nonCollectable) {
    throw new Error("Uncollectable shops and skipped markers differ");
  }
  const failedCount = outcome.failed.count + outcome.unresolved.count;
  for (const item of [...outcome.failed.items, ...outcome.unresolved.items]) {
    const itemKey = text(item.itemKey, "failed foreach itemKey");
    if (discoveriesByKey.get(itemKey)?.status !== "active") {
      throw new AllianceRetiredFactScopeMismatchError(
        "Only an active discovered shop can fail collection"
      );
    }
  }
  if (facts.length + failedCount !== collectable) {
    throw new Error("Collectable shop coverage does not conserve");
  }
  const records = facts.map((fact) => object(fact.record, "retired fact record"));
  const affectedShopCount = records.filter(
    (record) => integer(record.retiredCount, "fact retiredCount") > 0
  ).length;
  const retiredProductCount = records.reduce(
    (total, record) => total + integer(record.retiredCount, "fact retiredCount"),
    0
  );
  const status =
    facts.length === 0
      ? "failed"
      : failedCount > 0
        ? "partial"
        : retiredProductCount > 0
          ? "complete_with_items"
          : "complete_empty";
  const businessContext = store.getOperationalBusinessContext(
    invocation.identity.runId,
    BUSINESS_TIME_ZONE
  );
  const businessDate = facts[0]?.businessDate ?? businessContext.businessDate;
  const observedAt =
    facts.map((fact) => fact.observedAt).sort().at(-1) ?? businessContext.anchorAt;
  const marker = (item: JsonObject): JsonObject => ({
    itemKey: text(item.itemKey, "foreach itemKey")
  });
  return {
    status,
    businessDate,
    observedAt,
    discoveredCount: discovered,
    collectableCount: collectable,
    attemptedCount: collectable,
    persistedCount: facts.length,
    failedCount,
    skippedCount: nonCollectable,
    affectedShopCount,
    retiredProductCount,
    factRefs: facts.map(factRef),
    shops: records.map((record) => ({
      shop: record.shop ?? null,
      status: record.status ?? null,
      retiredCount: record.retiredCount ?? null
    })),
    foreachOutcome: {
      total: outcome.total,
      succeeded: {
        count: outcome.succeeded.count,
        items: [
          ...persistedMarkers.map((item) => ({ ...item, status: "persisted" })),
          ...skippedMarkers.map((itemKey) => ({
            itemKey,
            status: "uncollectable"
          }))
        ].sort((left, right) => left.itemKey.localeCompare(right.itemKey))
      },
      failed: {
        count: outcome.failed.count,
        items: outcome.failed.items.map(marker)
      },
      unresolved: {
        count: outcome.unresolved.count,
        items: outcome.unresolved.items.map(marker)
      }
    }
  };
}

function publicationOutput(
  store: OperationalFactStore,
  invocation: RuntimeInvocation
): JsonValue {
  const input = object(invocation.input, "Dataset prepare input");
  exactKeys(input, ["daily"], "Dataset prepare input");
  const daily = object(input.daily ?? null, "daily");
  const status = text(daily.status, "daily.status");
  const quality = status === "partial" ? "partial" : "complete";
  if (
    status !== "complete_empty" &&
    status !== "complete_with_items" &&
    status !== "partial"
  ) {
    throw new Error("Only complete or partial retired-products facts can prepare a Dataset");
  }
  const facts = retiredFacts(store, invocation.identity.runId);
  if (facts.length === 0) throw new Error("Dataset publication requires facts");
  const references = array(daily.factRefs, "daily.factRefs").map((value) =>
    object(value, "daily factRef")
  );
  if (
    references.length !== facts.length ||
    references.some((reference, index) => {
      const fact = facts[index]!;
      return (
        reference.factKey !== fact.factKey ||
        reference.businessDate !== fact.businessDate ||
        reference.subjectId !== fact.subjectId ||
        reference.recordDigest !== fact.recordDigest
      );
    })
  ) {
    throw new Error("Daily fact references do not match current Run facts");
  }
  const coverage: OperationalDatasetCoverage = {
    discovered: integer(daily.discoveredCount, "daily.discoveredCount"),
    collectable: integer(daily.collectableCount, "daily.collectableCount"),
    attempted: integer(daily.attemptedCount, "daily.attemptedCount"),
    persisted: integer(daily.persistedCount, "daily.persistedCount"),
    failed: integer(daily.failedCount, "daily.failedCount"),
    skipped: integer(daily.skippedCount, "daily.skippedCount")
  };
  if (
    coverage.persisted !== facts.length ||
    coverage.collectable > coverage.discovered ||
    coverage.attempted !== coverage.collectable ||
    coverage.persisted + coverage.failed !== coverage.attempted ||
    coverage.discovered !== coverage.attempted + coverage.skipped ||
    (quality === "complete" &&
      (coverage.persisted !== coverage.collectable || coverage.failed !== 0)) ||
    (quality === "partial" &&
      (coverage.persisted === 0 || coverage.failed === 0))
  ) {
    throw new Error("Daily coverage is inconsistent");
  }
  const businessDate = text(daily.businessDate, "daily.businessDate");
  if (facts.some((fact) => fact.businessDate !== businessDate)) {
    throw new Error("Daily businessDate does not match current Run facts");
  }
  const observedAt = text(daily.observedAt, "daily.observedAt");
  const records = facts.map((fact) => fact.record);
  const canonicalRecords = canonicalJson(records);
  const canonicalBytes = Buffer.byteLength(canonicalRecords, "utf8");
  if (canonicalBytes > MAX_DATASET_CANONICAL_BYTES) {
    throw new AllianceRetiredDatasetTooLargeError(
      "Retired-products Dataset canonical source exceeds 16 MiB"
    );
  }
  const recordsDigest = contentDigest(records);
  const runToken = contentDigest(invocation.identity.runId).slice(7, 39);
  const [year, month, day] = businessDate.split("-");
  if (!year || !month || !day) throw new Error("daily.businessDate is invalid");
  const version = `${Number(year)}.${Number(month)}.${Number(day)}-run.${runToken}`;
  const publicationIntentId = `alliance-retired-dataset-intent:${runToken}`;
  const stagingId = `alliance-retired-dataset-staging:${runToken}`;
  const dataset = {
    apiVersion: "bpa.data/v1alpha1" as const,
    kind: "DatasetVersion" as const,
    metadata: {
      id: DATASET_ID,
      version,
      title: "抖店精选联盟每日清退商品",
      description: `Run ${invocation.identity.runId} 的${quality === "complete" ? "完整" : "部分"}逐店清退商品事实。`
    },
    profile: DOUDIAN_ALLIANCE_RETIRED_DATASET_PROFILE,
    source: {
      fileName: `doudian-alliance-retired-${businessDate}-${runToken}.json`,
      mediaType: "application/json",
      size: canonicalBytes,
      digest: recordsDigest
    },
    recordSchema: RETIRED_RECORD_SCHEMA,
    recordCount: records.length,
    recordsDigest
  };
  const audit = {
    id: `audit:alliance-retired-dataset:${runToken}`,
    action: "dataset.published",
    actor: "runtime:alliance-retired-data",
    target: `dataset:${DATASET_ID}@${version}`,
    detail: {
      runId: invocation.identity.runId,
      quality,
      coverage,
      factKeys: facts.map((fact) => fact.factKey),
      sourceCanonicalBytes: canonicalBytes,
      sourceDigest: recordsDigest
    },
    occurredAt: observedAt
  };
  const prepared = store.prepareOperationalDatasetPublication({
    publicationIntentId,
    runId: invocation.identity.runId,
    stagingId,
    dataset,
    factKeys: facts.map((fact) => fact.factKey),
    audit,
    quality,
    coverage,
    executionContext: executionContext(invocation),
    preparedAt: observedAt
  });
  return {
    status: "prepared",
    datasetStatus: prepared.quality,
    publicationIntentId: prepared.publicationIntentId,
    datasetId: prepared.dataset.metadata.id,
    version: prepared.dataset.metadata.version,
    recordCount: prepared.dataset.recordCount,
    recordsDigest: prepared.dataset.recordsDigest
  };
}

export class AllianceRetiredDataRuntimeProvider implements RuntimeProvider {
  readonly id = "alliance-retired-data";

  constructor(
    readonly store: OperationalFactStore,
    readonly now: () => Date = () => new Date()
  ) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    const rule = NODE_RULES.get(node.id);
    return rule !== undefined && rule.version === node.version;
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) {
      return {
        status: "cancelled",
        error: {
          code: "CANCELLED",
          message: "Retired-products data operation was cancelled.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    const rule = NODE_RULES.get(invocation.node.id);
    if (!rule || rule.version !== invocation.node.version) {
      return rejected(
        "ALLIANCE_RETIRED_DATA_NODE_UNSUPPORTED",
        "Retired-products data Node id and version are not exact."
      );
    }
    if (!permissionMatches(invocation, rule)) {
      return rejected(
        rule.permissionError,
        "Retired-products data permission snapshot is not exact."
      );
    }
    try {
      if (
        invocation.node.id ===
        "doudian.alliance.shop.retired-products.fact.persist"
      ) {
        const input = object(invocation.input, "fact persist input");
        exactKeys(input, ["scan"], "fact persist input");
        const projected = projectScan(input.scan ?? null);
        assertFactScope(invocation, projected.subjectId);
        const result = this.store.putOperationalFact({
          namespace: FACT_NAMESPACE,
          businessTimeZone: BUSINESS_TIME_ZONE,
          subjectId: projected.subjectId,
          schemaVersion: FACT_SCHEMA_VERSION,
          record: projected.record,
          observedAt: projected.observedAt,
          persistedAt: this.now().toISOString(),
          executionContext: executionContext(invocation)
        });
        const storedRecord = object(result.fact.record, "stored retired fact");
        const storedStatus = text(storedRecord.status, "stored retired status");
        if (
          storedStatus !== "complete_empty" &&
          storedStatus !== "complete_with_items"
        ) {
          throw new Error("Stored retired-products fact has an invalid status");
        }
        return succeeded({
          status: storedStatus,
          businessDate: result.fact.businessDate,
          shop: storedRecord.shop ?? null,
          observedAt: result.fact.observedAt,
          retiredCount: storedRecord.retiredCount ?? null,
          factRef: {
            factKey: result.fact.factKey,
            businessDate: result.fact.businessDate,
            subjectId: result.fact.subjectId
          },
          recordDigest: result.fact.recordDigest,
          inserted: result.status === "accepted"
        });
      }
      if (
        invocation.node.id === "doudian.alliance.retired-products.aggregate"
      ) {
        return succeeded(aggregateOutput(this.store, invocation));
      }
      return succeeded(publicationOutput(this.store, invocation));
    } catch (error) {
      if (error instanceof AllianceRetiredDatasetTooLargeError) {
        return rejected(
          "ALLIANCE_RETIRED_DATASET_TOO_LARGE",
          error.message
        );
      }
      if (error instanceof AllianceRetiredFactScopeMismatchError) {
        return rejected("ALLIANCE_RETIRED_FACT_SCOPE_MISMATCH", error.message);
      }
      if (error instanceof StaleFencingTokenError) {
        return rejected(
          invocation.node.id ===
            "doudian.alliance.shop.retired-products.fact.persist"
            ? "ALLIANCE_RETIRED_FACT_FENCE_INVALID"
            : invocation.node.id ===
                "doudian.alliance.retired-products.dataset.prepare"
              ? "ALLIANCE_RETIRED_DATASET_FENCE_INVALID"
              : "ALLIANCE_RETIRED_FACT_SCOPE_MISMATCH",
          error.message
        );
      }
      if (error instanceof OperationalFactConflictError) {
        return rejected(
          invocation.node.id ===
            "doudian.alliance.shop.retired-products.fact.persist"
            ? "ALLIANCE_RETIRED_FACT_IDEMPOTENCY_CONFLICT"
            : invocation.node.id ===
                "doudian.alliance.retired-products.dataset.prepare"
              ? "ALLIANCE_RETIRED_DATASET_INTENT_CONFLICT"
              : "ALLIANCE_RETIRED_FACT_DUPLICATE",
          error.message
        );
      }
      return failed(
        invocation.node.id ===
          "doudian.alliance.shop.retired-products.fact.persist"
          ? "ALLIANCE_RETIRED_FACT_INVALID"
          : invocation.node.id === "doudian.alliance.retired-products.aggregate"
            ? "DOUDIAN_ALLIANCE_OUTCOME_INVALID"
            : "ALLIANCE_RETIRED_DATASET_PREPARE_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
