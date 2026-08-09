import { createHash } from "node:crypto";
import { LocalAssetStore } from "@bpa/asset-store-local";
import { defaultRetention } from "@bpa/asset-core";
import { contentDigest } from "@bpa/compiler";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type { Persistence } from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const PROVIDER_ID = "ecommerce-evidence";
const MATERIALIZE_NODE = "ecommerce.reference-assets.materialize@1.0.0";
const PUBLISH_NODE = "ecommerce.reference-pack.publish@1.0.0";
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ASSETS = 20;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const PLATFORMS = ["DOUYIN", "TAOBAO", "JD"] as const;

type JsonObject = Record<string, JsonValue>;
type Platform = typeof PLATFORMS[number];
type ImageMediaType = typeof IMAGE_TYPES[number];

const CDN_SUFFIXES: Readonly<Record<Platform, readonly string[]>> = {
  DOUYIN: ["ecombdimg.com", "byteimg.com"],
  TAOBAO: ["alicdn.com"],
  JD: ["360buyimg.com"]
};
const PAGE_HOSTS: Readonly<Record<Platform, string>> = {
  DOUYIN: "www.douyin.com",
  TAOBAO: "s.taobao.com",
  JD: "search.jd.com"
};
const PAGE_QUERY_KEYS: Readonly<Record<Platform, readonly string[]>> = {
  DOUYIN: ["type"],
  TAOBAO: ["q"],
  JD: ["keyword"]
};

export interface PublicImageFetchResult {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly finalUrl: string;
}

export interface PublicImageFetcher {
  fetch(
    input: { readonly platform: Platform; readonly url: string },
    signal: AbortSignal
  ): Promise<PublicImageFetchResult>;
}

class EcommerceEvidenceRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EcommerceEvidenceRuntimeError";
  }
}

function object(value: JsonValue | unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EcommerceEvidenceRuntimeError(
      label.includes("curation")
        ? "ECOMMERCE_REFERENCE_CURATION_INVALID"
        : "ECOMMERCE_REFERENCE_INPUT_INVALID"
    );
  }
  return value as JsonObject;
}

function exact(
  value: JsonObject,
  keys: readonly string[],
  code = "ECOMMERCE_REFERENCE_INPUT_INVALID"
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new EcommerceEvidenceRuntimeError(code);
  }
}

function text(
  value: JsonValue | unknown,
  maximum = 500,
  code = "ECOMMERCE_REFERENCE_INPUT_INVALID"
): string {
  if (typeof value !== "string") {
    throw new EcommerceEvidenceRuntimeError(code);
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum) {
    throw new EcommerceEvidenceRuntimeError(code);
  }
  return normalized;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function matchesImageSignature(
  mediaType: ImageMediaType,
  bytes: Uint8Array
): boolean {
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/png") {
    return bytes.length >= 8 &&
      Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
  }
  return bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function safeUrl(value: unknown, platform: Platform): string {
  let candidate: URL;
  try {
    candidate = new URL(text(value, 4_096));
  } catch {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
  }
  const hostname = candidate.hostname.toLowerCase();
  const approved = CDN_SUFFIXES[platform].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    (candidate.port && candidate.port !== "443") ||
    !approved
  ) {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
  }
  candidate.hash = "";
  return candidate.toString();
}

function safePageUrl(value: unknown, platform: Platform): string {
  let candidate: URL;
  try {
    candidate = new URL(text(value, 4_096));
  } catch {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.hostname.toLowerCase() !== PAGE_HOSTS[platform] ||
    candidate.username ||
    candidate.password ||
    (candidate.port && candidate.port !== "443") ||
    [...candidate.searchParams.keys()].some(
      (key) => !PAGE_QUERY_KEYS[platform].includes(key)
    )
  ) {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
  }
  candidate.hash = "";
  return candidate.toString();
}

