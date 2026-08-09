import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import {
  DEFAULT_BPA_EXTENSION_ID,
  exportPublicKeySpkiBase64,
  verifyPermissionGrant,
  type CoreSigningKey,
  type SignedPermissionGrant
} from "@bpa/gateway-core";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  LocalBrowserGateway,
  observationCoversFrozenRevision
} from "./browser-gateway.js";
import { BrowserEvidenceReceiver } from "./browser-evidence.js";
import { LocalCoreService } from "./control.js";

function fixture(path: string): unknown {
  return parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );
}

const extensionResourceUsage = {
  active_commands: 1,
  active_tab_commands: 1,
  active_alliance_stages: 0,
  cancellation_requests: 0,
  cancellation_stop_barriers: 0,
  observed_tabs: 2,
  observation_capacity: 64,
  managed_tabs: 0,
  managed_tab_reservations: 0,
  managed_tab_capacity: 8,
  pacing_reservations: { active: 1, capacity: 64, ttl_ms: 120_000 },
  probes: { active: 1, capacity: 32, ttl_ms: 30_000 }
};

describe("local browser gateway", () => {
  it("accepts monotonic observation heartbeats for the same frozen page",() => {
    expect(observationCoversFrozenRevision(1,1)).toBe(true);
    expect(observationCoversFrozenRevision(2,1)).toBe(true);
    expect(observationCoversFrozenRevision(1,2)).toBe(false);
  });

  it("rejects a Bridge build that does not match the installed Runtime", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      {
        keyId: "core-build-key",
        privateKey,
        publicKey,
        publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
      },
      undefined,
      undefined,
      "v0.6.0-rc.expected.node24.18.0"
    );
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      () => undefined
    );
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "hello-wrong-build",
      session_id: "new",
      seq: 0,
      sent_at: new Date().toISOString(),
      type: "session.hello",
      trace_id: "trace-wrong-build",
      payload: {
        browser_instance_id: "browser-wrong-build",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.6.0",
        bridge_build_id: "v0.6.0-rc.old.node24.18.0",
        supported_protocols: ["bpa.browser/2"],
        features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
        last_acked_command_seq: 0
      }
    });
    expect(gateway.status()).toMatchObject({
      ready: false,
      lastError: "BROWSER_BRIDGE_BUILD_MISMATCH"
    });
    persistence.close();
  });

  it("rejects an old Bridge without exact page observation features", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      {
        keyId: "core-feature-key",
        privateKey,
        publicKey,
        publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
      }
    );
    const outgoing: Array<Record<string, any>> = [];
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "hello-old-bridge",
      session_id: "new",
      seq: 0,
      sent_at: new Date().toISOString(),
      type: "session.hello",
      trace_id: "trace-old-bridge",
      payload: {
        browser_instance_id: "browser-old",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.5.0",
        bridge_build_id: "v0.5.0-test.node24.18.0",
        supported_protocols: ["bpa.browser/2"],
        last_acked_command_seq: 0
      }
    });
    expect(gateway.status()).toMatchObject({
      connected: true,
      ready: false,
      lastError: "BROWSER_BRIDGE_FEATURE_MISMATCH"
    });
    expect(outgoing).toEqual([]);
    persistence.close();
  });

  it("polls and validates bounded Extension resource usage", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      {
        keyId: "core-heartbeat-key",
        privateKey,
        publicKey,
        publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
      }
    );
    const outgoing: Array<Record<string, any>> = [];
    const connectionId = gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "hello-heartbeat",
        session_id: "new",
        seq: 0,
        sent_at: "2026-08-10T00:00:00.000Z",
        type: "session.hello",
        trace_id: "trace-heartbeat-test",
        payload: {
          browser_instance_id: "browser-heartbeat",
          extension_id: DEFAULT_BPA_EXTENSION_ID,
          extension_version: "0.6.2",
          bridge_build_id: "v0.6.0-test.node24.18.0",
          supported_protocols: ["bpa.browser/2"],
          features: [
            "page_observation_v2",
            "exact_tab_binding_v2",
            "active_page_probe_v1"
          ],
          last_acked_command_seq: 0
        }
      },
      connectionId
    );
    const sessionId = String(outgoing.at(-1)!.session_id);
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "capability-heartbeat",
        session_id: sessionId,
        seq: 1,
        sent_at: "2026-08-10T00:00:01.000Z",
        type: "capability.report",
        trace_id: "trace-heartbeat-test",
        payload: {
          capabilities: [],
          features: [
            "page_observation_v2",
            "exact_tab_binding_v2",
            "active_page_probe_v1"
          ],
          manifest_digest: `sha256:${"a".repeat(64)}`
        }
      },
      connectionId
    );
    expect(gateway.status().resourceUsage.extension).toBeNull();

    gateway.tick(new Date("2026-08-10T00:00:20.000Z"));
    const heartbeat = outgoing.findLast(
      (message) => message.type === "heartbeat.ping"
    )!;
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "heartbeat-resource-usage",
        session_id: sessionId,
        seq: 2,
        sent_at: "2026-08-10T00:00:20.100Z",
        type: "heartbeat.pong",
        trace_id: "trace-heartbeat-test",
        payload: {
          nonce: heartbeat.payload.nonce,
          resource_usage: extensionResourceUsage
        }
      },
      connectionId
    );
    expect(gateway.status().resourceUsage.extension).toMatchObject({
      activeCommands: 1,
      observedTabs: 2,
      pacingReservations: { active: 1, capacity: 64, ttlMs: 120_000 },
      probes: { active: 1, capacity: 32, ttlMs: 30_000 }
    });

    gateway.tick(new Date("2026-08-10T00:00:40.000Z"));
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "heartbeat-stale-nonce",
        session_id: sessionId,
        seq: 3,
        sent_at: "2026-08-10T00:00:40.100Z",
        type: "heartbeat.pong",
        trace_id: "trace-heartbeat-test",
        payload: {
          nonce: heartbeat.payload.nonce,
          resource_usage: extensionResourceUsage
        }
      },
      connectionId
    );
    expect(gateway.status().lastError).toBe(
      "BROWSER_HEARTBEAT_NONCE_INVALID"
    );

    gateway.tick(new Date("2026-08-10T00:01:00.000Z"));
    expect(gateway.status()).toMatchObject({
      resourceUsage: { extension: null },
      lastError: "BROWSER_HEARTBEAT_TIMEOUT"
    });
    const recoveryHeartbeat = outgoing.findLast(
      (message) => message.type === "heartbeat.ping"
    )!;
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "heartbeat-resource-usage-recovered",
        session_id: sessionId,
        seq: 4,
        sent_at: "2026-08-10T00:01:00.100Z",
        type: "heartbeat.pong",
        trace_id: "trace-heartbeat-test",
        payload: {
          nonce: recoveryHeartbeat.payload.nonce,
          resource_usage: extensionResourceUsage
        }
      },
      connectionId
    );
    expect(gateway.status()).toMatchObject({
      resourceUsage: {
        extension: { activeCommands: 1, observedTabs: 2 }
      }
    });
    expect(gateway.status().lastError).toBeUndefined();

    gateway.tick(new Date("2026-08-10T00:01:20.000Z"));
    const invariantHeartbeat = outgoing.findLast(
      (message) => message.type === "heartbeat.ping"
    )!;
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "heartbeat-managed-tab-invariant",
        session_id: sessionId,
        seq: 5,
        sent_at: "2026-08-10T00:01:20.100Z",
        type: "heartbeat.pong",
        trace_id: "trace-heartbeat-test",
        payload: {
          nonce: invariantHeartbeat.payload.nonce,
          resource_usage: {
            ...extensionResourceUsage,
            managed_tabs: 8,
            managed_tab_reservations: 1
          }
        }
      },
      connectionId
    );
    expect(gateway.status()).toMatchObject({
      resourceUsage: { extension: null },
      lastError: "BROWSER_EXTENSION_RESOURCE_USAGE_INVALID"
    });
    persistence.close();
  });

  it("persists per-tab observations and invalidates them on disconnect", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      {
        keyId: "core-observation-key",
        privateKey,
        publicKey,
        publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
      }
    );
    const outgoing: Array<Record<string, any>> = [];
    const connectionId = gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle(
      {
      protocol: "bpa.browser/2",
      version: "2.0.0",
        message_id: "hello-observation",
        session_id: "new",
        seq: 0,
        sent_at: new Date().toISOString(),
        type: "session.hello",
        trace_id: "trace-observation",
        payload: {
          browser_instance_id: "browser-observation",
          extension_id: DEFAULT_BPA_EXTENSION_ID,
          extension_version: "0.6.0",
          bridge_build_id: "v0.6.0-test.node24.18.0",
          supported_protocols: ["bpa.browser/2"],
          features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
          last_acked_command_seq: 0
        }
      },
      connectionId
    );
    const sessionId = String(outgoing.at(-1)!.session_id);
    gateway.handle(
      {
      protocol: "bpa.browser/2",
      version: "2.0.0",
        message_id: "capability-observation",
        session_id: sessionId,
        seq: 1,
        sent_at: new Date().toISOString(),
        type: "capability.report",
        trace_id: "trace-observation",
        payload: {
          capabilities: [],
          features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
          manifest_digest: `sha256:${"a".repeat(64)}`
        }
      },
      connectionId
    );
    gateway.handle(
      {
      protocol: "bpa.browser/2",
      version: "2.0.0",
        message_id: "page-observation",
        session_id: sessionId,
        seq: 2,
        sent_at: new Date().toISOString(),
        type: "page.observation",
        trace_id: "trace-observation",
        payload: {
          tab_ref: {
            browser_instance_id: "browser-observation",
            tab_id: 42,
            window_id: 7,
            origin: "https://fxg.jinritemai.com"
          },
          pathname: "/ffa/g/list",
          content_script_ready: true,
          authentication: {
            state: "authenticated",
            context_ref: "auth-context-shop-1"
          },
          observation_state: "ready",
          page_epoch: "tab-42:1:test",
          observation_revision: 1,
          observer_capability_id: "doudian.page",
          observed_at: new Date().toISOString(),
        }
      },
      connectionId
    );
    expect(
      persistence.getBrowserPageObservation(sessionId, 42)
    ).toMatchObject({
      observationState: "ready",
      authentication: "authenticated",
      authenticationContextRef: "auth-context-shop-1"
    });
    const probe = gateway.requestPageProbe({
      sessionId,
      browserInstanceId: "browser-observation",
      tabId: 42,
      windowId: 7,
      origin: "https://fxg.jinritemai.com"
    });
    expect(gateway.status().resourceUsage.pageProbes.active).toBe(1);
    expect(() =>
      gateway.requestPageProbe({
        sessionId,
        browserInstanceId: "browser-observation",
        tabId: 42,
        windowId: 7,
        origin: "https://fxg.jinritemai.com"
      })
    ).toThrow("PAGE_PROBE_THROTTLED");
    gateway.handle(
      {
        protocol: "bpa.browser/2",
        version: "2.0.0",
        message_id: "page-probe-result",
        session_id: sessionId,
        seq: 3,
        sent_at: new Date().toISOString(),
        type: "page.probe.result",
        trace_id: "trace-page-probe",
        payload: {
          request_id: probe.requestId,
          tab_ref: {
            browser_instance_id: "browser-observation",
            tab_id: 42,
            window_id: 7,
            origin: "https://fxg.jinritemai.com"
          },
          accepted: true,
          observation_revision: 1
        }
      },
      connectionId
    );
    expect(gateway.status().resourceUsage.pageProbes.active).toBe(0);
    gateway.detach(connectionId);
    expect(
      persistence.getBrowserPageObservation(sessionId, 42)
    ).toMatchObject({
      observationState: "stale",
      reasonCode: "BROWSER_BRIDGE_DISCONNECTED"
    });
    persistence.close();
  });

  it("completes a signed, idempotent browser workflow", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const dataDirectory = mkdtempSync(join(tmpdir(), "bpa-browser-evidence-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signingKey: CoreSigningKey = {
      keyId: "core-test-key",
      privateKey,
      publicKey,
      publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
    };
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      signingKey,
      undefined,
      new BrowserEvidenceReceiver(persistence, dataDirectory)
    );
    const service = new LocalCoreService(persistence, gateway);
    for (const path of [
      "nodes/core/control.start.node.yaml",
      "nodes/core/control.succeed.node.yaml",
      "nodes/core/doudian.shop.context.read@1.3.0.node.yaml"
    ]) {
      const content = fixture(path) as Record<string, any>;
      if (path.includes("doudian.shop.context.read")) {
        content.execution.timingPolicy.dispatchJitter = {
          minMs: 0,
          maxMs: 0,
          distribution: "uniform"
        };
      }
      expect(
        service.handle({
          id: path,
          method: "asset.publish",
          params: { assetType: "node", content, actor: "test" }
        }).ok
      ).toBe(true);
    }
    const adapter = fixture(
      "adapters/doudian/doudian.adapter.yaml"
    ) as Record<string, any>;
    adapter.capabilities = adapter.capabilities.filter(
      (capability: Record<string, unknown>) =>
        capability.nodeId === "doudian.shop.context.read"
    );
    const adapterPublish = service.handle({
        id: "adapter",
        method: "asset.publish",
        params: {
          assetType: "adapter",
          content: adapter,
          actor: "test"
        }
      });
    expect(adapterPublish, JSON.stringify(adapterPublish)).toMatchObject({
      ok: true
    });
    const workflowPublish = service.handle({
      id: "workflow",
      method: "asset.publish",
      params: {
        assetType: "workflow",
        content: fixture(
          "workflows/examples/doudian.shop-context-observe.workflow.yaml"
        ),
        actor: "test"
      }
    });
    expect(workflowPublish, JSON.stringify(workflowPublish)).toMatchObject({
      ok: true
    });
    const outgoing: Array<Record<string, any>> = [];
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "hello-1",
      session_id: "new",
      seq: 0,
      sent_at: "2026-07-27T06:00:00.000Z",
      type: "session.hello",
      trace_id: "trace-session",
      payload: {
        browser_instance_id: "browser-test",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.3.0",
        bridge_build_id: "v0.3.0-test.node24.18.0",
        supported_protocols: ["bpa.browser/2"],
        features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
        last_acked_command_seq: 0
      }
    });
    const welcome = outgoing.at(-1)!;
    expect(welcome.type).toBe("session.welcome");
    const sessionId = String(welcome.session_id);
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "capability-1",
      session_id: sessionId,
      seq: 1,
      sent_at: "2026-07-27T06:00:00.100Z",
      type: "capability.report",
      trace_id: "trace-session",
      payload: {
        capabilities: [
          {
            node_id: "doudian.shop.context.read",
            versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
            risk_level: "R0",
            permissions: ["browser.dom.read", "browser.tabs.read"],
            routes: [
              {
                origin: "https://fxg.jinritemai.com",
                pathname_prefixes: ["/ffa/g/list"],
                observer_capability_id: "doudian.page"
              }
            ],
            adapter_id: "doudian",
            adapter_version: "1.2.0"
          }
        ],
        features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
        manifest_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    });
    persistence.upsertBrowserPageObservation({
      sessionId,
      browserInstanceId: "browser-test",
      tabId: 42,
      windowId: 7,
      origin: "https://fxg.jinritemai.com",
      pathname: "/ffa/g/list",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-gateway-test",
      observationState: "ready",
      pageEpoch: "tab-42:1:gateway-test",
      observerCapabilityId: "doudian.page",
      revision: 1,
      observedAt: new Date().toISOString()
    });
    expect(service.handle({
      id: "browser-trigger-put",
      method: "trigger.put",
      params: {
        actor: "test",
        spec: {
          apiVersion: "bpa.trigger/v1alpha2",
          id: "browser-gateway-test",
          version: "1.0.0",
          appId: "browser-gateway-test",
          kind: "manual",
          workflow: {
            id: "doudian.shop-context-observe",
            version: "2.0.0"
          },
          enabled: true,
          inputSchemaVersion: "browser-gateway-test/1",
          input: {},
          concurrencyKey: "doudian-account:browser-gateway-test",
          browserInstanceId: "browser-test",
          idempotencyPolicy: "request_key",
          retryPolicy: "none"
        }
      }
    })).toMatchObject({ ok: true });
    const started = service.handle({
      id: "browser-trigger-fire",
      method: "trigger.fire",
      params: { id: "browser-gateway-test", requestKey: "success" }
    });
    expect(started.ok).toBe(true);
    const runId = String(
      (started.result as { attempt: { workflowRunId: string } }).attempt
        .workflowRunId
    );
    expect(persistence.getRun(runId)?.status).toBe("waiting_browser");
    const firstDrain = service.ir2Runtime.drainOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const command = outgoing.find(
      (message) => message.type === "command.dispatch"
    )!;
    expect(command).toBeTruthy();
    expect(command.payload.timing_policy).toMatchObject({
      readiness: { timeoutMs: 8000, stableForMs: 300 },
      rateLimit: { scope: "tab", minIntervalMs: 350 }
    });
    expect(
      verifyPermissionGrant(
        command.payload.permission_grant as SignedPermissionGrant,
        publicKey
      )
    ).toBe(true);

    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "command-ack-1",
      session_id: sessionId,
      seq: 2,
      sent_at: new Date().toISOString(),
      type: "command.ack",
      trace_id: command.trace_id,
      payload: {
        command_seq: command.payload.command_seq,
        command_id: command.payload.command_id,
        node_execution_id: command.payload.node_execution_id,
        accepted: true,
        fencing_token: 1
      }
    });
    const evidenceBody = Buffer.from(
      JSON.stringify({
        schema: "bpa.browser-evidence/1",
        supported: true,
        shop_id: "shop-1"
      })
    );
    const evidenceDigest = `sha256:${createHash("sha256")
      .update(evidenceBody)
      .digest("hex")}`;
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "evidence-begin-1",
      session_id: sessionId,
      seq: 3,
      sent_at: new Date().toISOString(),
      type: "evidence.begin",
      trace_id: command.trace_id,
      payload: {
        evidence_id: "evidence-1",
        run_id: runId,
        node_execution_id: command.payload.node_execution_id,
        kind: "dom_summary",
        media_type: "application/vnd.bpa.browser-evidence+json",
        size: evidenceBody.byteLength,
        digest: evidenceDigest,
        chunk_size: 262_144,
        chunk_count: 1
      }
    });
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "evidence-out-of-order-1",
      session_id: sessionId,
      seq: 4,
      sent_at: new Date().toISOString(),
      type: "evidence.chunk",
      trace_id: command.trace_id,
      payload: {
        evidence_id: "evidence-1",
        index: 1,
        data_base64: evidenceBody.toString("base64"),
        chunk_digest: evidenceDigest
      }
    });
    expect(outgoing.at(-1)).toMatchObject({
      type: "evidence.ack",
      payload: {
        evidence_id: "evidence-1",
        accepted: false,
        next_chunk_index: 0,
        reason_code: "RESUME_FROM_CHUNK"
      }
    });
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "evidence-chunk-1",
      session_id: sessionId,
      seq: 5,
      sent_at: new Date().toISOString(),
      type: "evidence.chunk",
      trace_id: command.trace_id,
      payload: {
        evidence_id: "evidence-1",
        index: 0,
        data_base64: evidenceBody.toString("base64"),
        chunk_digest: evidenceDigest
      }
    });
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "evidence-complete-1",
      session_id: sessionId,
      seq: 6,
      sent_at: new Date().toISOString(),
      type: "evidence.complete",
      trace_id: command.trace_id,
      payload: {
        evidence_id: "evidence-1",
        digest: evidenceDigest,
        chunk_count: 1
      }
    });
    expect(outgoing.at(-1)).toMatchObject({
      type: "evidence.ack",
      payload: { evidence_id: "evidence-1", accepted: true }
    });
    const result = {
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "result-1",
      session_id: sessionId,
      seq: 7,
      sent_at: new Date().toISOString(),
      type: "command.result",
      trace_id: command.trace_id,
      payload: {
        command_seq: command.payload.command_seq,
        command_id: command.payload.command_id,
        node_execution_id: command.payload.node_execution_id,
        idempotency_key: command.payload.idempotency_key,
        fencing_token: 1,
        status: "succeeded",
        output: {
          supported: true,
          shop: {
            id: "shop-1",
            name: "测试店铺",
            identity_confirmed: true
          },
          tab_ref: {
            browser_instance_id: "browser-test",
            tab_id: 1,
            window_id: 1,
            origin: "https://fxg.jinritemai.com"
          },
          page_epoch: "epoch-1"
        },
        evidence_refs: ["evidence-1"],
        page_epoch: "epoch-1"
      }
    };
    gateway.handle(result);
    await firstDrain;
    expect(persistence.getRun(runId)?.status).toBe("succeeded");
    expect(outgoing.at(-1)?.type).toBe("result.ack");
    expect(persistence.getEvidenceTransfer("evidence-1")).toMatchObject({
      state: "linked",
      digest: evidenceDigest,
      classification: "restricted"
    });
    expect(persistence.getEvidenceLink("link-evidence-1")).toMatchObject({
      runId,
      nodeExecutionId: command.payload.node_execution_id,
      sourceIds: ["source-evidence-1"],
      assetIds: ["asset-evidence-1"]
    });
    expect(
      persistence.getAssetRecord("asset-evidence-1")
    ).toMatchObject({
      digest: evidenceDigest,
      classification: "restricted",
      retention: { policy: "restricted_24h" }
    });

    gateway.handle(result);
    expect(persistence.getRun(runId)?.status).toBe("succeeded");
    expect(
      persistence
        .listEvents(runId)
        .filter((event) => event.type === "RUNTIME_RESULT_APPLIED")
    ).toHaveLength(1);
    service.triggers.tick();

    const riskRun = service.handle({
      id: "risk-trigger-fire",
      method: "trigger.fire",
      params: { id: "browser-gateway-test", requestKey: "risk" }
    });
    const riskRunId = String(
      (riskRun.result as { attempt: { workflowRunId: string } }).attempt
        .workflowRunId
    );
    const riskDrain = service.ir2Runtime.drainOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const riskCommand = outgoing
      .filter((message) => message.type === "command.dispatch")
      .at(-1)!;
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "risk-command-ack",
      session_id: sessionId,
      seq: 8,
      sent_at: new Date().toISOString(),
      type: "command.ack",
      trace_id: riskCommand.trace_id,
      payload: {
        command_seq: riskCommand.payload.command_seq,
        command_id: riskCommand.payload.command_id,
        node_execution_id: riskCommand.payload.node_execution_id,
        accepted: true,
        fencing_token: 1
      }
    });
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "risk-result",
      session_id: sessionId,
      seq: 9,
      sent_at: new Date().toISOString(),
      type: "command.result",
      trace_id: riskCommand.trace_id,
      payload: {
        command_seq: riskCommand.payload.command_seq,
        command_id: riskCommand.payload.command_id,
        node_execution_id: riskCommand.payload.node_execution_id,
        idempotency_key: riskCommand.payload.idempotency_key,
        fencing_token: 1,
        status: "rejected",
        error: {
          code: "CAPTCHA_REQUIRED",
          message: "Human verification required.",
          retryable: false
        },
        risk_signals: [
          {
            code: "CAPTCHA_REQUIRED",
            category: "challenge",
            severity: "blocking",
            source: "page",
            detected_at: "2026-07-27T00:00:00.000Z"
          }
        ],
        timing_observation: {
          rate_limit_wait_ms: 350,
          readiness_wait_ms: 420,
          stable_for_ms: 300
        },
        evidence_refs: []
      }
    });
    await riskDrain;
    expect(persistence.getRun(riskRunId)?.status).toBe("rejected");
    expect(
      persistence
        .listEvents(riskRunId)
        .find((event) => event.type === "RUNTIME_RESULT_APPLIED")?.payload
    ).toMatchObject({
      outcomeStatus: "rejected",
      errorCode: "CAPTCHA_REQUIRED",
      riskSignals: [{ code: "CAPTCHA_REQUIRED", severity: "blocking" }]
    });
    persistence.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it("resumes the same Browser Session identity after reconnect", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const gateway = new LocalBrowserGateway(
      persistence,
      new LocalWorkflowEngine(persistence),
      {
        keyId: "core-resume-key",
        privateKey,
        publicKey,
        publicKeySpkiBase64: exportPublicKeySpkiBase64(publicKey)
      }
    );
    const outgoing: Array<Record<string, any>> = [];
    const firstConnection = gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "hello-resume-first",
      session_id: "new",
      seq: 0,
      sent_at: new Date().toISOString(),
      type: "session.hello",
      trace_id: "trace-resume",
      payload: {
        browser_instance_id: "browser-resume",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.4.0",
        bridge_build_id: "v0.4.0-test.node24.18.0",
        supported_protocols: ["bpa.browser/2"],
        features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
        last_acked_command_seq: 0
      }
    });
    const firstWelcome = outgoing.find(
      (message) => message.type === "session.welcome"
    )!;
    const firstSessionId = String(firstWelcome.session_id);
    const resumeToken = String(firstWelcome.payload.resume_token);
    expect(resumeToken).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    persistence.upsertBrowserPageObservation({
      sessionId: firstSessionId,
      browserInstanceId: "browser-resume",
      tabId: 42,
      origin: "https://fxg.jinritemai.com",
      pathname: "/ffa/g/list",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-before-reload",
      observationState: "ready",
      pageEpoch: "tab-42:before-reload",
      observerCapabilityId: "doudian.page",
      revision: 1,
      observedAt: new Date().toISOString()
    });
    gateway.detach(firstConnection);

    const marker = outgoing.length;
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/2",
      version: "2.0.0",
      message_id: "hello-resume-second",
      session_id: "new",
      seq: 0,
      sent_at: new Date().toISOString(),
      type: "session.hello",
      trace_id: "trace-resume",
      payload: {
        browser_instance_id: "browser-resume",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.4.0",
        bridge_build_id: "v0.4.0-test.node24.18.0",
        supported_protocols: ["bpa.browser/2"],
        features: ["page_observation_v2", "exact_tab_binding_v2", "active_page_probe_v1"],
        last_acked_command_seq: 0,
        resume_token: resumeToken
      }
    });
    const resumedMessages = outgoing.slice(marker);
    expect(
      resumedMessages.find((message) => message.type === "session.welcome")
        ?.session_id
    ).toBe(firstSessionId);
    expect(resumedMessages).toContainEqual(
      expect.objectContaining({
        type: "session.resume",
        session_id: firstSessionId,
        payload: expect.objectContaining({ accepted: true })
      })
    );
    expect(gateway.status().sessionId).toBe(firstSessionId);
    expect(
      persistence.getBrowserPageObservation(firstSessionId, 42)
    ).toBeUndefined();
    expect(persistence.listBrowserSessions({ limit: 10 }).records).toHaveLength(
      1
    );
    persistence.close();
  });
});
