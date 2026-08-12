import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import {
  ExternalDomainLeaseConflictError,
  RevisionConflictError,
  type EngineCheckpointRecord,
  type ExecutionEventRecord,
  type OutboxMessage,
  type RunPlanSnapshotRecord,
  type RunRecord
} from "@bpa/persistence";
import {
  migrationChecksum,
  migrations,
  SqlitePersistence
} from "./index.js";

const t0 = "2026-08-09T00:00:00.000Z";
const t1 = "2026-08-09T00:01:00.000Z";
const t2 = "2026-08-09T00:02:00.000Z";
const t3 = "2026-08-09T00:03:00.000Z";
const t4 = "2026-08-09T00:04:00.000Z";
const expiry = "2026-08-09T00:10:00.000Z";

function dropMigration26(database: Database.Database): void {
  const tables = [
    "binance_market_reference_snapshots",
    "binance_market_funding_rates",
    "binance_market_candles_1m",
    "binance_market_symbol_snapshots",
    "binance_market_captures",
    "binance_copy_record_current",
    "binance_copy_raw_records",
    "binance_position_snapshots",
    "binance_copy_project_snapshots",
    "binance_source_captures",
    "binance_collection_runs"
  ];
  database.exec(tables.map((table) => `DROP TABLE ${table};`).join("\n"));
  database.prepare("DELETE FROM schema_migrations WHERE version=26").run();
}

function event(runId: string, sequence = 1): ExecutionEventRecord {
  return {
    id: `event:${runId}:${sequence}`,
    runId,
    sequence,
    type: sequence === 1 ? "RUN_CREATED" : "RUN_CANCELLED",
    payload: {},
    occurredAt: sequence === 1 ? t2 : t4
  };
}

function checkpoint(runId: string): EngineCheckpointRecord {
  return {
    runId,
    stateVersion: "bpa.engine-state/2",
    stateRevision: 1,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId,
      revision: 1,
      status: "waiting_runtime"
    },
    updatedAt: t2
  };
}

function planSnapshot(runId: string): RunPlanSnapshotRecord {
  return {
    runId,
    irVersion: "bpa.workflow-ir/2",
    planDigest: "sha256:plan",
    workflowSourceDigest: "sha256:workflow",
    artifactClosureDigest: "sha256:closure",
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.workflow",
        version: "1.0.0",
        digest: "sha256:workflow"
      },
      artifactClosure: { entries: [] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 1 },
      entry: "done",
      steps: {
        done: { key: "done", kind: "terminal", status: "succeeded" }
      }
    },
    riskSnapshot: [],
    createdAt: t2
  };
}

function seedOccurrence(
  store: SqlitePersistence,
  suffix: string
): {
  occurrenceId: string;
  attemptId: string;
} {
  const spec = {
    apiVersion: "bpa.trigger/v1alpha2" as const,
    id: `inventory.external-lease.${suffix}`,
    version: "1.0.0",
    appId: "inventory-monitor",
    kind: "manual" as const,
    workflow: { id: "test.workflow", version: "1.0.0" },
    enabled: true,
    inputSchemaVersion: "test/1",
    input: {},
    concurrencyKey: `inventory:${suffix}`,
    externalDomainLease: {
      providerId: "inventory-postgres" as const,
      resourceId: "inventory-production-cycle" as const,
      ttlSeconds: 300 as const
    },
    idempotencyPolicy: "request_key" as const,
    retryPolicy: "none" as const
  };
  store.putTriggerSpec({ spec, actor: "test", occurredAt: t0 });
  const occurrenceId = `trigger-occurrence:${suffix}`;
  const attemptId = `trigger-attempt:${suffix}`;
  store.claimTriggerOccurrence({
    occurrenceId,
    triggerId: spec.id,
    triggerVersion: spec.version,
    occurrenceKey: `manual:${suffix}`,
    scheduledAt: t0,
    status: "pending",
    attemptCount: 0,
    revision: 0,
    createdAt: t0,
    updatedAt: t0
  });
  return { occurrenceId, attemptId };
}

