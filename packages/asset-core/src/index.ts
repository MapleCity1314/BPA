import {
  formatValidationErrors,
  validateAssetRecord,
  type AssetRecordDefinition
} from "@bpa/schemas";

export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
export const MAX_RUN_BYTES = 2 * 1024 * 1024 * 1024;
export const GLOBAL_STORAGE_WARNING_BYTES = 10 * 1024 * 1024 * 1024;

export type Classification = AssetRecordDefinition["classification"];
export type RetentionPolicy = AssetRecordDefinition["retention"];

export interface Clock {
  now(): Date;
}

export interface IdFactory {
  create(): string;
}

export interface BlobRecord {
  digest: string;
  size: number;
  mediaType: string;
  storageRef: string;
  createdAt: string;
}

export interface StagingLeaseRecord {
  leaseId: string;
  runId: string;
  tokenDigest: string;
  maxBytes: number;
  state: "active" | "consumed" | "expired" | "rejected";
  createdAt: string;
  expiresAt: string;
}

export interface AssetValidationContext {
  blob: BlobRecord | undefined;
  sourceExists(sourceId: string): boolean;
  assetExists(assetId: string): boolean;
}

export class AssetValidationError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Invalid AssetRecord: ${reasons.join("; ")}`);
  }
}

export function storageRefForDigest(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new AssetValidationError(["digest must be a SHA-256 digest"]);
  }
  return `asset-store:${digest}`;
}

export function defaultRetention(
  classification: Classification,
  createdAt: Date
): RetentionPolicy {
  const duration =
    classification === "confidential" || classification === "restricted"
      ? 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return {
    policy:
      classification === "confidential" || classification === "restricted"
        ? "restricted_24h"
        : "public_30d",
    retainUntil: new Date(createdAt.getTime() + duration).toISOString()
  };
}

export function assertAssetRecord(
  value: unknown,
  context: AssetValidationContext
): asserts value is AssetRecordDefinition {
  if (!validateAssetRecord(value)) {
    throw new AssetValidationError(
      formatValidationErrors(validateAssetRecord.errors)
    );
  }
  const asset = value as AssetRecordDefinition;
  const reasons: string[] = [];
  if (asset.storageRef !== storageRefForDigest(asset.digest)) {
    reasons.push("storageRef must be generated from digest");
  }
  if (
    (asset.classification === "confidential" ||
      asset.classification === "restricted") &&
    asset.retention.policy === "public_30d"
  ) {
    reasons.push("sensitive Assets cannot use public_30d retention");
  }
  if (
    asset.classification === "public" &&
    asset.retention.policy === "restricted_24h"
  ) {
    reasons.push("public Assets cannot use restricted_24h retention");
  }
  if (
    "retainUntil" in asset.retention &&
    Date.parse(asset.retention.retainUntil) <= Date.parse(asset.createdAt)
  ) {
    reasons.push("retainUntil must be later than createdAt");
  }
  for (const sourceId of asset.sourceIds) {
    if (!context.sourceExists(sourceId)) {
      reasons.push(`unknown SourceRecord: ${sourceId}`);
    }
  }
  for (const parentId of asset.derivedFromAssetIds ?? []) {
    if (parentId === asset.assetId) {
      reasons.push("an Asset cannot derive from itself");
    } else if (!context.assetExists(parentId)) {
      reasons.push(`unknown parent Asset: ${parentId}`);
    }
  }
  if (!context.blob) {
    reasons.push("Blob metadata must exist before Asset publication");
  } else if (
    context.blob.digest !== asset.digest ||
    context.blob.size !== asset.size ||
    context.blob.mediaType !== asset.mediaType ||
    context.blob.storageRef !== asset.storageRef
  ) {
    reasons.push("Asset metadata does not match the stored Blob");
  }
  if (reasons.length > 0) {
    throw new AssetValidationError(reasons);
  }
}
