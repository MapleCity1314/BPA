import type { JsonValue } from "@bpa/workflow-ir";

interface Shop {
  readonly id: string;
  readonly name: string;
}

export type InventorySourceShopResolutionErrorCode =
  | "INVENTORY_SOURCE_SHOP_INPUT_INVALID"
  | "INVENTORY_SOURCE_SHOP_NOT_CONFIGURED"
  | "INVENTORY_SOURCE_SHOP_AMBIGUOUS";

export class InventorySourceShopResolutionError extends Error {
  constructor(
    readonly code: InventorySourceShopResolutionErrorCode,
    message: string
  ) {
    super(message);
  }
}

interface Bucket {
  readonly count: number;
  readonly items: readonly Record<string, JsonValue>[];
}

function object(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function exactKeys(value: Record<string, JsonValue>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key,index) => key !== required[index])) {
    throw new Error(`${label} keys are not exact`);
  }
}

function integer(value: JsonValue | undefined, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function shop(value: JsonValue | undefined, label: string): Shop {
  const candidate = object(value,label);
  exactKeys(candidate,["id","name"],label);
  const id = text(candidate.id,`${label}.id`,30);
  const name = text(candidate.name,`${label}.name`,80);
  if (!/^[0-9]{5,30}$/u.test(id) || name.length < 2) throw new Error(`${label} is invalid`);
  return { id,name };
}

function normalizeShopName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[（(]\s*(?:当前|当前店铺)\s*[）)]$/u, "")
    .trim();
}

function stableShopNameHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8,"0");
}

export function validateInventoryProductionCycleConfiguration(
  expectedShopCount: JsonValue | undefined,
  configuredShopsValue: JsonValue | undefined
): readonly Shop[] {
  if (expectedShopCount !== 13 ||
    !Array.isArray(configuredShopsValue) ||
    configuredShopsValue.length !== 13) {
    throw new Error("configured shop count does not match expectedShopCount");
  }
  const configuredShops = configuredShopsValue.map((value,index) =>
    shop(value,`configuredShops[${index}]`)
  );
  if (new Set(configuredShops.map(({ id }) => id)).size !== 13 ||
    new Set(configuredShops.map(({ name }) => normalizeShopName(name))).size !== 13) {
    throw new Error("configured shops contain duplicate identity");
  }
  return configuredShops;
}

export function resolveInventoryProductionCycleSourceShop(
  observedShopValue: JsonValue | undefined,
  configuredShopsValue: JsonValue | undefined
): JsonValue {
  let observed: Record<string,JsonValue>;
  let configuredShops: readonly Shop[];
  try {
    observed = object(observedShopValue,"observedShop");
    exactKeys(observed,["id","name","identity_confirmed"],"observedShop");
    configuredShops = validateInventoryProductionCycleConfiguration(
      13,
      configuredShopsValue
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("duplicate identity")) {
      throw new InventorySourceShopResolutionError(
        "INVENTORY_SOURCE_SHOP_AMBIGUOUS",
        "Configured source shop identities are ambiguous."
      );
    }
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
      "Source shop resolution input is not exact."
    );
  }
  if (observed.identity_confirmed !== true) {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
      "Observed source shop identity is not confirmed."
    );
  }
  let observedId: string;
  let observedName: string;
  try {
    observedId = text(observed.id,"observedShop.id",30);
    observedName = text(observed.name,"observedShop.name",80);
  } catch {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
      "Observed source shop identity is invalid."
    );
  }
  const normalizedName = normalizeShopName(observedName);
  if (normalizedName.length < 2) {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
      "Observed source shop name is invalid."
    );
  }
  const nameMatches = configuredShops.filter(
    ({ name }) => normalizeShopName(name) === normalizedName
  );
  if (nameMatches.length > 1) {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_AMBIGUOUS",
      "Observed source shop name matches multiple configured shops."
    );
  }
  if (/^[0-9]{5,30}$/u.test(observedId)) {
    const idMatch = configuredShops.find(({ id }) => id === observedId);
    if (!idMatch || normalizeShopName(idMatch.name) !== normalizedName) {
      throw new InventorySourceShopResolutionError(
        "INVENTORY_SOURCE_SHOP_NOT_CONFIGURED",
        "Observed source shop does not match a configured shop."
      );
    }
    return { status:"resolved",shop:{ id:idMatch.id,name:idMatch.name } };
  }
  const expectedNameIdentity = `name:${stableShopNameHash(normalizedName)}`;
  if (!/^name:[0-9a-f]{8}$/u.test(observedId) || observedId !== expectedNameIdentity) {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
      "Observed source shop name identity is malformed."
    );
  }
  const match = nameMatches[0];
  if (!match) {
    throw new InventorySourceShopResolutionError(
      "INVENTORY_SOURCE_SHOP_NOT_CONFIGURED",
      "Observed source shop is not configured."
    );
  }
  return { status:"resolved",shop:{ id:match.id,name:match.name } };
}

