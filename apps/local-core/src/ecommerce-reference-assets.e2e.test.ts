import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssetStore } from "@bpa/asset-store-local";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes
} from "@bpa/evidence-core";
import {
  RuntimeProviderRegistry,
  type RuntimeInvocation,
  type RuntimeOutcome,
  type RuntimeProvider
} from "@bpa/node-runtime";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  TeamHandlerError,
  type TeamHandlerDefinition
} from "@bpa/team-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { teamHandlerRegistry } from "../../team-worker/src/handlers.js";
import {
  UdsControlBackend,
  type ConsoleControlRequester
} from "../../console-host/src/control-backend.js";
import { LocalCoreService } from "./control.js";
import {
  EcommerceEvidenceRuntimeProvider,
  type PublicImageFetcher
} from "./ecommerce-evidence-runtime-provider.js";

const root = new URL("../../../", import.meta.url);
const browserInstanceId = "ecommerce-research-browser";

function source(path: string): unknown {
  return parse(readFileSync(new URL(path, root), "utf8"));
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

class TeamFixtureProvider implements RuntimeProvider {
  readonly id = "team";

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return teamHandlerRegistry.has(node);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    try {
      const handler: TeamHandlerDefinition = teamHandlerRegistry.get(
        invocation.node
      );
      return {
        status: "succeeded",
        output: json(await handler.invoke(invocation.input, signal)),
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: error instanceof TeamHandlerError
            ? error.code
            : "TEAM_HANDLER_FAILED",
          message: "Fixture Team operation failed.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
  }
}

const marketplaceFixtures = {
  DOUYIN: {
    productId: "douyin-1",
    pageUrl: "https://www.douyin.com/search/%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC?type=product",
    productUrl: "https://www.douyin.com/product/1",
    imageUrl: "https://p3.ecombdimg.com/tos-cn-i-001/douyin.webp"
  },
  TAOBAO: {
    productId: "taobao-1",
    pageUrl: "https://s.taobao.com/search?q=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
    productUrl: "https://item.taobao.com/item.htm?id=2",
    imageUrl: "https://img.alicdn.com/imgextra/taobao.webp"
  },
  JD: {
    productId: "jd-1",
    pageUrl: "https://search.jd.com/Search?keyword=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
    productUrl: "https://item.jd.com/3.html",
    imageUrl: "https://img14.360buyimg.com/n1/jd.webp"
  }
} as const;

class BrowserEvidenceFixtureProvider implements RuntimeProvider {
  readonly id = "browser";
  readonly #assets: LocalAssetStore;

  constructor(
    readonly persistence: SqlitePersistence,
    dataDirectory: string
  ) {
    this.#assets = new LocalAssetStore({ dataDirectory });
  }

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return node.id === "ecommerce.marketplace.search-results.read" &&
      node.version === "1.0.0";
  }

  async invoke(invocation: RuntimeInvocation): Promise<RuntimeOutcome> {
    const input = invocation.input as Record<string, JsonValue>;
    const platform = String(input.platform) as keyof typeof marketplaceFixtures;
    const fixture = marketplaceFixtures[platform];
    if (!fixture) {
      return {
        status: "rejected",
        error: {
          code: "PAGE_MISMATCH",
          message: "Fixture marketplace is unavailable.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    const capturedAt = new Date().toISOString();
    const output = {
      schemaVersion: "marketplace-probe/v0.1",
      platform,
      query: String(input.query),
      observedAt: capturedAt,
      pageUrl: fixture.pageUrl,
      queryConfirmed: true,
      status: "READY",
      items: [
        {
          productId: fixture.productId,
          title: `${platform} 杂粮软煎饼独立包装开袋即食`,
          productUrl: fixture.productUrl,
          mainImageUrl: fixture.imageUrl,
          priceText: "¥19.90",
          position: 1
        }
      ],
      warnings: []
    };
    const envelope = {
      schema: "bpa.browser-evidence/1",
      captured_at: capturedAt,
      node: {
        id: "ecommerce.marketplace.search-results.read",
        version: "1.0.0"
      },
      page: {
        origin: new URL(fixture.pageUrl).origin,
        pathname: new URL(fixture.pageUrl).pathname,
        epoch: `epoch:${platform.toLowerCase()}`
      },
      status: "succeeded",
      output
    };
    const body = Buffer.from(JSON.stringify(envelope));
    const bodyDigest = digestBytes(body);
    const nodeExecutionId = `evidence:${invocation.invocationId}`;
    const eventSequence = this.persistence.listEvents(
      invocation.identity.runId
    ).length + 1;
    this.persistence.createNodeExecution(
      {
        id: nodeExecutionId,
        runId: invocation.identity.runId,
        nodeKey: invocation.identity.stepKey,
        nodeId: invocation.node.id,
        nodeVersion: invocation.node.version,
        status: "dispatched",
        revision: 0,
        attempt: invocation.identity.attempt,
        idempotencyKey: invocation.idempotencyKey,
        fencingToken: invocation.fencingToken,
        input: invocation.input,
        createdAt: capturedAt,
        updatedAt: capturedAt
      },
      {
        id: `event:${nodeExecutionId}`,
        runId: invocation.identity.runId,
        nodeExecutionId,
        sequence: eventSequence,
        type: "node.dispatched",
        payload: {},
        occurredAt: capturedAt
      }
    );
    this.persistence.enqueueCommand(
      {
        id: `command:${invocation.invocationId}`,
        nodeExecutionId,
        commandSeq: this.persistence.nextGatewayCommandSequence(),
        idempotencyKey: `command:${invocation.idempotencyKey}`,
        fencingToken: invocation.fencingToken,
        state: "queued",
        payload: {
          run_id: invocation.identity.runId,
          node_execution_id: nodeExecutionId,
          fencing_token: invocation.fencingToken
        },
        createdAt: capturedAt,
        updatedAt: capturedAt
      },
      {
        id: `outbox:${invocation.invocationId}`,
        topic: "browser.command",
        aggregateId: `command:${invocation.invocationId}`,
        payload: {},
        createdAt: capturedAt
      }
    );
    const issued = this.#assets.issueStagingLease({
      runId: invocation.identity.runId,
      maxBytes: body.byteLength
    });
    this.persistence.putStagingLease(issued.lease);
    const evidenceId = `evidence:${platform.toLowerCase()}:${invocation.invocationId}`;
    this.persistence.declareEvidence(
      declareEvidence(
        {
          evidenceId,
          runId: invocation.identity.runId,
          nodeExecutionId,
          sessionId: "session:ecommerce-e2e",
          fencingToken: invocation.fencingToken,
          kind: "dom_summary",
          mediaType: "application/json",
          size: body.byteLength,
          digest: bodyDigest,
          chunkSize: EVIDENCE_CHUNK_BYTES,
          chunkCount: 1,
          classification: "restricted",
          stagingLeaseId: issued.lease.leaseId
        },
        { now: () => new Date(capturedAt) }
      )
    );
    this.#assets.writeTrustedChunk({
      lease: issued.lease,
      index: 0,
      bytes: body,
      digest: bodyDigest
    });
    this.persistence.commitEvidenceChunk({
      evidenceId,
      chunk: {
        evidenceId,
        index: 0,
        digest: bodyDigest,
        size: body.byteLength,
        receivedAt: capturedAt
      }
    });
    const stored = this.#assets.finalizeTrusted({
      lease: issued.lease,
      chunks: [{ index: 0, digest: bodyDigest, size: body.byteLength }],
      expectedDigest: bodyDigest,
      expectedSize: body.byteLength,
      mediaType: "application/json"
    });
    this.persistence.completeEvidence({ evidenceId, blob: stored.blob });
    this.persistence.acknowledgeEvidence(evidenceId, capturedAt);
    return {
      status: "succeeded",
      output: json(output),
      evidence: [{ evidenceId, digest: bodyDigest, classification: "sensitive" }],
      riskSignals: []
    };
  }
}

