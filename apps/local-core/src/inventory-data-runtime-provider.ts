import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import { contentDigest } from "@bpa/compiler";
import {
  RevisionConflictError,
  type ExternalDomainLeaseRecord,
  type Persistence
} from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import {
  aggregateInventoryProductionCycle,
  InventorySourceShopResolutionError,
  resolveInventoryProductionCycleSourceShop,
  validateInventoryProductionCycleConfiguration
} from "./inventory-production-cycle-aggregate.js";

const PROVIDER_ID = "inventory-data";
const LEASE_PROVIDER_ID = "inventory-postgres";
const LEASE_DOMAIN_KEY = "inventory-production-cycle";
const ORDERS_FRESHNESS_NODE = "inventory.orders.freshness.read@1.0.0";
const PRODUCTION_CYCLE_VALIDATE_NODE = "inventory.production-cycle.input.validate@1.0.0";
const PRODUCTION_CYCLE_SOURCE_SHOP_RESOLVE_NODE =
  "inventory.production-cycle.source-shop.resolve@1.0.0";
const PRODUCTION_CYCLE_AGGREGATE_NODE = "inventory.production-cycle.aggregate@1.0.0";

export type InventoryWriteOperation =
  | "sales-demand.sync"
  | "inventory.snapshot.persist"
  | "inventory.shop.forecast-risk.refresh";

interface InventoryNodeRule {
  readonly operation: InventoryWriteOperation;
  readonly permission: string;
  readonly inputErrorCode: string;
  readonly inputKeys: readonly string[];
  readonly objectKeys: readonly string[];
}

const NODE_RULES = new Map<string, InventoryNodeRule>([
  [
    "ecom.sales-demand.sync@2.0.0",
    {
      operation: "sales-demand.sync",
      permission: "inventory.service.sales-demand.write",
      inputErrorCode: "INVENTORY_WRITE_INPUT_INVALID",
      inputKeys: ["shopId", "shopName"],
      objectKeys: []
    }
  ],
  [
    "inventory.snapshot.persist@2.0.0",
    {
      operation: "inventory.snapshot.persist",
      permission: "inventory.service.snapshot.write",
      inputErrorCode: "INVENTORY_SNAPSHOT_INPUT_INVALID",
      inputKeys: ["snapshot"],
      objectKeys: ["snapshot"]
    }
  ],
  [
    "inventory.shop.forecast-risk.refresh@1.0.0",
    {
      operation: "inventory.shop.forecast-risk.refresh",
      permission: "inventory.service.forecast-risk.write",
      inputErrorCode: "INVENTORY_FORECAST_RISK_INPUT_INVALID",
      inputKeys: [
        "shop",
        "attemptedSnapshots",
        "persistedSnapshots",
        "failedSnapshots",
        "unresolvedSnapshots",
        "snapshotReceipts"
      ],
      objectKeys: ["shop"]
    }
  ]
]);

export function isInventoryDataNode(id: string, version: string): boolean {
  const key = `${id}@${version}`;
  return NODE_RULES.has(key) ||
    key === ORDERS_FRESHNESS_NODE ||
    key === PRODUCTION_CYCLE_VALIDATE_NODE ||
    key === PRODUCTION_CYCLE_SOURCE_SHOP_RESOLVE_NODE ||
    key === PRODUCTION_CYCLE_AGGREGATE_NODE;
}

export interface LeaseFence {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly fencingToken: number;
}

export interface InventoryEffectIdentity {
  readonly effectId: string;
  readonly inputDigest: string;
  readonly identityDigest: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly idempotencyKey: string;
  readonly leaseRequestId: string;
}

export function inventoryEffectIdentity(
  invocation: Pick<
    RuntimeInvocation,
    "idempotencyKey" | "identity" | "invocationId" | "node"
  >,
  operation: InventoryWriteOperation,
  input: JsonValue,
  leaseRequestId: string
): InventoryEffectIdentity {
  return {
    effectId: `inventory-effect:${contentDigest({
      idempotencyKey: invocation.idempotencyKey,
      identity: invocation.identity,
      node: invocation.node
    })}`,
    inputDigest: contentDigest({ operation, input }),
    identityDigest: contentDigest({
      identity: invocation.identity,
      node: invocation.node
    }),
    runId: invocation.identity.runId,
    invocationId: invocation.invocationId,
    idempotencyKey: invocation.idempotencyKey,
    leaseRequestId
  };
}