function bucket(value: JsonValue | undefined, label: string, kind: "succeeded" | "failed" | "unresolved"): Bucket {
  const candidate = object(value,label);
  exactKeys(candidate,["count","items"],label);
  if (!Array.isArray(candidate.items)) throw new Error(`${label}.items is invalid`);
  const items = candidate.items.map((value,index) => {
    const item = object(value,`${label}.items[${index}]`);
    exactKeys(item,kind === "succeeded" ? ["itemKey","output"] : kind === "failed" ? ["itemKey","error"] : ["itemKey"],`${label}.items[${index}]`);
    text(item.itemKey,`${label}.items[${index}].itemKey`,200);
    return item;
  });
  const count = integer(candidate.count,`${label}.count`,13);
  if (count !== items.length) throw new Error(`${label}.count does not match items`);
  return { count,items };
}

function compactForecastRisk(value: JsonValue | undefined): {
  readonly status: "complete" | "partial";
  readonly attemptedProducts: number;
  readonly completedProducts: number;
  readonly partialProducts: number;
  readonly failedProducts: number;
  readonly severities: { readonly normal: number; readonly warning: number; readonly critical: number; readonly unknown: number };
} {
  const candidate = object(value,"forecastRisk");
  exactKeys(candidate,["status","attemptedProducts","completedProducts","partialProducts","failedProducts","forecastWrites","riskWrites","severities"],"forecastRisk");
  const status = candidate.status;
  if (status !== "complete" && status !== "partial") throw new Error("forecastRisk.status is invalid");
  const attemptedProducts = integer(candidate.attemptedProducts,"forecastRisk.attemptedProducts",250);
  const completedProducts = integer(candidate.completedProducts,"forecastRisk.completedProducts",250);
  const partialProducts = integer(candidate.partialProducts,"forecastRisk.partialProducts",250);
  const failedProducts = integer(candidate.failedProducts,"forecastRisk.failedProducts",250);
  if (attemptedProducts !== completedProducts + partialProducts + failedProducts) throw new Error("forecastRisk product counts do not conserve");
  const writes = (value: JsonValue | undefined, label: string) => {
    const result = object(value,label);
    exactKeys(result,["attempted","persisted"],label);
    const attempted = integer(result.attempted,`${label}.attempted`,100_000);
    const persisted = integer(result.persisted,`${label}.persisted`,100_000);
    if (persisted > attempted) throw new Error(`${label} counts are invalid`);
    return { attempted,persisted };
  };
  writes(candidate.forecastWrites,"forecastRisk.forecastWrites");
  const riskWrites = writes(candidate.riskWrites,"forecastRisk.riskWrites");
  if (riskWrites.attempted > attemptedProducts || riskWrites.persisted !== completedProducts) throw new Error("risk write counts do not conserve");
  const severityObject = object(candidate.severities,"forecastRisk.severities");
  exactKeys(severityObject,["normal","warning","critical","unknown"],"forecastRisk.severities");
  const severities = {
    normal:integer(severityObject.normal,"severities.normal",250),
    warning:integer(severityObject.warning,"severities.warning",250),
    critical:integer(severityObject.critical,"severities.critical",250),
    unknown:integer(severityObject.unknown,"severities.unknown",250)
  };
  if (severities.normal + severities.warning + severities.critical + severities.unknown !== completedProducts) {
    throw new Error("severity counts do not conserve");
  }
  if (status === "complete" && (partialProducts !== 0 || failedProducts !== 0)) throw new Error("complete forecastRisk contains failures");
  if (status === "partial" && partialProducts + failedProducts === 0) throw new Error("partial forecastRisk contains no degradation");
  return { status,attemptedProducts,completedProducts,partialProducts,failedProducts,severities };
}

