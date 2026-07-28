import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import {
  DEFAULT_BPA_EXTENSION_ID,
  exportPublicKeySpkiBase64,
  type CoreSigningKey
} from "@bpa/gateway-core";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { NodeDefinition } from "@bpa/schemas";
import type { ExecutionPlan } from "@bpa/workflow-ir";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { LocalCoreService } from "./control.js";

function nodeFixture(): NodeDefinition {
  const node = parse(
    readFileSync(
      new URL(
        "../../../nodes/core/doudian.shop.context.read.node.yaml",
        import.meta.url
      ),
      "utf8"
    )
  ) as NodeDefinition;
  return {
    ...node,
    execution: {
      ...node.execution,
      timingPolicy: {
        ...node.execution.timingPolicy,
        dispatchJitter: {
          minMs: 0,
          maxMs: 0,
          distribution: "uniform"
        }
      }
    }
  };
}

function plan(node: NodeDefinition): ExecutionPlan {
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "test.ir2-browser",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`
    },
    artifactClosure: {
      entries: [
        {
          kind: "node",
          id: node.metadata.id,
          version: node.metadata.version,
          digest: contentDigest(node)
        }
      ]
    },
    riskSnapshot: [],
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    entry: "observe",
    steps: {
      observe: {
        kind: "call",
        key: "observe",
        node: {
          kind: "node",
          id: node.metadata.id,
          version: node.metadata.version,
          digest: contentDigest(node)
        },
        providerId: "browser",
        permissionSnapshot: {
          riskLevel: node.risk.level,
          permissions: [...node.risk.permissions],
          domains: [...(node.risk.domains ?? [])]
        },
        dependencies: {
          adapters: [],
          policies: [],
          datasetProfiles: []
        },
        timeoutMs: 5_000,
        retry: {
          maxAttempts: 1,
          retryableOutcomes: [],
          retryableErrorCodes: [],
          backoff: {
            strategy: "fixed",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0
          }
        },
        timing: {},
        routes: {
          succeeded: "done",
          failed: "failed",
          timed_out: "failed",
          rejected: "failed",
          cancelled: "failed",
          uncertain: "uncertain"
        }
      },
      done: { kind: "terminal", key: "done", status: "succeeded" },
      failed: {
        kind: "terminal",
        key: "failed",
        status: "failed",
        errorCode: "BROWSER_FAILED"
      },
      uncertain: {
        kind: "terminal",
        key: "uncertain",
        status: "uncertain"
      }
    }
  };
}

describe("IR2 browser provider", () => {
  it("durably bridges a frozen invocation through Browser Protocol v1", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signingKey: CoreSigningKey = {
      keyId: "core-ir2-test",
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
    const node = nodeFixture();
    expect(
      service.handle({
        id: "publish-node",
        method: "asset.publish",
        params: { assetType: "node", content: node, actor: "test" }
      }).ok
    ).toBe(true);
    const outgoing: Array<Record<string, any>> = [];
    gateway.attach(
      `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
      (message) => outgoing.push(message)
    );
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
      message_id: "hello-ir2",
      session_id: "new",
      seq: 0,
      sent_at: new Date().toISOString(),
      type: "session.hello",
      trace_id: "trace-ir2",
      payload: {
        browser_instance_id: "browser-ir2",
        extension_id: DEFAULT_BPA_EXTENSION_ID,
        extension_version: "0.3.0",
        supported_protocols: ["bpa.browser/1"],
        last_acked_command_seq: 0
      }
    });
    const sessionId = String(outgoing.at(-1)?.session_id);
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
      message_id: "capability-ir2",
      session_id: sessionId,
      seq: 1,
      sent_at: new Date().toISOString(),
      type: "capability.report",
      trace_id: "trace-ir2",
      payload: {
        capabilities: [
          {
            node_id: node.metadata.id,
            versions: [node.metadata.version],
            risk_level: node.risk.level,
            permissions: node.risk.permissions,
            adapter_id: "doudian",
            adapter_version: "1.1.0"
          }
        ],
        manifest_digest: `sha256:${"c".repeat(64)}`
      }
    });
    const run = service.ir2Runtime.start(plan(node), {});
    const draining = service.ir2Runtime.drainOnce();
    const command = outgoing.find(
      (message) => message.type === "command.dispatch"
    );
    if (!command) throw new Error("IR2 browser command was not dispatched");
    expect(command.payload).toMatchObject({
      run_id: run.id,
      node: {
        id: node.metadata.id,
        version: node.metadata.version
      }
    });
    gateway.handle({
      protocol: "bpa.browser/1",
      version: "1.0.0",
      message_id: "result-ir2",
      session_id: sessionId,
      seq: 2,
      sent_at: new Date().toISOString(),
      type: "command.result",
      trace_id: command.trace_id,
      payload: {
        command_seq: command.payload.command_seq,
        command_id: command.payload.command_id,
        node_execution_id: command.payload.node_execution_id,
        idempotency_key: command.payload.idempotency_key,
        fencing_token: command.payload.fencing_token,
        status: "succeeded",
        output: {
          shopId: "shop-1",
          shopName: "测试店铺",
          pageEpoch: "epoch-1"
        },
        evidence_refs: []
      }
    });
    expect(gateway.status().lastError).toBeUndefined();
    expect(
      persistence.getGatewayCommand(String(command.payload.command_id))
    ).toMatchObject({
      state: "terminal",
      result: { status: "succeeded" }
    });
    await expect(draining).resolves.toBe(1);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      output: {
        shopId: "shop-1",
        shopName: "测试店铺",
        pageEpoch: "epoch-1"
      }
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    await expect(service.ir2Runtime.drainOnce()).resolves.toBe(0);
    persistence.close();
  });
});
