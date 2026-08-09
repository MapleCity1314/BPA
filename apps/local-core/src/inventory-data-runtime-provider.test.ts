import { contentDigest } from "@bpa/compiler";
import {
  RevisionConflictError,
  type ExternalDomainLeaseRecord,
  type Persistence,
  type RunRecord,
  type TriggerAttemptRecord,
  type TriggerOccurrenceRecord,
  type TriggerSpecDefinition
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import type { JsonValue } from "@bpa/workflow-ir";
import { describe, expect, it } from "vitest";
import {
  InventoryDataRuntimeProvider,
  InventoryServiceWriterError,
  type InventoryEffectIdentity,
  type InventoryServiceWriter,
  type InventoryWriteOperation,
  type LeaseFence
} from "./inventory-data-runtime-provider.js";

const localUpdatedAt = "2026-08-09T08:00:00.000Z";
const serverNow = "2026-08-09T00:00:00.000Z";
const expiresAt = "2026-08-09T00:05:00.000Z";

const run: RunRecord = {
  id: "run:inventory",
  workflowId: "doudian.inventory.snapshot.refresh",
  workflowVersion: "2.0.0",
  workflowDigest: "sha256:workflow",
  status: "running",
  revision: 3,
  input: { shopId: "10001", shopName: "测试店铺" },
  createdAt: localUpdatedAt,
  updatedAt: localUpdatedAt
};

const occurrence: TriggerOccurrenceRecord = {
  occurrenceId: "occurrence:inventory",
  triggerId: "doudian.inventory.snapshot.refresh.30m",
  triggerVersion: "1.0.0",
  occurrenceKey: "2026-08-09T08:00:00+08:00",
  scheduledAt: localUpdatedAt,
  status: "running",
  attemptCount: 1,
  revision: 1,
  createdAt: localUpdatedAt,
  updatedAt: localUpdatedAt
};

const attempt: TriggerAttemptRecord = {
  attemptId: "attempt:inventory",
  occurrenceId: occurrence.occurrenceId,
  attemptNumber: 1,
  revision: 2,
  status: "running",
  workflowRunId: run.id,
  createdAt: localUpdatedAt,
  updatedAt: localUpdatedAt
};

const spec: TriggerSpecDefinition = {
  apiVersion: "bpa.trigger/v1alpha2",
  id: occurrence.triggerId,
  version: occurrence.triggerVersion,
  appId: "inventory-monitor",
  kind: "manual",
  workflow: { id: run.workflowId, version: run.workflowVersion },
  enabled: false,
  inputSchemaVersion: "doudian.inventory.snapshot.refresh/2.0.0",
  input: { shopId: "10001", shopName: "测试店铺" },
  concurrencyKey: "inventory-production-cycle",
  externalDomainLease: {
    providerId: "inventory-postgres",
    resourceId: "inventory-production-cycle",
    ttlSeconds: 300
  },
  idempotencyPolicy: "request_key",
  retryPolicy: "none"
};

const lease: ExternalDomainLeaseRecord = {
  requestId: "external-lease:inventory",
  providerId: "inventory-postgres",
  domainKey: "inventory-production-cycle",
  occurrenceId: occurrence.occurrenceId,
  ownerId: attempt.attemptId,
  triggerAttemptId: attempt.attemptId,
  runId: run.id,
  state: "bound",
  revision: 2,
  fencingToken: 7,
  serverNow,
  expiresAt,
  createdAt: localUpdatedAt,
  updatedAt: localUpdatedAt
};

interface FakeState {
  run?: RunRecord;
  occurrence?: TriggerOccurrenceRecord;
  attempt?: TriggerAttemptRecord;
  spec?: TriggerSpecDefinition;
  leases: ExternalDomainLeaseRecord[];
  reconciliation?: {
    requestId: string;
    expectedRevision: number;
    diagnostic: string;
    updatedAt: string;
  };
  reconciliationRevisionConflictOnce?: boolean;
}

function store(state: FakeState): Persistence {
  return {
    getRun: (id: string) => (state.run?.id === id ? state.run : undefined),
    getTriggerAttempt: (id: string) =>
      state.attempt?.attemptId === id ? state.attempt : undefined,
    getTriggerOccurrence: (id: string) =>
      state.occurrence?.occurrenceId === id ? state.occurrence : undefined,
    getTriggerSpecVersion: (id: string, version: string) =>
      state.spec?.id === id && state.spec.version === version
        ? state.spec
        : undefined,
    getExternalDomainLease: (requestId: string) =>
      state.leases.find((candidate) => candidate.requestId === requestId),
    listExternalDomainLeases: () => state.leases,
    markExternalDomainLeaseReconciliationRequired: (
      input: Parameters<
        Persistence["markExternalDomainLeaseReconciliationRequired"]
      >[0]
    ) => {
      if (state.reconciliationRevisionConflictOnce) {
        state.reconciliationRevisionConflictOnce = false;
        state.leases = state.leases.map((candidate) =>
          candidate.requestId === input.requestId
            ? { ...candidate, revision: candidate.revision + 1 }
            : candidate
        );
        throw new RevisionConflictError("simulated renewal race");
      }
      state.reconciliation = input;
      const current = state.leases.find(
        (candidate) => candidate.requestId === input.requestId
      );
      if (!current) throw new Error("lease missing");
      const record: ExternalDomainLeaseRecord = {
        ...current,
        state: "reconciliation_required",
        revision: current.revision + 1,
        diagnostic: input.diagnostic,
        reconciliationRequiredAt: input.updatedAt,
        updatedAt: input.updatedAt
      };
      state.leases = state.leases.map((candidate) =>
        candidate.requestId === record.requestId ? record : candidate
      );
      return { status: "updated", record };
    }
  } as unknown as Persistence;
}

function state(
  overrides: Partial<FakeState> = {}
): FakeState {
  return {
    run: { ...run },
    occurrence: { ...occurrence },
    attempt: { ...attempt },
    spec: structuredClone(spec),
    leases: [{ ...lease }],
    ...overrides
  };
}

function invocation(input: JsonValue): RuntimeInvocation {
  return {
    invocationId: "invocation:inventory",
    identity: {
      runId: run.id,
      scopePath: [
        { foreachStepKey: "snapshot_products", itemKey: "80001" }
      ],
      iterationKey: "80001",
      stepKey: "persist_snapshot",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "inventory.snapshot.persist",
      version: "2.0.0",
      digest: "sha256:node"
    },
    providerId: "inventory-data",
    input,
    permissionSnapshot: {
      riskLevel: "R1",
      permissions: ["inventory.service.snapshot.write"],
      domains: []
    },
    deadlineAt: Date.parse("2026-08-09T08:05:00.000Z"),
    idempotencyKey: "inventory:10001:80001",
    fencingToken: 11,
    traceId: "trace:inventory"
  };
}

function writeInvocation(input:{
  readonly id:string;
  readonly version?:string;
  readonly permission:string;
  readonly value:JsonValue;
}):RuntimeInvocation {
  const base = invocation(input.value);
  return {
    ...base,
    node:{ ...base.node,id:input.id,version:input.version ?? "2.0.0" },
    permissionSnapshot:{
      riskLevel:"R1",permissions:[input.permission],domains:[]
    }
  };
}

class FakeWriter implements InventoryServiceWriter {
  calls: Array<{
    operation: InventoryWriteOperation;
    input: JsonValue;
    lease: LeaseFence;
    effect: InventoryEffectIdentity;
  }> = [];

  constructor(readonly error?: Error) {}

  async write(
    request: {
      readonly operation: InventoryWriteOperation;
      readonly input: JsonValue;
      readonly lease: LeaseFence;
      readonly effect: InventoryEffectIdentity;
    }
  ): Promise<JsonValue> {
    this.calls.push(structuredClone(request));
    if (this.error) throw this.error;
    if (request.operation === "sales-demand.sync") {
      return {
        status:"succeeded",syncRunId:"sync:1",processed:10,
        inserted:10,updated:0,internal:"not-public"
      };
    }
    if (request.operation === "inventory.shop.forecast-risk.refresh") {
      return {
        status:"complete",attemptedProducts:0,completedProducts:0,
        partialProducts:0,failedProducts:0,
        forecastWrites:{ attempted:0,persisted:0 },
        riskWrites:{ attempted:0,persisted:0 },
        severities:{ normal:0,warning:0,critical:0,unknown:0 }
      };
    }
    return {
      snapshotId: "snapshot:80001",
      envelope: { persisted: true }
    };
  }

  async readOrdersFreshness():Promise<JsonValue> {
    return {
      status:"refresh_required",shop:{ id:"10001",name:"测试店铺" },
      checkedAt:localUpdatedAt,maxAgeSeconds:7200,
      latestObservedAt:null,ageSeconds:null,datasetId:null,dataVersion:null,
      source:null
    };
  }
}

function provider(
  fakeState: FakeState,
  writer: InventoryServiceWriter
): InventoryDataRuntimeProvider {
  return new InventoryDataRuntimeProvider(
    store(fakeState),
    writer,
    () => new Date("2026-08-09T08:04:00.000Z")
  );
}

describe("InventoryDataRuntimeProvider", () => {
  it("rejects duplicate fixed-shop identity before any inventory service call",async () => {
    const writer = new FakeWriter();
    const duplicateShops = Array.from({ length:13 },(_,index) => ({
      id:index === 12 ? "10001" : String(10_001 + index),
      name:`测试店铺${index + 1}`
    }));
    const base = invocation({ expectedShopCount:13,shops:duplicateShops });
    const result = await provider(state(),writer).invoke({
      ...base,
      node:{
        ...base.node,
        id:"inventory.production-cycle.input.validate",
        version:"1.0.0"
      },
      permissionSnapshot:{ riskLevel:"R0",permissions:[],domains:[] }
    },new AbortController().signal);
    expect(result).toMatchObject({
      status:"rejected",
      error:{ code:"INVENTORY_PRODUCTION_CYCLE_SHOP_DUPLICATE" }
    });
    expect(writer.calls).toEqual([]);
  });

  it.each([
    {
      id:"ecom.sales-demand.sync",
      permission:"inventory.service.sales-demand.write",
      operation:"sales-demand.sync",
      value:{ shopId:"10001",shopName:"测试店铺" }
    },
    {
      id:"inventory.snapshot.persist",
      permission:"inventory.service.snapshot.write",
      operation:"inventory.snapshot.persist",
      value:{ snapshot:{ shop:{ id:"10001" },product:{ id:"80001" } } }
    },
    {
      id:"inventory.shop.forecast-risk.refresh",
      version:"1.0.0",
      permission:"inventory.service.forecast-risk.write",
      operation:"inventory.shop.forecast-risk.refresh",
      value:{
        shop:{ id:"10001",name:"测试店铺" },
        attemptedSnapshots:0,persistedSnapshots:0,
        failedSnapshots:0,unresolvedSnapshots:0,snapshotReceipts:[]
      }
    }
  ])("routes exact v2 $id through the hidden Run fence",async (entry) => {
    const writer = new FakeWriter();
    const result = await provider(state(),writer).invoke(
      writeInvocation(entry),new AbortController().signal
    );
    expect(result.status).toBe("succeeded");
    expect(writer.calls).toMatchObject([{
      operation:entry.operation,
      input:entry.value,
      lease:{
        leaseKey:"inventory-production-cycle",
        holderId:"attempt:inventory",fencingToken:7
      }
    }]);
  });

  it("routes orders freshness through the trusted read without exposing a fence",async () => {
    const writer = new FakeWriter();
    const base = invocation({ shop:{ id:"10001",name:"测试店铺" } });
    const result = await provider(state(),writer).invoke({
      ...base,
      node:{
        ...base.node,id:"inventory.orders.freshness.read",version:"1.0.0"
      },
      permissionSnapshot:{
        riskLevel:"R0",permissions:["inventory.service.orders.read"],domains:[]
      }
    },new AbortController().signal);
    expect(result).toMatchObject({
      status:"succeeded",
      output:{
        status:"refresh_required",shop:{ id:"10001",name:"测试店铺" },
        maxAgeSeconds:7200
      }
    });
    expect(writer.calls).toEqual([]);
  });

  it("injects the unique Run-bound lease without accepting it from Workflow input", async () => {
    const fakeState = state();
    const writer = new FakeWriter();
    const result = await provider(fakeState, writer).invoke(
      invocation({ snapshot: { shop: { id: "10001" }, product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: { snapshotId: "snapshot:80001" }
    });
    expect(writer.calls).toEqual([
      {
        operation: "inventory.snapshot.persist",
        input: {
          snapshot: {
            shop: { id: "10001" },
            product: { id: "80001" }
          }
        },
        lease: {
          leaseKey: "inventory-production-cycle",
          holderId: "attempt:inventory",
          fencingToken: 7
        },
        effect: {
          effectId: `inventory-effect:${contentDigest({
            idempotencyKey: "inventory:10001:80001",
            identity: invocation({}).identity,
            node: invocation({}).node
          })}`,
          inputDigest: contentDigest({
            operation: "inventory.snapshot.persist",
            input: {
              snapshot: {
                shop: { id: "10001" },
                product: { id: "80001" }
              }
            }
          }),
          identityDigest: contentDigest({
            identity: invocation({}).identity,
            node: invocation({}).node
          }),
          runId: run.id,
          invocationId: "invocation:inventory",
          idempotencyKey: "inventory:10001:80001",
          leaseRequestId: "external-lease:inventory"
        }
      }
    ]);
    expect(run.input).not.toHaveProperty("lease");
  });

  it("rejects caller-supplied lease material and never dispatches it", async () => {
    const writer = new FakeWriter();
    const result = await provider(state(), writer).invoke(
      invocation({
        snapshot: { product: { id: "80001" } },
        lease: { leaseKey: "forged", holderId: "forged", fencingToken: 99 }
      }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "INVENTORY_SNAPSHOT_INPUT_INVALID", retryable: false }
    });
    expect(writer.calls).toEqual([]);
  });

  it("fails closed for a missing, duplicate, or mismatched Run lease", async () => {
    const { fencingToken: _fencingToken, ...leaseWithoutFence } = lease;
    const cases: ExternalDomainLeaseRecord[][] = [
      [],
      [{ ...lease }, { ...lease, requestId: "external-lease:duplicate" }],
      [{ ...lease, providerId: "wrong-provider" }],
      [leaseWithoutFence]
    ];
    for (const leases of cases) {
      const writer = new FakeWriter();
      const result = await provider(state({ leases }), writer).invoke(
        invocation({ snapshot: { product: { id: "80001" } } }),
        new AbortController().signal
      );
      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "INVENTORY_EXTERNAL_LEASE_INVALID", retryable: false }
      });
      expect(writer.calls).toEqual([]);
    }
  });

  it("uses server duration plus local elapsed time instead of comparing clocks", async () => {
    const writer = new FakeWriter();
    const result = await provider(state(), writer).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result.status).toBe("succeeded");
    expect(writer.calls).toHaveLength(1);
  });

  it("fails closed when the Core wall clock moves behind the verified lease window", async () => {
    const writer = new FakeWriter();
    const result = await new InventoryDataRuntimeProvider(
      store(state()),
      writer,
      () => new Date("2026-08-09T07:59:59.000Z")
    ).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "INVENTORY_EXTERNAL_LEASE_INVALID", retryable: false }
    });
    expect(writer.calls).toEqual([]);
  });

  it("marks transport-uncertain writes for reconciliation without leaking diagnostics", async () => {
    const fakeState = state();
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "INVENTORY_SERVICE_UNAVAILABLE",
        "connect /private/secret/inventory.sock timed out",
        true
      )
    );
    const result = await provider(fakeState, writer).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "uncertain",
      error: { code: "INVENTORY_SERVICE_UNAVAILABLE", retryable: false }
    });
    expect(fakeState.reconciliation).toMatchObject({
      requestId: lease.requestId,
      expectedRevision: lease.revision,
      diagnostic:
        "Inventory write inventory.snapshot.persist requires reconciliation: INVENTORY_SERVICE_UNAVAILABLE."
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(fakeState.reconciliation)).not.toContain("secret");
  });

  it("re-reads the exact lease after a concurrent renewal before marking uncertainty", async () => {
    const fakeState = state({ reconciliationRevisionConflictOnce: true });
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "INVENTORY_SERVICE_UNAVAILABLE",
        "response was not received",
        true
      )
    );
    const result = await provider(fakeState, writer).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result.status).toBe("uncertain");
    expect(fakeState.reconciliation).toMatchObject({
      requestId: lease.requestId,
      expectedRevision: lease.revision + 1
    });
    expect(fakeState.leases[0]).toMatchObject({
      state: "reconciliation_required",
      revision: lease.revision + 2
    });
  });

  it("treats scheduler lease loss as uncertain and reconciliation-required", async () => {
    const fakeState = state();
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "SCHEDULER_LEASE_LOST",
        "lease assertion failed"
      )
    );
    const result = await provider(fakeState, writer).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "uncertain",
      error: { code: "SCHEDULER_LEASE_LOST", retryable: false }
    });
    expect(fakeState.leases[0]).toMatchObject({
      state: "reconciliation_required",
      diagnostic:
        "Inventory write inventory.snapshot.persist requires reconciliation: SCHEDULER_LEASE_LOST."
    });
  });

  it("keeps a sales-demand partial commit uncertain through Provider reconciliation", async () => {
    const fakeState = state();
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "SALES_DEMAND_PARTIAL_COMMIT",
        "controlled service response",
        true
      )
    );
    const result = await provider(fakeState,writer).invoke(
      writeInvocation({
        id:"ecom.sales-demand.sync",
        permission:"inventory.service.sales-demand.write",
        value:{ shopId:"10001",shopName:"测试店铺" }
      }),
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status:"uncertain",
      error:{ code:"SALES_DEMAND_PARTIAL_COMMIT",retryable:false }
    });
    expect(fakeState.reconciliation?.diagnostic).toBe(
      "Inventory write sales-demand.sync requires reconciliation: SALES_DEMAND_PARTIAL_COMMIT."
    );
  });

  it("keeps a shop forecast-risk partial commit uncertain through Provider reconciliation",async () => {
    const fakeState = state();
    const writer = new FakeWriter(new InventoryServiceWriterError(
      "INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT",
      "socket /private/secret-path timed out",
      true
    ));
    const entry = {
      id:"inventory.shop.forecast-risk.refresh",version:"1.0.0",
      permission:"inventory.service.forecast-risk.write",
      operation:"inventory.shop.forecast-risk.refresh",
      value:{
        shop:{ id:"10001",name:"测试店铺" },
        attemptedSnapshots:1,persistedSnapshots:1,
        failedSnapshots:0,unresolvedSnapshots:0,
        snapshotReceipts:[{ itemKey:"80001",output:{ productId:"80001",snapshotId:"snapshot:1" } }]
      }
    };
    const outcome = await provider(fakeState,writer).invoke(
      writeInvocation(entry),new AbortController().signal
    );
    expect(outcome).toMatchObject({
      status:"uncertain",
      error:{ code:"INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT",retryable:false }
    });
    expect(fakeState.reconciliation?.diagnostic).toBe(
      "Inventory write inventory.shop.forecast-risk.refresh requires reconciliation: INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT."
    );
    expect(JSON.stringify(outcome)).not.toContain("secret-path");
  });

  it("returns unavailable only for a controlled zero-commit sales source gap",async () => {
    const fakeState = state();
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "MYSQL_SOURCE_NOT_CONFIGURED","source is disabled",false
      )
    );
    const result = await provider(fakeState,writer).invoke(
      writeInvocation({
        id:"ecom.sales-demand.sync",
        permission:"inventory.service.sales-demand.write",
        value:{ shopId:"10001",shopName:"测试店铺" }
      }),
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status:"succeeded",
      output:{
        status:"unavailable",syncRunId:null,processed:0,
        reasonCode:"MYSQL_SOURCE_NOT_CONFIGURED"
      }
    });
    expect(fakeState.reconciliation).toBeUndefined();
  });

  it("does not downgrade a sales identity violation to unavailable",async () => {
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "SHOP_IDENTITY_MISMATCH","identity mismatch",false
      )
    );
    const result = await provider(state(),writer).invoke(
      writeInvocation({
        id:"ecom.sales-demand.sync",
        permission:"inventory.service.sales-demand.write",
        value:{ shopId:"10001",shopName:"测试店铺" }
      }),
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status:"failed",
      error:{ code:"SHOP_IDENTITY_MISMATCH",retryable:false }
    });
  });

  it("returns a deterministic non-retryable failure for a known business rejection", async () => {
    const fakeState = state();
    const writer = new FakeWriter(
      new InventoryServiceWriterError(
        "LEASE_FENCE_INVALID",
        "database included sensitive detail"
      )
    );
    const result = await provider(fakeState, writer).invoke(
      invocation({ snapshot: { product: { id: "80001" } } }),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "LEASE_FENCE_INVALID",
        message: "The inventory service rejected the lease fence.",
        retryable: false
      }
    });
    expect(fakeState.reconciliation).toBeUndefined();
  });
});
