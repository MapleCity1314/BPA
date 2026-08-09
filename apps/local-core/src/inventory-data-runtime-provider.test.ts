import { describe, expect, it } from "vitest";
import type {
  ExternalDomainLeaseRecord,
  Persistence,
  RunRecord,
  TriggerAttemptRecord,
  TriggerOccurrenceRecord,
  TriggerSpecDefinition
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  InventoryDataRuntimeProvider,
  InventoryServiceWriterError,
  type InventoryServiceWriter,
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
    listExternalDomainLeases: () => state.leases,
    markExternalDomainLeaseReconciliationRequired: (
      input: Parameters<
        Persistence["markExternalDomainLeaseReconciliationRequired"]
      >[0]
    ) => {
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

class FakeWriter implements InventoryServiceWriter {
  calls: Array<{ snapshot: JsonValue; lease: LeaseFence }> = [];

  constructor(readonly error?: Error) {}

  async persistSnapshot(
    input: { readonly snapshot: JsonValue; readonly lease: LeaseFence }
  ): Promise<JsonValue> {
    this.calls.push(structuredClone(input));
    if (this.error) throw this.error;
    return {
      snapshotId: "snapshot:80001",
      envelope: { persisted: true }
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
        snapshot: { shop: { id: "10001" }, product: { id: "80001" } },
        lease: {
          leaseKey: "inventory-production-cycle",
          holderId: "attempt:inventory",
          fencingToken: 7
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
        "Inventory snapshot persistence requires reconciliation: INVENTORY_SERVICE_UNAVAILABLE."
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(fakeState.reconciliation)).not.toContain("secret");
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
        "Inventory snapshot persistence requires reconciliation: SCHEDULER_LEASE_LOST."
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
