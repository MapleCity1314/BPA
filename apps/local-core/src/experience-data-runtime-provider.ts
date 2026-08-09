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
import { canonicalJson, contentDigest } from "@bpa/compiler";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const FACT_NAMESPACE = "doudian.experience.shop-snapshot";
const FACT_SCHEMA_VERSION = "1.0.0";
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DATASET_ID = "doudian-experience-daily";

export const DOUDIAN_EXPERIENCE_DATASET_PROFILE = Object.freeze({
  id: "doudian-experience-v1",
  version: "1.0.0"
});

const EXPERIENCE_RECORD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "businessDate",
    "status",
    "shop",
    "observedAt",
    "sourceUpdatedAt",
    "summary",
    "dimensions",
    "evidence"
  ],
  properties: {
    id: { type: "string", pattern: "^[0-9]{5,30}$" },
    businessDate: { type: "string", format: "date" },
    status: { enum: ["complete", "no_score"] },
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
    sourceUpdatedAt: { type: ["string", "null"], format: "date-time" },
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "totalScore",
        "totalScoreRaw",
        "level",
        "industry",
        "orders30d",
        "orders30dRaw"
      ],
      properties: {
        totalScore: { type: ["number", "null"] },
        totalScoreRaw: { type: ["string", "null"] },
        level: { type: ["string", "null"] },
        industry: { type: ["string", "null"] },
        orders30d: { type: ["number", "null"] },
        orders30dRaw: { type: ["string", "null"] }
      }
    },
    dimensions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "score", "scoreRaw", "metrics"],
        properties: {
          key: { enum: ["goods", "logistics", "service"] },
          label: { type: "string" },
          score: { type: ["number", "null"] },
          scoreRaw: { type: ["string", "null"] },
          metrics: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "key",
                "label",
                "rawValue",
                "value",
                "unit",
                "score",
                "scoreRaw",
                "weight",
                "weightRaw",
                "numerator",
                "denominator",
                "change",
                "note"
              ],
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                rawValue: { type: "string" },
                value: { type: ["number", "string", "null"] },
                unit: { type: ["string", "null"] },
                score: { type: ["number", "null"] },
                scoreRaw: { type: ["string", "null"] },
                weight: { type: ["number", "null"] },
                weightRaw: { type: ["string", "null"] },
                numerator: { type: ["number", "null"] },
                denominator: { type: ["number", "null"] },
                change: { type: ["number", "string", "null"] },
                note: { type: ["string", "null"] }
              }
            }
          }
        }
      }
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["pageUrl", "capturedAt"],
      properties: {
        pageUrl: {
          const: "https://fxg.jinritemai.com/ffa/eco/experience-score"
        },
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
    "doudian.experience.shop.fact.persist",
    {
      version: "1.0.0",
      riskLevel: "R1",
      permission: "experience.fact.write",
      permissionError: "EXPERIENCE_FACT_PERMISSION_MISMATCH"
    }
  ],
  [
    "doudian.experience.daily.aggregate",
    {
      version: "2.0.0",
      riskLevel: "R0",
      permission: "experience.fact.read",
      permissionError: "EXPERIENCE_FACT_PERMISSION_MISMATCH"
    }
  ],
  [
    "doudian.experience.daily.dataset.prepare",
    {
      version: "1.0.0",
      riskLevel: "R1",
      permission: "experience.dataset.prepare",
      permissionError: "EXPERIENCE_DATASET_PERMISSION_MISMATCH"
    }
  ]
]);

type JsonObject = Record<string, JsonValue>;

class ExperienceFactScopeMismatchError extends Error {}

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

function executionContext(invocation: RuntimeInvocation): OperationalExecutionContext {
  return {
    invocationId: invocation.invocationId,
    identity: invocation.identity,
    node: invocation.node,
    idempotencyKey: invocation.idempotencyKey,
    fencingToken: invocation.fencingToken
  };
}

