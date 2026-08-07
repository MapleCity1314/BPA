import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

type JsonObject = Record<string, unknown>;

export interface VerifiedReferenceAsset {
  productId: string;
  sourceUrl: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  digest: string;
  sizeBytes: number;
  observedAt: string;
  accessScope: "public";
  rightsStatus: "not_assessed";
  allowedUse: "internal_reference_only";
}

export interface EcommerceEvidenceClosureReport {
  schemaVersion: "ecommerce-evidence-closure/v1";
  status: "source_verified_rights_pending";
  packId: string;
  sourceRunId: string;
  verifiedAt: string;
  assetCount: number;
  assets: VerifiedReferenceAsset[];
  blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"];
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeFile(root: string, candidate: unknown, label: string): string {
  const path = text(candidate, label);
  if (
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedPath = resolve(resolvedRoot, path);
  if (
    resolvedPath === resolvedRoot ||
    !resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error(`${label} escaped the evidence root`);
  }
  const metadata = lstatSync(resolvedPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must resolve to a regular file`);
  }
  const realPath = realpathSync(resolvedPath);
  if (!realPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} resolved outside the evidence root`);
  }
  return realPath;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mediaType(value: unknown, bytes: Uint8Array): VerifiedReferenceAsset["mediaType"] {
  const candidate = text(value, "asset contentType");
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const valid =
    candidate === "image/jpeg"
      ? prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff
      : candidate === "image/png"
        ? prefix.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          )
        : candidate === "image/webp"
          ? prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
            prefix.subarray(8, 12).toString("ascii") === "WEBP"
          : false;
  if (!valid) {
    throw new Error(`Asset signature does not match ${candidate}`);
  }
  return candidate as VerifiedReferenceAsset["mediaType"];
}

function sourceUrl(value: unknown): string {
  const candidate = new URL(text(value, "asset source URL"));
  if (
    candidate.protocol !== "https:" ||
    !candidate.hostname.endsWith(".ecombdimg.com") ||
    candidate.username ||
    candidate.password
  ) {
    throw new Error("Asset source URL is outside the approved Douyin item CDN");
  }
  return candidate.toString();
}

function observedAt(value: unknown): string {
  const candidate = text(value, "observedAt");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    throw new Error("observedAt must use YYYY-MM-DD");
  }
  const timestamp = `${candidate}T00:00:00.000Z`;
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("observedAt is invalid");
  }
  return timestamp;
}

export function verifyEcommerceEvidenceClosure(input: {
  replayInput: unknown;
  runRoot: string;
  verifiedAt: string;
}): EcommerceEvidenceClosureReport {
  const replay = object(input.replayInput, "replay input");
  const products = replay.products;
  if (!Array.isArray(products) || products.length === 0 || products.length > 100) {
    throw new Error("replay input products must contain 1 to 100 items");
  }
  const timestamp = new Date(input.verifiedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("verifiedAt must be a valid timestamp");
  }
  const seenProducts = new Set<string>();
  const seenDigests = new Set<string>();
  const assets = products.map((entry, index) => {
    const product = object(entry, `products[${index}]`);
    const productId = text(product.productId, `products[${index}].productId`);
    if (seenProducts.has(productId)) {
      throw new Error(`Duplicate productId: ${productId}`);
    }
    seenProducts.add(productId);
    const assetInput = object(product.assets, `products[${index}].assets`);
    if (assetInput.source !== "DOUYIN_PUBLIC_PRODUCT_PAGE") {
      throw new Error(`Unsupported asset source for ${productId}`);
    }
    const selected = object(
      assetInput.selectedMain,
      `products[${index}].assets.selectedMain`
    );
    const assetPath = safeFile(
      input.runRoot,
      selected.path,
      `products[${index}].assets.selectedMain.path`
    );
    const bytes = readFileSync(assetPath);
    const expectedDigest = text(
      selected.sha256,
      `products[${index}].assets.selectedMain.sha256`
    );
    const actualDigest = sha256(bytes);
    if (actualDigest !== expectedDigest) {
      throw new Error(`Selected asset digest mismatch for ${productId}`);
    }
    if (seenDigests.has(actualDigest)) {
      throw new Error(`Selected asset is duplicated across products: ${productId}`);
    }
    seenDigests.add(actualDigest);
    const manifestPath = safeFile(
      input.runRoot,
      assetInput.sourceManifest,
      `products[${index}].assets.sourceManifest`
    );
    const manifest = object(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      `source manifest for ${productId}`
    );
    if (!Array.isArray(manifest.failures) || manifest.failures.length !== 0) {
      throw new Error(`Source manifest contains failures for ${productId}`);
    }
    if (!Array.isArray(manifest.assets)) {
      throw new Error(`Source manifest assets are missing for ${productId}`);
    }
    const selectedId = basename(assetPath).replace(/\.[^.]+$/u, "");
    const sourceEntry = manifest.assets
      .map((candidate, assetIndex) =>
        object(candidate, `source manifest ${productId}.assets[${assetIndex}]`)
      )
      .find((candidate) => candidate.id === selectedId);
    if (!sourceEntry) {
      throw new Error(`Selected asset is absent from source manifest for ${productId}`);
    }
    return {
      productId,
      sourceUrl: sourceUrl(sourceEntry.url),
      mediaType: mediaType(sourceEntry.contentType, bytes),
      digest: `sha256:${actualDigest}`,
      sizeBytes: bytes.byteLength,
      observedAt: observedAt(replay.observedAt),
      accessScope: "public" as const,
      rightsStatus: "not_assessed" as const,
      allowedUse: "internal_reference_only" as const
    };
  });
  return {
    schemaVersion: "ecommerce-evidence-closure/v1",
    status: "source_verified_rights_pending",
    packId: text(replay.packId, "packId"),
    sourceRunId: text(replay.sourceRunId, "sourceRunId"),
    verifiedAt: timestamp.toISOString(),
    assetCount: assets.length,
    assets,
    blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
  };
}
