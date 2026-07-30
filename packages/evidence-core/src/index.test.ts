import { describe, expect, it } from "vitest";
import type { BlobRecord } from "@bpa/asset-core";
import {
  EVIDENCE_CHUNK_BYTES,
  acceptChunk,
  acknowledgeEvidence,
  completeEvidence,
  declareEvidence,
  digestBytes
} from "./index.js";

const clock = { now: () => new Date("2026-07-30T00:00:00.000Z") };

describe("Evidence state machine", () => {
  it("enforces ordering, idempotency and completion", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = digestBytes(bytes);
    let transfer = declareEvidence(
      {
        evidenceId: "evidence:test:1",
        runId: "run:test:1",
        nodeExecutionId: "execution:test:1",
        sessionId: "session:test:1",
        fencingToken: 1,
        kind: "screenshot",
        mediaType: "image/jpeg",
        size: bytes.byteLength,
        digest,
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 1,
        classification: "restricted",
        stagingLeaseId: "lease:test:1"
      },
      clock
    );
    const chunk = {
      evidenceId: transfer.evidenceId,
      index: 0,
      digest,
      size: 3,
      receivedAt: clock.now().toISOString()
    };
    transfer = acceptChunk(transfer, chunk, undefined, clock).transfer;
    expect(acceptChunk(
      { ...transfer, state: "receiving" },
      chunk,
      chunk,
      clock
    ).status).toBe("duplicate");
    const blob: BlobRecord = {
      digest,
      size: 3,
      mediaType: "image/jpeg",
      storageRef: `asset-store:${digest}`,
      createdAt: clock.now().toISOString()
    };
    transfer = completeEvidence(transfer, [chunk], blob, clock);
    transfer = acknowledgeEvidence(transfer, clock);
    expect(transfer.state).toBe("acknowledged");
    expect(transfer.expiresAt).toBe("2026-07-31T00:00:00.000Z");
  });

  it("rejects out-of-order chunks", () => {
    const transfer = declareEvidence(
      {
        evidenceId: "evidence:test:2",
        runId: "run:test:1",
        nodeExecutionId: "execution:test:1",
        sessionId: "session:test:1",
        fencingToken: 1,
        kind: "file",
        mediaType: "application/octet-stream",
        size: EVIDENCE_CHUNK_BYTES + 1,
        digest: `sha256:${"a".repeat(64)}`,
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 2,
        classification: "internal",
        stagingLeaseId: "lease:test:2"
      },
      clock
    );
    expect(() =>
      acceptChunk(
        transfer,
        {
          evidenceId: transfer.evidenceId,
          index: 1,
          digest: `sha256:${"b".repeat(64)}`,
          size: 1,
          receivedAt: clock.now().toISOString()
        },
        undefined,
        clock
      )
    ).toThrow("Expected chunk 0");
  });

  it("returns a stable error code for an empty Evidence declaration", () => {
    try {
      declareEvidence(
        {
          evidenceId: "evidence:empty",
          runId: "run:test:1",
          nodeExecutionId: "execution:test:1",
          sessionId: "session:test:1",
          fencingToken: 1,
          kind: "file",
          mediaType: "application/octet-stream",
          size: 0,
          digest: digestBytes(new Uint8Array()),
          chunkSize: EVIDENCE_CHUNK_BYTES,
          chunkCount: 0,
          classification: "internal",
          stagingLeaseId: "lease:empty"
        },
        clock
      );
      throw new Error("expected declaration to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "EMPTY_EVIDENCE_UNSUPPORTED"
      });
    }
  });
});
