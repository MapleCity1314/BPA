import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrowserSessionRecord,
  ResourceBindingSnapshot,
  RunPlanSnapshotRecord
} from "@bpa/persistence";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes
} from "@bpa/evidence-core";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-07-30T00:00:00.000Z";
const capabilityDigest = `sha256:${"a".repeat(64)}`;
const requirement = {
  kind: "browser" as const,
  capabilities: ["browser.dom.read"],
  allowedOrigins: ["https://www.chanmama.com"],
  authentication: "membership" as const,
  purpose: "Read authenticated metrics."
};

function browserSession(id = "session:v8"): BrowserSessionRecord {
  return {
    id,
    browserInstanceId: "browser:v8",
    extensionId: "extension:v8",
    extensionVersion: "1.0.0",
    protocolVersion: "1.0.0",
    incomingSeq: 0,
    outgoingSeq: 0,
    lastAckedCommandSeq: 0,
    capabilityDigest,
    resumeTokenDigest: `sha256:${createHash("sha256").update(id).digest("hex")}`,
    resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
    connectedAt: timestamp
  };
}

function planSnapshot(runId: string): RunPlanSnapshotRecord {
  return {
    runId,
    irVersion: "bpa.workflow-ir/2",
    planDigest: `sha256:${"1".repeat(64)}`,
    workflowSourceDigest: `sha256:${"2".repeat(64)}`,
    artifactClosureDigest: `sha256:${"3".repeat(64)}`,
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "workflow:v8",
        version: "1.0.0",
        digest: `sha256:${"2".repeat(64)}`
      },
      artifactClosure: { entries: [] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 4 },
      resourceSlots: { metrics_source: requirement },
      entry: "done",
      steps: {
        done: { key: "done", kind: "terminal", status: "succeeded" }
      }
    },
    riskSnapshot: [],
    createdAt: timestamp
  };
}

function bindingSnapshot(
  runId: string,
  sessionId = "session:v8"
): ResourceBindingSnapshot {
  return {
    snapshotVersion: "bpa.resource-binding/1",
    runId,
    resourceSlots: { metrics_source: requirement },
    bindings: {
      metrics_source: {
        bindingId: `binding:${runId}`,
        revision: 1,
        slotName: "metrics_source",
        sessionId,
        browserInstanceId: "browser:v8",
        tabId: 42,
        capabilityDigest,
        origin: "https://www.chanmama.com",
        pathname: "/metrics",
        pageEpoch: "tab-42:1:test",
        observerCapabilityId: "chanmama.page",
        authentication: "membership",
        authenticationContextRef: "auth-context-member",
        frozenAt: 1,
        approvedBy: "user:test"
      }
    }
  };
}

function openObservedSession(database: SqlitePersistence, id = "session:v8") {
  const session = browserSession(id);
  expect(
    database.openBrowserSession({ session, now: timestamp }).session
  ).toEqual(session);
  database.upsertBrowserPageObservation({
    sessionId: id,
    browserInstanceId: session.browserInstanceId,
    tabId: 42,
    origin: "https://www.chanmama.com",
    pathname: "/metrics",
    contentScriptReady: true,
    authentication: "membership",
    authenticationContextRef: "auth-context-member",
    observationState: "ready",
    pageEpoch: "tab-42:1:test",
    observerCapabilityId: "chanmama.page",
    revision: 1,
    observedAt: timestamp,
  });
  return database.updateBrowserSessionObservation({
    id,
    expectedRevision: 0,
    role: "metrics_source",
    observedOrigin: "https://www.chanmama.com",
    observedAuthentication: "membership",
    observationState: "available",
    observedAt: timestamp
  });
}

