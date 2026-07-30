import { createHash } from "node:crypto";
import {
  formatValidationErrors,
  validateEvidence,
  validateEvidenceLink,
  type EvidenceLinkDefinition
} from "@bpa/schemas";
import {
  MAX_OBJECT_BYTES,
  type BlobRecord,
  type Classification
} from "@bpa/asset-core";

export const EVIDENCE_CHUNK_BYTES = 256 * 1024;

export type EvidenceState =
  | "declared"
  | "receiving"
  | "complete"
  | "acknowledged"
  | "linked"
  | "rejected"
  | "expired";

export interface EvidenceTransferRecord {
  evidenceId: string;
  runId: string;
  nodeExecutionId: string;
  sessionId: string;
  fencingToken: number;
  kind: "dom_summary" | "screenshot" | "file" | "verification" | "error";
  mediaType: string;
  size: number;
  digest: string;
  chunkSize: typeof EVIDENCE_CHUNK_BYTES;
  chunkCount: number;
  nextChunkIndex: number;
  classification: Classification;
  stagingLeaseId: string;
  state: EvidenceState;
  storageRef?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface EvidenceDeclaration {
  evidenceId: string;
  runId: string;
  nodeExecutionId: string;
  sessionId: string;
  fencingToken: number;
  kind: EvidenceTransferRecord["kind"];
  mediaType: string;
  size: number;
  digest: string;
  chunkSize: number;
  chunkCount: number;
  classification: Classification;
  stagingLeaseId: string;
}

export interface EvidenceChunkRecord {
  evidenceId: string;
  index: number;
  digest: string;
  size: number;
  receivedAt: string;
}

export interface Clock {
  now(): Date;
}

export class EvidenceValidationError extends Error {
  constructor(
    readonly code:
      | "INVALID_DECLARATION"
      | "EMPTY_EVIDENCE_UNSUPPORTED"
      | "OUT_OF_ORDER"
      | "CHUNK_CONFLICT"
      | "INCOMPLETE"
      | "DIGEST_MISMATCH"
      | "INVALID_TRANSITION"
      | "INVALID_LINK",
    message: string
  ) {
    super(message);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      `${label} must be a SHA-256 digest`
    );
  }
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function declareEvidence(
  input: EvidenceDeclaration,
  clock: Clock
): EvidenceTransferRecord {
  assertDigest(input.digest, "digest");
  if (input.size === 0) {
    throw new EvidenceValidationError(
      "EMPTY_EVIDENCE_UNSUPPORTED",
      "Empty Evidence objects are not stored; return a metadata-only Result"
    );
  }
  if (input.size < 0 || input.size > MAX_OBJECT_BYTES) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      `Evidence size must be between 0 and ${MAX_OBJECT_BYTES} bytes`
    );
  }
  if (input.chunkSize !== EVIDENCE_CHUNK_BYTES) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      `chunkSize must be ${EVIDENCE_CHUNK_BYTES}`
    );
  }
  if (input.chunkCount !== Math.ceil(input.size / EVIDENCE_CHUNK_BYTES)) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      "chunkCount does not match size"
    );
  }
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      "fencingToken must be a positive safe integer"
    );
  }
  const timestamp = clock.now().toISOString();
  const expiresAt =
    input.classification === "confidential" ||
    input.classification === "restricted"
      ? new Date(clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString()
      : undefined;
  const record: EvidenceTransferRecord = {
    ...input,
    chunkSize: EVIDENCE_CHUNK_BYTES,
    nextChunkIndex: 0,
    state: "declared",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(expiresAt ? { expiresAt } : {})
  };
  const metadata = {
    evidence_id: record.evidenceId,
    run_id: record.runId,
    node_execution_id: record.nodeExecutionId,
    kind: record.kind,
    digest: record.digest,
    size: record.size,
    media_type: record.mediaType,
    created_at: record.createdAt,
    ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
    classification: record.classification
  };
  if (!validateEvidence(metadata)) {
    throw new EvidenceValidationError(
      "INVALID_DECLARATION",
      formatValidationErrors(validateEvidence.errors).join("; ")
    );
  }
  return record;
}

export type AcceptChunkResult =
  | { status: "accepted"; transfer: EvidenceTransferRecord }
  | { status: "duplicate"; transfer: EvidenceTransferRecord };

