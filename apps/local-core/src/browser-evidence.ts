import { randomUUID } from "node:crypto";
import { LocalAssetStore } from "@bpa/asset-store-local";
import {
  declareEvidence,
  digestBytes,
  type EvidenceTransferRecord
} from "@bpa/evidence-core";
import type {
  GatewayCommandRecord,
  Persistence
} from "@bpa/persistence";
import type {
  EvidenceLinkDefinition,
  NodeDefinition,
  SourceRecordDefinition
} from "@bpa/schemas";

export class BrowserEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextChunkIndex?: number
  ) {
    super(message);
    this.name = "BrowserEvidenceError";
  }
}

export interface BrowserEvidenceAcknowledgement {
  readonly evidenceId: string;
  readonly accepted: boolean;
  readonly nextChunkIndex?: number;
  readonly reasonCode?: string;
}

function strictBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value
    )
  ) {
    throw new BrowserEvidenceError(
      "EVIDENCE_CHUNK_INVALID",
      "Evidence chunk is not canonical base64."
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new BrowserEvidenceError(
      "EVIDENCE_CHUNK_INVALID",
      "Evidence chunk base64 is not canonical."
    );
  }
  return bytes;
}

function transferMatches(
  transfer: EvidenceTransferRecord,
  input: {
    sessionId: string;
    command: GatewayCommandRecord;
    payload: Record<string, unknown>;
  }
): boolean {
  return (
    transfer.sessionId === input.sessionId &&
    transfer.runId === String(input.payload.run_id) &&
    transfer.nodeExecutionId === String(input.payload.node_execution_id) &&
    transfer.fencingToken === input.command.fencingToken &&
    transfer.kind === input.payload.kind &&
    transfer.mediaType === input.payload.media_type &&
    transfer.size === Number(input.payload.size) &&
    transfer.digest === input.payload.digest &&
    transfer.chunkSize === Number(input.payload.chunk_size) &&
    transfer.chunkCount === Number(input.payload.chunk_count)
  );
}

function classification(
  _kind: EvidenceTransferRecord["kind"]
): EvidenceTransferRecord["classification"] {
  // Browser DOM summaries, screenshots and failure facts can all contain
  // authenticated business data. Default closed; later curation may derive a
  // separately reviewed public Asset.
  return "restricted";
}

export class BrowserEvidenceReceiver {
  readonly #assets: LocalAssetStore;

