import { contentDigest } from "@bpa/compiler";
import type {
  ExternalDomainLeaseRecord,
  InventoryEffectReconciliationClassification,
  InventoryEffectReconciliationRecord,
  Persistence
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  inventoryEffectIdentity,
  type InventoryEffectIdentity,
  type InventoryWriteOperation
} from "./inventory-data-runtime-provider.js";
import {
  InventoryDomainLeaseClient,
  type InventoryEffectReconciliationReport,
  type InventoryEffectSummary
} from "./inventory-domain-lease-client.js";

const PROVIDER_ID = "inventory-postgres";
const DOMAIN_KEY = "inventory-production-cycle";
const INVENTORY_RUNTIME_PROVIDER = "inventory-data";
const OPERATIONS = new Map<string, InventoryWriteOperation>([
  ["ecom.sales-demand.sync@2.0.0","sales-demand.sync"],
  ["inventory.snapshot.persist@2.0.0","inventory.snapshot.persist"],
  [
    "inventory.shop.forecast-risk.refresh@1.0.0",
    "inventory.shop.forecast-risk.refresh"
  ]
]);

interface ExpectedEffect extends InventoryEffectIdentity {
  readonly operation: InventoryWriteOperation;
}

export interface InventoryEffectReconciliationProjection {
  readonly state: "not-required" | "ready" | "resolved";
  readonly resolutionToken: string | null;
  readonly classification: InventoryEffectReconciliationClassification | null;
  readonly effects: {
    readonly expected: number;
    readonly remote: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly running: number;
    readonly missing: number;
  };
  readonly items: {
    readonly succeeded: number;
    readonly failed: number;
  };
  readonly inspectedAt: string | null;
  readonly resolvedAt: string | null;
}

interface Inspection {
  readonly lease: ExternalDomainLeaseRecord;
  readonly expected: readonly ExpectedEffect[];
  readonly expectedEffectSetDigest: string;
  readonly report: InventoryEffectReconciliationReport;
  readonly resolutionToken: string;
  readonly inspectedAt: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 500) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function expectedInvocation(
  value: JsonValue,
  runId: string,
  leaseRequestId: string
): ExpectedEffect | undefined {
  const invocation = object(value,"runtime invocation");
  if (invocation.providerId !== INVENTORY_RUNTIME_PROVIDER) return undefined;
  const node = object(invocation.node,"runtime invocation node");
  const identity = object(invocation.identity,"runtime invocation identity");
  const nodeId = text(node.id,"runtime invocation node id");
  const nodeVersion = text(node.version,"runtime invocation node version");
  const operation = OPERATIONS.get(`${nodeId}@${nodeVersion}`);
  if (!operation) return undefined;
  if (node.kind !== "node" || identity.runId !== runId ||
    invocation.input === undefined) {
    throw new Error("Inventory runtime invocation identity is invalid");
  }
  text(invocation.invocationId,"runtime invocation id");
  text(invocation.idempotencyKey,"runtime invocation idempotency key");
  const typed = invocation as unknown as RuntimeInvocation;
  return {
    operation,
    ...inventoryEffectIdentity(
      typed,
      operation,
      typed.input,
      leaseRequestId
    )
  };
}

function classification(
  report: InventoryEffectReconciliationReport,
  missing: number
): InventoryEffectReconciliationClassification {
  const abandoned = report.effects.some((effect) =>
    effect.operation === "sales-demand.sync" &&
    (effect.status === "running" ||
      effect.errorCode === "RECONCILED_ABANDONED_STAGING")
  );
  const partial = report.effects.some((effect) =>
    effect.operation === "inventory.shop.forecast-risk.refresh" &&
    (effect.status === "running" ||
      effect.errorCode === "RECONCILED_CONFIRMED_PARTIAL")
  );
  const notCommitted = report.effects.some((effect) =>
    effect.errorCode === "RECONCILED_NOT_COMMITTED"
  );
  const categories = [missing > 0 || notCommitted,abandoned,partial]
    .filter(Boolean).length;
  if (categories > 1) return "mixed";
  if (partial) return "confirmed_partial";
  if (abandoned) return "abandoned_staging";
  if (missing > 0 || notCommitted) return "not_committed";
  return "all_terminal";
}

function projectRecord(
  record: InventoryEffectReconciliationRecord
): InventoryEffectReconciliationProjection {
  return {
    state:"resolved",
    resolutionToken:null,
    classification:record.classification,
    effects:{
      expected:record.expectedEffectCount,
      remote:record.remoteEffectCount,
      succeeded:record.succeededEffectCount,
      failed:record.failedEffectCount,
      running:0,
      missing:record.missingEffectCount
    },
    items:{
      succeeded:record.succeededItemCount,
      failed:record.failedItemCount
    },
    inspectedAt:record.inspectedAt,
    resolvedAt:record.resolvedAt
  };
}

export class InventoryEffectReconciliationService {
  readonly #resolutions = new Map<
    string,
    Promise<InventoryEffectReconciliationProjection>
  >();

