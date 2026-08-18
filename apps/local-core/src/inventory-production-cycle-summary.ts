import type {
  TriggeredWorkflowExecutionRecord,
  TriggerOccurrenceStatus,
  TriggerTerminalOutcome
} from "@bpa/persistence";

const APP_ID="inventory-monitor";
const WORKFLOW_ID="doudian.inventory.production-cycle";
const WORKFLOW_VERSION="1.0.1";
const EXPECTED_SHOP_COUNT=13;

type CycleStatus="complete"|"complete_degraded"|"partial"|"failed";
type RunStatus="succeeded"|"uncertain"|"failed"|"rejected"|"cancelled";
type ActiveRunStatus=
  | "created"|"validated"|"queued"|"running"|"waiting_browser"
  | "waiting_assistance"|"waiting_human"|"paused"|"compensating";

interface Shop {
  readonly id:string;
  readonly name:string;
}

interface ShopSummary {
  readonly shop:Shop;
  readonly status:"complete"|"degraded"|"partial"|"blocked";
  readonly ordersStatus:"fresh_reused"|"refreshed"|"degraded";
  readonly inventoryStatus:"complete"|"partial"|"blocked";
  readonly riskStatus:"complete"|"degraded"|"not_run";
  readonly discoveredProducts:number;
  readonly attemptedProducts:number;
  readonly persistedProducts:number;
  readonly failedProducts:number;
  readonly skippedProducts:number;
}

export interface InventoryProductionCycleProjection {
  readonly status:CycleStatus;
  readonly observedAt:string;
  readonly coverage:{
    readonly expectedShops:number;
    readonly configuredShops:number;
    readonly attemptedShops:number;
    readonly succeededShops:number;
    readonly failedShops:number;
    readonly unresolvedShops:number;
    readonly canaryPassedShops:number;
    readonly usableInventoryShops:number;
    readonly blockedShops:number;
    readonly partialShops:number;
  };
  readonly orders:{
    readonly freshReusedShops:number;
    readonly refreshedShops:number;
    readonly fallbackShops:number;
    readonly degradedShops:number;
  };
  readonly inventory:{
    readonly discoveredProducts:number;
    readonly attemptedProducts:number;
    readonly persistedProducts:number;
    readonly failedProducts:number;
    readonly skippedProducts:number;
  };
  readonly risk:{
    readonly attemptedProducts:number;
    readonly succeededProducts:number;
    readonly degradedProducts:number;
    readonly normalProducts:number;
    readonly warningProducts:number;
    readonly criticalProducts:number;
    readonly unknownProducts:number;
  };
  readonly shops:readonly ShopSummary[];
  readonly attentionRequired:boolean;
}

export type InventoryProductionCycleSummary =
  | {
      readonly projectionVersion:"1";
      readonly state:"not-run";
      readonly workflow:{ readonly id:typeof WORKFLOW_ID;readonly version:typeof WORKFLOW_VERSION };
      readonly expectedShopCount:typeof EXPECTED_SHOP_COUNT;
    }
  | {
      readonly projectionVersion:"1";
      readonly state:"in-progress";
      readonly workflow:{ readonly id:typeof WORKFLOW_ID;readonly version:typeof WORKFLOW_VERSION };
      readonly expectedShopCount:typeof EXPECTED_SHOP_COUNT;
      readonly trigger?:{
        readonly status:Exclude<TriggerOccurrenceStatus,"terminal">;
        readonly scheduledAt:string;
      };
      readonly run?:{
        readonly status:ActiveRunStatus;
        readonly scheduledAt:string;
        readonly createdAt:string;
        readonly updatedAt:string;
      };
    }
  | {
      readonly projectionVersion:"1";
      readonly state:"not-produced";
      readonly workflow:{ readonly id:typeof WORKFLOW_ID;readonly version:typeof WORKFLOW_VERSION };
      readonly expectedShopCount:typeof EXPECTED_SHOP_COUNT;
      readonly trigger:{
        readonly status:"terminal";
        readonly terminalOutcome:TriggerTerminalOutcome;
        readonly scheduledAt:string;
      };
      readonly reasonCode:"TRIGGER_TERMINATED_BEFORE_RUN";
    }
  | {
      readonly projectionVersion:"1";
      readonly state:"available";
      readonly workflow:{ readonly id:typeof WORKFLOW_ID;readonly version:typeof WORKFLOW_VERSION };
      readonly expectedShopCount:typeof EXPECTED_SHOP_COUNT;
      readonly run:{
        readonly status:RunStatus;
        readonly scheduledAt:string;
        readonly createdAt:string;
        readonly terminalAt:string;
      };
      readonly summary:
        | { readonly state:"available";readonly cycle:InventoryProductionCycleProjection }
        | {
            readonly state:"not-produced";
            readonly reasonCode:
              | "RUN_REJECTED"
              | "RUN_CANCELLED_BEFORE_AGGREGATE"
              | "RUN_FAILED_BEFORE_AGGREGATE"
              | "RUN_UNCERTAIN_BEFORE_AGGREGATE";
          };
    };