function createBoundRun(
  database: SqlitePersistence,
  runId = "run:v8",
  snapshot = bindingSnapshot(runId)
) {
  const plan = planSnapshot(runId);
  return database.createRecoverableRun({
    run: {
      id: runId,
      workflowId: "workflow:v8",
      workflowVersion: "1.0.0",
      workflowDigest: `sha256:${"2".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    planSnapshot: plan,
    resourceBindingSnapshot: snapshot,
    checkpoint: {
      runId,
      stateVersion: "bpa.engine-state/2",
      stateRevision: 1,
      state: { runId, status: "waiting_runtime" },
      updatedAt: timestamp
    },
    event: {
      id: `event:${runId}:1`,
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
}

describe("SQLite v8 Resource Binding and Session observation", () => {
  it("persists generic available pages and keeps stable observation revisions", () => {
    const database = new SqlitePersistence({ path: ":memory:" });
    const session = browserSession("session:page");
    database.openBrowserSession({ session, now: timestamp });
    const first = database.upsertBrowserPageObservation({
      sessionId: session.id,
      browserInstanceId: session.browserInstanceId,
      tabId: 7,
      origin: "https://fxg.jinritemai.com",
      pathname: "/ffa/g/list",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-shop",
      observationState: "ready",
      pageEpoch: "tab-7:1:test",
      observerCapabilityId: "doudian.page",
      revision: 1,
      observedAt: timestamp
    });
    const refreshed = database.upsertBrowserPageObservation({
      ...first,
      observedAt: "2026-07-30T00:00:01.000Z"
    });
    expect(refreshed.revision).toBe(first.revision);
    expect(
      database.pruneBrowserPageObservations({
        observedBefore: "2026-08-31T00:00:00.000Z"
      })
    ).toBe(0);
    database.invalidateBrowserPageObservations({
      sessionId: session.id,
      observedAt: "2026-07-30T00:00:02.000Z",
      reasonCode: "TEST_DISCONNECT"
    });
    expect(
      database.pruneBrowserPageObservations({
        observedBefore: "2026-08-31T00:00:00.000Z"
      })
    ).toBe(1);
    expect(database.getBrowserPageObservation(session.id, 7)).toBeUndefined();
    database.close();
  });

  it("freezes an exact Resource Binding Snapshot with the recoverable Run", () => {
    const database = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    const observed = openObservedSession(database);
    expect(observed).toMatchObject({
      observationRevision: 1,
      role: "metrics_source",
      observedOrigin: "https://www.chanmama.com",
      observedAuthentication: "membership",
      observationState: "available"
    });
    const snapshot = bindingSnapshot("run:v8");
    createBoundRun(database, "run:v8", snapshot);
    expect(database.getRunResourceBindingSnapshot("run:v8")).toEqual(
      snapshot
    );
  });

  it("rejects slot drift, observed Session drift, and stale CAS", () => {
    const database = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    openObservedSession(database);
    expect(() =>
      database.updateBrowserSessionObservation({
        id: "session:v8",
        expectedRevision: 0,
        role: "metrics_source",
        observedOrigin: "https://www.chanmama.com",
        observedAuthentication: "membership",
        observationState: "available",
        observedAt: timestamp
      })
    ).toThrow("revision changed");
    expect(() =>
      createBoundRun(database, "run:slot-drift", {
        ...bindingSnapshot("run:slot-drift"),
        bindings: {}
      })
    ).toThrow("exact IR resource slots");
    database.upsertBrowserPageObservation({
      sessionId: "session:v8",
      browserInstanceId: "browser:v8",
      tabId: 42,
      origin: "https://www.chanmama.com",
      pathname: "/metrics",
      contentScriptReady: true,
      authentication: "anonymous",
      observationState: "auth_required",
      pageEpoch: "tab-42:1:test",
      observerCapabilityId: "chanmama.page",
      revision: 2,
      observedAt: "2026-07-30T00:00:01.000Z"
    });
    expect(() => createBoundRun(database, "run:session-drift")).toThrow(
      "session observation drifted"
    );
  });

  it("lists Browser Sessions with bounded stable filters", () => {
    const database = new SqlitePersistence({ path: ":memory:" });
    openObservedSession(database, "session:a");
    database.openBrowserSession({
      session: browserSession("session:b"),
      now: timestamp
    });
    database.updateBrowserSessionObservation({
      id: "session:b",
      expectedRevision: 0,
      role: "public_asset_source",
      observedOrigin: "https://www.chanmama.com",
      observedAuthentication: "anonymous",
      observationState: "available",
      observedAt: timestamp
    });
    const first = database.listBrowserSessions({ limit: 1 });
    expect(first.records.map((session) => session.id)).toEqual(["session:a"]);
    expect(
      database.listBrowserSessions({
        limit: 1,
        cursor: first.nextCursor!
      }).records.map((session) => session.id)
    ).toEqual(["session:b"]);
    expect(
      database.listBrowserSessions({
        limit: 10,
        role: "metrics_source",
        observationState: "available"
      }).records.map((session) => session.id)
    ).toEqual(["session:a"]);
    expect(() =>
      database.listBrowserSessions({
        limit: 10,
        cursor: { createdAt: "not-a-date", id: "session:a" }
      })
    ).toThrow("cursor is invalid");
  });

  it("resumes the same observed Session identity for frozen bindings", () => {
    const database = new SqlitePersistence({ path: ":memory:" });
    const observed = openObservedSession(database);
    database.updateBrowserSession({
      id: observed.id,
      disconnectedAt: "2026-07-30T00:01:00.000Z"
    });
    const replacement = {
      ...browserSession("session:new-connection"),
      resumeTokenDigest: `sha256:${"c".repeat(64)}`,
      connectedAt: "2026-07-30T00:02:00.000Z"
    };
    const resumed = database.openBrowserSession({
      session: replacement,
      presentedResumeTokenDigest: browserSession().resumeTokenDigest,
      now: "2026-07-30T00:02:00.000Z"
    });
    expect(resumed.resumedFrom?.id).toBe("session:v8");
    expect(resumed.session).toMatchObject({
      id: "session:v8",
      observationRevision: 1,
      observationState: "available",
      observedOrigin: "https://www.chanmama.com",
      observedAuthentication: "membership",
      resumeTokenDigest: replacement.resumeTokenDigest,
      connectedAt: replacement.connectedAt
    });
    expect(resumed.session.disconnectedAt).toBeUndefined();
    expect(
      database.getBrowserSession("session:new-connection")
    ).toBeUndefined();
  });

  it("rolls Run, plan, checkpoint and bindings back together", () => {
    let inject = false;
    const database = new SqlitePersistence({
      path: ":memory:",
      failureInjector: (point) => {
        if (inject && point === "recoverable_run.after_binding") {
          throw new Error("crash");
        }
      }
    });
    openObservedSession(database);
    inject = true;
    expect(() => createBoundRun(database, "run:rollback")).toThrow("crash");
    expect(database.getRun("run:rollback")).toBeUndefined();
    expect(
      database.getRunResourceBindingSnapshot("run:rollback")
    ).toBeUndefined();
  });
});

function seedLineage(database: SqlitePersistence) {
  const runId = "run:lineage";
  database.createRun({
    run: {
      id: runId,
      workflowId: "workflow:lineage",
      workflowVersion: "1.0.0",
      workflowDigest: `sha256:${"4".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      id: "event:lineage:1",
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
  const sessionId = "session:lineage";
  database.openBrowserSession({
    session: browserSession(sessionId),
    now: timestamp
  });
  const assetIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const nodeExecutionId = `execution:lineage:${index}`;
    database.createNodeExecution(
      {
        id: nodeExecutionId,
        runId,
        nodeKey: `inspect-${index}`,
        nodeId: "browser.inspect",
        nodeVersion: "1.0.0",
        status: "dispatched",
        revision: 0,
        attempt: 1,
        idempotencyKey: `idempotency:lineage:${index}`,
        fencingToken: index + 1,
        input: {},
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: `event:lineage:${index + 2}`,
        runId,
        nodeExecutionId,
        sequence: index + 2,
        type: "node.dispatched",
        payload: {},
        occurredAt: timestamp
      }
    );
    database.enqueueCommand(
      {
        id: `command:lineage:${index}`,
        nodeExecutionId,
        commandSeq: index + 1,
        idempotencyKey: `command-idempotency:lineage:${index}`,
        fencingToken: index + 1,
        state: "queued",
        payload: {
          run_id: runId,
          node_execution_id: nodeExecutionId,
          fencing_token: index + 1
        },
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: `outbox:lineage:${index}`,
        topic: "browser.command",
        aggregateId: `command:lineage:${index}`,
        payload: {},
        createdAt: timestamp
      }
    );
    const sourceId = `source:lineage:${index}`;
    database.putSourceRecord({
      apiVersion: "bpa.source/v1alpha1",
      kind: "SourceRecord",
      sourceId,
      sourceType: "public_url",
      locator: { url: `https://example.com/${index}` },
      observedAt: timestamp,
      recordedAt: timestamp,
      accessScope: "public",
      classification: "public"
    });
    const body = Buffer.from([0xff, 0xd8, 0xff, index]);
    const evidenceId = `evidence:lineage:${index}`;
    const leaseId = `lease:lineage:${index}`;
    database.putStagingLease({
      leaseId,
      runId,
      tokenDigest: `sha256:${"5".repeat(64)}`,
      maxBytes: 1024,
      state: "active",
      createdAt: timestamp,
      expiresAt: "2026-07-31T00:00:00.000Z"
    });
    const transfer = declareEvidence(
      {
        evidenceId,
        runId,
        nodeExecutionId,
        sessionId,
        fencingToken: index + 1,
        kind: "screenshot",
        mediaType: "image/jpeg",
        size: body.length,
        digest: digestBytes(body),
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 1,
        classification: "public",
        stagingLeaseId: leaseId
      },
      { now: () => new Date(timestamp) }
    );
    database.declareEvidence(transfer);
    database.commitEvidenceChunk({
      evidenceId,
      chunk: {
        evidenceId,
        index: 0,
        digest: transfer.digest,
        size: body.length,
        receivedAt: timestamp
      }
    });
    const blob = {
      digest: transfer.digest,
      size: body.length,
      mediaType: "image/jpeg",
      storageRef: `asset-store:${transfer.digest}`,
      createdAt: timestamp
    };
    database.completeEvidence({ evidenceId, blob });
    database.acknowledgeEvidence(evidenceId, timestamp);
    const assetId = `asset:lineage:${index}`;
    assetIds.push(assetId);
    database.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId,
      digest: blob.digest,
      size: blob.size,
      mediaType: blob.mediaType,
      storageRef: blob.storageRef,
      classification: "public",
      sourceIds: [sourceId],
      createdAt: timestamp,
      retention: {
        policy: "public_30d",
        retainUntil: "2026-08-29T00:00:00.000Z"
      }
    });
    database.linkEvidence({
      apiVersion: "bpa.evidence/v1alpha1",
      kind: "EvidenceLink",
      linkId: `link:lineage:${index}`,
      evidenceId,
      runId,
      nodeExecutionId,
      relation: "captures",
      sourceIds: [sourceId],
      assetIds: [assetId],
      createdAt: timestamp
    });
  }
  return { runId, assetIds };
}

describe("SQLite v8 lineage and Export metadata", () => {
  it("uses bounded stable cursors without returning Blob bodies", () => {
    const database = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    const seeded = seedLineage(database);
    const first = database.listEvidenceTransfersForRun({
      runId: seeded.runId,
      limit: 1
    });
    expect(first.records.map((record) => record.evidenceId)).toEqual([
      "evidence:lineage:0"
    ]);
    expect(first.nextCursor).toBeDefined();
    expect(
      database.listEvidenceTransfersForRun({
        runId: seeded.runId,
        limit: 1,
        cursor: first.nextCursor!
      }).records.map((record) => record.evidenceId)
    ).toEqual(["evidence:lineage:1"]);
    expect(
      database.listEvidenceLinksForRun({
        runId: seeded.runId,
        limit: 2
      }).records
    ).toHaveLength(2);
    expect(
      database.listSourceRecordsForRun({
        runId: seeded.runId,
        limit: 2
      }).records.map((record) => record.sourceId)
    ).toEqual(["source:lineage:0", "source:lineage:1"]);
    const assets = database.listAssetRecordsForRun({
      runId: seeded.runId,
      limit: 2
    }).records;
    expect(assets.map((record) => record.assetId)).toEqual(seeded.assetIds);
    expect(JSON.stringify(assets)).not.toContain("data_base64");
    expect(() =>
      database.getAssetRecords(
        Array.from({ length: 101 }, (_, index) => `asset:${index}`)
      )
    ).toThrow("at most 100");
    expect(() =>
      database.listEvidenceTransfersForRun({
        runId: seeded.runId,
        limit: 201
      })
    ).toThrow("between 1 and 200");
  });

  it("stores immutable Export metadata and AssetRefs only", () => {
    const database = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    const seeded = seedLineage(database);
    const exportBody = Buffer.from([0xff, 0xd8, 0xff, 0xee]);
    const exportDigest = digestBytes(exportBody);
    database.registerBlob({
      digest: exportDigest,
      size: exportBody.length,
      mediaType: "image/jpeg",
      storageRef: `asset-store:${exportDigest}`,
      createdAt: timestamp
    });
    const exportAssetId = "asset:export-only";
    database.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId: exportAssetId,
      digest: exportDigest,
      size: exportBody.length,
      mediaType: "image/jpeg",
      storageRef: `asset-store:${exportDigest}`,
      classification: "public",
      sourceIds: ["source:lineage:0"],
      createdAt: timestamp,
      retention: {
        policy: "public_30d",
        retainUntil: "2026-08-29T00:00:00.000Z"
      }
    });
    const record = {
      exportId: "export:lineage:1",
      runId: seeded.runId,
      exportType: "reference_asset_pack" as const,
      status: "ready" as const,
      assetIds: [exportAssetId],
      metadata: { title: "Reference pack" },
      createdAt: timestamp
    };
    expect(database.putExportRecord(record).status).toBe("accepted");
    expect(database.putExportRecord(record).status).toBe("duplicate");
    expect(database.getExportRecord(record.exportId)).toEqual(record);
    expect(
      database.listExportRecordsForRun({
        runId: seeded.runId,
        limit: 10
      }).records
    ).toEqual([record]);
    expect(
      database.deleteAssetRecord({
        assetId: exportAssetId,
        actor: "user:test",
        deletedAt: "2026-09-01T00:00:00.000Z"
      })
    ).toEqual({ status: "referenced" });
    expect(() =>
      database.putExportRecord({
        ...record,
        exportId: "export:body",
        metadata: { notes: "x".repeat(33 * 1024) }
      })
    ).toThrow("32 KiB");
    expect(() =>
      database.putExportRecord({
        ...record,
        exportId: "export:inline-body",
        metadata: { body: "inline export body" }
      })
    ).toThrow("must be an AssetRef");
  });
});

describe("migration v8", () => {
  it("rolls an interrupted v8 back and applies it cleanly on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v8-"));
    const path = join(directory, "bpa.sqlite");
    expect(
      () =>
        new SqlitePersistence({
          path,
          failureInjector: (point) => {
            if (point === "migration.8.after_sql") throw new Error("crash");
          }
        })
    ).toThrow("crash");
    const recovered = new SqlitePersistence({ path });
    expect(recovered.health().schemaVersion).toBe(20);
    recovered.close();
  });
});