function assertFactScope(invocation: RuntimeInvocation, subjectId: string): void {
  const scope = invocation.identity.scopePath.at(-1);
  const expectedItemKey = `id:${subjectId}`;
  if (
    !scope ||
    scope.foreachStepKey !== "collect_shops" ||
    scope.itemKey !== expectedItemKey ||
    invocation.identity.iterationKey !== expectedItemKey
  ) {
    throw new ExperienceFactScopeMismatchError(
      "Experience fact subject does not match the collect_shops iteration identity"
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

function permissionMatches(invocation: RuntimeInvocation, rule: NodeRule): boolean {
  return (
    invocation.permissionSnapshot.riskLevel === rule.riskLevel &&
    invocation.permissionSnapshot.permissions.length === 1 &&
    invocation.permissionSnapshot.permissions[0] === rule.permission &&
    invocation.permissionSnapshot.domains.length === 0
  );
}

function safePageUrl(value: JsonValue | undefined): string {
  const candidate = text(value, "snapshot.evidence.pageUrl");
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://fxg.jinritemai.com" ||
    url.pathname !== "/ffa/eco/experience-score" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("snapshot.evidence.pageUrl is outside the experience page");
  }
  return `${url.origin}${url.pathname}`;
}

function projectMetric(value: JsonValue): JsonObject {
  const metric = object(value, "snapshot dimension metric");
  return {
    key: metric.key ?? null,
    label: metric.label ?? null,
    rawValue: metric.rawValue ?? null,
    value: metric.value ?? null,
    unit: metric.unit ?? null,
    score: metric.score ?? null,
    scoreRaw: metric.scoreRaw ?? null,
    weight: metric.weight ?? null,
    weightRaw: metric.weightRaw ?? null,
    numerator: metric.numerator ?? null,
    denominator: metric.denominator ?? null,
    change: metric.change ?? null,
    note: metric.note ?? null
  };
}

function projectSnapshot(value: JsonValue): {
  readonly subjectId: string;
  readonly observedAt: string;
  readonly record: JsonObject;
} {
  const snapshot = object(value, "snapshot");
  exactKeys(
    snapshot,
    [
      "status",
      "shop",
      "observedAt",
      "sourceUpdatedAt",
      "summary",
      "dimensions",
      "evidence",
      "diagnostics",
      "formMutations"
    ],
    "snapshot"
  );
  const status = text(snapshot.status, "snapshot.status");
  if (status !== "complete" && status !== "no_score") {
    throw new Error("snapshot.status is not persistable");
  }
  const shop = object(snapshot.shop ?? null, "snapshot.shop");
  const subjectId = text(shop.id, "snapshot.shop.id");
  const shopName = text(shop.name, "snapshot.shop.name");
  const observedAt = text(snapshot.observedAt, "snapshot.observedAt");
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("snapshot.observedAt must be a timestamp");
  }
  const summary = object(snapshot.summary ?? null, "snapshot.summary");
  const dimensions = array(snapshot.dimensions, "snapshot.dimensions").map(
    (entry) => {
      const dimension = object(entry, "snapshot dimension");
      return {
        key: dimension.key ?? null,
        label: dimension.label ?? null,
        score: dimension.score ?? null,
        scoreRaw: dimension.scoreRaw ?? null,
        metrics: array(dimension.metrics, "snapshot dimension metrics").map(
          projectMetric
        )
      };
    }
  );
  const evidence = object(snapshot.evidence ?? null, "snapshot.evidence");
  return {
    subjectId,
    observedAt,
    record: {
      id: subjectId,
      status,
      shop: { id: subjectId, name: shopName },
      observedAt,
      sourceUpdatedAt: snapshot.sourceUpdatedAt ?? null,
      summary: {
        totalScore: summary.totalScore ?? null,
        totalScoreRaw: summary.totalScoreRaw ?? null,
        level: summary.level ?? null,
        industry: summary.industry ?? null,
        orders30d: summary.orders30d ?? null,
        orders30dRaw: summary.orders30dRaw ?? null
      },
      dimensions,
      evidence: {
        pageUrl: safePageUrl(evidence.pageUrl),
        capturedAt: evidence.capturedAt ?? null
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
    const id = shop.id === undefined ? undefined : text(shop.id, "discovered shop.id");
    if (status === "active" && !id) {
      throw new ExperienceFactScopeMismatchError(
        "An active discovered shop requires a stable numeric id"
      );
    }
    const expectedKey = id ? `id:${id}` : `name:${normalizedShopName(name)}`;
    if (key !== expectedKey) {
      throw new Error("discovered shop.key does not match its identity");
    }
    return { key, ...(id ? { id } : {}), status } satisfies DiscoveredShop;
  });
  if (shops.length === 0 || new Set(shops.map((shop) => shop.key)).size !== shops.length) {
    throw new Error("discoveredShops must contain unique shops");
  }
  return shops;
}

function foreachBucket(value: JsonValue | undefined, label: string): ForeachBucket {
  const bucket = object(value ?? null, label);
  exactKeys(bucket, ["count", "items"], label);
  const items = array(bucket.items, `${label}.items`).map((item) =>
    object(item, `${label} item`)
  );
  const count = integer(bucket.count, `${label}.count`);
  if (count !== items.length) throw new Error(`${label}.count does not match items`);
  return { count, items };
}

function foreachOutcome(value: JsonValue): ForeachOutcome {
  const outcome = object(value, "foreachOutcome");
  exactKeys(outcome, ["total", "succeeded", "failed", "unresolved"], "foreachOutcome");
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

function experienceFacts(store: OperationalFactStore, runId: string): OperationalFactRecord[] {
  const runFacts = store.listOperationalFactsForRun(runId);
  const facts = runFacts
    .filter(
      (fact) =>
        fact.namespace === FACT_NAMESPACE &&
        fact.schemaVersion === FACT_SCHEMA_VERSION &&
        fact.businessTimeZone === BUSINESS_TIME_ZONE
    );
  if (facts.length !== runFacts.length) {
    throw new Error("Run contains an unexpected operational fact namespace");
  }
  if (new Set(facts.map((fact) => fact.subjectId)).size !== facts.length) {
    throw new Error("Run contains duplicate experience subjects");
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
    [
      "foreachOutcome",
      "discoveredShops",
      "discoveredCount",
      "collectableCount"
    ],
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
  const discoveriesByKey = new Map(
    discoveries.map((shop) => [shop.key, shop])
  );
  const outcomeItemKeys = [
    ...outcome.succeeded.items,
    ...outcome.failed.items,
    ...outcome.unresolved.items
  ].map((item) => text(item.itemKey, "foreach itemKey"));
  if (
    outcomeItemKeys.some((itemKey) => !discoveriesByKey.has(itemKey)) ||
    new Set(outcomeItemKeys).size !== discoveriesByKey.size
  ) {
    throw new ExperienceFactScopeMismatchError(
      "foreachOutcome does not cover the controlled discovery list"
    );
  }
  const facts = experienceFacts(store, invocation.identity.runId);
  const factsByKey = new Map(facts.map((fact) => [fact.factKey, fact]));
  const persistedMarkers: Array<{ itemKey: string; factKey: string }> = [];
  const skippedMarkers: string[] = [];
  for (const item of outcome.succeeded.items) {
    const itemKey = text(item.itemKey, "succeeded itemKey");
    const output = object(item.output ?? null, "succeeded item output");
    if (output.status === "skipped") {
      if (discoveriesByKey.get(itemKey)?.status !== "blocked") {
        throw new ExperienceFactScopeMismatchError(
          "Only a blocked discovered shop can be skipped"
        );
      }
      skippedMarkers.push(itemKey);
      continue;
    }
    const reference = object(output.factRef ?? null, "persisted factRef");
    const factKey = text(reference.factKey, "persisted factRef.factKey");
    const fact = factsByKey.get(factKey);
    const record = fact ? object(fact.record, "persisted fact record") : undefined;
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
      throw new ExperienceFactScopeMismatchError(
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
  const failed = outcome.failed.count + outcome.unresolved.count;
  for (const item of [...outcome.failed.items, ...outcome.unresolved.items]) {
    const itemKey = text(item.itemKey, "failed foreach itemKey");
    if (discoveriesByKey.get(itemKey)?.status !== "active") {
      throw new ExperienceFactScopeMismatchError(
        "Only an active discovered shop can fail collection"
      );
    }
  }
  if (facts.length + failed !== collectable) {
    throw new Error("Collectable shop coverage does not conserve");
  }
  const attempted = collectable;
  const skipped = nonCollectable;
  const status =
    facts.length === 0 ? "failed" : failed === 0 ? "complete" : "partial";
  const businessContext = store.getOperationalBusinessContext(
    invocation.identity.runId,
    BUSINESS_TIME_ZONE
  );
  const businessDate = facts[0]?.businessDate ?? businessContext.businessDate;
  const observedAt =
    facts.map((fact) => fact.observedAt).sort().at(-1) ??
    businessContext.anchorAt;
  const marker = (item: JsonObject): JsonObject => ({
    itemKey: text(item.itemKey, "foreach itemKey")
  });
  return {
    status,
    businessDate,
    observedAt,
    discoveredCount: discovered,
    collectableCount: collectable,
    attemptedCount: attempted,
    persistedCount: facts.length,
    failedCount: failed,
    skippedCount: skipped,
    factRefs: facts.map(factRef),
    foreachOutcome: {
      total: outcome.total,
      succeeded: {
        count: outcome.succeeded.count,
        items: [
          ...persistedMarkers.map((item) => ({ ...item, status: "persisted" })),
          ...skippedMarkers.map((itemKey) => ({ itemKey, status: "uncollectable" }))
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
  if (status !== "complete" && status !== "partial") {
    throw new Error("Only complete or partial daily facts can prepare a Dataset");
  }
  const facts = experienceFacts(store, invocation.identity.runId);
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
    coverage.attempted > coverage.collectable ||
    coverage.attempted !== coverage.collectable ||
    coverage.persisted + coverage.failed !== coverage.attempted ||
    coverage.discovered !== coverage.attempted + coverage.skipped ||
    (status === "complete" &&
      (coverage.persisted !== coverage.collectable ||
        coverage.failed !== 0)) ||
    (status === "partial" &&
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
  const recordsDigest = contentDigest(records);
  const runToken = contentDigest(invocation.identity.runId).slice(7, 39);
  const [year, month, day] = businessDate.split("-");
  if (!year || !month || !day) throw new Error("daily.businessDate is invalid");
  const version = `${Number(year)}.${Number(month)}.${Number(day)}-run.${runToken}`;
  const publicationIntentId = `experience-dataset-intent:${runToken}`;
  const stagingId = `experience-dataset-staging:${runToken}`;
  const dataset = {
    apiVersion: "bpa.data/v1alpha1" as const,
    kind: "DatasetVersion" as const,
    metadata: {
      id: DATASET_ID,
      version,
      title: "抖店每日体验分",
      description: `Run ${invocation.identity.runId} 的${status === "complete" ? "完整" : "部分"}单店体验分事实。`
    },
    profile: DOUDIAN_EXPERIENCE_DATASET_PROFILE,
    source: {
      fileName: `doudian-experience-${businessDate}-${runToken}.json`,
      mediaType: "application/json",
      size: Buffer.byteLength(canonicalRecords, "utf8"),
      digest: recordsDigest
    },
    recordSchema: EXPERIENCE_RECORD_SCHEMA,
    recordCount: records.length,
    recordsDigest
  };
  const audit = {
    id: `audit:experience-dataset:${runToken}`,
    action: "dataset.published",
    actor: "runtime:experience-data",
    target: `dataset:${DATASET_ID}@${version}`,
    detail: {
      runId: invocation.identity.runId,
      quality: status,
      coverage,
      factKeys: facts.map((fact) => fact.factKey),
      sourceCanonicalBytes: Buffer.byteLength(canonicalRecords, "utf8"),
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
    quality: status,
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

export class ExperienceDataRuntimeProvider implements RuntimeProvider {
  readonly id = "experience-data";

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
          message: "Experience data operation was cancelled.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    const rule = NODE_RULES.get(invocation.node.id);
    if (!rule || rule.version !== invocation.node.version) {
      return rejected(
        "EXPERIENCE_DATA_NODE_UNSUPPORTED",
        "Experience data Node id and version are not exact."
      );
    }
    if (!permissionMatches(invocation, rule)) {
      return rejected(
        rule.permissionError,
        "Experience data permission snapshot is not exact."
      );
    }
    try {
      if (invocation.node.id === "doudian.experience.shop.fact.persist") {
        const input = object(invocation.input, "fact persist input");
        exactKeys(input, ["snapshot"], "fact persist input");
        const projected = projectSnapshot(input.snapshot ?? null);
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
        const storedRecord = object(result.fact.record, "stored experience fact");
        const storedStatus = text(storedRecord.status, "stored experience status");
        if (storedStatus !== "complete" && storedStatus !== "no_score") {
          throw new Error("Stored experience fact has an invalid status");
        }
        const storedShop = object(storedRecord.shop ?? null, "stored experience shop");
        return succeeded({
          status: storedStatus,
          businessDate: result.fact.businessDate,
          shop: storedShop,
          observedAt: result.fact.observedAt,
          factRef: {
            factKey: result.fact.factKey,
            businessDate: result.fact.businessDate,
            subjectId: result.fact.subjectId
          },
          recordDigest: result.fact.recordDigest,
          inserted: result.status === "accepted"
        });
      }
      if (invocation.node.id === "doudian.experience.daily.aggregate") {
        return succeeded(aggregateOutput(this.store, invocation));
      }
      return succeeded(publicationOutput(this.store, invocation));
    } catch (error) {
      if (error instanceof ExperienceFactScopeMismatchError) {
        return rejected("EXPERIENCE_FACT_SCOPE_MISMATCH", error.message);
      }
      if (error instanceof StaleFencingTokenError) {
        return rejected(
          invocation.node.id === "doudian.experience.shop.fact.persist"
            ? "EXPERIENCE_FACT_FENCE_INVALID"
            : invocation.node.id === "doudian.experience.daily.dataset.prepare"
              ? "EXPERIENCE_DATASET_FENCE_INVALID"
              : "EXPERIENCE_FACT_SCOPE_MISMATCH",
          error.message
        );
      }
      if (error instanceof OperationalFactConflictError) {
        return rejected(
          invocation.node.id === "doudian.experience.shop.fact.persist"
            ? "EXPERIENCE_FACT_IDEMPOTENCY_CONFLICT"
            : invocation.node.id === "doudian.experience.daily.dataset.prepare"
              ? "EXPERIENCE_DATASET_INTENT_CONFLICT"
              : "EXPERIENCE_FACT_DUPLICATE",
          error.message
        );
      }
      return failed(
        invocation.node.id === "doudian.experience.shop.fact.persist"
          ? "EXPERIENCE_FACT_INVALID"
          : invocation.node.id === "doudian.experience.daily.aggregate"
            ? "DOUDIAN_EXPERIENCE_OUTCOME_INVALID"
            : "EXPERIENCE_DATASET_PREPARE_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
