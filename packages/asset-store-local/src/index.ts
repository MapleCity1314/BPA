import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  GLOBAL_STORAGE_WARNING_BYTES,
  MAX_OBJECT_BYTES,
  storageRefForDigest,
  type BlobRecord,
  type Clock,
  type StagingLeaseRecord
} from "@bpa/asset-core";

const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export interface LocalAssetStoreOptions {
  dataDirectory: string;
  clock?: Clock;
  idFactory?: () => string;
  secretFactory?: () => Uint8Array;
  globalWarningBytes?: number;
}

export interface IssuedStagingLease {
  lease: StagingLeaseRecord;
  token: string;
}

export interface StagedChunk {
  index: number;
  digest: string;
  size: number;
}

export interface FinalizeStagingInput {
  lease: StagingLeaseRecord;
  token: string;
  chunks: readonly StagedChunk[];
  expectedDigest: string;
  expectedSize: number;
  mediaType: string;
}

export type FinalizeTrustedStagingInput = Omit<
  FinalizeStagingInput,
  "token"
>;

export interface StoredBlob {
  blob: BlobRecord;
  storageWarning: boolean;
  deduplicated: boolean;
}

export class AssetStoreSecurityError extends Error {}
export class AssetStoreConflictError extends Error {}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestToken(token: string): string {
  return sha256(Buffer.from(token, "utf8"));
}

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AssetStoreSecurityError("Asset store entry must be a regular file");
  }
}

function assertDirectory(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AssetStoreSecurityError(
      "Asset store entry must be a real directory"
    );
  }
}

function assertKnownMediaSignature(mediaType: string, bytes: Uint8Array): void {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const valid =
    mediaType === "image/jpeg"
      ? prefix.length >= 3 &&
        prefix[0] === 0xff &&
        prefix[1] === 0xd8 &&
        prefix[2] === 0xff
      : mediaType === "image/png"
        ? prefix.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          )
        : mediaType === "image/gif"
          ? prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
            prefix.subarray(0, 6).toString("ascii") === "GIF89a"
          : mediaType === "application/pdf"
            ? prefix.subarray(0, 5).toString("ascii") === "%PDF-"
            : true;
  if (!valid) {
    throw new AssetStoreConflictError(
      `Blob signature does not match ${mediaType}`
    );
  }
}

export class LocalAssetStore {
  readonly #dataDirectory: string;
  readonly #assetsDirectory: string;
  readonly #stagingDirectory: string;
  readonly #clock: Clock;
  readonly #idFactory: () => string;
  readonly #secretFactory: () => Uint8Array;
  readonly #globalWarningBytes: number;