function beginAndBind(
  store: SqlitePersistence,
  suffix: string
): { occurrenceId: string; attemptId: string; requestId: string } {
  const { occurrenceId, attemptId } = seedOccurrence(store, suffix);
  const requestId = `external-lease:${suffix}`;
  store.beginExternalDomainLeaseAcquisition({
    requestId,
    providerId: "inventory-postgres",
    domainKey: "inventory-production-cycle",
    occurrenceId,
    ownerId: attemptId,
    createdAt: t0
  });
  store.bindExternalDomainLease({
    requestId,
    expectedRevision: 0,
    fencingToken: 7,
    serverNow: t1,
    expiresAt: expiry,
    updatedAt: t1
  });
  return { occurrenceId, attemptId, requestId };
}

function createAttemptAndRun(
  store: SqlitePersistence,
  identity: { occurrenceId: string; attemptId: string; requestId: string },
  runId: string,
  outbox?: readonly OutboxMessage[]
): RunRecord {
  store.createTriggerAttempt({
    attemptId: identity.attemptId,
    occurrenceId: identity.occurrenceId,
    expectedOccurrenceRevision: 0,
    createdAt: t2
  });
  store.updateTriggerAttempt({
    attemptId: identity.attemptId,
    expectedRevision: 0,
    status: "running",
    updatedAt: t2
  });
  const run: RunRecord = {
    id: runId,
    workflowId: "test.workflow",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:workflow",
    status: "created",
    revision: 0,
    input: {},
    createdAt: t2,
    updatedAt: t2
  };
  store.createRecoverableRun({
    run,
    planSnapshot: planSnapshot(run.id),
    checkpoint: checkpoint(run.id),
    event: event(run.id),
    triggerAttemptId: identity.attemptId,
    externalDomainLeaseRequestId: identity.requestId,
    ...(outbox ? { outbox } : {})
  });
  return run;
}

