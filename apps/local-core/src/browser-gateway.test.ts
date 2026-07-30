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
import { LocalBrowserGateway } from "./browser-gateway.js";
import { BrowserEvidenceReceiver } from "./browser-evidence.js";
import { LocalCoreService } from "./control.js";

function fixture(path: string): unknown {
  return parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );
}

describe("local browser gateway", () => {
  it("completes a signed, idempotent browser workflow", () => {
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
      "nodes/core/doudian.shop.context.read.node.yaml"
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
    const started = service.handle({
      id: "run",
      method: "run.create",
      params: {
        workflowId: "doudian.shop-context-observe",
        workflowVersion: "1.2.0",
        input: {}
      }
    });
    expect(started.ok).toBe(true);
    const runId = (started.result as { id: string }).id;
    expect(persistence.getRun(runId)?.status).toBe("waiting_browser");

    const outgoing: Array<Record<string, any>> = [];
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
        supported_protocols: ["bpa.browser/1"],
        last_acked_command_seq: 0
      }
    });
    const welcome = outgoing.at(-1)!;
    expect(welcome.type).toBe("session.welcome");
    const sessionId = String(welcome.session_id);
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
            versions: ["1.0.0", "1.1.0", "1.2.0"],
            risk_level: "R0",
            permissions: ["browser.dom.read", "browser.tabs.read"],
            adapter_id: "doudian",
            adapter_version: "1.1.0"
          }
        ],
        manifest_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    });
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      sourceIds: ["source-evidence-1"]
    });

    gateway.handle(result);
    expect(persistence.getRun(runId)?.status).toBe("succeeded");
    expect(
      persistence
        .listEvents(runId)
        .filter((event) => event.type === "RUN_SUCCEEDED")
    ).toHaveLength(1);

    const riskRun = service.handle({
      id: "risk-run",
      method: "run.create",
      params: {
        workflowId: "doudian.shop-context-observe",
        workflowVersion: "1.2.0",
        input: {}
      }
    });
    const riskRunId = (riskRun.result as { id: string }).id;
    const riskCommand = outgoing
      .filter((message) => message.type === "command.dispatch")
      .at(-1)!;
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
    expect(persistence.getRun(riskRunId)?.status).toBe("failed");
    expect(
      persistence
        .listEvents(riskRunId)
        .find((event) => event.type === "NODE_REJECTED")?.payload
    ).toMatchObject({
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
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
        supported_protocols: ["bpa.browser/1"],
        last_acked_command_seq: 0
      }
    });
    const firstWelcome = outgoing.find(
      (message) => message.type === "session.welcome"
    )!;
    const firstSessionId = String(firstWelcome.session_id);
    const resumeToken = String(firstWelcome.payload.resume_token);
    gateway.detach(firstConnection);

    const marker = outgoing.length;
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
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
        supported_protocols: ["bpa.browser/1"],
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
    expect(persistence.listBrowserSessions({ limit: 10 }).records).toHaveLength(
      1
    );
    persistence.close();
  });
});
