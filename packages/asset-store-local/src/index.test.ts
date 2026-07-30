import {
  mkdirSync,
  mkdtempSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "@bpa/evidence-core";
import {
  AssetStoreConflictError,
  AssetStoreSecurityError,
  LocalAssetStore
} from "./index.js";

const now = new Date("2026-07-30T00:00:00.000Z");

function store(root: string, warning = 10 * 1024 * 1024 * 1024) {
  return new LocalAssetStore({
    dataDirectory: root,
    clock: { now: () => now },
    idFactory: (() => {
      let next = 0;
      return () => `generated-${next++}`;
    })(),
    secretFactory: () => new Uint8Array(32).fill(7),
    globalWarningBytes: warning
  });
}

describe("LocalAssetStore", () => {
  it("stages, verifies, deduplicates and returns opaque refs", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-assets-"));
    const assets = store(root, 3);
    const body = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const digest = digestBytes(body);
    const issued = assets.issueStagingLease({ runId: "run:test:1" });
    expect(
      assets.writeChunk({
        lease: issued.lease,
        token: issued.token,
        index: 0,
        bytes: body,
        digest
      })
    ).toBe("stored");
    expect(
      assets.writeChunk({
        lease: issued.lease,
        token: issued.token,
        index: 0,
        bytes: body,
        digest
      })
    ).toBe("duplicate");
    const first = assets.finalize({
      lease: issued.lease,
      token: issued.token,
      chunks: [{ index: 0, digest, size: body.byteLength }],
      expectedDigest: digest,
      expectedSize: body.byteLength,
      mediaType: "image/jpeg"
    });
    expect(first.blob.storageRef).toBe(`asset-store:${digest}`);
    expect(first.storageWarning).toBe(true);
    expect(assets.read(first.blob.storageRef)).toEqual(body);

    const issuedAgain = assets.issueStagingLease({ runId: "run:test:1" });
    assets.writeChunk({
      lease: issuedAgain.lease,
      token: issuedAgain.token,
      index: 0,
      bytes: body,
      digest
    });
    expect(
      assets.finalize({
        lease: issuedAgain.lease,
        token: issuedAgain.token,
        chunks: [{ index: 0, digest, size: body.byteLength }],
        expectedDigest: digest,
        expectedSize: body.byteLength,
        mediaType: "image/jpeg"
      }).deduplicated
    ).toBe(true);
  });

  it("rejects MIME spoofing and caller paths", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-assets-"));
    const assets = store(root);
    const body = Buffer.from("not a jpeg");
    const digest = digestBytes(body);
    const issued = assets.issueStagingLease({ runId: "run:test:1" });
    assets.writeChunk({
      lease: issued.lease,
      token: issued.token,
      index: 0,
      bytes: body,
      digest
    });
    expect(() =>
      assets.finalize({
        lease: issued.lease,
        token: issued.token,
        chunks: [{ index: 0, digest, size: body.byteLength }],
        expectedDigest: digest,
        expectedSize: body.byteLength,
        mediaType: "image/jpeg"
      })
    ).toThrow(AssetStoreConflictError);
    expect(() => assets.read("/tmp/file")).toThrow(AssetStoreSecurityError);
  });

  it("rejects symlinked staging leases", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-assets-"));
    const assets = store(root);
    const issued = assets.issueStagingLease({ runId: "run:test:1" });
    assets.discardStaging(issued.lease.leaseId);
    const outside = mkdtempSync(join(tmpdir(), "bpa-outside-"));
    mkdirSync(outside, { recursive: true });
    symlinkSync(
      outside,
      join(root, "staging", issued.lease.leaseId),
      "dir"
    );
    expect(() =>
      assets.writeChunk({
        lease: issued.lease,
        token: issued.token,
        index: 0,
        bytes: Buffer.from([1]),
        digest: digestBytes(Buffer.from([1]))
      })
    ).toThrow(AssetStoreSecurityError);
  });

  it("resumes trusted Core chunk writes after restart without persisting token", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-assets-restart-"));
    const first = store(root);
    const issued = first.issueStagingLease({ runId: "run:test:resume" });
    const firstBytes = Buffer.from([1, 2]);
    first.writeChunk({
      lease: issued.lease,
      token: issued.token,
      index: 0,
      bytes: firstBytes,
      digest: digestBytes(firstBytes)
    });

    const afterRestart = store(root);
    const secondBytes = Buffer.from([3, 4]);
    expect(
      afterRestart.writeTrustedChunk({
        lease: issued.lease,
        index: 1,
        bytes: secondBytes,
        digest: digestBytes(secondBytes)
      })
    ).toBe("stored");
    const completeBody = Buffer.concat([firstBytes, secondBytes]);
    const stored = afterRestart.finalizeTrusted({
      lease: issued.lease,
      chunks: [
        { index: 0, digest: digestBytes(firstBytes), size: firstBytes.length },
        { index: 1, digest: digestBytes(secondBytes), size: secondBytes.length }
      ],
      expectedDigest: digestBytes(completeBody),
      expectedSize: completeBody.length,
      mediaType: "application/octet-stream"
    });
    expect(afterRestart.read(stored.blob.storageRef)).toEqual(completeBody);

    const newLease = afterRestart.issueStagingLease({
      runId: "run:test:resume"
    });
    expect(() =>
      afterRestart.writeTrustedChunk({
        lease: newLease.lease,
        index: 3,
        bytes: Buffer.from([5]),
        digest: digestBytes(Buffer.from([5]))
      })
    ).toThrow("Expected trusted staging chunk 0");
  });

  it("replays finalize after Blob storage but before SQLite completion", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-assets-finalize-replay-"));
    const first = store(root);
    const issued = first.issueStagingLease({ runId: "run:test:crash" });
    const body = Buffer.from([0xff, 0xd8, 0xff, 0x22]);
    const digest = digestBytes(body);
    first.writeTrustedChunk({
      lease: issued.lease,
      index: 0,
      bytes: body,
      digest
    });
    const finalizeInput = {
      lease: issued.lease,
      chunks: [{ index: 0, digest, size: body.length }],
      expectedDigest: digest,
      expectedSize: body.length,
      mediaType: "image/jpeg"
    };
    const beforeCrash = first.finalizeTrusted(finalizeInput);

    const afterRestart = store(root);
    const replay = afterRestart.finalizeTrusted(finalizeInput);
    expect(replay.deduplicated).toBe(true);
    expect(replay.blob.storageRef).toBe(beforeCrash.blob.storageRef);
    expect(afterRestart.read(replay.blob.storageRef)).toEqual(body);
  });
});