async function responseBytes(
  response: Response,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (!response.body) {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_REMOTE_UNAVAILABLE");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_LIMIT_EXCEEDED");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CANCELLED");
      }
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_LIMIT_EXCEEDED");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size < 1) {
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class HttpsPublicImageFetcher implements PublicImageFetcher {
  async fetch(
    input: { readonly platform: Platform; readonly url: string },
    signal: AbortSignal
  ): Promise<PublicImageFetchResult> {
    let current = safeUrl(input.url, input.platform);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          headers: { accept: IMAGE_TYPES.join(",") },
          signal
        });
      } catch {
        throw new EcommerceEvidenceRuntimeError(
          signal.aborted
            ? "ECOMMERCE_REFERENCE_CANCELLED"
            : "ECOMMERCE_REFERENCE_REMOTE_UNAVAILABLE"
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) {
          throw new EcommerceEvidenceRuntimeError(
            "ECOMMERCE_REFERENCE_REMOTE_UNAVAILABLE"
          );
        }
        current = safeUrl(new URL(location, current).toString(), input.platform);
        continue;
      }
      if (!response.ok) {
        throw new EcommerceEvidenceRuntimeError(
          "ECOMMERCE_REFERENCE_REMOTE_UNAVAILABLE"
        );
      }
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!IMAGE_TYPES.includes(mediaType as ImageMediaType)) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      return {
        bytes: await responseBytes(response, signal),
        mediaType: mediaType as ImageMediaType,
        finalUrl: current
      };
    }
    throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_REMOTE_UNAVAILABLE");
  }
}

function rejected(code: string): RuntimeOutcome {
  return {
    status: "rejected",
    error: {
      code,
      message: "Ecommerce reference evidence input is not exact.",
      retryable: false
    },
    evidence: [],
    riskSignals: []
  };
}

function failed(code: string): RuntimeOutcome {
  return {
    status: "failed",
    error: {
      code,
      message: "Ecommerce reference evidence operation did not complete.",
      retryable: false
    },
    evidence: [],
    riskSignals: []
  };
}

function cancelled(): RuntimeOutcome {
  return {
    status: "cancelled",
    error: {
      code: "ECOMMERCE_REFERENCE_CANCELLED",
      message: "Ecommerce reference evidence operation was cancelled.",
      retryable: false
    },
    evidence: [],
    riskSignals: []
  };
}

interface EvidenceProbe {
  readonly platform: Platform;
  readonly sourceEvidenceId: string;
  readonly capturedAt: string;
  readonly pageUrl: string;
  readonly items: readonly JsonObject[];
}

interface MaterializedAsset {
  readonly discoveryId: string;
  readonly platform: Platform;
  readonly sourceEvidenceId: string;
  readonly assetId: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly mediaType: ImageMediaType;
  readonly observedRemoteUrl: string;
  readonly sourceUrl: string;
  readonly sourcePageUrl: string;
  readonly role: "UNASSIGNED_REFERENCE_CANDIDATE";
  readonly rightsStatus: "not_assessed";
  readonly allowedUse: "internal_reference_only";
}

interface MaterializationOutput extends JsonObject {
  schemaVersion: "reference-asset-materialization/v1";
  materializationExportId: string;
  packId: string;
  sourceRunId: string;
  status: "materialized_internal_reference";
  rightsStatus: "not_assessed";
  allowedUse: "internal_reference_only";
  sourceEvidenceDigest: string;
  assetCount: number;
  assets: MaterializedAsset[] & JsonValue;
  blockers: ["SOURCE_RIGHTS_NOT_ASSESSED", "HUMAN_ROLE_CURATION_REQUIRED"] & JsonValue;
}

function runtimeClassification(value: string): "public" | "internal" | "sensitive" {
  return value === "public" ? "public" : value === "internal" ? "internal" : "sensitive";
}

export function isEcommerceEvidenceNode(id: string, version: string): boolean {
  return `${id}@${version}` === MATERIALIZE_NODE ||
    `${id}@${version}` === PUBLISH_NODE;
}

export class EcommerceEvidenceRuntimeProvider implements RuntimeProvider {
  readonly id = PROVIDER_ID;
  readonly #assets: LocalAssetStore;

