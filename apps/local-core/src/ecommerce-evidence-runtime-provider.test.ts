import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssetStore } from "@bpa/asset-store-local";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes
} from "@bpa/evidence-core";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { JsonValue } from "@bpa/workflow-ir";
import { describe, expect, it } from "vitest";
import {
  EcommerceEvidenceRuntimeProvider,
  type PublicImageFetcher
} from "./ecommerce-evidence-runtime-provider.js";

const timestamp = "2026-08-09T00:00:00.000Z";
const nodeDigest = `sha256:${"a".repeat(64)}`;
const PLATFORMS_FOR_FIXTURE = ["DOUYIN", "TAOBAO", "JD"] as const;

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function createRun(store: SqlitePersistence, runId: string): void {
  store.createRun({
    run: {
      id: runId,
      workflowId: "ecommerce.cross-platform-evidence-probe",
      workflowVersion: "2.0.0",
      workflowDigest: `sha256:${"b".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      id: `event:${runId}`,
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
  store.openBrowserSession({
    session: {
      id: "session:ecommerce",
      browserInstanceId: "browser:ecommerce",
      extensionId: "extension:ecommerce",
      extensionVersion: "0.6.2",
      protocolVersion: "1.0.0",
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: 0,
      resumeTokenDigest: `sha256:${"c".repeat(64)}`,
      resumeTokenExpiresAt: "2026-08-11T00:00:00.000Z",
      connectedAt: timestamp
    },
    now: timestamp
  });
}

function seedProbeEvidence(input: {
  store: SqlitePersistence;
  dataDirectory: string;
  runId: string;
  platform: "DOUYIN" | "TAOBAO" | "JD";
  productId: string;
  pageUrl: string;
  imageUrl: string;
}): { evidenceId: string; digest: string; classification: "sensitive" } {
  const evidenceId = `evidence:${input.platform.toLowerCase()}`;
  const nodeExecutionId = `probe:${input.platform.toLowerCase()}`;
  const eventSequence = PLATFORMS_FOR_FIXTURE.indexOf(input.platform) + 2;
  const envelope = {
    schema: "bpa.browser-evidence/1",
    captured_at: timestamp,
    node: {
      id: "ecommerce.marketplace.search-results.read",
      version: "1.0.0"
    },
    page: {
      origin: new URL(input.pageUrl).origin,
      pathname: new URL(input.pageUrl).pathname,
      epoch: `epoch:${input.platform.toLowerCase()}`
    },
    status: "succeeded",
    output: {
      schemaVersion: "marketplace-probe/v0.1",
      platform: input.platform,
      query: "煎饼",
      observedAt: timestamp,
      pageUrl: input.pageUrl,
      queryConfirmed: true,
      status: "READY",
      items: [
        {
          productId: input.productId,
          title: `${input.platform} 商品`,
          productUrl: `${new URL(input.pageUrl).origin}/item/${input.productId}`,
          mainImageUrl: input.imageUrl,
          position: 1
        }
      ],
      warnings: []
    }
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const bodyDigest = digestBytes(body);
  const assets = new LocalAssetStore({
    dataDirectory: input.dataDirectory,
    clock: { now: () => new Date(timestamp) },
    idFactory: () => `lease:${input.platform.toLowerCase()}`,
    secretFactory: () => Buffer.alloc(32, 7)
  });
  const lease = assets.issueStagingLease({
    runId: input.runId,
    maxBytes: body.byteLength
  });
  input.store.createNodeExecution(
    {
      id: nodeExecutionId,
      runId: input.runId,
      nodeKey: nodeExecutionId,
      nodeId: "ecommerce.marketplace.search-results.read",
      nodeVersion: "1.0.0",
      status: "dispatched",
      revision: 0,
      attempt: 1,
      idempotencyKey: `idempotency:${nodeExecutionId}`,
      fencingToken: 1,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: `event:${nodeExecutionId}`,
      runId: input.runId,
      nodeExecutionId,
      sequence: eventSequence,
      type: "node.dispatched",
      payload: {},
      occurredAt: timestamp
    }
  );
  input.store.enqueueCommand(
    {
      id: `command:${nodeExecutionId}`,
      nodeExecutionId,
      commandSeq: input.store.nextGatewayCommandSequence(),
      idempotencyKey: `command-idempotency:${nodeExecutionId}`,
      fencingToken: 1,
      state: "queued",
      payload: {
        run_id: input.runId,
        node_execution_id: nodeExecutionId,
        fencing_token: 1
      },
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: `outbox:${nodeExecutionId}`,
      topic: "browser.command",
      aggregateId: `command:${nodeExecutionId}`,
      payload: {},
      createdAt: timestamp
    }
  );
  input.store.putStagingLease(lease.lease);
  input.store.declareEvidence(
    declareEvidence(
      {
        evidenceId,
        runId: input.runId,
        nodeExecutionId,
        sessionId: "session:ecommerce",
        fencingToken: 1,
        kind: "dom_summary",
        mediaType: "application/json",
        size: body.byteLength,
        digest: bodyDigest,
        chunkSize: EVIDENCE_CHUNK_BYTES,
        chunkCount: 1,
        classification: "restricted",
        stagingLeaseId: lease.lease.leaseId
      },
      { now: () => new Date(timestamp) }
    )
  );
  assets.writeTrustedChunk({
    lease: lease.lease,
    index: 0,
    bytes: body,
    digest: bodyDigest
  });
  input.store.commitEvidenceChunk({
    evidenceId,
    chunk: {
      evidenceId,
      index: 0,
      digest: bodyDigest,
      size: body.byteLength,
      receivedAt: timestamp
    }
  });
  const stored = assets.finalizeTrusted({
    lease: lease.lease,
    chunks: [{ index: 0, digest: bodyDigest, size: body.byteLength }],
    expectedDigest: bodyDigest,
    expectedSize: body.byteLength,
    mediaType: "application/json"
  });
  input.store.completeEvidence({ evidenceId, blob: stored.blob });
  input.store.acknowledgeEvidence(evidenceId, timestamp);
  return { evidenceId, digest: bodyDigest, classification: "sensitive" };
}

function invocation(
  runId: string,
  nodeId: string,
  permission: string,
  input: JsonValue
): RuntimeInvocation {
  return {
    invocationId: `invocation:${nodeId}`,
    identity: {
      runId,
      scopePath: [],
      stepKey: nodeId,
      iterationKey: "root",
      attempt: 1
    },
    node: {
      kind: "node",
      id: nodeId,
      version: "1.0.0",
      digest: nodeDigest
    },
    providerId: "ecommerce-evidence",
    input,
    permissionSnapshot: {
      riskLevel: "R1",
      permissions: [permission],
      domains: []
    },
    deadlineAt: Date.parse(timestamp) + 300_000,
    idempotencyKey: `idempotency:${nodeId}`,
    fencingToken: 1,
    traceId: `trace:${nodeId}`
  };
}

function materializationInput(input: {
  store: SqlitePersistence;
  dataDirectory: string;
  runId: string;
}): JsonValue {
  const probes = [
    {
      platform: "DOUYIN" as const,
      productId: "douyin-1",
      pageUrl: "https://www.douyin.com/search/%E7%85%8E%E9%A5%BC?type=product",
      imageUrl: "https://p3.ecombdimg.com/tos-cn-i-001/douyin.webp"
    },
    {
      platform: "TAOBAO" as const,
      productId: "taobao-1",
      pageUrl: "https://s.taobao.com/search?q=%E7%85%8E%E9%A5%BC",
      imageUrl: "https://img.alicdn.com/imgextra/taobao.webp"
    },
    {
      platform: "JD" as const,
      productId: "jd-1",
      pageUrl: "https://search.jd.com/Search?keyword=%E7%85%8E%E9%A5%BC",
      imageUrl: "https://img14.360buyimg.com/n1/jd.webp"
    }
  ];
  const references = Object.fromEntries(
    probes.map((probe) => [
      probe.platform.toLowerCase(),
      [seedProbeEvidence({ ...input, ...probe })]
    ])
  );
  return json({
    packId: "pack:jianbing:v1",
    referencePack: {
      schemaVersion: "reference-asset-pack/v0.4",
      packId: "pack:jianbing:v1",
      status: "PROVISIONAL_REMOTE_ASSETS",
      summary: {
        discoveredProductCount: 3,
        remoteMainImageCount: 3,
        downloadedAssetCount: 0
      },
      selectedAssets: probes.map((probe) => ({
        discoveryId: `${probe.platform}:${probe.productId}`,
        platform: probe.platform,
        role: "REMOTE_MAIN_IMAGE_CANDIDATE",
        remoteUrl: probe.imageUrl,
        sourcePageUrl: probe.pageUrl,
        comparisonTier: "DIRECT_COMPETITOR",
        downloadStatus: "PENDING",
        evidenceLevel: "E1",
        useBoundary: "pending"
      })),
      nextRequiredAction: "materialize"
    },
    sourceEvidence: references
  });
}

describe("ecommerce evidence Runtime Provider", () => {
  it("materializes evidence-bound images once and publishes only curated roles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ecommerce-evidence-"));
    try {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = "run:ecommerce:materialize";
      createRun(store, runId);
      let fetches = 0;
      const fetcher: PublicImageFetcher = {
        async fetch(input) {
          fetches += 1;
          return {
            bytes: Buffer.from([0xff, 0xd8, 0xff, 0xee, fetches]),
            mediaType: "image/jpeg",
            finalUrl: input.url
          };
        }
      };
      const provider = new EcommerceEvidenceRuntimeProvider(
        store,
        directory,
        fetcher
      );
      const materialize = invocation(
        runId,
        "ecommerce.reference-assets.materialize",
        "ecommerce.reference-asset.materialize",
        materializationInput({ store, dataDirectory: directory, runId })
      );
      const first = await provider.invoke(
        materialize,
        new AbortController().signal
      );
      expect(first.status, JSON.stringify(first)).toBe("succeeded");
      expect(first).toMatchObject({
        status: "succeeded",
        output: {
          schemaVersion: "reference-asset-materialization/v1",
          sourceRunId: runId,
          assetCount: 3,
          rightsStatus: "not_assessed",
          allowedUse: "internal_reference_only"
        }
      });
      expect(fetches).toBe(3);
      const replay = await provider.invoke(
        materialize,
        new AbortController().signal
      );
      expect(replay).toEqual(first);
      expect(fetches).toBe(3);

      if (first.status !== "succeeded") throw new Error("fixture changed");
      const materialization = first.output as Record<string, JsonValue>;
      const assets = materialization.assets as Array<Record<string, JsonValue>>;
      const publish = await provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-pack.publish",
          "ecommerce.reference-pack.publish",
          json({
            materialization,
            curation: {
              packId: "pack:jianbing:v1",
              selectedAssets: [
                {
                  assetId: assets[0]!.assetId,
                  role: "COMPOSITION_TEMPLATE",
                  reason: "主体与留白关系清楚",
                  allowedTransferDimensions: ["composition"],
                  prohibitedInferences: ["不得据此推断销量或版权"]
                },
                {
                  assetId: assets[1]!.assetId,
                  role: "PACKAGING_FACT",
                  reason: "包装层级可供事实核对",
                  allowedTransferDimensions: ["packaging_observation"],
                  prohibitedInferences: ["不得复制商标或宣称包装授权"]
                }
              ],
              rejectedAssetIds: [assets[2]!.assetId]
            }
          })
        ),
        new AbortController().signal
      );
      expect(publish).toMatchObject({
        status: "succeeded",
        output: {
          schemaVersion: "reference-asset-pack/v1",
          sourceRunId: runId,
          assetCount: 2,
          status: "ready_internal_reference",
          blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
        }
      });
      if (publish.status !== "succeeded") throw new Error("fixture changed");
      const published = publish.output as Record<string, JsonValue>;
      expect(store.getExportRecord(String(published.exportId))).toMatchObject({
        runId,
        exportType: "reference_asset_pack",
        assetIds: [assets[0]!.assetId, assets[1]!.assetId]
      });
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a remote URL that is not present in immutable Browser Evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ecommerce-mismatch-"));
    try {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = "run:ecommerce:mismatch";
      createRun(store, runId);
      const input = materializationInput({
        store,
        dataDirectory: directory,
        runId
      }) as Record<string, JsonValue>;
      const pack = input.referencePack as Record<string, JsonValue>;
      const selected = pack.selectedAssets as Array<Record<string, JsonValue>>;
      selected[0]!.remoteUrl = "https://p3.ecombdimg.com/tos-cn-i-001/changed.webp";
      let fetches = 0;
      const provider = new EcommerceEvidenceRuntimeProvider(store, directory, {
        async fetch(value) {
          fetches += 1;
          return {
            bytes: Buffer.from([0xff, 0xd8, 0xff, 0xee]),
            mediaType: "image/jpeg",
            finalUrl: value.url
          };
        }
      });
      await expect(provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-assets.materialize",
          "ecommerce.reference-asset.materialize",
          input
        ),
        new AbortController().signal
      )).resolves.toMatchObject({
        status: "rejected",
        error: { code: "ECOMMERCE_REFERENCE_EVIDENCE_INVALID" }
      });
      expect(fetches).toBe(0);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a curated pack whose materialization no longer matches the same-Run Export receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ecommerce-forged-receipt-"));
    try {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = "run:ecommerce:forged-receipt";
      createRun(store, runId);
      const provider = new EcommerceEvidenceRuntimeProvider(store, directory, {
        async fetch(input) {
          return {
            bytes: Buffer.from([0xff, 0xd8, 0xff, 0xee]),
            mediaType: "image/jpeg",
            finalUrl: input.url
          };
        }
      });
      const materialized = await provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-assets.materialize",
          "ecommerce.reference-asset.materialize",
          materializationInput({ store, dataDirectory: directory, runId })
        ),
        new AbortController().signal
      );
      if (materialized.status !== "succeeded") {
        throw new Error("Materialization fixture changed");
      }
      const forged = json(materialized.output) as Record<string, JsonValue>;
      forged.sourceEvidenceDigest = `sha256:${"f".repeat(64)}`;
      const assets = forged.assets as Array<Record<string, JsonValue>>;
      const result = await provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-pack.publish",
          "ecommerce.reference-pack.publish",
          json({
            materialization: forged,
            curation: {
              packId: "pack:jianbing:v1",
              selectedAssets: [{
                assetId: assets[0]!.assetId,
                role: "COMPOSITION_TEMPLATE",
                reason: "构图关系清楚",
                allowedTransferDimensions: ["composition"],
                prohibitedInferences: ["不得推断版权或销量"]
              }],
              rejectedAssetIds: assets.slice(1).map((asset) => asset.assetId)
            }
          })
        ),
        new AbortController().signal
      );
      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "ECOMMERCE_REFERENCE_CURATION_INVALID" }
      });
      expect(
        store.listExportRecordsForRun({ runId, limit: 10 }).records
          .filter((record) => record.exportType === "reference_asset_pack")
      ).toEqual([]);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects publication when a selected materialized asset is missing from CAS", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ecommerce-missing-cas-"));
    try {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = "run:ecommerce:missing-cas";
      createRun(store, runId);
      const provider = new EcommerceEvidenceRuntimeProvider(store, directory, {
        async fetch(input) {
          return {
            bytes: Buffer.from([0xff, 0xd8, 0xff, 0xee]),
            mediaType: "image/jpeg",
            finalUrl: input.url
          };
        }
      });
      const materialized = await provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-assets.materialize",
          "ecommerce.reference-asset.materialize",
          materializationInput({ store, dataDirectory: directory, runId })
        ),
        new AbortController().signal
      );
      if (materialized.status !== "succeeded") {
        throw new Error("Materialization fixture changed");
      }
      const materialization = materialized.output as Record<string, JsonValue>;
      const assets = materialization.assets as Array<Record<string, JsonValue>>;
      const selectedAssetId = String(assets[0]!.assetId);
      const selectedAsset = store.getAssetRecord(selectedAssetId);
      if (!selectedAsset) throw new Error("Materialized asset fixture changed");
      const digest = selectedAsset.storageRef.slice("asset-store:sha256:".length);
      rmSync(join(directory, "assets", "sha256", digest.slice(0, 2), digest));

      const result = await provider.invoke(
        invocation(
          runId,
          "ecommerce.reference-pack.publish",
          "ecommerce.reference-pack.publish",
          json({
            materialization,
            curation: {
              packId: "pack:jianbing:v1",
              selectedAssets: [{
                assetId: selectedAssetId,
                role: "COMPOSITION_TEMPLATE",
                reason: "构图关系清楚",
                allowedTransferDimensions: ["composition"],
                prohibitedInferences: ["不得推断版权或销量"]
              }],
              rejectedAssetIds: assets.slice(1).map((asset) => asset.assetId)
            }
          })
        ),
        new AbortController().signal
      );

      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "ECOMMERCE_REFERENCE_ASSET_INVALID" }
      });
      expect(
        store.listExportRecordsForRun({ runId, limit: 10 }).records
          .filter((record) => record.exportType === "reference_asset_pack")
      ).toEqual([]);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
