import { beforeAll, describe, expect, it } from "vitest";
import {
  createJsonEvidenceUpload,
  evidenceTransferMessages,
  interpretEvidenceAcknowledgement
} from "./evidence-transfer.js";

beforeAll(() => {
  if (typeof globalThis.btoa !== "function") {
    Object.defineProperty(globalThis, "btoa", {
      value: (value: string) => Buffer.from(value, "binary").toString("base64")
    });
  }
});

describe("browser evidence transfer", () => {
  it("chunks evidence at the frozen 256 KiB boundary with digests", async () => {
    const upload = await createJsonEvidenceUpload({
      evidenceId: "evidence-1",
      traceId: "trace-1",
      runId: "run-1",
      nodeExecutionId: "node-execution-1",
      value: { content: "a".repeat(300 * 1024) }
    });

    expect(upload.beginPayload).toMatchObject({
      evidence_id: "evidence-1",
      run_id: "run-1",
      node_execution_id: "node-execution-1",
      kind: "dom_summary",
      chunk_size: 262_144,
      chunk_count: 2
    });
    expect(upload.chunkPayloads).toHaveLength(2);
    expect(upload.chunkPayloads[0]).toMatchObject({
      evidence_id: "evidence-1",
      index: 0
    });
    expect(String(upload.chunkPayloads[0]?.chunk_digest)).toMatch(
      /^sha256:[a-f0-9]{64}$/u
    );
    expect(upload.completePayload).toMatchObject({
      evidence_id: "evidence-1",
      chunk_count: 2
    });
  });

  it("sends begin, all chunks and complete before the final ACK", async () => {
    const upload = await createJsonEvidenceUpload({
      evidenceId: "evidence-2",
      traceId: "trace-2",
      runId: "run-2",
      nodeExecutionId: "node-execution-2",
      value: { supported: true }
    });

    expect(evidenceTransferMessages(upload).map((message) => message.type)).toEqual([
      "evidence.begin",
      "evidence.chunk",
      "evidence.complete"
    ]);
    expect(
      interpretEvidenceAcknowledgement(upload, { accepted: true }).state
    ).toBe("complete");
  });

  it("can resume at a persisted chunk and rejects unsafe acknowledgements", async () => {
    const upload = await createJsonEvidenceUpload({
      evidenceId: "evidence-3",
      traceId: "trace-3",
      runId: "run-3",
      nodeExecutionId: "node-execution-3",
      value: {}
    });
    expect(
      interpretEvidenceAcknowledgement(upload, {
        accepted: false,
        reasonCode: "RESUME_FROM_CHUNK",
        nextChunkIndex: 0
      })
    ).toMatchObject({
      state: "resume",
      nextChunkIndex: 0
    });
    expect(
      evidenceTransferMessages(upload, {
        includeBegin: false,
        startChunkIndex: 0
      }).map((message) => message.type)
    ).toEqual(["evidence.chunk", "evidence.complete"]);
    expect(
      interpretEvidenceAcknowledgement(upload, {
        accepted: false,
        reasonCode: "RESUME_FROM_CHUNK",
        nextChunkIndex: -1
      })
    ).toMatchObject({
      state: "rejected",
      reasonCode: "RESUME_FROM_CHUNK"
    });
  });
});
