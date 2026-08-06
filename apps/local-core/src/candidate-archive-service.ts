import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { LocalAssetStore } from "@bpa/asset-store-local";
import {
  createCandidateArchive,
  createCandidatePatch,
  sha256,
  verifyCandidateArchive,
  type CandidateArchiveEntry
} from "@bpa/candidate-archive";
import { canonicalJson } from "@bpa/compiler";
import type { Persistence } from "@bpa/persistence";

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assertRealDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Candidate export directory is unsafe: ${path}`);
  }
}

const CANDIDATE_FILE_PATH =
  /^(?:adapters|nodes|workflows|tests)\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/u;
const CANDIDATE_MEDIA_TYPES = new Set([
  "application/json",
  "application/yaml",
  "text/typescript",
  "text/markdown"
]);

export class LocalCandidateArchiveService {
  readonly #assets: LocalAssetStore;
  readonly #exportsDirectory: string;

  constructor(
    readonly persistence: Persistence,
    dataDirectory: string
  ) {
    const exactDataDirectory = resolve(dataDirectory);
    this.#assets = new LocalAssetStore({
      dataDirectory: exactDataDirectory
    });
    this.#exportsDirectory = join(exactDataDirectory, "exports");
    mkdirSync(this.#exportsDirectory, {
      recursive: true,
      mode: 0o700
    });
    assertRealDirectory(this.#exportsDirectory);
  }

  inspect(bundleId: string) {
    const record = this.persistence.getCandidateBundle(bundleId);
    if (!record) {
      throw new Error(`Candidate Bundle not found: ${bundleId}`);
    }
    return {
      ...record,
      validationResults:
        this.persistence.listCandidateBundleValidation(bundleId)
    };
  }

  readAsset(storageRef: string): Uint8Array {
    return this.#assets.read(storageRef);
  }

  storeCandidateFile(input: {
    authoringSessionId: string;
    path: string;
    mediaType: string;
    body: string;
    createdAt: string;
  }) {
    if (
      !CANDIDATE_FILE_PATH.test(input.path) ||
      !CANDIDATE_MEDIA_TYPES.has(input.mediaType)
    ) {
      throw new Error("Generated Candidate file path or media type is unsafe");
    }
    const bytes = Buffer.from(input.body, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > 25 * 1024 * 1024) {
      throw new Error("Generated Candidate file size is outside the safe limit");
    }
    const digest = sha256(bytes);
    const identity = sha256(
      Buffer.from(
        `${input.authoringSessionId}\0${input.path}\0${digest}`,
        "utf8"
      )
    ).slice("sha256:".length, "sha256:".length + 32);
    const sourceId = `source:candidate:${identity}`;
    const assetId = `candidate-file-${identity}`;
    const issued = this.#assets.issueStagingLease({
      runId: input.authoringSessionId,
      maxBytes: bytes.byteLength
    });
    this.#assets.writeChunk({
      lease: issued.lease,
      token: issued.token,
      index: 0,
      bytes,
      digest
    });
    const stored = this.#assets.finalize({
      lease: issued.lease,
      token: issued.token,
      chunks: [
        {
          index: 0,
          digest,
          size: bytes.byteLength
        }
      ],
      expectedDigest: digest,
      expectedSize: bytes.byteLength,
      mediaType: input.mediaType
    });
    const blob =
      this.persistence.getBlob(digest) ??
      this.persistence.registerBlob(stored.blob).record;
    this.persistence.putSourceRecord({
      apiVersion: "bpa.source/v1alpha1",
      kind: "SourceRecord",
      sourceId,
      sourceType: "user_file",
      locator: {
        originalFileName: input.path.split("/").at(-1)!,
        mediaType: input.mediaType,
        size: bytes.byteLength,
        digest
      },
      observedAt: input.createdAt,
      recordedAt: input.createdAt,
      accessScope: "user_provided",
      rawDigest: digest,
      classification: "internal",
      title: `Generated Candidate file ${input.path}`
    });
    this.persistence.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId,
      digest,
      size: bytes.byteLength,
      mediaType: input.mediaType,
      storageRef: blob.storageRef,
      classification: "internal",
      sourceIds: [sourceId],
      createdAt: input.createdAt,
      retention: { policy: "manual" }
    });
    return {
      path: input.path,
      mediaType: input.mediaType,
      digest,
      sizeBytes: bytes.byteLength,
      sourceAssetRef: {
        id: assetId,
        digest
      }
    };
  }

  export(input: {
    bundleId: string;
    actor: string;
    occurredAt: string;
  }) {
    const record = this.persistence.getCandidateBundle(input.bundleId);
    if (!record) {
      throw new Error(`Candidate Bundle not found: ${input.bundleId}`);
    }
    const sourceFiles: CandidateArchiveEntry[] = record.bundle.files.map(
      (file) => {
        const asset = this.persistence.getAssetRecord(
          file.sourceAssetRef.id
        );
        if (
          !asset ||
          asset.digest !== file.digest ||
          asset.digest !== file.sourceAssetRef.digest ||
          asset.size !== file.sizeBytes ||
          asset.mediaType !== file.mediaType
        ) {
          throw new Error(
            `Candidate file Asset no longer matches: ${file.path}`
          );
        }
        const bytes = this.#assets.read(asset.storageRef);
        if (
          bytes.byteLength !== file.sizeBytes ||
          sha256(bytes) !== file.digest
        ) {
          throw new Error(
            `Candidate file CAS body is corrupt: ${file.path}`
          );
        }
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { path: file.path, bytes };
      }
    );
    const manifest = {
      formatVersion: "bpa.candidate-archive/1",
      bundleId: record.bundle.metadata.id,
      bundleVersion: record.bundle.metadata.version,
      bundleDigest: record.digest,
      scenarioRef: record.bundle.scenarioRef,
      authoringSession: record.bundle.authoringSession,
      artifacts: record.bundle.artifacts,
      files: record.bundle.files,
      dependencyClosure: record.bundle.dependencyClosure,
      createdAt: record.bundle.createdAt
    };
    const archive = createCandidateArchive([
      {
        path: "candidate-manifest.json",
        bytes: jsonBytes(manifest)
      },
      {
        path: "candidate.patch",
        bytes: Buffer.from(
          `${createCandidatePatch(sourceFiles)}\n`,
          "utf8"
        )
      },
      {
        path: "validation-report.json",
        bytes: jsonBytes({
          bundleId: record.bundle.metadata.id,
          checks:
            this.persistence.listCandidateBundleValidation(
              input.bundleId
            )
        })
      },
      {
        path: "risk-report.json",
        bytes: jsonBytes(record.bundle.riskReport)
      },
      ...sourceFiles.map((file) => ({
        path: `files/${file.path}`,
        bytes: file.bytes
      }))
    ]);
    const verification = verifyCandidateArchive(archive);
    if (!verification.valid) {
      throw new Error(
        `Generated Candidate archive failed verification: ${verification.issues.join("; ")}`
      );
    }
    const exportId = `candidate-export-${randomUUID()}`;
    const archivePath = join(
      this.#exportsDirectory,
      `${exportId}.tar`
    );
    if (
      !archivePath.startsWith(`${this.#exportsDirectory}${sep}`) ||
      existsSync(archivePath)
    ) {
      throw new Error("Candidate export destination is unsafe");
    }
    writeFileSync(archivePath, archive, {
      flag: "wx",
      mode: 0o600
    });
    const manifestEntry = verification.entries.find(
      (entry) => entry.path === "candidate-manifest.json"
    );
    if (!manifestEntry) {
      throw new Error("Candidate archive manifest is missing");
    }
    const exportRecord = this.persistence.putCandidateExport({
      exportId,
      bundleId: input.bundleId,
      bundleDigest: record.digest,
      archiveDigest: verification.archiveDigest,
      manifestDigest: manifestEntry.digest,
      destinationRef: `candidate-export:${exportId}`,
      actor: input.actor,
      createdAt: input.occurredAt
    });
    return {
      status: exportRecord.status,
      export: exportRecord.record,
      archivePath,
      sizeBytes: archive.byteLength,
      verification
    };
  }
}
