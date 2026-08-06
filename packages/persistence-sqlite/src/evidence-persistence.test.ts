import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes,
  type EvidenceTransferRecord
} from "@bpa/evidence-core";
import type {
  AssetRecordDefinition,
  EvidenceLinkDefinition,
  SourceRecordDefinition
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-07-30T00:00:00.000Z";
const clock = { now: () => new Date(timestamp) };

function persistence(
  failureInjector?: (point: string) => void
): SqlitePersistence {
  let id = 0;
  return new SqlitePersistence({
    path: ":memory:",
    clock: clock.now,
    idFactory: () => `audit:test:${id++}`,
    ...(failureInjector ? { failureInjector } : {})
  });
}

function seedExecution(
  database: SqlitePersistence,
  suffix: string,
  fencingToken = 7
) {
  const runId = `run:test:${suffix}`;
  const nodeExecutionId = `execution:test:${suffix}`;
  database.createRun({
    run: {
      id: runId,
      workflowId: "workflow:test",
      workflowVersion: "1.0.0",
      workflowDigest: `sha256:${"a".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      id: `event:run:${suffix}`,
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
  database.createNodeExecution(
    {
      id: nodeExecutionId,
      runId,
      nodeKey: "inspect",
      nodeId: "browser.test",
      nodeVersion: "1.0.0",
      status: "dispatched",
      revision: 0,
      attempt: 1,
      idempotencyKey: `idempotency:${suffix}`,
      fencingToken,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: `event:node:${suffix}`,
      runId,
      nodeExecutionId,
      sequence: 2,
      type: "node.dispatched",
      payload: {},
      occurredAt: timestamp
    }
  );
  return { runId, nodeExecutionId, fencingToken };
}

function seedIr2Run(database: SqlitePersistence, suffix: string) {
  const runId = `run:ir2:${suffix}`;
  database.createRecoverableRun({
    run: {
      id: runId,
      workflowId: "workflow:ir2",
      workflowVersion: "1.0.0",
      workflowDigest: `sha256:${"1".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    planSnapshot: {
      runId,
      irVersion: "bpa.workflow-ir/2",
      planDigest: `sha256:${"2".repeat(64)}`,
      workflowSourceDigest: `sha256:${"1".repeat(64)}`,
      artifactClosureDigest: `sha256:${"3".repeat(64)}`,
      planJson: {
        irVersion: "bpa.workflow-ir/2",
        workflow: {
          id: "workflow:ir2",
          version: "1.0.0",
          digest: `sha256:${"1".repeat(64)}`
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
      createdAt: timestamp
    },
    checkpoint: {
      runId,
      stateVersion: "bpa.engine-state/2",
      stateRevision: 1,
      state: {
        stateVersion: "bpa.engine-state/2",
        runId,
        revision: 1,
        status: "waiting_runtime"
      },
      updatedAt: timestamp
    },
    event: {
      id: `event:ir2:${suffix}`,
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
  return {
    runId,
    nodeExecutionId: `invocation:ir2:${suffix}`,
    fencingToken: 11
  };
}

function seedSession(database: SqlitePersistence, suffix: string) {
  const sessionId = `session:test:${suffix}`;
  database.openBrowserSession({
    session: {
      id: sessionId,
      browserInstanceId: `browser:${suffix}`,
      extensionId: "extension:test",
      extensionVersion: "1.0.0",
      protocolVersion: "1.0.0",
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: 0,
      resumeTokenDigest: `sha256:${"b".repeat(64)}`,
      resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
      connectedAt: timestamp
    },
    now: timestamp
  });
  return sessionId;
}

function source(suffix = "primary"): SourceRecordDefinition {
  return {
    apiVersion: "bpa.source/v1alpha1",
    kind: "SourceRecord",
    sourceId: `source:test:${suffix}`,
    sourceType: "public_url",
    locator: { url: `https://example.com/${suffix}` },
    observedAt: timestamp,
    recordedAt: timestamp,
    accessScope: "public",
    classification: "public"
  };
}

function seedCommand(
  database: SqlitePersistence,
  runId: string,
  nodeExecutionId: string,
  fencingToken: number,
  suffix = "primary"
) {
  const commandId = `command:test:${suffix}`;
  database.enqueueCommand(
    {
      id: commandId,
      nodeExecutionId,
      commandSeq: database.nextGatewayCommandSequence(),
      idempotencyKey: `command-idempotency:${suffix}`,
      fencingToken,
      state: "queued",
      payload: {
        run_id: runId,
        node_execution_id: nodeExecutionId,
        fencing_token: fencingToken
      },
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: `outbox:test:${suffix}`,
      topic: "browser.command",
      aggregateId: commandId,
      payload: {},
      createdAt: timestamp
    }
  );
  return commandId;
}

function declare(
  database: SqlitePersistence,
  input: {
    evidenceId: string;
    runId: string;
    nodeExecutionId: string;
    sessionId: string;
    fencingToken: number;
  }
): { transfer: EvidenceTransferRecord; body: Buffer } {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
  const leaseId = `lease:${input.evidenceId}`;
  if (
    !database
      .listPendingGatewayCommands()
      .some((command) => command.nodeExecutionId === input.nodeExecutionId)
  ) {
    seedCommand(
      database,
      input.runId,
      input.nodeExecutionId,
      input.fencingToken,
      input.evidenceId
    );
  }
  database.putStagingLease({
    leaseId,
    runId: input.runId,
    tokenDigest: `sha256:${"c".repeat(64)}`,
    maxBytes: 25 * 1024 * 1024,
    state: "active",
    createdAt: timestamp,
    expiresAt: "2026-07-31T00:00:00.000Z"
  });
  const transfer = declareEvidence(
    {
      ...input,
      kind: "screenshot",
      mediaType: "image/jpeg",
      size: body.length,
      digest: digestBytes(body),
      chunkSize: EVIDENCE_CHUNK_BYTES,
      chunkCount: 1,
      classification: "public",
      stagingLeaseId: leaseId
    },
    clock
  );
  expect(database.declareEvidence(transfer).status).toBe("accepted");
  return { transfer, body };
}

function complete(
  database: SqlitePersistence,
  transfer: EvidenceTransferRecord,
  body: Buffer
) {
  const chunk = {
    evidenceId: transfer.evidenceId,
    index: 0,
    digest: digestBytes(body),
    size: body.length,
    receivedAt: timestamp
  };
  expect(
    database.commitEvidenceChunk({
      evidenceId: transfer.evidenceId,
      chunk
    }).status
  ).toBe("accepted");
  const blob = {
    digest: transfer.digest,
    size: transfer.size,
    mediaType: transfer.mediaType,
    storageRef: `asset-store:${transfer.digest}`,
    createdAt: timestamp
  };
  database.completeEvidence({ evidenceId: transfer.evidenceId, blob });
  expect(
    database.commitEvidenceChunk({
      evidenceId: transfer.evidenceId,
      chunk
    }).status
  ).toBe("duplicate");
  expect(
    database.completeEvidence({
      evidenceId: transfer.evidenceId,
      blob: { ...blob, createdAt: "2026-07-30T00:00:01.000Z" }
    }).state
  ).toBe("complete");
  database.acknowledgeEvidence(transfer.evidenceId, timestamp);
  expect(
    database.acknowledgeEvidence(transfer.evidenceId, timestamp).state
  ).toBe("acknowledged");
}

function link(
  transfer: EvidenceTransferRecord,
  sourceId: string,
  suffix = "primary"
): EvidenceLinkDefinition {
  return {
    apiVersion: "bpa.evidence/v1alpha1",
    kind: "EvidenceLink",
    linkId: `link:test:${suffix}`,
    evidenceId: transfer.evidenceId,
    runId: transfer.runId,
    nodeExecutionId: transfer.nodeExecutionId,
    relation: "captures",
    sourceIds: [sourceId],
    createdAt: timestamp
  };
}

describe("SQLite trusted Evidence persistence", () => {
  it("survives reopen with nextChunkIndex and immutable chunk metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-evidence-reopen-"));
    const path = join(directory, "bpa.sqlite");
    const first = new SqlitePersistence({ path, clock: clock.now });
    const execution = seedExecution(first, "resume");
    const sessionId = seedSession(first, "resume");
    const staged = declare(first, {
      evidenceId: "evidence:test:resume",
      ...execution,
      sessionId
    });
    const chunk = {
      evidenceId: staged.transfer.evidenceId,
      index: 0,
      digest: digestBytes(staged.body),
      size: staged.body.length,
      receivedAt: timestamp
    };
    first.commitEvidenceChunk({
      evidenceId: staged.transfer.evidenceId,
      chunk
    });
    first.close();

    const reopened = new SqlitePersistence({ path, clock: clock.now });
    expect(
      reopened.getEvidenceTransfer(staged.transfer.evidenceId)?.nextChunkIndex
    ).toBe(1);
    expect(reopened.declareEvidence(staged.transfer)).toMatchObject({
      status: "duplicate",
      transfer: { state: "receiving", nextChunkIndex: 1 }
    });
    expect(
      reopened.commitEvidenceChunk({
        evidenceId: staged.transfer.evidenceId,
        chunk
      }).status
    ).toBe("duplicate");
    reopened.close();
  });

  it("atomically accepts a Result and links acknowledged Evidence", () => {
    const database = persistence();
    const execution = seedExecution(database, "success");
    const sessionId = seedSession(database, "success");
    const commandId = seedCommand(
      database,
      execution.runId,
      execution.nodeExecutionId,
      execution.fencingToken
    );
    const provenance = source();
    database.putSourceRecord(provenance);
    const staged = declare(database, {
      evidenceId: "evidence:test:success",
      ...execution,
      sessionId
    });
    complete(database, staged.transfer, staged.body);
    const evidenceLink = link(staged.transfer, provenance.sourceId);

    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: { ok: true },
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:success",
        receivedAt: timestamp
      })
    ).toBe("accepted");
    expect(database.getGatewayCommand(commandId)?.state).toBe("terminal");
    expect(
      database.getEvidenceTransfer(staged.transfer.evidenceId)?.state
    ).toBe("linked");
    expect(database.getEvidenceLink(evidenceLink.linkId)).toEqual(evidenceLink);

    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: { ok: true },
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:success",
        receivedAt: timestamp
      })
    ).toBe("duplicate");
    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: { ok: true },
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:replay",
        receivedAt: timestamp
      })
    ).toBe("duplicate");
  });

  it("accepts IR2 Evidence ownership without a legacy node_executions row", () => {
    const database = persistence();
    const execution = seedIr2Run(database, "success");
    const sessionId = seedSession(database, "ir2");
    const commandId = seedCommand(
      database,
      execution.runId,
      execution.nodeExecutionId,
      execution.fencingToken,
      "ir2"
    );
    const provenance = source("ir2");
    database.putSourceRecord(provenance);
    const staged = declare(database, {
      evidenceId: "evidence:test:ir2",
      ...execution,
      sessionId
    });
    complete(database, staged.transfer, staged.body);
    const evidenceLink = link(
      staged.transfer,
      provenance.sourceId,
      "ir2"
    );
    expect(database.getNodeExecution(execution.nodeExecutionId)).toBeUndefined();
    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: { ok: true },
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:ir2",
        receivedAt: timestamp
      })
    ).toBe("accepted");
    expect(
      database.getEvidenceTransfer(staged.transfer.evidenceId)?.state
    ).toBe("linked");
  });

  it("rejects incomplete and cross-Run Evidence without partial writes", () => {
    const database = persistence();
    const execution = seedExecution(database, "primary");
    const sessionId = seedSession(database, "shared");
    const commandId = seedCommand(
      database,
      execution.runId,
      execution.nodeExecutionId,
      execution.fencingToken
    );
    const provenance = source();
    database.putSourceRecord(provenance);
    const incomplete = declare(database, {
      evidenceId: "evidence:test:incomplete",
      ...execution,
      sessionId
    });
    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: {},
        evidenceIds: [incomplete.transfer.evidenceId],
        evidenceLinks: [link(incomplete.transfer, provenance.sourceId)],
        inboxMessageId: "inbox:test:early",
        receivedAt: timestamp
      })
    ).toBe("evidence_not_ready");
    expect(database.getGatewayCommand(commandId)?.state).toBe("queued");

    const other = seedExecution(database, "other");
    const cross = declare(database, {
      evidenceId: "evidence:test:cross",
      ...other,
      sessionId
    });
    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: {},
        evidenceIds: [cross.transfer.evidenceId],
        evidenceLinks: [link(cross.transfer, provenance.sourceId, "cross")],
        inboxMessageId: "inbox:test:cross",
        receivedAt: timestamp
      })
    ).toBe("evidence_invalid");
    expect(database.getGatewayCommand(commandId)?.state).toBe("queued");
    expect(database.getEvidenceLink("link:test:cross")).toBeUndefined();
  });

  it("rolls the Result back when Evidence linking crashes", () => {
    let inject = false;
    const database = persistence((point) => {
      if (inject && point === "evidence.result.after_gateway") {
        throw new Error("crash");
      }
    });
    const execution = seedExecution(database, "rollback");
    const sessionId = seedSession(database, "rollback");
    const commandId = seedCommand(
      database,
      execution.runId,
      execution.nodeExecutionId,
      execution.fencingToken
    );
    const provenance = source("rollback");
    database.putSourceRecord(provenance);
    const staged = declare(database, {
      evidenceId: "evidence:test:rollback",
      ...execution,
      sessionId
    });
    complete(database, staged.transfer, staged.body);
    const evidenceLink = link(
      staged.transfer,
      provenance.sourceId,
      "rollback"
    );
    inject = true;
    expect(() =>
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: {},
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:rollback",
        receivedAt: timestamp
      })
    ).toThrow("crash");
    expect(database.getGatewayCommand(commandId)?.state).toBe("queued");
    expect(database.getEvidenceLink(evidenceLink.linkId)).toBeUndefined();
    expect(
      database.getEvidenceTransfer(staged.transfer.evidenceId)?.state
    ).toBe("acknowledged");
    inject = false;
    expect(
      database.acceptResultWithEvidence({
        commandId,
        ...execution,
        result: {},
        evidenceIds: [staged.transfer.evidenceId],
        evidenceLinks: [evidenceLink],
        inboxMessageId: "inbox:test:rollback",
        receivedAt: timestamp
      })
    ).toBe("accepted");
  });

  it("protects active Asset references from retention deletion", () => {
    const database = persistence();
    const execution = seedExecution(database, "asset");
    const sessionId = seedSession(database, "asset");
    const provenance = source("asset");
    database.putSourceRecord(provenance);
    const staged = declare(database, {
      evidenceId: "evidence:test:asset",
      ...execution,
      sessionId
    });
    complete(database, staged.transfer, staged.body);
    const blob = database.getBlob(staged.transfer.digest)!;
    const asset: AssetRecordDefinition = {
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId: "asset:test:active",
      digest: blob.digest,
      size: blob.size,
      mediaType: blob.mediaType,
      storageRef: blob.storageRef,
      classification: "public",
      sourceIds: [provenance.sourceId],
      createdAt: timestamp,
      retention: {
        policy: "public_30d",
        retainUntil: "2026-08-29T00:00:00.000Z"
      }
    };
    database.putAssetRecord(asset);
    const evidenceLink = {
      ...link(staged.transfer, provenance.sourceId, "asset"),
      assetIds: [asset.assetId]
    };
    database.linkEvidence(evidenceLink);
    expect(
      database.deleteAssetRecord({
        assetId: asset.assetId,
        actor: "retention",
        deletedAt: "2026-09-01T00:00:00.000Z"
      }).status
    ).toBe("referenced");
  });

  it("enforces the cumulative 2 GiB Run quota at declaration", () => {
    const database = persistence();
    const execution = seedExecution(database, "quota");
    const sessionId = seedSession(database, "quota");
    seedCommand(
      database,
      execution.runId,
      execution.nodeExecutionId,
      execution.fencingToken,
      "quota"
    );
    const objectSize = 25 * 1024 * 1024;
    for (let index = 0; index < 81; index += 1) {
      const leaseId = `lease:quota:${index}`;
      database.putStagingLease({
        leaseId,
        runId: execution.runId,
        tokenDigest: `sha256:${"d".repeat(64)}`,
        maxBytes: objectSize,
        state: "active",
        createdAt: timestamp,
        expiresAt: "2026-07-31T00:00:00.000Z"
      });
      const transfer = declareEvidence(
        {
          evidenceId: `evidence:quota:${index}`,
          ...execution,
          sessionId,
          kind: "file",
          mediaType: "application/octet-stream",
          size: objectSize,
          digest: `sha256:${String(index).padStart(64, "0")}`,
          chunkSize: EVIDENCE_CHUNK_BYTES,
          chunkCount: 100,
          classification: "internal",
          stagingLeaseId: leaseId
        },
        clock
      );
      expect(database.declareEvidence(transfer).status).toBe("accepted");
    }
    const leaseId = "lease:quota:overflow";
    database.putStagingLease({
      leaseId,
      runId: execution.runId,
      tokenDigest: `sha256:${"e".repeat(64)}`,
      maxBytes: objectSize,
      state: "active",
      createdAt: timestamp,
      expiresAt: "2026-07-31T00:00:00.000Z"
    });
    const overflow = declareEvidence(
      {
        evidenceId: "evidence:quota:overflow",
        ...execution,
        sessionId,
        kind: "file",
        mediaType: "application/octet-stream",
        size: objectSize,
        digest: `sha256:${"f".repeat(64)}`,
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 100,
        classification: "internal",
        stagingLeaseId: leaseId
      },
      clock
    );
    expect(database.declareEvidence(overflow)).toMatchObject({
      status: "over_run_quota",
      runBytes: 81 * objectSize
    });
    expect(
      database.getEvidenceTransfer(overflow.evidenceId)
    ).toBeUndefined();
  });
});

describe("migration v7", () => {
  it("rolls back an interrupted migration and applies it on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v7-"));
    const path = join(directory, "bpa.sqlite");
    expect(
      () =>
        new SqlitePersistence({
          path,
          failureInjector: (point) => {
            if (point === "migration.7.after_sql") throw new Error("crash");
          }
        })
    ).toThrow("crash");
    const recovered = new SqlitePersistence({ path });
    expect(recovered.health().schemaVersion).toBe(14);
    recovered.close();
  });
});
