import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes
} from "@bpa/evidence-core";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { TrustedEvidenceQueryService } from "./trusted-evidence-queries.js";

const timestamp = "2026-07-30T00:00:00.000Z";

describe("TrustedEvidenceQueryService", () => {
  it("projects bounded lineage and ready business exports", () => {
    const persistence = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    persistence.createRun({
      run: {
        id: "run-query",
        workflowId: "workflow-query",
        workflowVersion: "1.0.0",
        workflowDigest: `sha256:${"1".repeat(64)}`,
        status: "running",
        revision: 0,
        input: {},
        createdAt: timestamp,
        updatedAt: timestamp
      },
      event: {
        id: "event-run-query",
        runId: "run-query",
        sequence: 1,
        type: "run.created",
        payload: {},
        occurredAt: timestamp
      }
    });
    persistence.createNodeExecution(
      {
        id: "execution-query",
        runId: "run-query",
        nodeKey: "inspect",
        nodeId: "browser.query",
        nodeVersion: "1.0.0",
        status: "dispatched",
        revision: 0,
        attempt: 1,
        idempotencyKey: "idempotency-query",
        fencingToken: 3,
        input: {},
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "event-execution-query",
        runId: "run-query",
        nodeExecutionId: "execution-query",
        sequence: 2,
        type: "node.dispatched",
        payload: {},
        occurredAt: timestamp
      }
    );
    persistence.openBrowserSession({
      session: {
        id: "session-query",
        browserInstanceId: "browser-query",
        extensionId: "extension-query",
        extensionVersion: "0.4.0",
        protocolVersion: "1.0.0",
        incomingSeq: 0,
        outgoingSeq: 0,
        lastAckedCommandSeq: 0,
        resumeTokenDigest: `sha256:${"2".repeat(64)}`,
        resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
        connectedAt: timestamp
      },
      now: timestamp
    });
    persistence.enqueueCommand(
      {
        id: "command-query",
        nodeExecutionId: "execution-query",
        commandSeq: 1,
        idempotencyKey: "command-idempotency-query",
        fencingToken: 3,
        state: "queued",
        payload: {
          run_id: "run-query",
          node_execution_id: "execution-query",
          fencing_token: 3
        },
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "outbox-query",
        topic: "browser.command",
        aggregateId: "command-query",
        payload: {},
        createdAt: timestamp
      }
    );

    const body = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const digest = digestBytes(body);
    persistence.putStagingLease({
      leaseId: "lease-query",
      runId: "run-query",
      tokenDigest: `sha256:${"3".repeat(64)}`,
      maxBytes: 1024,
      state: "active",
      createdAt: timestamp,
      expiresAt: "2026-07-31T00:00:00.000Z"
    });
    const transfer = declareEvidence(
      {
        evidenceId: "evidence-query",
        runId: "run-query",
        nodeExecutionId: "execution-query",
        sessionId: "session-query",
        fencingToken: 3,
        kind: "screenshot",
        mediaType: "image/jpeg",
        size: body.length,
        digest,
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 1,
        classification: "public",
        stagingLeaseId: "lease-query"
      },
      { now: () => new Date(timestamp) }
    );
    persistence.declareEvidence(transfer);
    persistence.commitEvidenceChunk({
      evidenceId: transfer.evidenceId,
      chunk: {
        evidenceId: transfer.evidenceId,
        index: 0,
        digest,
        size: body.length,
        receivedAt: timestamp
      }
    });
    persistence.completeEvidence({
      evidenceId: transfer.evidenceId,
      blob: {
        digest,
        size: body.length,
        mediaType: "image/jpeg",
        storageRef: `asset-store:${digest}`,
        createdAt: timestamp
      }
    });
    persistence.acknowledgeEvidence(transfer.evidenceId, timestamp);
    persistence.putSourceRecord({
      apiVersion: "bpa.source/v1alpha1",
      kind: "SourceRecord",
      sourceId: "source-query",
      sourceType: "public_url",
      locator: { url: "https://example.com/product/1" },
      observedAt: timestamp,
      recordedAt: timestamp,
      accessScope: "public",
      classification: "public",
      title: "公开商品页"
    });
    persistence.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId: "asset-query",
      digest,
      size: body.length,
      mediaType: "image/jpeg",
      storageRef: `asset-store:${digest}`,
      classification: "public",
      sourceIds: ["source-query"],
      createdAt: timestamp,
      retention: {
        policy: "public_30d",
        retainUntil: "2026-08-29T00:00:00.000Z"
      }
    });
    persistence.acceptResultWithEvidence({
      commandId: "command-query",
      runId: "run-query",
      nodeExecutionId: "execution-query",
      fencingToken: 3,
      result: { status: "succeeded" },
      evidenceIds: ["evidence-query"],
      evidenceLinks: [
        {
          apiVersion: "bpa.evidence/v1alpha1",
          kind: "EvidenceLink",
          linkId: "link-query",
          evidenceId: "evidence-query",
          runId: "run-query",
          nodeExecutionId: "execution-query",
          relation: "captures",
          sourceIds: ["source-query"],
          assetIds: ["asset-query"],
          createdAt: timestamp
        }
      ],
      inboxMessageId: "inbox-query",
      receivedAt: timestamp
    });
    persistence.putExportRecord({
      exportId: "export-query",
      runId: "run-query",
      exportType: "reference_asset_pack",
      status: "ready",
      assetIds: ["asset-query"],
      metadata: {
        title: "参考图包",
        fileName: "reference-pack.json"
      },
      createdAt: timestamp
    });

    const queries = new TrustedEvidenceQueryService(persistence);
    expect(queries.lineage("run-query")).toEqual({
      runId: "run-query",
      sources: [
        {
          id: "source-query",
          label: "公开商品页",
          origin: "https://example.com",
          observedAt: timestamp
        }
      ],
      evidence: [
        {
          id: "evidence-query",
          label: "screenshot",
          classification: "public",
          digest,
          sourceIds: ["source-query"]
        }
      ],
      assets: [
        {
          id: "asset-query",
          label: "image/jpeg",
          digest,
          evidenceIds: ["evidence-query"]
        }
      ]
    });
    expect(queries.listDownloads("run-query")).toEqual([
      {
        id: "export-query",
        runId: "run-query",
        kind: "reference_pack",
        title: "参考图包",
        fileName: "reference-pack.json",
        sizeBytes: body.length,
        createdAt: timestamp,
        assetIds: ["asset-query"]
      }
    ]);
    expect(queries.download("export-query")).toEqual(
      queries.listDownloads("run-query")[0]
    );
    persistence.close();
  });

  it("fails closed for unknown runs and exports", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const queries = new TrustedEvidenceQueryService(persistence);
    expect(() => queries.lineage("missing")).toThrow("Run not found");
    expect(() => queries.download("missing")).toThrow(
      "Download is unavailable"
    );
    expect(queries.listDownloads(undefined)).toEqual([]);
    persistence.close();
  });
});