describe("external domain lease persistence v24", () => {
  it("persists an acquisition intent before consuming a Trigger Attempt", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const { occurrenceId, attemptId } = seedOccurrence(store, "intent");
    const input = {
      requestId: "external-lease:intent",
      providerId: "inventory-postgres",
      domainKey: "inventory-production-cycle",
      occurrenceId,
      ownerId: attemptId,
      createdAt: t0
    };

    expect(store.beginExternalDomainLeaseAcquisition(input)).toMatchObject({
      status: "accepted",
      record: { state: "acquiring", revision: 0, ...input }
    });
    expect(store.beginExternalDomainLeaseAcquisition(input).status).toBe(
      "duplicate"
    );
    expect(store.getTriggerOccurrence(occurrenceId)).toMatchObject({
      status: "pending",
      attemptCount: 0,
      revision: 0
    });
    expect(store.getTriggerAttempt(attemptId)).toBeUndefined();

    expect(() =>
      store.beginExternalDomainLeaseAcquisition({
        ...input,
        requestId: "external-lease:conflict",
        occurrenceId: seedOccurrence(store, "conflict").occurrenceId,
        ownerId: "trigger-attempt:conflict"
      })
    ).toThrow(ExternalDomainLeaseConflictError);
    expect(() =>
      store.beginExternalDomainLeaseAcquisition({
        ...input,
        domainKey: "changed"
      })
    ).toThrow(ExternalDomainLeaseConflictError);
    store.close();
  });

  it("authorizes an intent from the Occurrence-pinned TriggerSpec version", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const { occurrenceId, attemptId } = seedOccurrence(store, "pinned");
    const v1 = store.getTriggerSpec("inventory.external-lease.pinned")!.spec;
    const { externalDomainLease: _removed, ...withoutExternalLease } = v1;
    store.putTriggerSpec({
      spec: {
        ...withoutExternalLease,
        version: "2.0.0"
      },
      actor: "test",
      occurredAt: t1
    });

    expect(() =>
      store.beginExternalDomainLeaseAcquisition({
        requestId: "external-lease:pinned-wrong",
        providerId: "inventory-postgres",
        domainKey: "inventory:not-pinned",
        occurrenceId,
        ownerId: attemptId,
        createdAt: t1
      })
    ).toThrow("does not match pinned TriggerSpec");
    expect(
      store.beginExternalDomainLeaseAcquisition({
        requestId: "external-lease:pinned-v1",
        providerId: "inventory-postgres",
        domainKey: "inventory-production-cycle",
        occurrenceId,
        ownerId: attemptId,
        createdAt: t1
      }).status
    ).toBe("accepted");
    store.close();
  });

  it("enforces CAS, replay, one-way reconciliation, and release closure", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const { requestId } = beginAndBind(store, "state-machine");
    const binding = {
      requestId,
      expectedRevision: 0,
      fencingToken: 7,
      serverNow: t1,
      expiresAt: expiry,
      updatedAt: t1
    };
    expect(store.bindExternalDomainLease(binding).status).toBe("duplicate");
    expect(() =>
      store.renewExternalDomainLease({
        ...binding,
        expectedRevision: 0,
        serverNow: t2,
        updatedAt: t2
      })
    ).toThrow(RevisionConflictError);
    expect(
      store.markExternalDomainLeaseReconciliationRequired({
        requestId,
        expectedRevision: 1,
        diagnostic: "provider response uncertain",
        updatedAt: t2
      }).record
    ).toMatchObject({
      state: "reconciliation_required",
      revision: 2,
      fencingToken: 7
    });
    expect(() =>
      store.bindExternalDomainLease({
        ...binding,
        expectedRevision: 2,
        updatedAt: t3
      })
    ).toThrow(ExternalDomainLeaseConflictError);
    expect(
      store.releaseExternalDomainLease({
        requestId,
        expectedRevision: 2,
        releasedAt: t3
      }).record
    ).toMatchObject({ state: "released", revision: 3, releasedAt: t3 });
    expect(
      store.releaseExternalDomainLease({
        requestId,
        expectedRevision: 2,
        releasedAt: t3
      }).status
    ).toBe("duplicate");
    store.close();
  });

  it("classifies acquisition recovery, renewal, expiry, and terminal release", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const renewal = beginAndBind(store, "renewal");

    expect(
      store
        .listExternalDomainLeasesNeedingRenewal({ now: t2, renewBefore: expiry })
        .map(({ requestId }) => requestId)
    ).toEqual([renewal.requestId]);
    expect(store.listExternalDomainLeasesNeedingRecovery({ now: t2 })).toEqual(
      []
    );
    expect(
      store
        .listExternalDomainLeasesNeedingRecovery({
          now: "2026-08-09T00:11:00.000Z"
        })
        .map(({ requestId }) => requestId)
    ).toEqual([renewal.requestId]);

    const run = createAttemptAndRun(store, renewal, "run:external-lease");
    expect(store.getExternalDomainLease(renewal.requestId)).toMatchObject({
      triggerAttemptId: renewal.attemptId,
      runId: run.id,
      state: "bound",
      revision: 2
    });
    store.commitRunTransition({
      runId: run.id,
      expectedRevision: 0,
      nextStatus: "cancelled",
      event: event(run.id, 2)
    });
    expect(
      store.listExternalDomainLeasesNeedingRelease().map(({ requestId }) =>
        requestId
      )
    ).toEqual([renewal.requestId]);
    store.releaseExternalDomainLease({
      requestId: renewal.requestId,
      expectedRevision: 2,
      releasedAt: t4
    });

    const acquiring = seedOccurrence(store, "recover-acquiring");
    store.beginExternalDomainLeaseAcquisition({
      requestId: "external-lease:recover-acquiring",
      providerId: "inventory-postgres",
      domainKey: "inventory-production-cycle",
      occurrenceId: acquiring.occurrenceId,
      ownerId: acquiring.attemptId,
      createdAt: t4
    });
    expect(
      store
        .listExternalDomainLeasesNeedingRecovery({ now: t4 })
        .map(({ requestId }) => requestId)
    ).toEqual(["external-lease:recover-acquiring"]);
    store.close();
  });

  it("atomically rolls back Run, Attempt link, and lease link on failure", () => {
    let fail = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (fail && point === "recoverable_run.after_external_domain_lease") {
          throw new Error("crash");
        }
      }
    });
    const identity = beginAndBind(store, "atomic");
    store.createTriggerAttempt({
      attemptId: identity.attemptId,
      occurrenceId: identity.occurrenceId,
      expectedOccurrenceRevision: 0,
      createdAt: t2
    });
    store.updateTriggerAttempt({
      attemptId: identity.attemptId,
      expectedRevision: 0,
      status: "running",
      updatedAt: t2
    });
    const run: RunRecord = {
      id: "run:atomic-failure",
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: "created",
      revision: 0,
      input: {},
      createdAt: t2,
      updatedAt: t2
    };
    expect(() =>
      store.createRecoverableRun({
        run,
        planSnapshot: planSnapshot(run.id),
        checkpoint: checkpoint(run.id),
        event: event(run.id),
        triggerAttemptId: identity.attemptId
      })
    ).toThrow("external domain lease does not match Run creation");
    expect(store.getRun(run.id)).toBeUndefined();
    fail = true;
    expect(() =>
      store.createRecoverableRun({
        run,
        planSnapshot: planSnapshot(run.id),
        checkpoint: checkpoint(run.id),
        event: event(run.id),
        triggerAttemptId: identity.attemptId,
        externalDomainLeaseRequestId: identity.requestId
      })
    ).toThrow("crash");
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getTriggerAttempt(identity.attemptId)?.workflowRunId).toBeUndefined();
    const lease = store.getExternalDomainLease(identity.requestId);
    expect(lease).toMatchObject({
      state: "bound",
      revision: 1
    });
    expect(lease?.triggerAttemptId).toBeUndefined();
    expect(lease?.runId).toBeUndefined();
    store.close();
  });

  it("rolls back an injected lease mutation for deterministic replay", () => {
    let fail = true;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (fail && point === "external_domain_lease.bind.after_update") {
          throw new Error("crash");
        }
      }
    });
    const identity = seedOccurrence(store, "bind-replay");
    store.beginExternalDomainLeaseAcquisition({
      requestId: "external-lease:bind-replay",
      providerId: "inventory-postgres",
      domainKey: "inventory-production-cycle",
      occurrenceId: identity.occurrenceId,
      ownerId: identity.attemptId,
      createdAt: t0
    });
    const input = {
      requestId: "external-lease:bind-replay",
      expectedRevision: 0,
      fencingToken: 8,
      serverNow: t1,
      expiresAt: expiry,
      updatedAt: t1
    };
    expect(() => store.bindExternalDomainLease(input)).toThrow("crash");
    expect(store.getExternalDomainLease(input.requestId)).toMatchObject({
      state: "acquiring",
      revision: 0
    });
    fail = false;
    expect(store.bindExternalDomainLease(input).record).toMatchObject({
      state: "bound",
      revision: 1,
      fencingToken: 8
    });
    store.close();
  });
});