function publish(
  service: LocalCoreService,
  assetType: string,
  path: string
): void {
  const response = service.handle({
    id: `publish:${path}`,
    method: "asset.publish",
    params: { assetType, content: source(path), actor: "test" }
  });
  if (!response.ok) {
    throw new Error(`${path}: ${JSON.stringify(response.error)}`);
  }
}

function seedBrowser(persistence: SqlitePersistence): void {
  const now = new Date().toISOString();
  persistence.openBrowserSession({
    session: {
      id: "session:ecommerce-e2e",
      browserInstanceId,
      extensionId: "extension:ecommerce-e2e",
      extensionVersion: "0.6.2",
      protocolVersion: "2.0.0",
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: 0,
      capabilityDigest: `sha256:${"a".repeat(64)}`,
      resumeTokenDigest: `sha256:${"b".repeat(64)}`,
      resumeTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      connectedAt: now
    },
    now
  });
  persistence.replaceBrowserCapabilities("session:ecommerce-e2e", [
    {
      nodeId: "ecommerce.marketplace.search-results.read",
      nodeVersion: "1.0.0",
      riskLevel: "R1",
      permissions: ["browser.dom.read", "browser.tabs.read"],
      routes: Object.values(marketplaceFixtures).map((fixture) => ({
        origin: new URL(fixture.pageUrl).origin,
        pathnamePrefixes: [new URL(fixture.pageUrl).pathname],
        observerCapabilityId: "marketplace.search"
      })),
      adapterId: "marketplace-search",
      adapterVersion: "1.0.0"
    }
  ]);
  Object.values(marketplaceFixtures).forEach((fixture, index) => {
    const url = new URL(fixture.pageUrl);
    persistence.upsertBrowserPageObservation({
      sessionId: "session:ecommerce-e2e",
      browserInstanceId,
      tabId: index + 1,
      windowId: 1,
      origin: url.origin,
      pathname: url.pathname,
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth:ecommerce-e2e",
      observationState: "ready",
      pageEpoch: `tab-${index + 1}:1:ecommerce`,
      observerCapabilityId: "marketplace.search",
      revision: 1,
      observedAt: now
    });
  });
}

