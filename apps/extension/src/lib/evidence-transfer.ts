const EVIDENCE_CHUNK_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

export interface PendingEvidenceUpload {
  readonly id: string;
  readonly evidenceId: string;
  readonly traceId: string;
  readonly beginPayload: Record<string, unknown>;
  readonly chunkPayloads: readonly Record<string, unknown>[];
  readonly completePayload: Record<string, unknown>;
}

export interface EvidenceTransferMessage {
  readonly type:
    | "evidence.begin"
    | "evidence.chunk"
    | "evidence.complete";
  readonly payload: Record<string, unknown>;
}

export type EvidenceAcknowledgement =
  | {
      readonly state: "complete";
    }
  | {
      readonly state: "resume";
      readonly nextChunkIndex: number;
    }
  | {
      readonly state: "rejected";
      readonly reasonCode: string;
    };

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes).buffer)
    .then((digest) => {
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256:${hex}`;
    });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function createJsonEvidenceUpload(input: {
  readonly evidenceId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  readonly value: unknown;
}): Promise<PendingEvidenceUpload> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.value));
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error("EVIDENCE_OBJECT_TOO_LARGE");
  }
  const digest = await sha256(bytes);
  const chunks: Record<string, unknown>[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += EVIDENCE_CHUNK_BYTES) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + EVIDENCE_CHUNK_BYTES, bytes.byteLength)
    );
    chunks.push({
      evidence_id: input.evidenceId,
      index: chunks.length,
      data_base64: base64(chunk),
      chunk_digest: await sha256(chunk)
    });
  }
  return {
    id: input.evidenceId,
    evidenceId: input.evidenceId,
    traceId: input.traceId,
    beginPayload: {
      evidence_id: input.evidenceId,
      run_id: input.runId,
      node_execution_id: input.nodeExecutionId,
      kind: "dom_summary",
      media_type: "application/vnd.bpa.browser-evidence+json",
      size: bytes.byteLength,
      digest,
      chunk_size: EVIDENCE_CHUNK_BYTES,
      chunk_count: chunks.length
    },
    chunkPayloads: chunks,
    completePayload: {
      evidence_id: input.evidenceId,
      digest,
      chunk_count: chunks.length
    }
  };
}

export function evidenceTransferMessages(
  upload: PendingEvidenceUpload,
  options: {
    readonly includeBegin?: boolean;
    readonly startChunkIndex?: number;
  } = {}
): EvidenceTransferMessage[] {
  const startChunkIndex = options.startChunkIndex ?? 0;
  if (
    !Number.isSafeInteger(startChunkIndex) ||
    startChunkIndex < 0 ||
    startChunkIndex > upload.chunkPayloads.length
  ) {
    throw new Error("EVIDENCE_RESUME_INDEX_INVALID");
  }
  return [
    ...(options.includeBegin === false
      ? []
      : [
          {
            type: "evidence.begin" as const,
            payload: upload.beginPayload
          }
        ]),
    ...upload.chunkPayloads.slice(startChunkIndex).map((payload) => ({
      type: "evidence.chunk" as const,
      payload
    })),
    {
      type: "evidence.complete",
      payload: upload.completePayload
    }
  ];
}

export function interpretEvidenceAcknowledgement(
  upload: PendingEvidenceUpload,
  acknowledgement: {
    readonly accepted: boolean;
    readonly nextChunkIndex?: number;
    readonly reasonCode?: string;
  }
): EvidenceAcknowledgement {
  if (acknowledgement.accepted) {
    return { state: "complete" };
  }
  if (
    acknowledgement.reasonCode === "RESUME_FROM_CHUNK" &&
    Number.isSafeInteger(acknowledgement.nextChunkIndex) &&
    acknowledgement.nextChunkIndex !== undefined &&
    acknowledgement.nextChunkIndex >= 0 &&
    acknowledgement.nextChunkIndex <= upload.chunkPayloads.length
  ) {
    return {
      state: "resume",
      nextChunkIndex: acknowledgement.nextChunkIndex
    };
  }
  return {
    state: "rejected",
    reasonCode: acknowledgement.reasonCode ?? "EVIDENCE_REJECTED"
  };
}