describe("migration v24", () => {
  it("keeps historical checksums immutable and upgrades v23 append-only", () => {
    expect(migrationChecksum(migrations[19]!)).toBe(
      "ea98c627836ed4b303cbcd3beb8059b6bac93fcd78818288bd1132883f232656"
    );
    expect(migrationChecksum(migrations[22]!)).toBe(
      "85e0d229dad63388ae53513a349f5db25f4f9dbf771134bfdb170a2cac3273f5"
    );
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v24-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path: databasePath });
      seeded.close();
      const v23 = new Database(databasePath);
      dropMigration26(v23);
      v23.exec(`
        DROP TABLE external_domain_lease_reconciliations;
        DROP TABLE external_domain_leases;
        DELETE FROM schema_migrations WHERE version IN (24,25);
      `);
      v23.close();

      const upgraded = new SqlitePersistence({ path: databasePath });
      expect(upgraded.health().schemaVersion).toBe(26);
      upgraded.close();
      const inspected = new Database(databasePath, { readonly: true });
      expect(
        inspected
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type='index' AND name='external_domain_leases_active_domain'`
          )
          .get()
      ).toMatchObject({ sql: expect.stringContaining("state != 'released'") });
      inspected.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back an interrupted v24 migration and reapplies it on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v24-crash-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path: databasePath });
      seeded.close();
      const v23 = new Database(databasePath);
      dropMigration26(v23);
      v23.exec(`
        DROP TABLE external_domain_lease_reconciliations;
        DROP TABLE external_domain_leases;
        DELETE FROM schema_migrations WHERE version IN (24,25);
      `);
      v23.close();

      expect(
        () =>
          new SqlitePersistence({
            path: databasePath,
            failureInjector(point) {
              if (point === "migration.24.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const inspected = new Database(databasePath, { readonly: true });
      expect(
        inspected
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get()
      ).toEqual({ version: 23 });
      expect(
        inspected
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type='table' AND name='external_domain_leases'`
          )
          .get()
      ).toBeUndefined();
      inspected.close();

      const recovered = new SqlitePersistence({ path: databasePath });
      expect(recovered.health().schemaVersion).toBe(26);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("inventory effect reconciliation persistence v25", () => {
  function uncertainLease(
    store: SqlitePersistence,
    suffix: string
  ): { requestId:string;attemptId:string;runId:string;revision:number } {
    const identity = beginAndBind(store,suffix);
    const run = createAttemptAndRun(store,identity,`run:${suffix}`);
    const terminalEvent = { ...event(run.id,2),type:"RUN_UNCERTAIN" };
    const item = projectTerminalRunAttention({
      id:run.id,workflowId:run.workflowId,workflowVersion:run.workflowVersion,
      status:"uncertain",updatedAt:terminalEvent.occurredAt,
      events:[{ type:terminalEvent.type,payload:terminalEvent.payload }]
    });
    const payload = {
      attentionId:item.id,runId:run.id,workflowId:run.workflowId,
      workflowVersion:run.workflowVersion,severity:item.kind,title:item.title,
      requestedAction:item.requestedAction,occurredAt:item.createdAt
    };
    const idempotencyKey = `attention:${item.id}:operator-notification`;
    store.commitRunTransition({
      runId:run.id,
      expectedRevision:0,
      nextStatus:"uncertain",
      event:terminalEvent,
      attention:{
        sourceRef:{ kind:"workflow-run",runId:run.id },
        deliveryPolicy:"operator-notification",item,state:"open",revision:0
      },
      attentionDelivery:{
        id:`delivery:${idempotencyKey}`,attentionId:item.id,
        channel:"operator-notification",idempotencyKey,
        requestDigest:`sha256:${createHash("sha256")
          .update(JSON.stringify(payload)).digest("hex")}`,
        payload,state:"pending",revision:0,attempt:0,
        createdAt:item.createdAt,updatedAt:item.createdAt
      }
    });
    const reconciled = store.markExternalDomainLeaseReconciliationRequired({
      requestId:identity.requestId,
      expectedRevision:2,
      diagnostic:"External write outcome requires reconciliation.",
      updatedAt:t3
    }).record;
    return {
      requestId:identity.requestId,
      attemptId:identity.attemptId,
      runId:run.id,
      revision:reconciled.revision
    };
  }

  it("atomically records an immutable audit and releases only the exact old lease", () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const identity = uncertainLease(store,"effect-resolve");
    const input = {
      requestId:identity.requestId,
      resolutionToken:`sha256:${"0".repeat(64)}`,
      runId:identity.runId,
      ownerId:identity.attemptId,
      fencingToken:7,
      expectedLeaseRevision:identity.revision,
      expectedEffectSetDigest:`sha256:${"1".repeat(64)}`,
      remoteReportDigest:`sha256:${"2".repeat(64)}`,
      expectedEffectCount:3,
      remoteEffectCount:2,
      succeededEffectCount:1,
      failedEffectCount:1,
      missingEffectCount:1,
      succeededItemCount:4,
      failedItemCount:1,
      classification:"mixed" as const,
      inspectedAt:t3,
      resolvedAt:t4,
      resolvedBy:"operator"
    };

    expect(store.commitInventoryEffectReconciliation(input)).toMatchObject({
      status:"created",
      record:{
        requestId:input.requestId,resolutionToken:input.resolutionToken,
        runId:input.runId,ownerId:input.ownerId,
        fencingToken:input.fencingToken,leaseRevision:identity.revision,
        expectedEffectSetDigest:input.expectedEffectSetDigest,
        remoteReportDigest:input.remoteReportDigest,
        expectedEffectCount:3,remoteEffectCount:2,succeededEffectCount:1,
        failedEffectCount:1,missingEffectCount:1,succeededItemCount:4,
        failedItemCount:1,classification:"mixed",inspectedAt:t3,
        resolvedAt:t4,resolvedBy:"operator"
      }
    });
    expect(store.commitInventoryEffectReconciliation(input).status).toBe("duplicate");
    expect(store.getInventoryEffectReconciliationByResolutionToken(
      input.resolutionToken
    )).toMatchObject({ requestId:input.requestId,classification:"mixed" });
    expect(store.getLatestInventoryEffectReconciliation()).toMatchObject({
      requestId:input.requestId,
      resolutionToken:input.resolutionToken,
      classification:"mixed"
    });
    expect(store.getExternalDomainLease(identity.requestId)).toMatchObject({
      state:"released",
      revision:identity.revision + 1,
      releasedAt:t4
    });
    expect(store.getRun(identity.runId)?.status).toBe("uncertain");
    expect(store.getTriggerAttempt(identity.attemptId)?.status).toBe("running");
    expect(() => store.commitInventoryEffectReconciliation({
      ...input,
      remoteReportDigest:`sha256:${"3".repeat(64)}`
    })).toThrow(ExternalDomainLeaseConflictError);
    store.close();
  });

  it("retains acknowledged runtime invocations for exact effect-set reconstruction",() => {
    const directory = mkdtempSync(join(tmpdir(),"bpa-effect-outbox-v25-"));
    const databasePath = join(directory,"bpa.sqlite3");
    const runId = "run:effect-outbox";
    try {
      const store = new SqlitePersistence({ path:databasePath });
      const identity = beginAndBind(store,"effect-outbox");
      const invocation = {
        invocationId:"invocation:effect-outbox",
        identity:{ runId,scopePath:[],stepKey:"persist",iterationKey:"shop:1",attempt:1 },
        node:{
          kind:"node",id:"inventory.snapshot.persist",version:"2.0.0",
          digest:"sha256:node"
        },
        providerId:"inventory-data",input:{ snapshot:{ snapshotId:"snapshot:1" } },
        permissionSnapshot:{ riskLevel:"R1",permissions:[],domains:[] },
        deadlineAt:Date.parse(t4),idempotencyKey:"inventory:effect-outbox",
        fencingToken:7,traceId:"trace:effect-outbox"
      };
      createAttemptAndRun(store,identity,runId,[
        {
          id:"outbox:effect",topic:"runtime.invoke",aggregateId:runId,
          payload:{ kind:"runtime.invoke",invocation },createdAt:t2
        },
        {
          id:"outbox:other-run",topic:"runtime.invoke",aggregateId:runId,
          payload:{
            kind:"runtime.invoke",
            invocation:{ ...invocation,identity:{ ...invocation.identity,runId:"run:other" } }
          },createdAt:t2
        },
        {
          id:"outbox:other-topic",topic:"browser.command",aggregateId:runId,
          payload:{ kind:"runtime.invoke",invocation },createdAt:t2
        }
      ]);
      store.close();
      const raw = new Database(databasePath);
      raw.prepare("UPDATE engine_outbox SET acknowledged_at=? WHERE id=?")
        .run(t3,"outbox:effect");
      raw.close();

      const reopened = new SqlitePersistence({ path:databasePath });
      expect(reopened.listRuntimeInvocationsForRun(runId)).toEqual([{
        outboxId:"outbox:effect",invocation,createdAt:t2,acknowledgedAt:t3
      }]);
      reopened.close();
    } finally {
      rmSync(directory,{ recursive:true,force:true });
    }
  });

  it("rolls back the audit when the lease CAS cannot commit", () => {
    let fail = false;
    const store = new SqlitePersistence({
      path:":memory:",
      failureInjector(point) {
        if (fail && point === "external_domain_lease_reconciliation.resolve.after_audit") {
          throw new Error("crash");
        }
      }
    });
    const identity = uncertainLease(store,"effect-crash");
    fail = true;
    expect(() => store.commitInventoryEffectReconciliation({
      requestId:identity.requestId,resolutionToken:`sha256:${"6".repeat(64)}`,
      runId:identity.runId,ownerId:identity.attemptId,
      fencingToken:7,expectedLeaseRevision:identity.revision,
      expectedEffectSetDigest:`sha256:${"4".repeat(64)}`,
      remoteReportDigest:`sha256:${"5".repeat(64)}`,
      expectedEffectCount:0,remoteEffectCount:0,succeededEffectCount:0,
      failedEffectCount:0,missingEffectCount:0,succeededItemCount:0,
      failedItemCount:0,classification:"all_terminal",inspectedAt:t3,
      resolvedAt:t4,resolvedBy:"operator"
    })).toThrow("crash");
    expect(store.getInventoryEffectReconciliation(identity.requestId)).toBeUndefined();
    expect(store.getExternalDomainLease(identity.requestId)).toMatchObject({
      state:"reconciliation_required",
      revision:identity.revision
    });
    store.close();
  });

  it("keeps v24 immutable and reapplies an interrupted v25 migration", () => {
    expect(migrationChecksum(migrations[23]!)).toBe(
      "120c7067a4871dcff5e89a3fba3172817054d0c40bc01e06b84931c99b54a10a"
    );
    const directory = mkdtempSync(join(tmpdir(),"bpa-migration-v25-crash-"));
    const databasePath = join(directory,"bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path:databasePath });
      seeded.close();
      const v24 = new Database(databasePath);
      dropMigration26(v24);
      v24.exec(`
        DROP TABLE external_domain_lease_reconciliations;
        DELETE FROM schema_migrations WHERE version=25;
      `);
      v24.close();
      expect(() => new SqlitePersistence({
        path:databasePath,
        failureInjector(point) {
          if (point === "migration.25.after_sql") throw new Error("crash");
        }
      })).toThrow("crash");
      const inspected = new Database(databasePath,{ readonly:true });
      expect(inspected.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations"
      ).get()).toEqual({ version:24 });
      expect(inspected.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='external_domain_lease_reconciliations'`
      ).get()).toBeUndefined();
      inspected.close();
      const recovered = new SqlitePersistence({ path:databasePath });
      expect(recovered.health().schemaVersion).toBe(26);
      recovered.close();
    } finally {
      rmSync(directory,{ recursive:true,force:true });
    }
  });
});
