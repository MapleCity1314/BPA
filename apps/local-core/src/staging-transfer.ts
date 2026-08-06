import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { LocalAssetStore } from "@bpa/asset-store-local";
import { defaultRetention, MAX_OBJECT_BYTES } from "@bpa/asset-core";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import type { Persistence } from "@bpa/persistence";

const METADATA_LIMIT_BYTES = 64 * 1024;

interface PendingUpload {
  token: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  expectedDigest?: string;
  purpose: "dataset" | "evidence";
}

interface TransferMetadata {
  protocol: "bpa.staging/1";
  leaseId: string;
  token: string;
  sizeBytes: number;
  expectedSha256?: string;
}

export interface StagingLeaseRequest {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
  purpose: "dataset" | "evidence";
}

export interface ResolvedDatasetUpload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly digest: string;
  readonly size: number;
}

function sourceId(leaseId: string): string {
  return `staging-source:${leaseId}`;
}

function assetId(leaseId: string): string {
  return `staging-asset:${leaseId}`;
}

export class StagingTransferService {
  readonly #store: LocalAssetStore;
  readonly #pending = new Map<string, PendingUpload>();

  constructor(
    private readonly persistence: Persistence,
    dataDirectory: string
  ) {
    this.#store = new LocalAssetStore({ dataDirectory });
  }

  issue(input: StagingLeaseRequest): {
    leaseId: string;
    expiresAt: string;
    maxBytes: number;
    transferToken: string;
  } {
    if (
      !input.fileName ||
      input.fileName.length > 255 ||
      input.fileName.includes("/") ||
      input.fileName.includes("\\") ||
      !input.mediaType ||
      input.mediaType.length > 255 ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > MAX_OBJECT_BYTES ||
      !["dataset", "evidence"].includes(input.purpose)
    ) {
      throw new Error("Staging lease metadata is invalid");
    }
    const expectedDigest =
      input.sha256 === undefined
        ? undefined
        : /^[a-f0-9]{64}$/i.test(input.sha256)
          ? `sha256:${input.sha256.toLowerCase()}`
          : undefined;
    if (input.sha256 !== undefined && !expectedDigest) {
      throw new Error("Staging lease SHA-256 is invalid");
    }
    const issued = this.#store.issueStagingLease({
      runId: `console-upload:${input.purpose}`,
      maxBytes: input.sizeBytes
    });
    this.persistence.putStagingLease(issued.lease);
    this.#pending.set(issued.lease.leaseId, {
      token: issued.token,
      fileName: input.fileName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      ...(expectedDigest ? { expectedDigest } : {}),
      purpose: input.purpose
    });
    return {
      leaseId: issued.lease.leaseId,
      expiresAt: issued.lease.expiresAt,
      maxBytes: issued.lease.maxBytes,
      transferToken: issued.token
    };
  }

  upload(metadata: TransferMetadata, body: Uint8Array): {
    leaseId: string;
    digest: string;
    sizeBytes: number;
  } {
    const pending = this.#pending.get(metadata.leaseId);
    const lease = this.persistence.getStagingLease(metadata.leaseId);
    if (
      metadata.protocol !== "bpa.staging/1" ||
      !pending ||
      !lease ||
      lease.state !== "active" ||
      !safeTokenEqual(metadata.token, pending.token) ||
      metadata.sizeBytes !== pending.sizeBytes ||
      body.byteLength !== pending.sizeBytes
    ) {
      throw new Error("Staging upload lease is invalid or expired");
    }
    const digest = `sha256:${createHash("sha256")
      .update(body)
      .digest("hex")}`;
    const requestDigest =
      metadata.expectedSha256 === undefined
        ? undefined
        : `sha256:${metadata.expectedSha256.toLowerCase()}`;
    if (
      (pending.expectedDigest && pending.expectedDigest !== digest) ||
      (requestDigest && requestDigest !== digest)
    ) {
      throw new Error("Staging upload digest mismatch");
    }
    this.#store.writeChunk({
      lease,
      token: metadata.token,
      index: 0,
      bytes: body,
      digest
    });
    const stored = this.#store.finalize({
      lease,
      token: metadata.token,
      chunks: [{ index: 0, digest, size: body.byteLength }],
      expectedDigest: digest,
      expectedSize: body.byteLength,
      mediaType: pending.mediaType
    });
    const existingBlob = this.persistence.getBlob(stored.blob.digest);
    if (
      existingBlob &&
      (existingBlob.size !== stored.blob.size ||
        existingBlob.storageRef !== stored.blob.storageRef)
    ) {
      throw new Error("Stored Blob metadata conflicts with its digest");
    }
    const blob =
      existingBlob ??
      this.persistence.registerBlob(stored.blob).record;
    const recordedAt = blob.createdAt;
    this.persistence.putSourceRecord({
      apiVersion: "bpa.source/v1alpha1",
      kind: "SourceRecord",
      sourceId: sourceId(lease.leaseId),
      sourceType: "user_file",
      locator: {
        originalFileName: pending.fileName,
        mediaType: pending.mediaType,
        size: body.byteLength,
        digest
      },
      observedAt: recordedAt,
      recordedAt,
      accessScope: "user_provided",
      classification: "restricted",
      title: pending.fileName
    });
    this.persistence.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId: assetId(lease.leaseId),
      digest,
      size: blob.size,
      mediaType: blob.mediaType,
      storageRef: blob.storageRef,
      classification: "restricted",
      sourceIds: [sourceId(lease.leaseId)],
      createdAt: recordedAt,
      retention: defaultRetention("restricted", new Date(recordedAt))
    });
    this.persistence.transitionStagingLease({
      leaseId: lease.leaseId,
      expectedState: "active",
      nextState: "consumed"
    });
    this.#pending.delete(lease.leaseId);
    return {
      leaseId: lease.leaseId,
      digest,
      sizeBytes: body.byteLength
    };
  }

  resolveDatasetUpload(input: {
    leaseId: string;
    digest: string;
  }): ResolvedDatasetUpload {
    const lease = this.persistence.getStagingLease(input.leaseId);
    if (
      !lease ||
      lease.state !== "consumed" ||
      lease.runId !== "console-upload:dataset" ||
      !/^sha256:[a-f0-9]{64}$/.test(input.digest)
    ) {
      throw new Error("Dataset upload receipt is invalid");
    }
    const source = this.persistence.getSourceRecord(sourceId(input.leaseId));
    const asset = this.persistence.getAssetRecord(assetId(input.leaseId));
    const locator =
      source?.sourceType === "user_file"
        ? (source.locator as Record<string, unknown>)
        : undefined;
    if (
      !source ||
      !asset ||
      !locator ||
      asset.digest !== input.digest ||
      !asset.sourceIds.includes(source.sourceId) ||
      locator.digest !== input.digest ||
      typeof locator.originalFileName !== "string" ||
      typeof locator.size !== "number"
    ) {
      throw new Error("Dataset upload lineage is incomplete or inconsistent");
    }
    const blob = this.persistence.getBlob(input.digest);
    if (
      !blob ||
      blob.size !== asset.size ||
      blob.storageRef !== asset.storageRef ||
      locator.size !== blob.size
    ) {
      throw new Error("Dataset upload Blob metadata is inconsistent");
    }
    const bytes = this.#store.read(blob.storageRef);
    const actualDigest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    if (bytes.byteLength !== blob.size || actualDigest !== blob.digest) {
      throw new Error("Dataset upload Blob failed integrity verification");
    }
    return {
      bytes: Uint8Array.from(bytes),
      fileName: locator.originalFileName,
      digest: blob.digest,
      size: blob.size
    };
  }
}