export function acceptChunk(
  transfer: EvidenceTransferRecord,
  chunk: EvidenceChunkRecord,
  existing: EvidenceChunkRecord | undefined,
  clock: Clock
): AcceptChunkResult {
  assertDigest(chunk.digest, "chunk digest");
  if (chunk.evidenceId !== transfer.evidenceId) {
    throw new EvidenceValidationError(
      "CHUNK_CONFLICT",
      "Chunk belongs to another Evidence transfer"
    );
  }
  if (chunk.index < transfer.nextChunkIndex) {
    if (
      existing?.digest === chunk.digest &&
      existing.size === chunk.size
    ) {
      return { status: "duplicate", transfer };
    }
    throw new EvidenceValidationError(
      "CHUNK_CONFLICT",
      "Previously persisted chunk conflicts"
    );
  }
  if (transfer.state !== "declared" && transfer.state !== "receiving") {
    throw new EvidenceValidationError(
      "INVALID_TRANSITION",
      `Cannot accept a new chunk in ${transfer.state}`
    );
  }
  if (chunk.index !== transfer.nextChunkIndex) {
    throw new EvidenceValidationError(
      "OUT_OF_ORDER",
      `Expected chunk ${transfer.nextChunkIndex}`
    );
  }
  const expectedSize =
    chunk.index === transfer.chunkCount - 1
      ? transfer.size - chunk.index * transfer.chunkSize
      : transfer.chunkSize;
  if (chunk.size !== expectedSize) {
    throw new EvidenceValidationError(
      "CHUNK_CONFLICT",
      `Chunk ${chunk.index} size does not match declaration`
    );
  }
  return {
    status: "accepted",
    transfer: {
      ...transfer,
      state: "receiving",
      nextChunkIndex: transfer.nextChunkIndex + 1,
      updatedAt: clock.now().toISOString()
    }
  };
}

export function completeEvidence(
  transfer: EvidenceTransferRecord,
  chunks: readonly EvidenceChunkRecord[],
  blob: BlobRecord,
  clock: Clock
): EvidenceTransferRecord {
  if (
    transfer.state !== "receiving" ||
    transfer.nextChunkIndex !== transfer.chunkCount ||
    chunks.length !== transfer.chunkCount
  ) {
    throw new EvidenceValidationError(
      "INCOMPLETE",
      "Every declared chunk must be persisted before completion"
    );
  }
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.index !== index || chunk.evidenceId !== transfer.evidenceId) {
      throw new EvidenceValidationError(
        "INCOMPLETE",
        "Persisted chunks are not contiguous"
      );
    }
  }
  if (
    blob.digest !== transfer.digest ||
    blob.size !== transfer.size ||
    blob.mediaType !== transfer.mediaType
  ) {
    throw new EvidenceValidationError(
      "DIGEST_MISMATCH",
      "Stored Blob does not match Evidence declaration"
    );
  }
  return {
    ...transfer,
    state: "complete",
    storageRef: blob.storageRef,
    updatedAt: clock.now().toISOString()
  };
}

export function acknowledgeEvidence(
  transfer: EvidenceTransferRecord,
  clock: Clock
): EvidenceTransferRecord {
  if (transfer.state !== "complete") {
    throw new EvidenceValidationError(
      "INVALID_TRANSITION",
      "Only complete Evidence can be acknowledged"
    );
  }
  return {
    ...transfer,
    state: "acknowledged",
    updatedAt: clock.now().toISOString()
  };
}

export interface EvidenceLinkContext {
  transfer: EvidenceTransferRecord | undefined;
  sourceExists(sourceId: string): boolean;
  assetExists(assetId: string): boolean;
}

export function assertEvidenceLink(
  value: unknown,
  context: EvidenceLinkContext
): asserts value is EvidenceLinkDefinition {
  if (!validateEvidenceLink(value)) {
    throw new EvidenceValidationError(
      "INVALID_LINK",
      formatValidationErrors(validateEvidenceLink.errors).join("; ")
    );
  }
  const link = value as EvidenceLinkDefinition;
  const transfer = context.transfer;
  if (
    !transfer ||
    transfer.state !== "acknowledged" ||
    transfer.evidenceId !== link.evidenceId ||
    transfer.runId !== link.runId ||
    transfer.nodeExecutionId !== link.nodeExecutionId
  ) {
    throw new EvidenceValidationError(
      "INVALID_LINK",
      "Evidence must be acknowledged by the same Run and Node Execution"
    );
  }
  if (link.sourceIds.some((id) => !context.sourceExists(id))) {
    throw new EvidenceValidationError(
      "INVALID_LINK",
      "EvidenceLink references an unknown SourceRecord"
    );
  }
  if ((link.assetIds ?? []).some((id) => !context.assetExists(id))) {
    throw new EvidenceValidationError(
      "INVALID_LINK",
      "EvidenceLink references an unknown AssetRecord"
    );
  }
}

export function markEvidenceLinked(
  transfer: EvidenceTransferRecord,
  clock: Clock
): EvidenceTransferRecord {
  if (transfer.state !== "acknowledged") {
    throw new EvidenceValidationError(
      "INVALID_TRANSITION",
      "Only acknowledged Evidence can be linked"
    );
  }
  return {
    ...transfer,
    state: "linked",
    updatedAt: clock.now().toISOString()
  };
}

export function terminateEvidence(
  transfer: EvidenceTransferRecord,
  terminalState: "rejected" | "expired",
  clock: Clock
): EvidenceTransferRecord {
  if (transfer.state !== "declared" && transfer.state !== "receiving") {
    throw new EvidenceValidationError(
      "INVALID_TRANSITION",
      `Cannot mark ${transfer.state} Evidence as ${terminalState}`
    );
  }
  return {
    ...transfer,
    state: terminalState,
    updatedAt: clock.now().toISOString()
  };
}
