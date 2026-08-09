import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import type {
  InventoryEffectReconciliationRecord,
  JsonValue,
  Persistence,
  RuntimeInvocationOutboxRecord
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import {
  inventoryEffectIdentity,
  type InventoryWriteOperation
} from "./inventory-data-runtime-provider.js";
import type {
  InventoryDomainLeaseClient,
  InventoryEffectReconciliationReport,
  InventoryEffectSummary
} from "./inventory-domain-lease-client.js";
import { InventoryEffectReconciliationService } from "./inventory-effect-reconciliation.js";

const runId = "run:inventory-reconciliation";
const requestId = "external-lease:inventory-reconciliation";
const attemptId = "trigger-attempt:inventory-reconciliation";
const occurrenceId = "trigger-occurrence:inventory-reconciliation";

function invocation(
  nodeId: "inventory.snapshot.persist" | "inventory.shop.forecast-risk.refresh",
  stepKey: string,
  input: JsonValue
): RuntimeInvocation {
  return {
    invocationId:`invocation:${stepKey}`,
    identity:{ runId,scopePath:[],stepKey,iterationKey:"root",attempt:1 },
    node:{
      kind:"node",
      id:nodeId,
      version:nodeId === "inventory.snapshot.persist" ? "2.0.0" : "1.0.0",
      digest:"sha256:node"
    },
    providerId:"inventory-data",
    input,
    permissionSnapshot:{ riskLevel:"R1",permissions:[],domains:[] },
    deadlineAt:Date.parse("2026-08-10T09:00:00.000Z"),
    idempotencyKey:`inventory:${stepKey}`,
    fencingToken:7,
    traceId:`trace:${stepKey}`
  };
}

function digest(effects: readonly InventoryEffectSummary[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(effects)).digest("hex")}`;
}

function state() {
  const snapshot = invocation("inventory.snapshot.persist","snapshot",{ snapshot:{} });
  const forecast = invocation(
    "inventory.shop.forecast-risk.refresh",
    "forecast",
    { shop:{ id:"10001",name:"店铺" },snapshotReceipts:[] }
  );
  const records:RuntimeInvocationOutboxRecord[] = [snapshot,forecast].map(
    (value,index) => ({
      outboxId:`effect:${value.invocationId}`,
      invocation:value as unknown as RuntimeInvocationOutboxRecord["invocation"],
      createdAt:`2026-08-10T08:00:0${index}.000Z`,
      acknowledgedAt:`2026-08-10T08:00:1${index}.000Z`
    })
  );
  const snapshotIdentity = {
    operation:"inventory.snapshot.persist" as const,
    ...inventoryEffectIdentity(snapshot,"inventory.snapshot.persist",snapshot.input,requestId)
  };
  const forecastIdentity = {
    operation:"inventory.shop.forecast-risk.refresh" as const,
    ...inventoryEffectIdentity(
      forecast,"inventory.shop.forecast-risk.refresh",forecast.input,requestId
    )
  };
  return { records,snapshotIdentity,forecastIdentity };
}

function summary(
  effect: ReturnType<typeof state>["forecastIdentity"],
  status:"running"|"failed" = "running"
):InventoryEffectSummary {
  return {
    effectId:effect.effectId,operation:effect.operation,
    inputDigest:effect.inputDigest,identityDigest:effect.identityDigest,
    runId,leaseRequestId:requestId,status,
    progressCounts:{ attemptedProducts:2,completedProducts:1 },
    itemCounts:{ succeeded:1,failed:0 },resultDigest:null,
    errorCode:status === "failed" ? "RECONCILED_CONFIRMED_PARTIAL" : null,
    updatedAt:"2026-08-10T08:02:00.000Z",
    completedAt:status === "failed" ? "2026-08-10T08:03:00.000Z" : null
  };
}

function fixture(input?:{ remoteIdentityDigest?:string }) {
  const values = state();
  let reconciliation:InventoryEffectReconciliationRecord | undefined;
  let effects:InventoryEffectSummary[] = [{
    ...summary(values.forecastIdentity),
    ...(input?.remoteIdentityDigest
      ? { identityDigest:input.remoteIdentityDigest }
      : {})
  }];
  const persistence = {
    listExternalDomainLeases:vi.fn(() => [{
      requestId,providerId:"inventory-postgres",domainKey:"inventory-production-cycle",
      occurrenceId,ownerId:attemptId,triggerAttemptId:attemptId,runId,
      state:"reconciliation_required",revision:3,fencingToken:7,
      serverNow:"2026-08-10T08:00:00.000Z",expiresAt:"2026-08-10T08:01:00.000Z",
      diagnostic:"reconciliation required",createdAt:"2026-08-10T07:59:00.000Z",
      updatedAt:"2026-08-10T08:02:00.000Z",
      reconciliationRequiredAt:"2026-08-10T08:02:00.000Z"
    }]),
    getRun:vi.fn(() => ({ id:runId,status:"uncertain" })),
    getTriggerAttempt:vi.fn(() => ({
      attemptId,occurrenceId,status:"running",workflowRunId:runId
    })),
    getTriggerOccurrence:vi.fn(() => ({ occurrenceId,status:"running" })),
    listRuntimeInvocationsForRun:vi.fn(() => values.records),
    getInventoryEffectReconciliation:vi.fn(() => undefined),
    getInventoryEffectReconciliationByResolutionToken:vi.fn((token:string) =>
      reconciliation?.resolutionToken === token ? reconciliation : undefined
    ),
    getLatestInventoryEffectReconciliation:vi.fn(() => reconciliation),
    commitInventoryEffectReconciliation:vi.fn((candidate) => {
      if (reconciliation?.resolutionToken === candidate.resolutionToken) {
        return { status:"duplicate" as const,record:reconciliation };
      }
      reconciliation = {
        requestId:candidate.requestId,resolutionToken:candidate.resolutionToken,
        runId:candidate.runId,
        ownerId:candidate.ownerId,fencingToken:candidate.fencingToken,
        leaseRevision:candidate.expectedLeaseRevision,
        expectedEffectSetDigest:candidate.expectedEffectSetDigest,
        remoteReportDigest:candidate.remoteReportDigest,
        expectedEffectCount:candidate.expectedEffectCount,
        remoteEffectCount:candidate.remoteEffectCount,
        succeededEffectCount:candidate.succeededEffectCount,
        failedEffectCount:candidate.failedEffectCount,
        missingEffectCount:candidate.missingEffectCount,
        succeededItemCount:candidate.succeededItemCount,
        failedItemCount:candidate.failedItemCount,
        classification:candidate.classification,
        inspectedAt:candidate.inspectedAt,resolvedAt:candidate.resolvedAt,
        resolvedBy:candidate.resolvedBy
      } satisfies InventoryEffectReconciliationRecord;
      return { status:"created" as const,record:reconciliation };
    })
  } as unknown as Persistence;
  const client = {
    inspectInventoryEffects:vi.fn(async ():Promise<InventoryEffectReconciliationReport> => ({
      status:effects.length ? "available" : "empty",
      effects,
      reportDigest:digest(effects)
    })),
    reconcileInventoryEffect:vi.fn(async (candidate:{ effect:Record<string,unknown> }) => {
      expect(candidate.effect.effectId).toBe(values.forecastIdentity.effectId);
      expect(Object.keys(candidate.effect).sort()).toEqual([
        "effectId","idempotencyKey","identityDigest","inputDigest",
        "invocationId","leaseRequestId","runId"
      ].sort());
      expect(candidate.effect).not.toHaveProperty("operation");
      effects = [summary(values.forecastIdentity,"failed")];
      return {
        effectId:candidate.effect.effectId,
        operation:"inventory.shop.forecast-risk.refresh" as InventoryWriteOperation,
        status:"failed" as const,
        classification:"confirmed_partial" as const
      };
    })
  } as unknown as InventoryDomainLeaseClient;
  return { values,persistence,client };
}

describe("inventory effect reconciliation",() => {
  it("uses a read-only inspection token then atomically resolves exact receipts",async () => {
    const { persistence,client } = fixture();
    const service = new InventoryEffectReconciliationService(
      persistence,client,() => new Date("2026-08-10T08:04:00.000Z")
    );
    const inspected = await service.inspect();
    expect(inspected).toMatchObject({
      state:"ready",classification:"mixed",
      effects:{ expected:2,remote:1,running:1,missing:1 },
      items:{ succeeded:1,failed:0 }
    });
    expect(JSON.stringify(inspected)).not.toContain(runId);
    expect(client.reconcileInventoryEffect).not.toHaveBeenCalled();

    const resolved = await service.resolve({
      resolutionToken:inspected.resolutionToken!,resolvedBy:"operator"
    });
    expect(resolved).toMatchObject({
      state:"resolved",classification:"mixed",
      effects:{ expected:2,remote:1,running:0,failed:1,missing:1 }
    });
    expect(client.reconcileInventoryEffect).toHaveBeenCalledOnce();
    expect(persistence.commitInventoryEffectReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        resolutionToken:inspected.resolutionToken,
        runId,ownerId:attemptId,fencingToken:7,expectedLeaseRevision:3,
        expectedEffectCount:2,remoteEffectCount:1,missingEffectCount:1,
        classification:"mixed",resolvedBy:"operator"
      })
    );
    await expect(service.resolve({
      resolutionToken:inspected.resolutionToken!,resolvedBy:"operator"
    })).resolves.toEqual(resolved);
    expect(client.reconcileInventoryEffect).toHaveBeenCalledOnce();
    expect(persistence.commitInventoryEffectReconciliation).toHaveBeenCalledOnce();
  });

  it("rejects a remote receipt whose trusted identity does not match the outbox",async () => {
    const { persistence,client } = fixture({
      remoteIdentityDigest:`sha256:${"0".repeat(64)}`
    });
    const service = new InventoryEffectReconciliationService(persistence,client);
    await expect(service.inspect()).rejects.toThrow(
      "INVENTORY_RECONCILIATION_EFFECT_SET_MISMATCH"
    );
    expect(persistence.commitInventoryEffectReconciliation).not.toHaveBeenCalled();
  });

  it("refuses a stale operator token before changing any remote effect",async () => {
    const { persistence,client } = fixture();
    const service = new InventoryEffectReconciliationService(persistence,client);
    await expect(service.resolve({
      resolutionToken:`sha256:${"9".repeat(64)}`,
      resolvedBy:"operator"
    })).rejects.toThrow("INVENTORY_RECONCILIATION_TOKEN_CHANGED");
    expect(client.reconcileInventoryEffect).not.toHaveBeenCalled();
  });

  it("returns one immutable result when two operators resolve the same token",async () => {
    const { persistence,client } = fixture();
    const service = new InventoryEffectReconciliationService(
      persistence,client,() => new Date("2026-08-10T08:04:00.000Z")
    );
    const inspected = await service.inspect();
    const [first,second] = await Promise.all([
      service.resolve({ resolutionToken:inspected.resolutionToken!,resolvedBy:"operator-a" }),
      service.resolve({ resolutionToken:inspected.resolutionToken!,resolvedBy:"operator-b" })
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state:"resolved",classification:"mixed" });
    expect(client.reconcileInventoryEffect).toHaveBeenCalledOnce();
    expect(persistence.commitInventoryEffectReconciliation).toHaveBeenCalledOnce();
  });
});
