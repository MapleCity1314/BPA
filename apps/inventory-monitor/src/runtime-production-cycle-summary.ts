const CONTROL_TIMEOUT_MS = 2_000;
const WORKFLOW_ID = "doudian.inventory.production-cycle";
const WORKFLOW_VERSION = "1.0.9";

interface ProductionCycleControlClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { requestId?: string; timeoutMs?: number }
  ): Promise<unknown>;
}

export interface InventoryPanelProductionCycle {
  readonly state:
    | "not-run"
    | "in-progress"
    | "not-produced"
    | "complete"
    | "degraded"
    | "partial"
    | "failed"
    | "rejected"
    | "cancelled";
  readonly workflowVersion: "1.0.9";
  readonly scheduledAt: string | null;
  readonly observedAt: string | null;
  readonly reasonCode: string | null;
  readonly coverage: {
    readonly expectedShops: number;
    readonly attemptedShops: number;
    readonly succeededShops: number;
    readonly failedShops: number;
    readonly unresolvedShops: number;
  } | null;
  readonly inventory: {
    readonly attemptedProducts: number;
    readonly persistedProducts: number;
    readonly failedProducts: number;
  } | null;
  readonly risk: {
    readonly attemptedProducts: number;
    readonly succeededProducts: number;
    readonly degradedProducts: number;
    readonly criticalProducts: number;
    readonly unknownProducts: number;
  } | null;
  readonly attentionRequired: boolean;
}

export type RuntimeProductionCycleSummaryProvider = () => Promise<
  InventoryPanelProductionCycle
>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  const result = record(value, "inventory production cycle response");
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in result)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  return value;
}

function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  return Number(value);
}

function counts<const K extends string>(
  value:unknown,
  keys:readonly K[],
  maximum:number
):Record<K,number> {
  const result = exact(value,keys);
  return Object.fromEntries(
    keys.map((key) => [key,count(result[key],maximum)])
  ) as Record<K,number>;
}

function base(value: unknown): Record<string, unknown> {
  const result = record(value, "inventory production cycle response");
  const workflow = exact(result.workflow, ["id", "version"]);
  if (
    result.projectionVersion !== "1" ||
    workflow.id !== WORKFLOW_ID ||
    workflow.version !== WORKFLOW_VERSION ||
    result.expectedShopCount !== 13
  ) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  return result;
}

function empty(
  state: InventoryPanelProductionCycle["state"],
  scheduledAt: string | null,
  reasonCode: string | null
): InventoryPanelProductionCycle {
  return {
    state,
    workflowVersion: WORKFLOW_VERSION,
    scheduledAt,
    observedAt: null,
    reasonCode,
    coverage: null,
    inventory: null,
    risk: null,
    attentionRequired: state !== "not-run" && state !== "in-progress"
  };
}