  constructor(
    readonly persistence: Persistence,
    readonly client: InventoryDomainLeaseClient,
    readonly clock: () => Date = () => new Date()
  ) {}

  async inspect(): Promise<InventoryEffectReconciliationProjection> {
    const inspection = await this.#inspect();
    if (!inspection) {
      const latest = this.persistence.getLatestInventoryEffectReconciliation();
      if (latest) return projectRecord(latest);
      return {
        state:"not-required",resolutionToken:null,classification:null,
        effects:{ expected:0,remote:0,succeeded:0,failed:0,running:0,missing:0 },
        items:{ succeeded:0,failed:0 },inspectedAt:null,resolvedAt:null
      };
    }
    const existing = this.persistence.getInventoryEffectReconciliation(
      inspection.lease.requestId
    );
    if (existing) return projectRecord(existing);
    const running = inspection.report.effects.filter(
      (effect) => effect.status === "running"
    );
    if (running.some((effect) =>
      effect.operation === "inventory.snapshot.persist")) {
      throw new Error("INVENTORY_RECONCILIATION_SNAPSHOT_RUNNING_INVALID");
    }
    const counts = this.#counts(inspection);
    return {
      state:"ready",
      resolutionToken:inspection.resolutionToken,
      classification:classification(inspection.report,counts.missing),
      effects:{ ...counts,running:running.length },
      items:this.#itemCounts(inspection.report),
      inspectedAt:inspection.inspectedAt,
      resolvedAt:null
    };
  }