function invalid():never {
  throw new Error("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
}

function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=="object" || Array.isArray(value)) invalid();
  return value as Record<string,unknown>;
}

function exactObject(
  value:unknown,
  required:readonly string[],
  optional:readonly string[]=[]
):Record<string,unknown> {
  const result=object(value);
  const allowed=new Set([...required,...optional]);
  if (
    required.some((key) => !(key in result)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) invalid();
  return result;
}

function integer(value:unknown,maximum?:number):number {
  if (
    !Number.isSafeInteger(value) || Number(value)<0 ||
    (maximum!==undefined && Number(value)>maximum)
  ) invalid();
  return Number(value);
}

function member<const T extends readonly string[]>(value:unknown,values:T):T[number] {
  if (typeof value!=="string" || !values.includes(value)) invalid();
  return value as T[number];
}

function timestamp(value:unknown):string {
  if (typeof value!=="string" || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}

function shop(value:unknown):Shop {
  const result=exactObject(value,["id","name"]);
  if (
    typeof result.id!=="string" || !/^[0-9]{5,30}$/u.test(result.id) ||
    typeof result.name!=="string" || result.name.length<2 || result.name.length>80
  ) invalid();
  return { id:result.id,name:result.name };
}

function boundedShopCounts<const K extends string>(
  value:unknown,
  keys:readonly K[]
):Record<K,number> {
  const result=exactObject(value,keys);
  return Object.fromEntries(
    keys.map((key) => [key,integer(result[key],13)])
  ) as Record<K,number>;
}

function productCounts<const K extends string>(
  value:unknown,
  keys:readonly K[],
  maximum=EXPECTED_SHOP_COUNT*250
):Record<K,number> {
  const result=exactObject(value,keys);
  return Object.fromEntries(
    keys.map((key) => [key,integer(result[key],maximum)])
  ) as Record<K,number>;
}

function parseShopSummary(value:unknown):ShopSummary {
  const result=exactObject(value,[
    "shop","status","ordersStatus","inventoryStatus","riskStatus",
    "discoveredProducts","attemptedProducts","persistedProducts",
    "failedProducts","skippedProducts"
  ]);
  return {
    shop:shop(result.shop),
    status:member(result.status,["complete","degraded","partial","blocked"] as const),
    ordersStatus:member(result.ordersStatus,["fresh_reused","refreshed","degraded"] as const),
    inventoryStatus:member(result.inventoryStatus,["complete","partial","blocked"] as const),
    riskStatus:member(result.riskStatus,["complete","degraded","not_run"] as const),
    discoveredProducts:integer(result.discoveredProducts,250),
    attemptedProducts:integer(result.attemptedProducts,250),
    persistedProducts:integer(result.persistedProducts,250),
    failedProducts:integer(result.failedProducts,250),
    skippedProducts:integer(result.skippedProducts,250)
  };
}

function parseCycle(value:unknown):InventoryProductionCycleProjection {
  const result=exactObject(value,[
    "status","observedAt","sourceShop","coverage","orders","inventory",
    "risk","shops","attentionRequired"
  ],["operationalAttentionMarker"]);
  shop(result.sourceShop);
  const coverage=boundedShopCounts(result.coverage,[
    "expectedShops","configuredShops","attemptedShops","succeededShops",
    "failedShops","unresolvedShops","canaryPassedShops",
    "usableInventoryShops","blockedShops","partialShops"
  ]);
  if (
    coverage.expectedShops!==EXPECTED_SHOP_COUNT ||
    coverage.configuredShops!==EXPECTED_SHOP_COUNT
  ) invalid();
  const orders=boundedShopCounts(result.orders,[
    "freshReusedShops","refreshedShops","fallbackShops","degradedShops"
  ]);
  const inventory=productCounts(result.inventory,[
    "discoveredProducts","attemptedProducts","persistedProducts",
    "failedProducts","skippedProducts"
  ]);
  const risk=productCounts(result.risk,[
    "attemptedProducts","succeededProducts","degradedProducts","normalProducts",
    "warningProducts","criticalProducts","unknownProducts"
  ]);
  if (!Array.isArray(result.shops) || result.shops.length!==EXPECTED_SHOP_COUNT) invalid();
  const shops=result.shops.map(parseShopSummary);
  if (
    new Set(shops.map((item) => item.shop.id)).size!==shops.length ||
    new Set(shops.map((item) => item.shop.name)).size!==shops.length
  ) invalid();
  if (typeof result.attentionRequired!=="boolean") invalid();
  let markerCode:string|undefined;
  if (result.operationalAttentionMarker!==undefined) {
    const marker=exactObject(result.operationalAttentionMarker,["version","kind","code"]);
    if (
      marker.version!=="1" || marker.kind!=="business-finding" ||
      !["inventory-production-cycle-degraded","inventory-risk-finding"].includes(
        String(marker.code)
      )
    ) invalid();
    markerCode=String(marker.code);
  }
  const status=member(result.status,["complete","complete_degraded","partial","failed"] as const);
  const sum=(select:(item:ShopSummary)=>number) =>
    shops.reduce((total,item) => total+select(item),0);
  const blockedShops=shops.filter((item) => item.status==="blocked").length;
  const partialShops=shops.filter((item) => item.status==="partial").length;
  const usableInventoryShops=shops.filter((item) => item.inventoryStatus!=="blocked").length;
  const degradedShops=shops.filter((item) => item.status==="degraded").length;
  const hasRiskFinding=
    risk.warningProducts+risk.criticalProducts+risk.unknownProducts>0;
  const derivedStatus:CycleStatus=usableInventoryShops===0
    ? "failed"
    : blockedShops>0 || partialShops>0
      ? "partial"
      : degradedShops>0
        ? "complete_degraded"
        : "complete";
  const attentionRequired=derivedStatus!=="complete" || hasRiskFinding;
  const shopCountsAreValid=shops.every((item) =>
    item.discoveredProducts===item.attemptedProducts &&
    item.attemptedProducts===
      item.persistedProducts+item.failedProducts+item.skippedProducts &&
    (item.status==="blocked"
      ? item.inventoryStatus==="blocked" && item.riskStatus==="not_run" &&
        item.attemptedProducts===0
      : item.status==="partial"
        ? item.inventoryStatus==="partial" && item.riskStatus==="degraded"
        : item.status==="degraded"
          ? item.ordersStatus==="degraded" && item.inventoryStatus==="complete" &&
            item.riskStatus==="degraded"
          : item.ordersStatus!=="degraded" && item.inventoryStatus==="complete" &&
            item.riskStatus==="complete")
  );
  if (
    !shopCountsAreValid ||
    coverage.succeededShops+coverage.failedShops+coverage.unresolvedShops!==EXPECTED_SHOP_COUNT ||
    coverage.attemptedShops!==coverage.succeededShops+coverage.failedShops ||
    coverage.canaryPassedShops!==usableInventoryShops ||
    coverage.usableInventoryShops!==usableInventoryShops ||
    coverage.blockedShops!==blockedShops ||
    coverage.partialShops!==partialShops ||
    orders.freshReusedShops!==shops.filter((item) => item.ordersStatus==="fresh_reused").length ||
    orders.refreshedShops!==shops.filter((item) => item.ordersStatus==="refreshed").length ||
    orders.degradedShops!==shops.filter((item) => item.ordersStatus==="degraded").length ||
    orders.fallbackShops!==0 ||
    inventory.discoveredProducts!==sum((item) => item.discoveredProducts) ||
    inventory.attemptedProducts!==sum((item) => item.attemptedProducts) ||
    inventory.persistedProducts!==sum((item) => item.persistedProducts) ||
    inventory.failedProducts!==sum((item) => item.failedProducts) ||
    inventory.skippedProducts!==sum((item) => item.skippedProducts) ||
    risk.attemptedProducts!==inventory.persistedProducts ||
    risk.attemptedProducts!==risk.succeededProducts+risk.degradedProducts ||
    risk.succeededProducts!==
      risk.normalProducts+risk.warningProducts+risk.criticalProducts+risk.unknownProducts ||
    status!==derivedStatus ||
    result.attentionRequired!==attentionRequired ||
    (attentionRequired ? markerCode===undefined : markerCode!==undefined) ||
    (markerCode!==undefined && markerCode!==(
      hasRiskFinding ? "inventory-risk-finding" : "inventory-production-cycle-degraded"
    ))
  ) invalid();
  return {
    status,
    observedAt:timestamp(result.observedAt),
    coverage:coverage as InventoryProductionCycleProjection["coverage"],
    orders:orders as InventoryProductionCycleProjection["orders"],
    inventory:inventory as InventoryProductionCycleProjection["inventory"],
    risk:risk as InventoryProductionCycleProjection["risk"],
    shops,
    attentionRequired
  };
}

function knownEarlyUncertainCycle(value:unknown):boolean {
  try {
    const cycle=exactObject(value,["status","reason","shop","snapshots"]);
    if (
      cycle.status!=="partial" ||
      cycle.reason!=="forecast-risk-outcome-uncertain"
    ) return false;
    shop(cycle.shop);
    const snapshots=productCounts(cycle.snapshots,[
      "attempted","persisted","failed","unresolved"
    ],250);
    return snapshots.attempted===
      snapshots.persisted+snapshots.failed+snapshots.unresolved;
  } catch {
    return false;
  }
}

function maybeCycle(
  output:unknown,
  status:RunStatus
):InventoryProductionCycleProjection|undefined {
  if (output===undefined) return undefined;
  const root=object(output);
  if (!("cycle" in root)) return undefined;
  try {
    return parseCycle(root.cycle);
  } catch {
    if (status==="uncertain" && knownEarlyUncertainCycle(root.cycle)) {
      return undefined;
    }
    invalid();
  }
}

export function projectInventoryProductionCycleSummary(
  record:TriggeredWorkflowExecutionRecord|undefined
):InventoryProductionCycleSummary {
  const identity={ id:WORKFLOW_ID,version:WORKFLOW_VERSION } as const;
  const base={
    projectionVersion:"1" as const,
    workflow:identity,
    expectedShopCount:13 as const
  };
  if (!record) return { ...base,state:"not-run" };
  const { run,scheduledAt }=record;
  const scheduled=timestamp(scheduledAt);
  if (!run) {
    if (record.occurrenceStatus==="terminal") {
      if (
        !record.occurrenceTerminalOutcome ||
        !(["blocked","failed","skipped","missed"] as const).includes(
          record.occurrenceTerminalOutcome as "blocked"|"failed"|"skipped"|"missed"
        )
      ) invalid();
      return {
        ...base,state:"not-produced",
        trigger:{
          status:"terminal",
          terminalOutcome:record.occurrenceTerminalOutcome,
          scheduledAt:scheduled
        },
        reasonCode:"TRIGGER_TERMINATED_BEFORE_RUN"
      };
    }
    if (record.occurrenceTerminalOutcome!==undefined) invalid();
    return {
      ...base,state:"in-progress",
      trigger:{ status:record.occurrenceStatus,scheduledAt:scheduled }
    };
  }
  if (
    run.workflowId!==WORKFLOW_ID || run.workflowVersion!==WORKFLOW_VERSION ||
    (record.occurrenceStatus!=="running" && record.occurrenceStatus!=="terminal")
  ) invalid();
  if (!(["succeeded","uncertain","failed","rejected","cancelled"] as const)
    .includes(run.status as RunStatus)) {
    if (
      record.occurrenceStatus==="terminal" ||
      !(["created","validated","queued","running","waiting_browser",
        "waiting_assistance","waiting_human","paused","compensating"] as const)
        .includes(run.status as ActiveRunStatus)
    ) invalid();
    return {
      ...base,state:"in-progress",
      run:{
        status:run.status as ActiveRunStatus,
        scheduledAt:scheduled,
        createdAt:timestamp(run.createdAt),
        updatedAt:timestamp(run.updatedAt)
      }
    };
  }
  const status=run.status as RunStatus;
  const expectedOutcome:Record<RunStatus,TriggerTerminalOutcome>={
    succeeded:"complete",
    uncertain:"uncertain",
    failed:"failed",
    rejected:"rejected",
    cancelled:"cancelled"
  };
  if (
    record.occurrenceStatus==="terminal" &&
    record.occurrenceTerminalOutcome!==expectedOutcome[status]
  ) invalid();
  const resultBase={
    ...base,
    state:"available" as const,
    run:{
      status,
      scheduledAt:scheduled,
      createdAt:timestamp(run.createdAt),
      terminalAt:timestamp(run.updatedAt)
    }
  };
  if (status==="rejected") {
    return { ...resultBase,summary:{ state:"not-produced",reasonCode:"RUN_REJECTED" } };
  }
  const cycle=maybeCycle(run.output,status);
  if (!cycle) {
    if (status==="succeeded") invalid();
    return {
      ...resultBase,
      summary:{
        state:"not-produced",
        reasonCode:status==="failed"
          ? "RUN_FAILED_BEFORE_AGGREGATE"
          : status==="cancelled"
            ? "RUN_CANCELLED_BEFORE_AGGREGATE"
            : "RUN_UNCERTAIN_BEFORE_AGGREGATE"
      }
    };
  }
  if (
    (status==="succeeded" && cycle.status!=="complete" && cycle.status!=="complete_degraded") ||
    (status==="uncertain" && cycle.status!=="partial") ||
    (status==="failed" && cycle.status!=="failed")
  ) invalid();
  return { ...resultBase,summary:{ state:"available",cycle } };
}

export const inventoryProductionCycleQuery={
  appId:APP_ID,
  workflowId:WORKFLOW_ID,
  workflowVersion:WORKFLOW_VERSION
};