  constructor(
    readonly persistence: Persistence,
    dataDirectory: string,
    readonly fetcher: PublicImageFetcher = new HttpsPublicImageFetcher()
  ) {
    this.#assets = new LocalAssetStore({ dataDirectory });
  }

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return isEcommerceEvidenceNode(node.id, node.version);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) return cancelled();
    const key = `${invocation.node.id}@${invocation.node.version}`;
    const expectedPermission = key === MATERIALIZE_NODE
      ? "ecommerce.reference-asset.materialize"
      : key === PUBLISH_NODE
        ? "ecommerce.reference-pack.publish"
        : undefined;
    if (!expectedPermission) {
      return rejected("ECOMMERCE_REFERENCE_INPUT_INVALID");
    }
    if (
      invocation.permissionSnapshot.riskLevel !== "R1" ||
      invocation.permissionSnapshot.permissions.length !== 1 ||
      invocation.permissionSnapshot.permissions[0] !== expectedPermission ||
      invocation.permissionSnapshot.domains.length !== 0
    ) {
      return rejected("ECOMMERCE_REFERENCE_INPUT_INVALID");
    }
    const run = this.persistence.getRun(invocation.identity.runId);
    if (!run || run.status !== "running") {
      return rejected("ECOMMERCE_REFERENCE_INPUT_INVALID");
    }
    try {
      const output = key === MATERIALIZE_NODE
        ? await this.#materialize(invocation, signal, run.createdAt)
        : this.#publish(invocation, run.createdAt);
      return {
        status: "succeeded",
        output: json(output),
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      const code = error instanceof EcommerceEvidenceRuntimeError
        ? error.code
        : key === MATERIALIZE_NODE
          ? "ECOMMERCE_REFERENCE_STORAGE_FAILED"
          : "ECOMMERCE_REFERENCE_EXPORT_CONFLICT";
      if (code === "ECOMMERCE_REFERENCE_CANCELLED") return cancelled();
      return [
        "ECOMMERCE_REFERENCE_INPUT_INVALID",
        "ECOMMERCE_REFERENCE_EVIDENCE_INVALID",
        "ECOMMERCE_REFERENCE_ASSET_INVALID",
        "ECOMMERCE_REFERENCE_CURATION_INVALID"
      ].includes(code)
        ? rejected(code)
        : failed(code);
    }
  }

  async #materialize(
    invocation: RuntimeInvocation,
    signal: AbortSignal,
    runCreatedAt: string
  ): Promise<MaterializationOutput> {
    const input = object(invocation.input, "materialization input");
    exact(input, ["packId", "referencePack", "sourceEvidence"]);
    const packId = text(input.packId, 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(packId)) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_INPUT_INVALID");
    }
    const exportId = `export:ecommerce-materialization:${contentDigest({
      runId: invocation.identity.runId,
      idempotencyKey: invocation.idempotencyKey,
      packId
    }).slice(7)}`;
    const replay = this.persistence.getExportRecord(exportId);
    if (replay) {
      if (
        replay.runId !== invocation.identity.runId ||
        replay.exportType !== "evidence_bundle" ||
        replay.status !== "ready"
      ) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_STORAGE_FAILED");
      }
      return this.#materializationOutput(replay.metadata, replay.assetIds);
    }

    const sourceEvidence = object(input.sourceEvidence, "sourceEvidence");
    exact(sourceEvidence, ["douyin", "taobao", "jd"]);
    const references = PLATFORMS.map((platform) => {
      const key = platform.toLowerCase();
      const group = sourceEvidence[key];
      if (!Array.isArray(group) || group.length !== 1) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
      }
      const reference = object(group[0], "source evidence reference");
      exact(
        reference,
        ["evidenceId", "digest", "classification"],
        "ECOMMERCE_REFERENCE_EVIDENCE_INVALID"
      );
      return {
        platform,
        evidenceId: text(reference.evidenceId, 200, "ECOMMERCE_REFERENCE_EVIDENCE_INVALID"),
        digest: text(reference.digest, 80, "ECOMMERCE_REFERENCE_EVIDENCE_INVALID"),
        classification: text(
          reference.classification,
          20,
          "ECOMMERCE_REFERENCE_EVIDENCE_INVALID"
        )
      };
    });
    const probes = new Map<Platform, EvidenceProbe>();
    for (const reference of references) {
      probes.set(
        reference.platform,
        this.#readProbeEvidence(invocation.identity.runId, reference)
      );
    }
    const pack = object(input.referencePack, "referencePack");
    exact(pack, [
      "schemaVersion", "packId", "status", "summary",
      "selectedAssets", "nextRequiredAction"
    ]);
    if (
      pack.schemaVersion !== "reference-asset-pack/v0.4" ||
      pack.packId !== packId ||
      pack.status !== "PROVISIONAL_REMOTE_ASSETS" ||
      !Array.isArray(pack.selectedAssets) ||
      pack.selectedAssets.length < 1
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_INPUT_INVALID");
    }
    if (pack.selectedAssets.length > MAX_ASSETS) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_LIMIT_EXCEEDED");
    }
    const seenDiscoveryIds = new Set<string>();
    const materialized: MaterializedAsset[] = [];
    for (const value of pack.selectedAssets) {
      if (signal.aborted) throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CANCELLED");
      const selected = object(value, "selected asset");
      exact(selected, [
        "discoveryId", "platform", "role", "remoteUrl", "sourcePageUrl",
        "comparisonTier", "downloadStatus", "evidenceLevel", "useBoundary"
      ]);
      const platform = text(selected.platform, 20) as Platform;
      if (!PLATFORMS.includes(platform)) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      const discoveryId = text(selected.discoveryId, 300);
      if (seenDiscoveryIds.has(discoveryId)) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      seenDiscoveryIds.add(discoveryId);
      const observedRemoteUrl = safeUrl(selected.remoteUrl, platform);
      const sourcePageUrl = safePageUrl(selected.sourcePageUrl, platform);
      const probe = probes.get(platform)!;
      const item = probe.items.find((candidate) => {
        const productId = typeof candidate.productId === "string"
          ? candidate.productId
          : "";
        return `${platform}:${productId}` === discoveryId;
      });
      if (
        !item ||
        safePageUrl(probe.pageUrl, platform) !== sourcePageUrl ||
        item.mainImageUrl !== selected.remoteUrl
      ) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
      }
      const fetched = await this.fetcher.fetch(
        { platform, url: observedRemoteUrl },
        signal
      );
      const finalUrl = safeUrl(fetched.finalUrl, platform);
      if (fetched.bytes.byteLength < 1 || fetched.bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_LIMIT_EXCEEDED");
      }
      if (!IMAGE_TYPES.includes(fetched.mediaType)) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      materialized.push(this.#storeImage({
        runId: invocation.identity.runId,
        discoveryId,
        platform,
        sourceEvidenceId: probe.sourceEvidenceId,
        observedRemoteUrl,
        finalUrl,
        sourcePageUrl,
        observedAt: probe.capturedAt,
        bytes: fetched.bytes,
        mediaType: fetched.mediaType
      }));
    }
    const output: MaterializationOutput = {
      schemaVersion: "reference-asset-materialization/v1",
      materializationExportId: exportId,
      packId,
      sourceRunId: invocation.identity.runId,
      status: "materialized_internal_reference",
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only",
      sourceEvidenceDigest: contentDigest(references),
      assetCount: materialized.length,
      assets: materialized as MaterializedAsset[] & JsonValue,
      blockers: [
        "SOURCE_RIGHTS_NOT_ASSESSED",
        "HUMAN_ROLE_CURATION_REQUIRED"
      ] as MaterializationOutput["blockers"]
    };
    this.persistence.putExportRecord({
      exportId,
      runId: invocation.identity.runId,
      exportType: "evidence_bundle",
      status: "ready",
      assetIds: materialized.map((asset) => asset.assetId),
      metadata: json(output),
      createdAt: runCreatedAt
    });
    return output;
  }

  #readProbeEvidence(
    runId: string,
    reference: {
      platform: Platform;
      evidenceId: string;
      digest: string;
      classification: string;
    }
  ): EvidenceProbe {
    const transfer = this.persistence.getEvidenceTransfer(reference.evidenceId);
    if (
      !transfer ||
      transfer.runId !== runId ||
      !["acknowledged", "linked"].includes(transfer.state) ||
      transfer.digest !== reference.digest ||
      runtimeClassification(transfer.classification) !== reference.classification ||
      !transfer.storageRef ||
      transfer.size < 1 ||
      transfer.size > MAX_EVIDENCE_BYTES
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
    }
    const bytes = this.#assets.read(transfer.storageRef);
    if (bytes.byteLength !== transfer.size || digest(bytes) !== transfer.digest) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
    }
    let envelope: JsonObject;
    try {
      envelope = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        "browser evidence"
      );
    } catch {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
    }
    const node = object(envelope.node, "browser evidence node");
    const page = object(envelope.page, "browser evidence page");
    const output = object(envelope.output, "browser evidence output");
    if (
      envelope.schema !== "bpa.browser-evidence/1" ||
      envelope.status !== "succeeded" ||
      node.id !== "ecommerce.marketplace.search-results.read" ||
      node.version !== "1.0.0" ||
      output.schemaVersion !== "marketplace-probe/v0.1" ||
      output.platform !== reference.platform ||
      !Array.isArray(output.items) ||
      output.items.length > 50 ||
      typeof output.pageUrl !== "string" ||
      typeof envelope.captured_at !== "string" ||
      !Number.isFinite(Date.parse(envelope.captured_at)) ||
      typeof page.origin !== "string" ||
      typeof page.pathname !== "string"
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_EVIDENCE_INVALID");
    }
    return {
      platform: reference.platform,
      sourceEvidenceId: reference.evidenceId,
      capturedAt: envelope.captured_at,
      pageUrl: output.pageUrl,
      items: output.items.map((item) => object(item, "probe item"))
    };
  }

  #storeImage(input: {
    runId: string;
    discoveryId: string;
    platform: Platform;
    sourceEvidenceId: string;
    observedRemoteUrl: string;
    finalUrl: string;
    sourcePageUrl: string;
    observedAt: string;
    bytes: Uint8Array;
    mediaType: ImageMediaType;
  }): MaterializedAsset {
    const bodyDigest = digest(input.bytes);
    const issued = this.#assets.issueStagingLease({
      runId: input.runId,
      maxBytes: input.bytes.byteLength
    });
    this.persistence.putStagingLease(issued.lease);
    this.#assets.writeTrustedChunk({
      lease: issued.lease,
      index: 0,
      bytes: input.bytes,
      digest: bodyDigest
    });
    const stored = this.#assets.finalizeTrusted({
      lease: issued.lease,
      chunks: [{ index: 0, digest: bodyDigest, size: input.bytes.byteLength }],
      expectedDigest: bodyDigest,
      expectedSize: input.bytes.byteLength,
      mediaType: input.mediaType
    });
    const existingBlob = this.persistence.getBlob(bodyDigest);
    const blob = existingBlob ?? this.persistence.registerBlob(stored.blob).record;
    if (
      blob.size !== input.bytes.byteLength ||
      blob.mediaType !== input.mediaType ||
      blob.storageRef !== stored.blob.storageRef
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_STORAGE_FAILED");
    }
    const sourceHash = createHash("sha256")
      .update(`${input.observedRemoteUrl}\n${bodyDigest}`)
      .digest("hex");
    const sourceId = `source:ecommerce:${sourceHash}`;
    const assetId = `asset:ecommerce:${sourceHash.slice(0, 24)}:${bodyDigest.slice(7, 39)}`;
    this.persistence.putSourceRecord({
      apiVersion: "bpa.source/v1alpha1",
      kind: "SourceRecord",
      sourceId,
      sourceType: "public_url",
      locator: { url: input.finalUrl },
      observedAt: input.observedAt,
      recordedAt: blob.createdAt,
      accessScope: "public",
      classification: "restricted",
      title: `${input.platform} ${input.discoveryId}`
    });
    this.persistence.putAssetRecord({
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId,
      digest: bodyDigest,
      size: blob.size,
      mediaType: blob.mediaType,
      storageRef: blob.storageRef,
      classification: "restricted",
      sourceIds: [sourceId],
      createdAt: blob.createdAt,
      retention: defaultRetention("restricted", new Date(blob.createdAt))
    });
    this.persistence.transitionStagingLease({
      leaseId: issued.lease.leaseId,
      expectedState: "active",
      nextState: "consumed"
    });
    return {
      discoveryId: input.discoveryId,
      platform: input.platform,
      sourceEvidenceId: input.sourceEvidenceId,
      assetId,
      digest: bodyDigest,
      sizeBytes: blob.size,
      mediaType: input.mediaType,
      observedRemoteUrl: input.observedRemoteUrl,
      sourceUrl: input.finalUrl,
      sourcePageUrl: input.sourcePageUrl,
      role: "UNASSIGNED_REFERENCE_CANDIDATE",
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only"
    };
  }

  #materializationOutput(
    value: JsonValue,
    assetIds: readonly string[]
  ): MaterializationOutput {
    const candidate = object(value, "materialization receipt");
    exact(candidate, [
      "schemaVersion", "materializationExportId", "packId", "sourceRunId",
      "status", "rightsStatus", "allowedUse", "sourceEvidenceDigest",
      "assetCount", "assets", "blockers"
    ]);
    if (
      candidate.schemaVersion !== "reference-asset-materialization/v1" ||
      candidate.status !== "materialized_internal_reference" ||
      candidate.rightsStatus !== "not_assessed" ||
      candidate.allowedUse !== "internal_reference_only" ||
      !Array.isArray(candidate.assets) ||
      candidate.assets.length < 1 ||
      candidate.assets.length > MAX_ASSETS ||
      candidate.assetCount !== candidate.assets.length
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_STORAGE_FAILED");
    }
    const recordedIds = candidate.assets.map((value) =>
      text(object(value, "materialized asset").assetId, 200)
    );
    if (JSON.stringify(recordedIds) !== JSON.stringify(assetIds)) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_STORAGE_FAILED");
    }
    return candidate as MaterializationOutput;
  }

  #publish(invocation: RuntimeInvocation, runCreatedAt: string): JsonObject {
    const input = object(invocation.input, "publish input");
    exact(input, ["materialization", "curation"]);
    const materializationInput = object(
      input.materialization,
      "materialization"
    );
    const materialization = this.#materializationOutput(
      materializationInput,
      Array.isArray(materializationInput.assets)
        ? (materializationInput.assets as JsonValue[])
            .map((value) => text(object(value, "materialized asset").assetId, 200))
        : []
    );
    if (materialization.sourceRunId !== invocation.identity.runId) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CURATION_INVALID");
    }
    const materializationReceipt = this.persistence.getExportRecord(
      materialization.materializationExportId
    );
    if (
      !materializationReceipt ||
      materializationReceipt.runId !== invocation.identity.runId ||
      materializationReceipt.exportType !== "evidence_bundle" ||
      materializationReceipt.status !== "ready" ||
      contentDigest(materializationReceipt.metadata) !== contentDigest(materialization) ||
      JSON.stringify(materializationReceipt.assetIds) !== JSON.stringify(
        (materialization.assets as MaterializedAsset[]).map((asset) => asset.assetId)
      )
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CURATION_INVALID");
    }
    const curation = object(input.curation, "curation");
    exact(
      curation,
      ["packId", "selectedAssets", "rejectedAssetIds"],
      "ECOMMERCE_REFERENCE_CURATION_INVALID"
    );
    if (
      curation.packId !== materialization.packId ||
      !Array.isArray(curation.selectedAssets) ||
      !Array.isArray(curation.rejectedAssetIds) ||
      curation.selectedAssets.length < 1 ||
      curation.selectedAssets.length > MAX_ASSETS ||
      curation.rejectedAssetIds.length > MAX_ASSETS
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CURATION_INVALID");
    }
    const available = new Map(
      (materialization.assets as MaterializedAsset[]).map((asset) => [asset.assetId, asset])
    );
    const rejectedIds = curation.rejectedAssetIds.map((value) =>
      text(value, 200, "ECOMMERCE_REFERENCE_CURATION_INVALID")
    );
    const selectedIds = new Set<string>();
    const roleDimension: Record<string, string> = {
      COMPOSITION_TEMPLATE: "composition",
      PACKAGING_FACT: "packaging_observation",
      PRODUCT_FACT: "product_observation",
      TEXTURE_MATERIAL: "texture_reference"
    };
    const curated = curation.selectedAssets.map((value) => {
      const item = object(value, "curation selected asset");
      exact(
        item,
        [
          "assetId", "role", "reason", "allowedTransferDimensions",
          "prohibitedInferences"
        ],
        "ECOMMERCE_REFERENCE_CURATION_INVALID"
      );
      const assetId = text(item.assetId, 200, "ECOMMERCE_REFERENCE_CURATION_INVALID");
      const role = text(item.role, 40, "ECOMMERCE_REFERENCE_CURATION_INVALID");
      const reason = text(item.reason, 500, "ECOMMERCE_REFERENCE_CURATION_INVALID");
      const dimensions = item.allowedTransferDimensions;
      const prohibited = item.prohibitedInferences;
      const source = available.get(assetId);
      if (
        !source ||
        selectedIds.has(assetId) ||
        !roleDimension[role] ||
        !Array.isArray(dimensions) ||
        dimensions.length < 1 ||
        dimensions.length > 4 ||
        new Set(dimensions).size !== dimensions.length ||
        !dimensions.includes(roleDimension[role]!) ||
        !Array.isArray(prohibited) ||
        prohibited.length < 1 ||
        prohibited.length > 10
      ) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CURATION_INVALID");
      }
      selectedIds.add(assetId);
      return {
        ...source,
        role,
        reason,
        allowedTransferDimensions: dimensions.map((entry) =>
          text(entry, 50, "ECOMMERCE_REFERENCE_CURATION_INVALID")
        ),
        prohibitedInferences: prohibited.map((entry) =>
          text(entry, 300, "ECOMMERCE_REFERENCE_CURATION_INVALID")
        )
      };
    });
    const decided = [...selectedIds, ...rejectedIds];
    if (
      new Set(decided).size !== decided.length ||
      decided.length !== available.size ||
      decided.some((id) => !available.has(id))
    ) {
      throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_CURATION_INVALID");
    }
    for (const assetId of selectedIds) {
      const asset = this.persistence.getAssetRecord(assetId);
      const frozen = available.get(assetId);
      if (
        !asset ||
        !frozen ||
        asset.classification !== "restricted" ||
        asset.digest !== frozen.digest ||
        asset.size !== frozen.sizeBytes ||
        asset.mediaType !== frozen.mediaType ||
        asset.storageRef !== `asset-store:${frozen.digest}`
      ) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      let bytes: Uint8Array;
      try {
        bytes = this.#assets.read(asset.storageRef);
      } catch {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
      if (
        bytes.byteLength !== frozen.sizeBytes ||
        digest(bytes) !== frozen.digest ||
        !matchesImageSignature(frozen.mediaType, bytes)
      ) {
        throw new EcommerceEvidenceRuntimeError("ECOMMERCE_REFERENCE_ASSET_INVALID");
      }
    }
    const exportId = `export:ecommerce-reference:${contentDigest({
      runId: invocation.identity.runId,
      packId: materialization.packId
    }).slice(7)}`;
    const output = {
      schemaVersion: "reference-asset-pack/v1",
      exportId,
      packId: materialization.packId,
      sourceRunId: invocation.identity.runId,
      status: "ready_internal_reference",
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only",
      assetCount: curated.length,
      assets: curated,
      blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
    };
    this.persistence.putExportRecord({
      exportId,
      runId: invocation.identity.runId,
      exportType: "reference_asset_pack",
      status: "ready",
      assetIds: curated.map((asset) => asset.assetId),
      metadata: json(output),
      createdAt: runCreatedAt
    });
    return output;
  }
}