describe("cross-platform reference asset Workflow", () => {
  it("binds immutable Browser Evidence, waits for human curation, and publishes an internal Export", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ecommerce-reference-e2e-"));
    try {
      const persistence = new SqlitePersistence({ path: ":memory:" });
      const providers = new RuntimeProviderRegistry();
      providers.register(new TeamFixtureProvider());
      providers.register(new BrowserEvidenceFixtureProvider(persistence, directory));
      let fetchCount = 0;
      const fetcher: PublicImageFetcher = {
        async fetch(input) {
          fetchCount += 1;
          return {
            bytes: Buffer.from([0xff, 0xd8, 0xff, 0xee, fetchCount]),
            mediaType: "image/jpeg",
            finalUrl: input.url
          };
        }
      };
      providers.register(
        new EcommerceEvidenceRuntimeProvider(persistence, directory, fetcher)
      );
      const service = new LocalCoreService(persistence, undefined, providers);
      for (const path of [
        "nodes/core/ecommerce.intent.normalize.node.yaml",
        "nodes/core/ecommerce.marketplace.search-results.read.node.yaml",
        "nodes/core/ecommerce.discovery.merge.node.yaml",
        "nodes/core/ecommerce.discovery.category-space.build.node.yaml",
        "nodes/core/ecommerce.discovery.comparable-pool.build.node.yaml",
        "nodes/core/ecommerce.discovery.evidence.evaluate.node.yaml",
        "nodes/core/ecommerce.discovery.reference-pack.build.node.yaml",
        "nodes/core/ecommerce.reference-assets.materialize.node.yaml",
        "nodes/core/ecommerce.reference-pack.publish.node.yaml"
      ]) {
        publish(service, "node", path);
      }
      publish(
        service,
        "adapter",
        "adapters/marketplace/marketplace-search.adapter.yaml"
      );
      publish(
        service,
        "assistance_profile",
        "assistance-profiles/core/reference_asset_curation.assistance-profile.yaml"
      );
      publish(
        service,
        "workflow",
        "workflows/examples/ecommerce.cross-platform-evidence-probe.workflow.yaml"
      );
      seedBrowser(persistence);
      const triggerId = "ecommerce-reference-assets-e2e";
      expect(service.handle({
        id: "trigger:put",
        method: "trigger.put",
        params: {
          actor: "test",
          spec: {
            apiVersion: "bpa.trigger/v1alpha2",
            id: triggerId,
            version: "1.0.0",
            appId: "ecommerce-evidence",
            kind: "manual",
            workflow: {
              id: "ecommerce.cross-platform-evidence-probe",
              version: "2.0.0"
            },
            enabled: true,
            inputSchemaVersion: "ecommerce-reference-assets/2",
            input: {
              intent: {
                intentId: "intent-jianbing-e2e",
                platform: "抖音电商、淘宝、京东",
                seedQuery: "预包装煎饼",
                researchGoal: "形成证据绑定的内部参考图片包",
                workingBoundary: {
                  productForm: "独立预包装、开袋即食煎饼",
                  targetPeople: ["早餐人群"],
                  usageScenes: ["早餐"],
                  confidence: "MEDIUM"
                }
              },
              poolId: "pool:jianbing:e2e",
              packId: "pack:jianbing:e2e",
              observedAt: new Date().toISOString(),
              comparisonRules: {
                coreTerms: ["煎饼"],
                packagingTerms: ["独立包装", "开袋即食"],
                excludeTerms: []
              },
              exclusionRules: [],
              maxItems: 5
            },
            concurrencyKey: "ecommerce-research",
            browserInstanceId,
            idempotencyPolicy: "request_key",
            retryPolicy: "none"
          }
        }
      })).toMatchObject({ ok: true });
      const fired = service.handle({
        id: "trigger:fire",
        method: "trigger.fire",
        params: { id: triggerId, requestKey: "e2e" }
      });
      expect(fired).toMatchObject({ ok: true });
      const attempt = (fired.result as {
        attempt?: { workflowRunId?: string };
      }).attempt;
      const runId = String(attempt?.workflowRunId);
      expect(runId).not.toBe("undefined");

      for (let turn = 0; turn < 50; turn += 1) {
        await service.ir2Runtime.drainOnce();
        if (persistence.getRun(runId)?.status === "waiting_assistance") break;
      }
      let consoleSequence = 0;
      const requester: ConsoleControlRequester = {
        async request<TResult>(
          method: string,
          params: Record<string, unknown> = {}
        ): Promise<TResult> {
          consoleSequence += 1;
          const response = await service.handleAsync({
            id: `console:ecommerce-e2e:${consoleSequence}`,
            method,
            params
          });
          if (!response.ok) {
            throw new Error(
              `${response.error?.code ?? "CORE_ERROR"}: ` +
              `${response.error?.message ?? "Control request failed"}`
            );
          }
          return response.result as TResult;
        }
      };
      const consoleBackend = new UdsControlBackend(requester, {
        actorId: "human:ecommerce-e2e",
        operationId: () => `console-operation-${++consoleSequence}`,
        now: () => new Date(),
        leaseDurationMs: 60_000,
        assetReader: new LocalAssetStore({ dataDirectory: directory })
      });
      const curationTask = (await consoleBackend.listTasks())[0];
      if (!curationTask?.referenceCuration) {
        throw new Error("Curation task was not projected to Console");
      }
      const assets = curationTask.referenceCuration.assets;
      expect(assets).toHaveLength(3);
      await expect(
        consoleBackend.getDownloadAsset(
          curationTask.referenceCuration.materializationExportId,
          assets[0]!.assetId
        )
      ).resolves.toMatchObject({ mediaType: "image/jpeg" });
      await consoleBackend.submitTask(curationTask.id, {
        decision: "publish_selection",
        referenceCuration: {
          selectedAssets: [{
            assetId: assets[0]!.assetId,
            role: "COMPOSITION_TEMPLATE",
            reason: "主体与留白关系清楚",
            prohibitedInferences: ["不得推断销量、版权或产品真实性"]
          }]
        }
      });
      for (let turn = 0; turn < 30; turn += 1) {
        await service.ir2Runtime.drainOnce();
        if (persistence.getRun(runId)?.status === "succeeded") break;
      }
      const run = persistence.getRun(runId);
      expect(run).toMatchObject({
        status: "succeeded",
        output: {
          status: "ready_internal_reference",
          materialization: {
            sourceRunId: runId,
            assetCount: 3,
            rightsStatus: "not_assessed"
          },
          publishedReferencePack: {
            sourceRunId: runId,
            assetCount: 1,
            allowedUse: "internal_reference_only",
            blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
          }
        }
      });
      expect(fetchCount).toBe(3);
      const output = run?.output as Record<string, JsonValue>;
      const published = output.publishedReferencePack as Record<string, JsonValue>;
      expect(persistence.getExportRecord(String(published.exportId))).toMatchObject({
        runId,
        exportType: "reference_asset_pack",
        assetIds: [assets[0]!.assetId]
      });
      persistence.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