  resolve(input: {
    readonly resolutionToken: string;
    readonly resolvedBy: string;
  }): Promise<InventoryEffectReconciliationProjection> {
    const active = this.#resolutions.get(input.resolutionToken);
    if (active) return active;
    const operation = this.#resolveOnce(input).finally(() => {
      if (this.#resolutions.get(input.resolutionToken) === operation) {
        this.#resolutions.delete(input.resolutionToken);
      }
    });
    this.#resolutions.set(input.resolutionToken,operation);
    return operation;
  }

  async #resolveOnce(input: {
    readonly resolutionToken: string;
    readonly resolvedBy: string;
  }): Promise<InventoryEffectReconciliationProjection> {
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.resolutionToken)) {
      throw new Error("INVENTORY_RECONCILIATION_TOKEN_INVALID");
    }
    const resolved = this.persistence
      .getInventoryEffectReconciliationByResolutionToken(input.resolutionToken);
    if (resolved) return projectRecord(resolved);
    const inspection = await this.#inspect();
    if (!inspection) {
      const concurrent = this.persistence
        .getInventoryEffectReconciliationByResolutionToken(input.resolutionToken);
      if (concurrent) return projectRecord(concurrent);
      throw new Error("INVENTORY_RECONCILIATION_NOT_REQUIRED");
    }
    const existing = this.persistence.getInventoryEffectReconciliation(
      inspection.lease.requestId
    );
    if (existing) {
      if (existing.resolutionToken !== input.resolutionToken) {
        throw new Error("INVENTORY_RECONCILIATION_TOKEN_CHANGED");
      }
      return projectRecord(existing);
    }
    if (inspection.resolutionToken !== input.resolutionToken) {
      throw new Error("INVENTORY_RECONCILIATION_TOKEN_CHANGED");
    }
    const byId = new Map(inspection.expected.map((effect) => [effect.effectId,effect]));
    for (const summary of inspection.report.effects) {
      if (summary.status !== "running") continue;
      const effect = byId.get(summary.effectId);
      if (!effect || summary.operation === "inventory.snapshot.persist") {
        throw new Error("INVENTORY_RECONCILIATION_EFFECT_INVALID");
      }
      const { operation: _operation,...identity } = effect;
      await this.client.reconcileInventoryEffect({
        leaseRequestId:inspection.lease.requestId,
        runId:inspection.lease.runId!,
        lease:{
          leaseKey:inspection.lease.domainKey,
          holderId:inspection.lease.ownerId,
          fencingToken:inspection.lease.fencingToken!
        },
        effect:identity
      });
    }
    const finalReport = await this.client.inspectInventoryEffects({
      leaseRequestId:inspection.lease.requestId,
      runId:inspection.lease.runId!,
      lease:{
        leaseKey:inspection.lease.domainKey,
        holderId:inspection.lease.ownerId,
        fencingToken:inspection.lease.fencingToken!
      }
    });
    this.#assertExactReport(inspection.expected,finalReport,inspection.lease);
    if (finalReport.effects.some((effect) => effect.status === "running")) {
      throw new Error("INVENTORY_RECONCILIATION_EFFECT_STILL_RUNNING");
    }
    const missing = inspection.expected.length - finalReport.effects.length;
    const finalClassification = classification(finalReport,missing);
    const itemCounts = this.#itemCounts(finalReport);
    const resolvedAt = this.clock().toISOString();
    const committed = this.persistence.commitInventoryEffectReconciliation({
      requestId:inspection.lease.requestId,
      resolutionToken:inspection.resolutionToken,
      runId:inspection.lease.runId!,
      ownerId:inspection.lease.ownerId,
      fencingToken:inspection.lease.fencingToken!,
      expectedLeaseRevision:inspection.lease.revision,
      expectedEffectSetDigest:inspection.expectedEffectSetDigest,
      remoteReportDigest:finalReport.reportDigest,
      expectedEffectCount:inspection.expected.length,
      remoteEffectCount:finalReport.effects.length,
      succeededEffectCount:finalReport.effects.filter(
        (effect) => effect.status === "succeeded"
      ).length,
      failedEffectCount:finalReport.effects.filter(
        (effect) => effect.status === "failed"
      ).length,
      missingEffectCount:missing,
      succeededItemCount:itemCounts.succeeded,
      failedItemCount:itemCounts.failed,
      classification:finalClassification,
      inspectedAt:inspection.inspectedAt,
      resolvedAt,
      resolvedBy:input.resolvedBy
    });
    return projectRecord(committed.record);
  }

  async #inspect(): Promise<Inspection | undefined> {
    const candidates = this.persistence.listExternalDomainLeases().filter(
      (lease) => lease.providerId === PROVIDER_ID &&
        lease.domainKey === DOMAIN_KEY &&
        lease.state === "reconciliation_required"
    );
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1) {
      throw new Error("INVENTORY_RECONCILIATION_LEASE_COUNT_INVALID");
    }
    const lease = candidates[0]!;
    if (!lease.runId || !lease.triggerAttemptId ||
      lease.ownerId !== lease.triggerAttemptId || lease.fencingToken === undefined) {
      throw new Error("INVENTORY_RECONCILIATION_LEASE_IDENTITY_INVALID");
    }
    const run = this.persistence.getRun(lease.runId);
    const attempt = this.persistence.getTriggerAttempt(lease.triggerAttemptId);
    const occurrence = this.persistence.getTriggerOccurrence(lease.occurrenceId);
    if (run?.status !== "uncertain" || attempt?.status !== "running" ||
      attempt.workflowRunId !== lease.runId || occurrence?.status !== "running") {
      throw new Error("INVENTORY_RECONCILIATION_LOCAL_STATE_INVALID");
    }
    const expected = this.persistence.listRuntimeInvocationsForRun(lease.runId)
      .flatMap((record) => {
        const effect = expectedInvocation(
          record.invocation,lease.runId!,lease.requestId
        );
        return effect ? [effect] : [];
      })
      .sort((left,right) => left.operation.localeCompare(right.operation) ||
        left.effectId.localeCompare(right.effectId));
    if (new Set(expected.map((effect) => effect.effectId)).size !== expected.length) {
      throw new Error("INVENTORY_RECONCILIATION_EXPECTED_EFFECTS_INVALID");
    }
    const expectedEffectSetDigest = contentDigest(expected);
    const inspectedAt = this.clock().toISOString();
    const report = await this.client.inspectInventoryEffects({
      leaseRequestId:lease.requestId,
      runId:lease.runId,
      lease:{
        leaseKey:lease.domainKey,
        holderId:lease.ownerId,
        fencingToken:lease.fencingToken
      }
    });
    this.#assertExactReport(expected,report,lease);
    return {
      lease,expected,expectedEffectSetDigest,report,inspectedAt,
      resolutionToken:contentDigest({
        requestId:lease.requestId,
        leaseRevision:lease.revision,
        expectedEffectSetDigest,
        remoteReportDigest:report.reportDigest
      })
    };
  }

  #assertExactReport(
    expected: readonly ExpectedEffect[],
    report: InventoryEffectReconciliationReport,
    lease: ExternalDomainLeaseRecord
  ): void {
    const byId = new Map(expected.map((effect) => [effect.effectId,effect]));
    for (const remote of report.effects) {
      const local = byId.get(remote.effectId);
      if (!local || remote.operation !== local.operation ||
        remote.inputDigest !== local.inputDigest ||
        remote.identityDigest !== local.identityDigest ||
        remote.runId !== lease.runId ||
        remote.leaseRequestId !== lease.requestId) {
        throw new Error("INVENTORY_RECONCILIATION_EFFECT_SET_MISMATCH");
      }
    }
  }

  #counts(inspection: Inspection): {
    expected: number;
    remote: number;
    succeeded: number;
    failed: number;
    missing: number;
  } {
    return {
      expected:inspection.expected.length,
      remote:inspection.report.effects.length,
      succeeded:inspection.report.effects.filter(
        (effect) => effect.status === "succeeded"
      ).length,
      failed:inspection.report.effects.filter(
        (effect) => effect.status === "failed"
      ).length,
      missing:inspection.expected.length - inspection.report.effects.length
    };
  }

  #itemCounts(report: InventoryEffectReconciliationReport): {
    succeeded: number;
    failed: number;
  } {
    return report.effects.reduce(
      (counts,effect:InventoryEffectSummary) => ({
        succeeded:counts.succeeded + effect.itemCounts.succeeded,
        failed:counts.failed + effect.itemCounts.failed
      }),
      { succeeded:0,failed:0 }
    );
  }
}
