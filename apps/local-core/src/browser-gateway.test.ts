import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { LocalWorkflowEngine } from "@bpa/engine";
import {
  DEFAULT_BPA_EXTENSION_ID,
  exportPublicKeySpkiBase64,
  verifyPermissionGrant,
  type CoreSigningKey,
  type SignedPermissionGrant
} from "@bpa/gateway-core";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { LocalCoreService } from "./control.js";

function fixture(path: string): unknown {
  return parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );
}

describe("local browser gateway", () => {
  it("completes a signed, idempotent browser workflow", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
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
      signingKey
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
    const result = {
      protocol: "bpa.browser/1",
      version: "1.0.0",
      message_id: "result-1",
      session_id: sessionId,
      seq: 3,
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
        evidence_refs: [],
        page_epoch: "epoch-1"
      }
    };
    gateway.handle(result);
    expect(persistence.getRun(runId)?.status).toBe("succeeded");
    expect(outgoing.at(-1)?.type).toBe("result.ack");

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
      seq: 4,
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
      seq: 5,
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
  });
});