export function aggregateInventoryProductionCycle(inputValue: JsonValue, observedAt: string): JsonValue {
  const input = object(inputValue,"production cycle input");
  exactKeys(input,["expectedShopCount","configuredShops","sourceShop","foreachOutcome"],"production cycle input");
  const configuredShops = validateInventoryProductionCycleConfiguration(
    input.expectedShopCount,
    input.configuredShops
  );
  const sourceShop = shop(input.sourceShop,"sourceShop");
  const outcome = object(input.foreachOutcome,"foreachOutcome");
  exactKeys(outcome,["total","succeeded","failed","unresolved"],"foreachOutcome");
  if (outcome.total !== 13) throw new Error("foreachOutcome does not cover configured shops");
  const succeeded = bucket(outcome.succeeded,"foreachOutcome.succeeded","succeeded");
  const failed = bucket(outcome.failed,"foreachOutcome.failed","failed");
  const unresolved = bucket(outcome.unresolved,"foreachOutcome.unresolved","unresolved");
  if (succeeded.count + failed.count + unresolved.count !== 13) throw new Error("foreachOutcome counts do not conserve");
  const itemMap = new Map<string,{ readonly kind:"succeeded"|"failed"|"unresolved"; readonly item:Record<string,JsonValue> }>();
  for (const [kind,items] of [["succeeded",succeeded.items],["failed",failed.items],["unresolved",unresolved.items]] as const) {
    for (const item of items) {
      const itemKey = text(item.itemKey,`${kind}.itemKey`,200);
      if (itemMap.has(itemKey) || !configuredShops.some(({ id }) => id === itemKey)) throw new Error("foreachOutcome itemKey is invalid");
      itemMap.set(itemKey,{ kind,item });
    }
  }
  const shopSummaries = configuredShops.map((configuredShop) => {
    const entry = itemMap.get(configuredShop.id);
    if (!entry) throw new Error("foreachOutcome omitted a configured shop");
    if (entry.kind !== "succeeded") {
      return {
        shop:configuredShop,status:"blocked",ordersStatus:"degraded",inventoryStatus:"blocked",riskStatus:"not_run",
        discoveredProducts:0,attemptedProducts:0,persistedProducts:0,failedProducts:0,skippedProducts:0,
        risk:{ attempted:0,completed:0,degraded:0,normal:0,warning:0,critical:0,unknown:0 }
      };
    }
    const output = object(entry.item.output,"shop output");
    exactKeys(output,["shop","ordersStatus","scopeStatus","snapshots","forecastRisk"],"shop output");
    const outputShop = shop(output.shop,"shop output.shop");
    if (outputShop.id !== configuredShop.id || outputShop.name !== configuredShop.name) throw new Error("shop output identity does not match");
    const ordersStatus = output.ordersStatus;
    if (ordersStatus !== "fresh_reused" && ordersStatus !== "refreshed" && ordersStatus !== "degraded") throw new Error("ordersStatus is invalid");
    const scopeStatus = output.scopeStatus;
    if (scopeStatus !== "complete" && scopeStatus !== "inconsistent" && scopeStatus !== "blocked") throw new Error("scopeStatus is invalid");
    const snapshots = object(output.snapshots,"shop output.snapshots");
    exactKeys(snapshots,["attempted","persisted","failed","unresolved"],"shop output.snapshots");
    const attempted = integer(snapshots.attempted,"snapshots.attempted",250);
    const persisted = integer(snapshots.persisted,"snapshots.persisted",250);
    const snapshotFailed = integer(snapshots.failed,"snapshots.failed",250);
    const snapshotUnresolved = integer(snapshots.unresolved,"snapshots.unresolved",250);
    if (attempted !== persisted + snapshotFailed + snapshotUnresolved) throw new Error("snapshot counts do not conserve");
    if (scopeStatus !== "complete") {
      if (attempted !== 0 || output.forecastRisk !== null) throw new Error("blocked scope contains write results");
      return {
        shop:configuredShop,status:"blocked",ordersStatus,inventoryStatus:"blocked",riskStatus:"not_run",
        discoveredProducts:0,attemptedProducts:0,persistedProducts:0,failedProducts:0,skippedProducts:0,
        risk:{ attempted:0,completed:0,degraded:0,normal:0,warning:0,critical:0,unknown:0 }
      };
    }
    const forecastRisk = compactForecastRisk(output.forecastRisk);
    if (forecastRisk.attemptedProducts !== persisted) throw new Error("forecastRisk does not cover persisted snapshots");
    const partial = snapshotFailed + snapshotUnresolved > 0 || forecastRisk.status === "partial";
    return {
      shop:configuredShop,
      status:partial ? "partial" : ordersStatus === "degraded" ? "degraded" : "complete",
      ordersStatus,
      inventoryStatus:partial ? "partial" : "complete",
      riskStatus:partial || ordersStatus === "degraded" ? "degraded" : "complete",
      discoveredProducts:attempted,
      attemptedProducts:attempted,
      persistedProducts:persisted,
      failedProducts:snapshotFailed + snapshotUnresolved,
      skippedProducts:0,
      risk:{
        attempted:forecastRisk.attemptedProducts,
        completed:forecastRisk.completedProducts,
        degraded:forecastRisk.partialProducts + forecastRisk.failedProducts,
        normal:forecastRisk.severities.normal,
        warning:forecastRisk.severities.warning,
        critical:forecastRisk.severities.critical,
        unknown:forecastRisk.severities.unknown
      }
    };
  });
  const sum = (select:(summary:(typeof shopSummaries)[number]) => number) => shopSummaries.reduce((total,summary) => total + select(summary),0);
  const usableInventoryShops = shopSummaries.filter(({ inventoryStatus }) => inventoryStatus !== "blocked").length;
  const blockedShops = shopSummaries.filter(({ status }) => status === "blocked").length;
  const partialShops = shopSummaries.filter(({ status }) => status === "partial").length;
  const risk = {
    attemptedProducts:sum((summary) => summary.risk.attempted),
    succeededProducts:sum((summary) => summary.risk.completed),
    degradedProducts:sum((summary) => summary.risk.degraded),
    normalProducts:sum((summary) => summary.risk.normal),
    warningProducts:sum((summary) => summary.risk.warning),
    criticalProducts:sum((summary) => summary.risk.critical),
    unknownProducts:sum((summary) => summary.risk.unknown)
  };
  const hasRiskFinding = risk.warningProducts + risk.criticalProducts + risk.unknownProducts > 0;
  const status = usableInventoryShops === 0 ? "failed"
    : blockedShops > 0 || partialShops > 0 ? "partial"
      : shopSummaries.some((summary) => summary.status === "degraded") ? "complete_degraded" : "complete";
  const attentionRequired = status !== "complete" || hasRiskFinding;
  return {
    status,observedAt,sourceShop,
    coverage:{
      expectedShops:13,configuredShops:13,attemptedShops:succeeded.count + failed.count,
      succeededShops:succeeded.count,failedShops:failed.count,unresolvedShops:unresolved.count,
      canaryPassedShops:usableInventoryShops,usableInventoryShops,blockedShops,partialShops
    },
    orders:{
      freshReusedShops:shopSummaries.filter((summary) => summary.ordersStatus === "fresh_reused").length,
      refreshedShops:shopSummaries.filter((summary) => summary.ordersStatus === "refreshed").length,
      fallbackShops:0,
      degradedShops:shopSummaries.filter((summary) => summary.ordersStatus === "degraded").length
    },
    inventory:{
      discoveredProducts:sum((summary) => summary.discoveredProducts),
      attemptedProducts:sum((summary) => summary.attemptedProducts),
      persistedProducts:sum((summary) => summary.persistedProducts),
      failedProducts:sum((summary) => summary.failedProducts),
      skippedProducts:sum((summary) => summary.skippedProducts)
    },
    risk,
    shops:shopSummaries.map(({ risk:_risk,...summary }) => summary),
    attentionRequired,
    ...(attentionRequired ? { operationalAttentionMarker:{
      version:"1",kind:"business-finding",
      code:hasRiskFinding ? "inventory-risk-finding" : "inventory-production-cycle-degraded"
    } } : {})
  } as unknown as JsonValue;
}