  constructor(
    readonly persistence: Persistence,
    dataDirectory: string,
    readonly now: () => Date = () => new Date(),
    readonly id: () => string = randomUUID
  ) {
    this.#assets = new LocalAssetStore({
      dataDirectory,
      clock: { now: this.now },
      idFactory: this.id
    });
  }

  begin(
    sessionId: string,
    payload: Record<string, unknown>
  ): void {
    const evidenceId = String(payload.evidence_id);
    const command = this.#owningCommand(payload);
    const existing = this.persistence.getEvidenceTransfer(evidenceId);
    if (existing) {
      if (!transferMatches(existing, { sessionId, command, payload })) {
        throw new BrowserEvidenceError(
          "EVIDENCE_CONFLICT",
          "Evidence ID was replayed with different ownership or metadata."
        );
      }
      return;
    }
    if (Number(payload.size) === 0) {
      throw new BrowserEvidenceError(
        "EMPTY_EVIDENCE_UNSUPPORTED",
        "Zero-byte browser Evidence is not supported."
      );
    }
    const issued = this.#assets.issueStagingLease({
      runId: String(payload.run_id),
      maxBytes: Number(payload.size),
      ttlMs: 24 * 60 * 60 * 1000
    });
    this.persistence.putStagingLease(issued.lease);
    const transfer = declareEvidence(
      {
        evidenceId,
        runId: String(payload.run_id),
        nodeExecutionId: String(payload.node_execution_id),
        sessionId,
        fencingToken: command.fencingToken,
        kind: payload.kind as EvidenceTransferRecord["kind"],
        mediaType: String(payload.media_type),
        size: Number(payload.size),
        digest: String(payload.digest),
        chunkSize: Number(payload.chunk_size),
        chunkCount: Number(payload.chunk_count),
        classification: classification(
          payload.kind as EvidenceTransferRecord["kind"]
        ),
        stagingLeaseId: issued.lease.leaseId
      },
      { now: this.now }
    );
    const declared = this.persistence.declareEvidence(transfer);
    if (declared.status === "over_run_quota") {
      throw new BrowserEvidenceError(
        "EVIDENCE_RUN_QUOTA_EXCEEDED",
        "Evidence would exceed the per-Run storage quota."
      );
    }
  }

  chunk(
    sessionId: string,
    payload: Record<string, unknown>
  ): void {
    const evidenceId = String(payload.evidence_id);
    const transfer = this.#ownedTransfer(sessionId, evidenceId);
    const bytes = strictBase64(payload.data_base64);
    const digest = digestBytes(bytes);
    if (digest !== payload.chunk_digest) {
      throw new BrowserEvidenceError(
        "EVIDENCE_CHUNK_DIGEST_MISMATCH",
        "Evidence chunk digest does not match its body."
      );
    }
    const index = Number(payload.index);
    const existing = this.persistence
      .listEvidenceChunks(evidenceId)
      .find((chunk) => chunk.index === index);
    if (
      transfer.state === "complete" ||
      transfer.state === "acknowledged" ||
      transfer.state === "linked"
    ) {
      if (
        !existing ||
        existing.digest !== digest ||
        existing.size !== bytes.byteLength
      ) {
        throw new BrowserEvidenceError(
          "EVIDENCE_CHUNK_CONFLICT",
          "Completed Evidence was replayed with a conflicting chunk."
        );
      }
      return;
    }
    if (index < transfer.nextChunkIndex) {
      if (
        existing?.digest === digest &&
        existing.size === bytes.byteLength
      ) {
        return;
      }
      throw new BrowserEvidenceError(
        "EVIDENCE_CHUNK_CONFLICT",
        "Persisted Evidence chunk conflicts with its replay."
      );
    }
    if (index > transfer.nextChunkIndex) {
      throw new BrowserEvidenceError(
        "RESUME_FROM_CHUNK",
        "Evidence chunks must resume at the first unpersisted chunk.",
        transfer.nextChunkIndex
      );
    }
    const lease = this.persistence.getStagingLease(
      transfer.stagingLeaseId
    );
    if (!lease) {
      throw new BrowserEvidenceError(
        "EVIDENCE_STAGING_MISSING",
        "Evidence staging lease is unavailable."
      );
    }
    this.#assets.writeTrustedChunk({
      lease,
      index,
      bytes,
      digest
    });
    const outcome = this.persistence.commitEvidenceChunk({
      evidenceId,
      chunk: {
        evidenceId,
        index,
        digest,
        size: bytes.byteLength,
        receivedAt: this.now().toISOString()
      }
    });
    if (outcome.status === "out_of_order") {
      throw new BrowserEvidenceError(
        "RESUME_FROM_CHUNK",
        "Evidence chunks must resume at the first unpersisted chunk.",
        outcome.nextChunkIndex
      );
    }
    if (outcome.status === "conflict") {
      throw new BrowserEvidenceError(
        "EVIDENCE_CHUNK_CONFLICT",
        "Evidence chunk conflicts with persisted data."
      );
    }
  }

  complete(
    sessionId: string,
    payload: Record<string, unknown>
  ): BrowserEvidenceAcknowledgement {
    const evidenceId = String(payload.evidence_id);
    let transfer = this.#ownedTransfer(sessionId, evidenceId);
    if (
      transfer.digest !== payload.digest ||
      transfer.chunkCount !== Number(payload.chunk_count)
    ) {
      throw new BrowserEvidenceError(
        "EVIDENCE_COMPLETION_CONFLICT",
        "Evidence completion does not match its declaration."
      );
    }
    if (
      transfer.state !== "complete" &&
      transfer.state !== "acknowledged" &&
      transfer.state !== "linked"
    ) {
      if (transfer.nextChunkIndex !== transfer.chunkCount) {
        throw new BrowserEvidenceError(
          "RESUME_FROM_CHUNK",
          "Evidence is incomplete.",
          transfer.nextChunkIndex
        );
      }
      const lease = this.persistence.getStagingLease(
        transfer.stagingLeaseId
      );
      if (!lease) {
        throw new BrowserEvidenceError(
          "EVIDENCE_STAGING_MISSING",
          "Evidence staging lease is unavailable."
        );
      }
      const chunks = this.persistence.listEvidenceChunks(evidenceId);
      const stored = this.#assets.finalizeTrusted({
        lease,
        chunks,
        expectedDigest: transfer.digest,
        expectedSize: transfer.size,
        mediaType: transfer.mediaType
      });
      transfer = this.persistence.completeEvidence({
        evidenceId,
        blob: stored.blob
      });
    }
    if (transfer.state === "complete") {
      transfer = this.persistence.acknowledgeEvidence(
        evidenceId,
        this.now().toISOString()
      );
    }
    return {
      evidenceId,
      accepted: true,
      ...(transfer.state === "linked"
        ? { reasonCode: "EVIDENCE_COMPLETE" }
        : {})
    };
  }

  acceptResult(input: {
    command: GatewayCommandRecord;
    payload: Record<string, unknown>;
    inboxMessageId: string;
    receivedAt: string;
  }):
    | "accepted"
    | "duplicate"
    | "stale"
    | "evidence_not_ready"
    | "evidence_invalid" {
    const evidenceIds = Array.isArray(input.payload.evidence_refs)
      ? input.payload.evidence_refs.map(String)
      : [];
    if (evidenceIds.length === 0) {
      return this.persistence.acceptResult({
        commandId: input.command.id,
        fencingToken: Number(input.payload.fencing_token),
        result: input.payload,
        inboxMessageId: input.inboxMessageId,
        receivedAt: input.receivedAt
      });
    }
    const runId = String(
      (input.command.payload as Record<string, unknown>).run_id
    );
    const links = evidenceIds.map((evidenceId) =>
      this.#evidenceLink(input.command, evidenceId)
    );
    return this.persistence.acceptResultWithEvidence({
      commandId: input.command.id,
      runId,
      nodeExecutionId: input.command.nodeExecutionId,
      fencingToken: Number(input.payload.fencing_token),
      result: input.payload,
      evidenceIds,
      evidenceLinks: links,
      inboxMessageId: input.inboxMessageId,
      receivedAt: input.receivedAt
    });
  }

  runtimeEvidence(
    evidenceIds: readonly string[]
  ): Array<{
    evidenceId: string;
    digest: string;
    classification: "public" | "internal" | "sensitive";
  }> {
    return evidenceIds.map((evidenceId) => {
      const transfer = this.persistence.getEvidenceTransfer(evidenceId);
      if (
        !transfer ||
        (transfer.state !== "acknowledged" &&
          transfer.state !== "linked")
      ) {
        throw new BrowserEvidenceError(
          "EVIDENCE_NOT_READY",
          `Trusted Evidence is unavailable: ${evidenceId}`
        );
      }
      return {
        evidenceId,
        digest: transfer.digest,
        classification:
          transfer.classification === "public"
            ? "public"
            : transfer.classification === "internal"
              ? "internal"
              : "sensitive"
      };
    });
  }

  #owningCommand(
    payload: Record<string, unknown>
  ): GatewayCommandRecord {
    const runId = String(payload.run_id);
    const nodeExecutionId = String(payload.node_execution_id);
    const candidates = this.persistence
      .listGatewayCommandsForRun(runId)
      .filter(
        (command) =>
          command.nodeExecutionId === nodeExecutionId &&
          command.state !== "terminal"
      );
    if (candidates.length !== 1) {
      throw new BrowserEvidenceError(
        "EVIDENCE_OWNER_INVALID",
        "Evidence does not belong to one active browser command."
      );
    }
    const command = candidates[0]!;
    const commandRunId = String(
      (command.payload as Record<string, unknown>).run_id
    );
    if (
      commandRunId !== runId ||
      !["delivered", "accepted"].includes(command.state)
    ) {
      throw new BrowserEvidenceError(
        "EVIDENCE_OWNER_INVALID",
        "Evidence command ownership is not active."
      );
    }
    return command;
  }

  #ownedTransfer(
    sessionId: string,
    evidenceId: string
  ): EvidenceTransferRecord {
    const transfer = this.persistence.getEvidenceTransfer(evidenceId);
    if (!transfer || transfer.sessionId !== sessionId) {
      throw new BrowserEvidenceError(
        "EVIDENCE_OWNER_INVALID",
        "Evidence does not belong to the active browser session."
      );
    }
    const command = this.persistence
      .listGatewayCommandsForRun(transfer.runId)
      .find(
        (candidate) =>
          candidate.nodeExecutionId === transfer.nodeExecutionId &&
          candidate.fencingToken === transfer.fencingToken
      );
    if (!command) {
      throw new BrowserEvidenceError(
        "STALE_FENCING_TOKEN",
        "Evidence command fencing token is stale."
      );
    }
    return transfer;
  }

  #evidenceLink(
    command: GatewayCommandRecord,
    evidenceId: string
  ): EvidenceLinkDefinition {
    const transfer = this.persistence.getEvidenceTransfer(evidenceId);
    if (!transfer) {
      throw new BrowserEvidenceError(
        "EVIDENCE_NOT_READY",
        `Evidence is unavailable: ${evidenceId}`
      );
    }
    const source = this.#sourceRecord(command, transfer);
    this.persistence.putSourceRecord(source);
    if (!transfer.storageRef) {
      throw new BrowserEvidenceError(
        "EVIDENCE_NOT_READY",
        "Evidence has no immutable Asset Store reference."
      );
    }
    const assetId = `asset-${evidenceId}`;
    this.persistence.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId,
      digest: transfer.digest,
      size: transfer.size,
      mediaType: transfer.mediaType,
      storageRef: transfer.storageRef,
      classification: transfer.classification,
      sourceIds: [source.sourceId],
      createdAt: transfer.createdAt,
      retention: {
        policy: "restricted_24h",
        retainUntil: new Date(
          Date.parse(transfer.createdAt) + 24 * 60 * 60 * 1000
        ).toISOString()
      }
    });
    return {
      apiVersion: "bpa.evidence/v1alpha1",
      kind: "EvidenceLink",
      linkId: `link-${evidenceId}`,
      evidenceId,
      runId: transfer.runId,
      nodeExecutionId: transfer.nodeExecutionId,
      relation: "captures",
      sourceIds: [source.sourceId],
      assetIds: [assetId],
      createdAt: transfer.createdAt
    };
  }

  #sourceRecord(
    command: GatewayCommandRecord,
    transfer: EvidenceTransferRecord
  ): SourceRecordDefinition {
    const payload = command.payload as Record<string, unknown>;
    const nodeRef = payload.node as { id: string; version: string };
    const grant = payload.permission_grant as {
      domains?: unknown;
    };
    const domain = Array.isArray(grant.domains)
      ? grant.domains.find(
          (value): value is string =>
            typeof value === "string" && value.startsWith("https://")
        )
      : undefined;
    if (!domain) {
      throw new BrowserEvidenceError(
        "EVIDENCE_SOURCE_INVALID",
        "Browser command has no frozen HTTPS source origin."
      );
    }
    const node = this.persistence.getPublished(
      "node",
      nodeRef.id,
      nodeRef.version
    )?.content as NodeDefinition | undefined;
    const adapterId = node?.adapter?.id;
    const adapterVersions = node?.adapter?.versions ?? [];
    const adapter = adapterId
      ? this.persistence
          .listPublished("adapter")
          .find(
            (candidate) =>
              candidate.assetId === adapterId &&
              adapterVersions.includes(candidate.version)
          )
      : undefined;
    const common = {
      apiVersion: "bpa.source/v1alpha1" as const,
      kind: "SourceRecord" as const,
      sourceId: `source-${transfer.evidenceId}`,
      observedAt: transfer.createdAt,
      recordedAt: transfer.createdAt,
      accessScope: "authenticated" as const,
      classification: transfer.classification,
      title: `${nodeRef.id}@${nodeRef.version}`
    };
    if (adapter && adapterId) {
      return {
        ...common,
        sourceType: "platform_page",
        locator: {
          platform: adapterId,
          url: `${new URL(domain).origin}/`,
          pageIdentity: transfer.nodeExecutionId
        },
        adapter: {
          id: adapterId,
          version: adapter.version,
          digest: adapter.digest
        },
        rawDigest: transfer.digest
      };
    }
    // Pre-0.4 Runs did not freeze Adapter digests. Preserve their exact URL
    // and authenticated scope without inventing a false Adapter artifact.
    return {
      ...common,
      sourceType: "public_url",
      locator: { url: `${new URL(domain).origin}/` }
    };
  }
}