  constructor(options: LocalAssetStoreOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#assetsDirectory = join(this.#dataDirectory, "assets", "sha256");
    this.#stagingDirectory = join(this.#dataDirectory, "staging");
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#secretFactory =
      options.secretFactory ?? (() => randomBytes(32));
    this.#globalWarningBytes =
      options.globalWarningBytes ?? GLOBAL_STORAGE_WARNING_BYTES;
    mkdirSync(this.#assetsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(this.#stagingDirectory, { recursive: true, mode: 0o700 });
    assertDirectory(this.#dataDirectory);
    assertDirectory(join(this.#dataDirectory, "assets"));
    assertDirectory(this.#assetsDirectory);
    assertDirectory(this.#stagingDirectory);
  }

  issueStagingLease(input: {
    runId: string;
    maxBytes?: number;
    ttlMs?: number;
  }): IssuedStagingLease {
    const leaseId = this.#idFactory();
    if (!LEASE_ID.test(leaseId)) {
      throw new AssetStoreSecurityError("Generated lease ID is unsafe");
    }
    const maxBytes = input.maxBytes ?? MAX_OBJECT_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_OBJECT_BYTES
    ) {
      throw new AssetStoreSecurityError(
        `Lease maxBytes must be between 1 and ${MAX_OBJECT_BYTES}`
      );
    }
    const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new AssetStoreSecurityError("Lease TTL is outside the allowed range");
    }
    const secret = this.#secretFactory();
    if (secret.byteLength < 32) {
      throw new AssetStoreSecurityError(
        "Generated lease secret must contain at least 256 bits"
      );
    }
    const token = Buffer.from(secret).toString("hex");
    if (!TOKEN.test(token)) {
      throw new AssetStoreSecurityError("Generated lease token is unsafe");
    }
    const createdAt = this.#clock.now();
    const lease: StagingLeaseRecord = {
      leaseId,
      runId: input.runId,
      tokenDigest: digestToken(token),
      maxBytes,
      state: "active",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString()
    };
    const directory = this.#leaseDirectory(leaseId);
    mkdirSync(directory, { mode: 0o700 });
    assertDirectory(directory);
    return { lease, token };
  }

  writeChunk(input: {
    lease: StagingLeaseRecord;
    token: string;
    index: number;
    bytes: Uint8Array;
    digest: string;
  }): "stored" | "duplicate" {
    this.#authorize(input.lease, input.token);
    return this.#writeAuthorizedChunk(input);
  }

  /**
   * Trusted Core recovery path. The caller must have loaded the lease from the
   * Core-owned persistence store. This deliberately does not accept a token;
   * UI/Control callers must use writeChunk and can never select this boundary.
   */
  writeTrustedChunk(input: {
    lease: StagingLeaseRecord;
    index: number;
    bytes: Uint8Array;
    digest: string;
  }): "stored" | "duplicate" {
    this.#authorizeTrustedLease(input.lease);
    return this.#writeAuthorizedChunk(input);
  }

  #writeAuthorizedChunk(input: {
    lease: StagingLeaseRecord;
    index: number;
    bytes: Uint8Array;
    digest: string;
  }): "stored" | "duplicate" {
    assertDirectory(this.#leaseDirectory(input.lease.leaseId));
    if (!Number.isSafeInteger(input.index) || input.index < 0) {
      throw new AssetStoreSecurityError("Chunk index is invalid");
    }
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > input.lease.maxBytes) {
      throw new AssetStoreSecurityError("Chunk exceeds staging lease");
    }
    const actualDigest = sha256(input.bytes);
    if (actualDigest !== input.digest) {
      throw new AssetStoreConflictError("Chunk digest mismatch");
    }
    const path = this.#chunkPath(input.lease.leaseId, input.index);
    if (existsSync(path)) {
      assertRegularFile(path);
      const current = readFileSync(path);
      if (
        current.byteLength === input.bytes.byteLength &&
        timingSafeEqual(current, Buffer.from(input.bytes))
      ) {
        return "duplicate";
      }
      throw new AssetStoreConflictError("Conflicting staged chunk");
    }
    const entries = readdirSync(this.#leaseDirectory(input.lease.leaseId));
    const indexes = entries.map((name) => {
      const match = /^chunk-([0-9]{8})$/.exec(name);
      if (!match) {
        throw new AssetStoreSecurityError("Unexpected staging entry");
      }
      return Number(match[1]);
    });
    const nextIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
    if (input.index !== nextIndex) {
      throw new AssetStoreConflictError(
        `Expected trusted staging chunk ${nextIndex}`
      );
    }
    const stagedBytes = entries.reduce((total, name) => {
      const entryPath = join(
        this.#leaseDirectory(input.lease.leaseId),
        name
      );
      assertRegularFile(entryPath);
      return total + statSync(entryPath).size;
    }, 0);
    if (stagedBytes + input.bytes.byteLength > input.lease.maxBytes) {
      throw new AssetStoreSecurityError("Staged bytes exceed lease quota");
    }
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, input.bytes);
    } finally {
      closeSync(fd);
    }
    return "stored";
  }

  finalize(input: FinalizeStagingInput): StoredBlob {
    this.#authorize(input.lease, input.token);
    return this.#finalizeAuthorized(input);
  }

  /**
   * Trusted Core recovery counterpart to writeTrustedChunk. The persisted
   * active lease is the authority; this is never exposed through Control.
   */
  finalizeTrusted(input: FinalizeTrustedStagingInput): StoredBlob {
    this.#authorizeTrustedLease(input.lease);
    return this.#finalizeAuthorized(input);
  }

  #finalizeAuthorized(
    input: FinalizeTrustedStagingInput
  ): StoredBlob {
    if (
      !Number.isSafeInteger(input.expectedSize) ||
      input.expectedSize < 1 ||
      input.expectedSize > input.lease.maxBytes ||
      input.expectedSize > MAX_OBJECT_BYTES
    ) {
      throw new AssetStoreSecurityError("Final Blob exceeds object limit");
    }
    const digestMatch = /^sha256:([a-f0-9]{64})$/.exec(
      input.expectedDigest
    );
    if (!digestMatch) {
      throw new AssetStoreConflictError("Final Blob digest is invalid");
    }
    const digestHex = digestMatch[1]!;
    const prefixDirectory = join(this.#assetsDirectory, digestHex.slice(0, 2));
    const destination = join(prefixDirectory, digestHex);
    if (existsSync(destination)) {
      assertRegularFile(destination);
      const existing = readFileSync(destination);
      if (
        existing.byteLength !== input.expectedSize ||
        sha256(existing) !== input.expectedDigest
      ) {
        throw new AssetStoreConflictError(
          "Existing content-addressed Blob is corrupt"
        );
      }
      assertKnownMediaSignature(input.mediaType, existing);
      this.discardStaging(input.lease.leaseId);
      const replayedBlob: BlobRecord = {
        digest: input.expectedDigest,
        size: input.expectedSize,
        mediaType: input.mediaType,
        storageRef: storageRefForDigest(input.expectedDigest),
        createdAt: this.#clock.now().toISOString()
      };
      return {
        blob: replayedBlob,
        deduplicated: true,
        storageWarning: this.storedBytes() >= this.#globalWarningBytes
      };
    }
    assertDirectory(this.#leaseDirectory(input.lease.leaseId));
    if (input.chunks.length < 1) {
      throw new AssetStoreConflictError("Final Blob has no chunks");
    }
    const buffers = input.chunks.map((chunk, expectedIndex) => {
      if (chunk.index !== expectedIndex) {
        throw new AssetStoreConflictError("Staged chunks are not contiguous");
      }
      const path = this.#chunkPath(input.lease.leaseId, chunk.index);
      assertRegularFile(path);
      const bytes = readFileSync(path);
      if (bytes.byteLength !== chunk.size || sha256(bytes) !== chunk.digest) {
        throw new AssetStoreConflictError(
          `Staged chunk ${chunk.index} failed verification`
        );
      }
      return bytes;
    });
    const body = Buffer.concat(buffers);
    if (
      body.byteLength !== input.expectedSize ||
      sha256(body) !== input.expectedDigest
    ) {
      throw new AssetStoreConflictError("Final Blob digest or size mismatch");
    }
    assertKnownMediaSignature(input.mediaType, body);
    if (!existsSync(prefixDirectory)) {
      mkdirSync(prefixDirectory, { mode: 0o700 });
    }
    assertDirectory(prefixDirectory);
    let deduplicated = false;
    if (existsSync(destination)) {
      assertRegularFile(destination);
      const existing = readFileSync(destination);
      if (
        existing.byteLength !== body.byteLength ||
        sha256(existing) !== input.expectedDigest
      ) {
        throw new AssetStoreConflictError(
          "Existing content-addressed Blob is corrupt"
        );
      }
      deduplicated = true;
    } else {
      const temporary = join(
        prefixDirectory,
        `.incoming-${this.#idFactory()}`
      );
      if (!temporary.startsWith(`${prefixDirectory}${sep}`)) {
        throw new AssetStoreSecurityError("Generated temporary path escaped CAS");
      }
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, destination);
      chmodSync(destination, 0o400);
    }
    this.discardStaging(input.lease.leaseId);
    const blob: BlobRecord = {
      digest: input.expectedDigest,
      size: input.expectedSize,
      mediaType: input.mediaType,
      storageRef: storageRefForDigest(input.expectedDigest),
      createdAt: this.#clock.now().toISOString()
    };
    return {
      blob,
      deduplicated,
      storageWarning: this.storedBytes() >= this.#globalWarningBytes
    };
  }

  read(storageRef: string): Uint8Array {
    const path = this.#pathForStorageRef(storageRef);
    assertRegularFile(path);
    return readFileSync(path);
  }

  storedBytes(): number {
    let total = 0;
    for (const prefix of readdirSync(this.#assetsDirectory)) {
      const prefixPath = join(this.#assetsDirectory, prefix);
      assertDirectory(prefixPath);
      for (const name of readdirSync(prefixPath)) {
        if (name.startsWith(".incoming-")) continue;
        const path = join(prefixPath, name);
        assertRegularFile(path);
        total += statSync(path).size;
      }
    }
    return total;
  }

  discardStaging(leaseId: string): void {
    const directory = this.#leaseDirectory(leaseId);
    if (!existsSync(directory)) return;
    assertDirectory(directory);
    for (const name of readdirSync(directory)) {
      if (!/^chunk-[0-9]{8}$/.test(name)) {
        throw new AssetStoreSecurityError("Unexpected staging entry");
      }
      const path = join(directory, name);
      assertRegularFile(path);
      unlinkSync(path);
    }
    rmdirSync(directory);
  }

  #authorize(lease: StagingLeaseRecord, token: string): void {
    this.#authorizeTrustedLease(lease);
    if (!TOKEN.test(token)) {
      throw new AssetStoreSecurityError("Staging lease token is invalid");
    }
    const actual = Buffer.from(digestToken(token));
    const expected = Buffer.from(lease.tokenDigest);
    if (
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new AssetStoreSecurityError("Staging lease token is invalid");
    }
  }

  #authorizeTrustedLease(lease: StagingLeaseRecord): void {
    if (
      lease.state !== "active" ||
      Date.parse(lease.expiresAt) <= this.#clock.now().getTime()
    ) {
      throw new AssetStoreSecurityError("Staging lease is not active");
    }
    this.#leaseDirectory(lease.leaseId);
  }

  #leaseDirectory(leaseId: string): string {
    if (!LEASE_ID.test(leaseId)) {
      throw new AssetStoreSecurityError("Staging lease ID is unsafe");
    }
    const path = join(this.#stagingDirectory, leaseId);
    if (!path.startsWith(`${this.#stagingDirectory}${sep}`)) {
      throw new AssetStoreSecurityError("Staging lease escaped its root");
    }
    return path;
  }

  #chunkPath(leaseId: string, index: number): string {
    return join(this.#leaseDirectory(leaseId), `chunk-${String(index).padStart(8, "0")}`);
  }

  #pathForStorageRef(storageRef: string): string {
    const match = /^asset-store:sha256:([a-f0-9]{64})$/.exec(storageRef);
    if (!match) {
      throw new AssetStoreSecurityError("Invalid storage reference");
    }
    const digest = match[1]!;
    return join(this.#assetsDirectory, digest.slice(0, 2), digest);
  }
}