export interface InventoryServiceWriter {
  write(
    request: {
      readonly operation: InventoryWriteOperation;
      readonly input: JsonValue;
      readonly lease: LeaseFence;
      readonly effect: InventoryEffectIdentity;
    },
    signal: AbortSignal
  ): Promise<JsonValue>;
  readOrdersFreshness(
    input: {
      readonly shop: JsonValue;
      readonly baseline?: JsonValue;
    },
    signal: AbortSignal
  ): Promise<JsonValue>;
}

export class InventoryServiceWriterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transportUncertain = false
  ) {
    super(message);
  }
}

function rejected(code: string, message: string): RuntimeOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function failed(code: string, message: string): RuntimeOutcome {
  return {
    status: "failed",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function uncertain(code: string, message: string): RuntimeOutcome {
  return {
    status: "uncertain",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function cancelled(operation?: InventoryWriteOperation): RuntimeOutcome {
  return {
    status: "cancelled",
    error: {
      code: "CANCELLED",
      message: operation
        ? `Inventory write ${operation} was cancelled before dispatch.`
        : "Inventory write was cancelled before dispatch.",
      retryable: false
    },
    evidence: [],
    riskSignals: []
  };
}

function inputObject(
  value: JsonValue,
  label: string
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, JsonValue>;
}

function exactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} must contain only ${required.join(", ")}.`);
  }
}

function estimatedRemainingMilliseconds(
  lease: {
    readonly serverNow?: string;
    readonly expiresAt?: string;
    readonly updatedAt: string;
  },
  localNow: string
): number | undefined {
  if (!lease.serverNow || !lease.expiresAt) return undefined;
  const grantedDuration =
    Date.parse(lease.expiresAt) - Date.parse(lease.serverNow);
  const localElapsed = Date.parse(localNow) - Date.parse(lease.updatedAt);
  if (!Number.isFinite(grantedDuration) || !Number.isFinite(localElapsed)) {
    return undefined;
  }
  if (localElapsed < 0) return undefined;
  return grantedDuration - localElapsed;
}

function controlledWriterMessage(
  operation: InventoryWriteOperation,
  code: string,
  uncertainWrite: boolean
): string {
  if (uncertainWrite) {
    return code === "SCHEDULER_LEASE_LOST"
      ? `The inventory domain lease was lost during ${operation}; reconciliation is required.`
      : `The inventory service outcome for ${operation} is unknown; reconciliation is required.`;
  }
  switch (code) {
    case "INVENTORY_SERVICE_NOT_CONFIGURED":
      return "The trusted inventory service is not configured.";
    case "INVENTORY_SERVICE_UNAVAILABLE":
      return "The trusted inventory service is unavailable.";
    case "INVENTORY_SERVICE_PROTOCOL_ERROR":
      return "The trusted inventory service returned an invalid response.";
    case "LEASE_FENCE_INVALID":
      return "The inventory service rejected the lease fence.";
    default:
      return `The trusted inventory service rejected ${operation}.`;
  }
}

function supportedWriterCode(code: string): string {
  return new Set([
    "INVENTORY_SERVICE_NOT_CONFIGURED",
    "INVENTORY_SERVICE_UNAVAILABLE",
    "INVENTORY_SERVICE_PROTOCOL_ERROR",
    "INVENTORY_SERVICE_FAILED",
    "LEASE_FENCE_INVALID",
    "SCHEDULER_LEASE_LOST",
    "SALES_DEMAND_PARTIAL_COMMIT",
    "INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT",
    "MYSQL_SOURCE_NOT_CONFIGURED",
    "WDT_SOURCE_UNAVAILABLE",
    "WDT_DATA_QUALITY_INVALID",
    "SHOP_IDENTITY_MISMATCH",
    "SHOP_IDENTITY_NOT_CONFIGURED"
  ]).has(code)
    ? code
    : "INVENTORY_SERVICE_FAILED";
}

export class InventoryDataRuntimeProvider implements RuntimeProvider {
  readonly id = PROVIDER_ID;

  constructor(
    readonly persistence: Persistence,
    readonly writer: InventoryServiceWriter,
    readonly now: () => Date = () => new Date()
  ) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return isInventoryDataNode(node.id, node.version);
  }

  #markWriteReconciliation(
    lease: ExternalDomainLeaseRecord,
    runId: string,
    diagnostic: string
  ): void {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = this.persistence.getExternalDomainLease(lease.requestId);
      if (
        !current ||
        current.ownerId !== lease.ownerId ||
        current.runId !== runId ||
        current.providerId !== lease.providerId ||
        current.domainKey !== lease.domainKey
      ) {
        throw new Error("Inventory external lease identity changed during reconciliation");
      }
      if (current.state === "reconciliation_required") return;
      if (current.state !== "bound") {
        throw new Error("Inventory external lease cannot be marked for reconciliation");
      }
      try {
        this.persistence.markExternalDomainLeaseReconciliationRequired({
          requestId: current.requestId,
          expectedRevision: current.revision,
          diagnostic,
          updatedAt: this.now().toISOString()
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
    throw new Error("Inventory external lease reconciliation did not converge");
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    const nodeKey = `${invocation.node.id}@${invocation.node.version}`;
    const rule = NODE_RULES.get(nodeKey);
    const ordersFreshness = nodeKey === ORDERS_FRESHNESS_NODE;
    const productionCycleValidate = nodeKey === PRODUCTION_CYCLE_VALIDATE_NODE;
    const productionCycleSourceShopResolve =
      nodeKey === PRODUCTION_CYCLE_SOURCE_SHOP_RESOLVE_NODE;
    const productionCycleAggregate = nodeKey === PRODUCTION_CYCLE_AGGREGATE_NODE;
    if (signal.aborted) return cancelled(rule?.operation);
    if (!rule && !ordersFreshness && !productionCycleValidate &&
      !productionCycleSourceShopResolve &&
      !productionCycleAggregate) {
      return rejected(
        "INVENTORY_DATA_NODE_UNSUPPORTED",
        "Inventory data Node id and version are not exact."
      );
    }
    if (
      invocation.permissionSnapshot.riskLevel !==
        (ordersFreshness || productionCycleValidate ||
          productionCycleSourceShopResolve || productionCycleAggregate
          ? "R0"
          : "R1") ||
      invocation.permissionSnapshot.permissions.length !==
        (productionCycleValidate || productionCycleSourceShopResolve ||
          productionCycleAggregate ? 0 : 1) ||
      (!productionCycleValidate && !productionCycleSourceShopResolve &&
        !productionCycleAggregate &&
        invocation.permissionSnapshot.permissions[0] !==
        (ordersFreshness ? "inventory.service.orders.read" : rule!.permission)) ||
      invocation.permissionSnapshot.domains.length !== 0
    ) {
      return rejected(
        "INVENTORY_DATA_PERMISSION_INVALID",
        "Inventory data permission snapshot is not exact."
      );
    }

    if (productionCycleValidate) {
      try {
        const input = inputObject(
          invocation.input,
          "Inventory cycle configuration"
        );
        exactKeys(
          input,
          ["expectedShopCount","shops"],
          "Inventory cycle configuration"
        );
        const shops = validateInventoryProductionCycleConfiguration(
          input.expectedShopCount,
          input.shops
        );
        return {
          status:"succeeded",
          output:{ status:"validated",shopCount:shops.length },
          evidence:[],riskSignals:[]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return rejected(
          message.includes("duplicate identity")
            ? "INVENTORY_PRODUCTION_CYCLE_SHOP_DUPLICATE"
            : message.includes("shop count")
              ? "INVENTORY_PRODUCTION_CYCLE_SHOP_COUNT_MISMATCH"
              : "INVENTORY_PRODUCTION_CYCLE_INPUT_INVALID",
          "Inventory production cycle configuration is not exact."
        );
      }
    }

    if (productionCycleSourceShopResolve) {
      try {
        const input = inputObject(invocation.input,"Source shop resolution");
        exactKeys(
          input,
          ["observedShop","configuredShops"],
          "Source shop resolution"
        );
        return {
          status:"succeeded",
          output:resolveInventoryProductionCycleSourceShop(
            input.observedShop,
            input.configuredShops
          ),
          evidence:[],riskSignals:[]
        };
      } catch (error) {
        return rejected(
          error instanceof InventorySourceShopResolutionError
            ? error.code
            : "INVENTORY_SOURCE_SHOP_INPUT_INVALID",
          "Inventory source shop identity could not be resolved exactly."
        );
      }
    }

    if (productionCycleAggregate) {
      try {
        return {
          status: "succeeded",
          output: aggregateInventoryProductionCycle(
            invocation.input,
            this.now().toISOString()
          ),
          evidence: [],
          riskSignals: []
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const code = message.includes("does not match expectedShopCount") ||
          message.includes("configured shop count is invalid")
          ? "INVENTORY_PRODUCTION_CYCLE_SHOP_COUNT_MISMATCH"
          : message.includes("duplicate identity")
            ? "INVENTORY_PRODUCTION_CYCLE_SHOP_DUPLICATE"
            : message.includes("production cycle input") ||
                message.includes("configuredShops") ||
                message.includes("sourceShop")
              ? "INVENTORY_PRODUCTION_CYCLE_INPUT_INVALID"
              : "INVENTORY_PRODUCTION_CYCLE_OUTCOME_INVALID";
        return rejected(code, "Inventory production cycle input is not exact.");
      }
    }

    let writeInput: JsonValue;
    try {
      const input = inputObject(invocation.input, "Inventory write input");
      const inputKeys = ordersFreshness
        ? input.baseline === undefined
          ? ["shop"]
          : ["shop","baseline"]
        : rule!.inputKeys;
      exactKeys(input, inputKeys, "Inventory write input");
      if (ordersFreshness) {
        const shop = input.shop;
        if (shop === undefined) throw new Error("shop is required");
        inputObject(shop,"Inventory orders freshness shop");
        if (input.baseline !== undefined) {
          inputObject(input.baseline,"Inventory orders freshness baseline");
        }
      }
      for (const key of ordersFreshness ? [] : rule!.objectKeys) {
        const candidate = input[key];
        if (candidate === undefined) throw new Error(`${key} is required`);
        inputObject(candidate, `Inventory write input ${key}`);
      }
      if (rule?.operation === "inventory.shop.forecast-risk.refresh") {
        const attempted = Number(input.attemptedSnapshots);
        const persisted = Number(input.persistedSnapshots);
        const failedCount = Number(input.failedSnapshots);
        const unresolved = Number(input.unresolvedSnapshots);
        const receipts = input.snapshotReceipts;
        if (
          ![attempted,persisted,failedCount,unresolved].every(
            (count) => Number.isSafeInteger(count) && count >= 0 && count <= 250
          ) ||
          !Array.isArray(receipts) ||
          receipts.length > 250 ||
          persisted !== receipts.length ||
          attempted !== persisted + failedCount + unresolved
        ) {
          throw new Error("forecast risk counts are invalid");
        }
        const productIds = new Set<string>();
        const snapshotIds = new Set<string>();
        for (const [index, value] of receipts.entries()) {
          const receipt = inputObject(value, `snapshotReceipts[${index}]`);
          exactKeys(receipt,["itemKey","output"],`snapshotReceipts[${index}]`);
          const output = inputObject(receipt.output as JsonValue,`snapshotReceipts[${index}].output`);
          exactKeys(output,["productId","snapshotId"],`snapshotReceipts[${index}].output`);
          if (receipt.itemKey !== output.productId ||
            typeof output.productId !== "string" ||
            typeof output.snapshotId !== "string" ||
            productIds.has(output.productId) ||
            snapshotIds.has(output.snapshotId)) {
            throw new Error("forecast risk receipts are invalid");
          }
          productIds.add(output.productId);
          snapshotIds.add(output.snapshotId);
        }
      }
      writeInput = input;
    } catch {
      return rejected(
        ordersFreshness
          ? "INVENTORY_ORDERS_FRESHNESS_INPUT_INVALID"
          : rule!.inputErrorCode,
        ordersFreshness
          ? "Inventory orders freshness input is not exact."
          : `Inventory write input for ${rule!.operation} is not exact.`
      );
    }

    const leases = this.persistence
      .listExternalDomainLeases()
      .filter((lease) => lease.runId === invocation.identity.runId);
    if (leases.length !== 1) {
      return rejected(
        "INVENTORY_EXTERNAL_LEASE_INVALID",
        "The Run must own exactly one external inventory domain lease."
      );
    }
    const lease = leases[0]!;
    const run = this.persistence.getRun(invocation.identity.runId);
    const attempt = lease.triggerAttemptId
      ? this.persistence.getTriggerAttempt(lease.triggerAttemptId)
      : undefined;
    const occurrence = attempt
      ? this.persistence.getTriggerOccurrence(attempt.occurrenceId)
      : undefined;
    const pinned = occurrence
      ? this.persistence.getTriggerSpecVersion(
          occurrence.triggerId,
          occurrence.triggerVersion
        )
      : undefined;
    const remaining = estimatedRemainingMilliseconds(
      lease,
      this.now().toISOString()
    );
    if (
      !run ||
      run.status !== "running" ||
      !attempt ||
      attempt.status !== "running" ||
      attempt.workflowRunId !== run.id ||
      attempt.occurrenceId !== lease.occurrenceId ||
      !occurrence ||
      occurrence.status !== "running" ||
      !pinned ||
      pinned.workflow.id !== run.workflowId ||
      pinned.workflow.version !== run.workflowVersion ||
      pinned.externalDomainLease?.providerId !== LEASE_PROVIDER_ID ||
      pinned.externalDomainLease.resourceId !== LEASE_DOMAIN_KEY ||
      lease.providerId !== LEASE_PROVIDER_ID ||
      lease.domainKey !== LEASE_DOMAIN_KEY ||
      lease.ownerId !== attempt.attemptId ||
      lease.state !== "bound" ||
      !Number.isSafeInteger(lease.fencingToken) ||
      Number(lease.fencingToken) < 1 ||
      remaining === undefined ||
      remaining <= 0
    ) {
      return rejected(
        "INVENTORY_EXTERNAL_LEASE_INVALID",
        "The Run external inventory domain lease is not active and exact."
      );
    }

    try {
      if (ordersFreshness) {
        const input = writeInput as Record<string, JsonValue>;
        const shop = input.shop;
        if (!shop || typeof shop !== "object" || Array.isArray(shop)) {
          return rejected(
            "INVENTORY_ORDERS_FRESHNESS_INPUT_INVALID",
            "Inventory orders freshness input is not exact."
          );
        }
        const output = await this.writer.readOrdersFreshness(
          {
            shop,
            ...(input.baseline === undefined
              ? {}
              : { baseline:input.baseline })
          },
          signal
        );
        return {
          status:"succeeded",output,evidence:[],riskSignals:[]
        };
      }
      const output = await this.writer.write(
        {
          operation: rule!.operation,
          input: writeInput,
          effect: inventoryEffectIdentity(
            invocation,
            rule!.operation,
            writeInput,
            lease.requestId
          ),
          lease: {
            leaseKey: lease.domainKey,
            holderId: lease.ownerId,
            fencingToken: lease.fencingToken!
          }
        },
        signal
      );
      let publicOutput = output;
      if (rule!.operation === "sales-demand.sync") {
        const salesOutput = inputObject(output, "sales demand output");
        const status = salesOutput.status;
        const syncRunId = salesOutput.syncRunId;
        const processed = salesOutput.processed;
        if ((status !== "succeeded" && status !== "no_changes") ||
          (typeof syncRunId !== "string" && syncRunId !== null) ||
          typeof processed !== "number" ||
          !Number.isSafeInteger(processed) || processed < 0) {
          throw new InventoryServiceWriterError(
            "INVENTORY_SERVICE_PROTOCOL_ERROR",
            "Inventory sales demand response is invalid."
          );
        }
        publicOutput = { status, syncRunId, processed, reasonCode: null };
      }
      return {
        status: "succeeded",
        output: publicOutput,
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      const writerError =
        error instanceof InventoryServiceWriterError ? error : undefined;
      const code = supportedWriterCode(
        writerError?.code ?? "INVENTORY_SERVICE_FAILED"
      );
      if (
        rule?.operation === "sales-demand.sync" &&
        writerError?.transportUncertain !== true &&
        (code === "MYSQL_SOURCE_NOT_CONFIGURED" ||
          code === "WDT_SOURCE_UNAVAILABLE" ||
          code === "WDT_DATA_QUALITY_INVALID")
      ) {
        return {
          status:"succeeded",
          output:{
            status:"unavailable",syncRunId:null,processed:0,reasonCode:code
          },
          evidence:[],riskSignals:[]
        };
      }
      const requiresReconciliation =
        !ordersFreshness &&
        (writerError?.transportUncertain === true ||
          code === "SCHEDULER_LEASE_LOST");
      if (requiresReconciliation) {
        this.#markWriteReconciliation(
          lease,
          invocation.identity.runId,
          `Inventory write ${rule!.operation} requires reconciliation: ${code}.`
        );
        return uncertain(
          code,
          controlledWriterMessage(rule!.operation, code, true)
        );
      }
      return failed(
        code,
        ordersFreshness
          ? "The trusted inventory service rejected orders freshness read."
          : controlledWriterMessage(rule!.operation, code, false)
      );
    }
  }
}