export class LocalStagingTransferServer {
  #server: Server | undefined;

  constructor(
    readonly socketPath: string,
    private readonly transfers: StagingTransferService
  ) {}

  async start(): Promise<void> {
    if (this.#server) throw new Error("Staging transfer server already started");
    if (!isWindowsNamedPipe(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
    const server = createServer((socket) => this.#accept(socket));
    server.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (!isWindowsNamedPipe(this.socketPath)) {
      chmodSync(this.socketPath, 0o600);
    }
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!isWindowsNamedPipe(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
  }

  #accept(socket: Socket): void {
    socket.on("error", () => undefined);
    let buffered = Buffer.alloc(0);
    let metadataLength: number | undefined;
    let metadata: TransferMetadata | undefined;
    let complete = false;
    socket.on("data", (chunk: Buffer) => {
      if (complete) return;
      buffered = Buffer.concat([buffered, chunk]);
      try {
        if (
          buffered.byteLength >
          MAX_OBJECT_BYTES + METADATA_LIMIT_BYTES + 4
        ) {
          throw new Error("Staging transfer exceeds the global object limit");
        }
        if (metadataLength === undefined && buffered.length >= 4) {
          metadataLength = buffered.readUInt32BE(0);
          buffered = buffered.subarray(4);
          if (
            metadataLength < 2 ||
            metadataLength > METADATA_LIMIT_BYTES
          ) {
            throw new Error("Staging transfer metadata frame is invalid");
          }
        }
        if (
          metadataLength !== undefined &&
          metadata === undefined &&
          buffered.length >= metadataLength
        ) {
          metadata = JSON.parse(
            buffered.subarray(0, metadataLength).toString("utf8")
          ) as TransferMetadata;
          buffered = buffered.subarray(metadataLength);
          if (
            !Number.isSafeInteger(metadata.sizeBytes) ||
            metadata.sizeBytes < 1 ||
            metadata.sizeBytes > MAX_OBJECT_BYTES
          ) {
            throw new Error("Staging transfer size is invalid");
          }
        }
        if (metadata && buffered.length >= metadata.sizeBytes) {
          if (buffered.length !== metadata.sizeBytes) {
            throw new Error("Staging transfer contains trailing bytes");
          }
          const result = this.transfers.upload(metadata, buffered);
          complete = true;
          socket.end(encodeTransferResponse({ ok: true, result }));
        }
      } catch (error) {
        complete = true;
        socket.end(
          encodeTransferResponse({
            ok: false,
            error: {
              code: "STAGING_TRANSFER_REJECTED",
              message: error instanceof Error ? error.message : String(error)
            }
          })
        );
      }
    });
  }
}

function encodeTransferResponse(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