export function projectRuntimeProductionCycleSummary(
  value: unknown
): InventoryPanelProductionCycle {
  const result = base(value);
  if (result.state === "not-run") {
    exact(result, ["projectionVersion", "state", "workflow", "expectedShopCount"]);
    return empty("not-run", null, null);
  }
  if (result.state === "in-progress") {
    exact(result, ["projectionVersion", "state", "workflow", "expectedShopCount"],
      ["trigger", "run"]);
    if ((result.trigger === undefined) === (result.run === undefined)) {
      throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
    }
    const source = result.trigger === undefined
      ? exact(result.run, ["status", "scheduledAt", "createdAt", "updatedAt"])
      : exact(result.trigger, ["status", "scheduledAt"]);
    if (result.trigger === undefined) {
      if (![
        "created","validated","queued","running","waiting_browser",
        "waiting_assistance","waiting_human","paused","compensating"
      ].includes(String(source.status))) {
        throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
      }
      timestamp(source.createdAt);
      timestamp(source.updatedAt);
    } else if (!["pending","deferred","running"].includes(String(source.status))) {
      throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
    }
    return empty("in-progress", timestamp(source.scheduledAt), null);
  }
  if (result.state === "not-produced") {
    exact(result, [
      "projectionVersion", "state", "workflow", "expectedShopCount", "trigger",
      "reasonCode"
    ]);
    const trigger = exact(result.trigger, ["status", "terminalOutcome", "scheduledAt"]);
    if (
      trigger.status !== "terminal" ||
      !["blocked","failed","skipped","missed"].includes(
        String(trigger.terminalOutcome)
      ) ||
      result.reasonCode !== "TRIGGER_TERMINATED_BEFORE_RUN"
    ) {
      throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
    }
    return empty("not-produced", timestamp(trigger.scheduledAt), result.reasonCode);
  }
  if (result.state !== "available") {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  exact(result, [
    "projectionVersion", "state", "workflow", "expectedShopCount", "run", "summary"
  ]);
  const run = exact(result.run, ["status", "scheduledAt", "createdAt", "terminalAt"]);
  const scheduledAt = timestamp(run.scheduledAt);
  timestamp(run.createdAt);
  timestamp(run.terminalAt);
  if (!["succeeded","uncertain","failed","rejected","cancelled"]
    .includes(String(run.status))) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  const summary = record(result.summary, "inventory production cycle summary");
  if (summary.state === "not-produced") {
    exact(summary, ["state", "reasonCode"]);
    const expectedReason = run.status === "rejected"
      ? "RUN_REJECTED"
      : run.status === "cancelled"
        ? "RUN_CANCELLED_BEFORE_AGGREGATE"
        : run.status === "failed"
          ? "RUN_FAILED_BEFORE_AGGREGATE"
          : run.status === "uncertain"
            ? "RUN_UNCERTAIN_BEFORE_AGGREGATE"
            : undefined;
    if (summary.reasonCode !== expectedReason) {
      throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
    }
    const state = run.status === "rejected"
      ? "rejected"
      : run.status === "cancelled"
        ? "cancelled"
        : run.status === "failed"
          ? "failed"
          : "partial";
    return empty(state, scheduledAt, String(summary.reasonCode));
  }
  exact(summary, ["state", "cycle"]);
  if (summary.state !== "available") {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  const cycle = exact(summary.cycle, [
    "status", "observedAt", "coverage", "orders", "inventory", "risk", "shops",
    "attentionRequired"
  ]);
  if (!Array.isArray(cycle.shops) || cycle.shops.length !== 13 ||
    typeof cycle.attentionRequired !== "boolean") {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  const coverageCounts = counts(cycle.coverage, [
    "expectedShops","configuredShops","attemptedShops","succeededShops",
    "failedShops","unresolvedShops","canaryPassedShops","usableInventoryShops",
    "blockedShops","partialShops"
  ],13);
  const orderCounts = counts(cycle.orders, [
    "freshReusedShops","refreshedShops","fallbackShops","degradedShops"
  ],13);
  const inventoryCounts = counts(cycle.inventory, [
    "discoveredProducts","attemptedProducts","persistedProducts",
    "failedProducts","skippedProducts"
  ],3_250);
  const riskCounts = counts(cycle.risk, [
    "attemptedProducts","succeededProducts","degradedProducts","normalProducts",
    "warningProducts","criticalProducts","unknownProducts"
  ],3_250);
  const shops = cycle.shops.map((value) => {
    const item = exact(value, [
      "shop","status","ordersStatus","inventoryStatus","riskStatus",
      "discoveredProducts","attemptedProducts","persistedProducts",
      "failedProducts","skippedProducts"
    ]);
    const identity = exact(item.shop,["id","name"]);
    if (typeof identity.id !== "string" || !/^\d{5,30}$/u.test(identity.id) ||
      typeof identity.name !== "string" || !identity.name.trim() ||
      identity.name.length > 80 ||
      !["complete","degraded","partial","blocked"].includes(String(item.status)) ||
      !["fresh_reused","refreshed","degraded"].includes(String(item.ordersStatus)) ||
      !["complete","partial","blocked"].includes(String(item.inventoryStatus)) ||
      !["complete","degraded","not_run"].includes(String(item.riskStatus))) {
      throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
    }
    return {
      id:identity.id,name:identity.name,status:String(item.status),
      ordersStatus:String(item.ordersStatus),inventoryStatus:String(item.inventoryStatus),
      riskStatus:String(item.riskStatus),
      discoveredProducts:count(item.discoveredProducts,250),
      attemptedProducts:count(item.attemptedProducts,250),
      persistedProducts:count(item.persistedProducts,250),
      failedProducts:count(item.failedProducts,250),
      skippedProducts:count(item.skippedProducts,250)
    };
  });
  const sum = (key:"discoveredProducts"|"attemptedProducts"|"persistedProducts"|
    "failedProducts"|"skippedProducts") => shops.reduce(
      (total,item) => total+item[key],0
    );
  const blockedShops = shops.filter((item) => item.status === "blocked").length;
  const partialShops = shops.filter((item) => item.status === "partial").length;
  const degradedShops = shops.filter((item) => item.status === "degraded").length;
  const usableInventoryShops = shops.filter(
    (item) => item.inventoryStatus !== "blocked"
  ).length;
  const hasRiskFinding = riskCounts.warningProducts+riskCounts.criticalProducts+
    riskCounts.unknownProducts > 0;
  const derivedStatus = usableInventoryShops === 0
    ? "failed"
    : blockedShops > 0 || partialShops > 0
      ? "partial"
      : degradedShops > 0
        ? "complete_degraded"
        : "complete";
  const attentionRequired = derivedStatus !== "complete" || hasRiskFinding;
  const shopsConserve = shops.every((item) =>
    item.discoveredProducts === item.attemptedProducts &&
    item.attemptedProducts === item.persistedProducts+item.failedProducts+
      item.skippedProducts &&
    (item.status === "blocked"
      ? item.inventoryStatus === "blocked" && item.riskStatus === "not_run" &&
        item.attemptedProducts === 0
      : item.status === "partial"
        ? item.inventoryStatus === "partial" && item.riskStatus === "degraded"
        : item.status === "degraded"
          ? item.ordersStatus === "degraded" && item.inventoryStatus === "complete" &&
            item.riskStatus === "degraded"
          : item.ordersStatus !== "degraded" && item.inventoryStatus === "complete" &&
            item.riskStatus === "complete")
  );
  if (new Set(shops.map((item) => item.id)).size !== 13 ||
    new Set(shops.map((item) => item.name)).size !== 13 || !shopsConserve ||
    coverageCounts.expectedShops !== 13 || coverageCounts.configuredShops !== 13 ||
    coverageCounts.succeededShops+coverageCounts.failedShops+
      coverageCounts.unresolvedShops !== 13 ||
    coverageCounts.attemptedShops !== coverageCounts.succeededShops+
      coverageCounts.failedShops ||
    coverageCounts.canaryPassedShops !== usableInventoryShops ||
    coverageCounts.usableInventoryShops !== usableInventoryShops ||
    coverageCounts.blockedShops !== blockedShops ||
    coverageCounts.partialShops !== partialShops ||
    orderCounts.freshReusedShops !== shops.filter(
      (item) => item.ordersStatus === "fresh_reused"
    ).length ||
    orderCounts.refreshedShops !== shops.filter(
      (item) => item.ordersStatus === "refreshed"
    ).length ||
    orderCounts.degradedShops !== shops.filter(
      (item) => item.ordersStatus === "degraded"
    ).length || orderCounts.fallbackShops !== 0 ||
    inventoryCounts.discoveredProducts !== sum("discoveredProducts") ||
    inventoryCounts.attemptedProducts !== sum("attemptedProducts") ||
    inventoryCounts.persistedProducts !== sum("persistedProducts") ||
    inventoryCounts.failedProducts !== sum("failedProducts") ||
    inventoryCounts.skippedProducts !== sum("skippedProducts") ||
    riskCounts.attemptedProducts !== inventoryCounts.persistedProducts ||
    riskCounts.attemptedProducts !== riskCounts.succeededProducts+
      riskCounts.degradedProducts ||
    riskCounts.succeededProducts !== riskCounts.normalProducts+
      riskCounts.warningProducts+riskCounts.criticalProducts+riskCounts.unknownProducts ||
    cycle.status !== derivedStatus || cycle.attentionRequired !== attentionRequired ||
    run.status === "rejected" ||
    (run.status === "succeeded" && !["complete","complete_degraded"].includes(derivedStatus)) ||
    (run.status === "uncertain" && derivedStatus !== "partial") ||
    (run.status === "failed" && derivedStatus !== "failed")) {
    throw new Error("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  }
  const state = cycle.status === "complete"
    ? "complete"
    : cycle.status === "complete_degraded"
      ? "degraded"
      : cycle.status === "partial"
        ? "partial"
        : "failed";
  return {
    state,
    workflowVersion: WORKFLOW_VERSION,
    scheduledAt,
    observedAt: timestamp(cycle.observedAt),
    reasonCode: null,
    coverage: {
      expectedShops: coverageCounts.expectedShops,
      attemptedShops: coverageCounts.attemptedShops,
      succeededShops: coverageCounts.succeededShops,
      failedShops: coverageCounts.failedShops,
      unresolvedShops: coverageCounts.unresolvedShops
    },
    inventory: {
      attemptedProducts: inventoryCounts.attemptedProducts,
      persistedProducts: inventoryCounts.persistedProducts,
      failedProducts: inventoryCounts.failedProducts
    },
    risk: {
      attemptedProducts: riskCounts.attemptedProducts,
      succeededProducts: riskCounts.succeededProducts,
      degradedProducts: riskCounts.degradedProducts,
      criticalProducts: riskCounts.criticalProducts,
      unknownProducts: riskCounts.unknownProducts
    },
    attentionRequired: cycle.attentionRequired
  };
}

export function createRuntimeProductionCycleSummaryProvider(
  control: ProductionCycleControlClient
): RuntimeProductionCycleSummaryProvider {
  return async () => projectRuntimeProductionCycleSummary(
    await control.request(
      "inventory.production-cycle.latest",
      {},
      { timeoutMs: CONTROL_TIMEOUT_MS }
    )
  );
}
