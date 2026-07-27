import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  verifyCommandAuthorization,
  type BridgeCapability,
  type BrowserCommandPayload
} from "@bpa/browser-bridge";
import protocolSchema from "@bpa/schemas/browser-protocol-v1.schema.json";
import permissionSchema from "@bpa/schemas/permission.schema.json";
import {
  listPendingResults,
  removePendingResult,
  savePendingResult
} from "../lib/pending-results";

const NATIVE_HOST = "com.bpa.browser";
const PROTOCOL = "bpa.browser/1";
const VERSION = "1.0.0";
const capability: BridgeCapability = {
  nodeId: "doudian.shop.context.read",
  nodeVersion: "1.0.0",
  riskLevel: "R0",
  permissions: ["browser.dom.read", "browser.tabs.read"]
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(permissionSchema);
const validateMessage = ajv.compile(protocolSchema);

interface SessionState {
  sessionId?: string;
  incomingSeq: number;
  outgoingSeq: number;
  keyId?: string;
  publicKey?: string;
}

export default defineBackground(() => {
  const session: SessionState = { incomingSeq: 0, outgoingSeq: 0 };
  let port: Browser.runtime.Port | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const activeCommands = new Set<string>();
  const cancelledCommands = new Set<string>();

  const updateStatus = async (
    patch: Record<string, unknown>
  ): Promise<void> => {
    const stored = await browser.storage.local.get("bpaStatus");
    const current =
      stored.bpaStatus && typeof stored.bpaStatus === "object"
        ? (stored.bpaStatus as Record<string, unknown>)
        : {};
    await browser.storage.local.set({
      bpaStatus: {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    });
  };

  const envelope = (
    type: string,
    payload: Record<string, unknown>,
    traceId: string
  ): Record<string, unknown> => {
    session.outgoingSeq += 1;
    return {
      protocol: PROTOCOL,
      version: VERSION,
      message_id: crypto.randomUUID(),
      session_id: session.sessionId ?? "new",
      seq: session.sessionId ? session.outgoingSeq : 0,
      sent_at: new Date().toISOString(),
      type,
      trace_id: traceId,
      payload
    };
  };

  const send = (message: Record<string, unknown>): void => {
    if (!port) throw new Error("Native port is disconnected");
    port.postMessage(message);
  };

  const sendCapabilities = (): void => {
    send(
      envelope(
        "capability.report",
        {
          capabilities: [
            {
              node_id: capability.nodeId,
              versions: [capability.nodeVersion],
              risk_level: capability.riskLevel,
              permissions: capability.permissions,
              adapter_id: "doudian",
              adapter_version: "1.0.0"
            }
          ],
          manifest_digest:
            "sha256:32a34fd815012f1d849bb60dd06c37ec930cc4bcbee728c3a3c9945be2d96da6"
        },
        "trace-capabilities"
      )
    );
  };

  const sendPending = async (): Promise<void> => {
    for (const pending of await listPendingResults()) {
      const message = envelope(
        "command.result",
        pending.payload,
        pending.traceId
      );
      await savePendingResult(pending);
      send(message);
    }
  };

  const handleCommand = async (
    message: Record<string, any>
  ): Promise<void> => {
    const payload = message.payload as BrowserCommandPayload &
      Record<string, any>;
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true
    });
    const currentUrl = tab?.url ?? "";
    const authorization =
      session.keyId && session.publicKey
        ? await verifyCommandAuthorization({
            command: payload,
            publicKeySpkiBase64: session.publicKey,
            keyId: session.keyId,
            capability,
            currentUrl
          })
        : { valid: false as const, reason: "SESSION_KEY_MISSING" };
    if (!authorization.valid || tab?.id == null) {
      send(
        envelope(
          "command.ack",
          {
            command_seq: payload.command_seq,
            command_id: payload.command_id,
            node_execution_id: payload.node_execution_id,
            accepted: false,
            fencing_token: payload.fencing_token,
            reason_code: authorization.valid
              ? "ACTIVE_TAB_MISSING"
              : authorization.reason
          },
          String(message.trace_id)
        )
      );
      return;
    }
    const pageEpoch = `${tab.id}:${tab.url}:${Date.now()}`;
    send(
      envelope(
        "command.ack",
        {
          command_seq: payload.command_seq,
          command_id: payload.command_id,
          node_execution_id: payload.node_execution_id,
          accepted: true,
          fencing_token: payload.fencing_token
        },
        String(message.trace_id)
      )
    );
    activeCommands.add(String(payload.command_id));
    let adapterResponse: {
      ok: boolean;
      output?: Record<string, unknown>;
      error?: { code: string; message: string; retryable?: boolean };
    };
    try {
      adapterResponse = await browser.tabs.sendMessage(tab.id, {
        type: "bpa.execute",
        node: payload.node,
        pageEpoch
      });
    } catch (error) {
      adapterResponse = {
        ok: false,
        error: {
          code: "CONTENT_SCRIPT_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        }
      };
    }
    activeCommands.delete(String(payload.command_id));
    if (cancelledCommands.delete(String(payload.command_id))) return;
    const resultPayload = {
        command_seq: payload.command_seq,
        command_id: payload.command_id,
        node_execution_id: payload.node_execution_id,
        idempotency_key: payload.idempotency_key,
        fencing_token: payload.fencing_token,
        status: adapterResponse.ok ? "succeeded" : "failed",
        ...(adapterResponse.output
          ? {
              output: {
                ...adapterResponse.output,
                tab_ref: {
                  browser_instance_id: (
                    await browser.storage.local.get("browserInstanceId")
                  ).browserInstanceId,
                  tab_id: tab.id,
                  ...(tab.windowId == null ? {} : { window_id: tab.windowId }),
                  origin: new URL(currentUrl).origin
                }
              }
            }
          : {}),
        ...(adapterResponse.error ? { error: adapterResponse.error } : {}),
        evidence_refs: [],
        page_epoch: pageEpoch
      };
    await savePendingResult({
      commandId: String(payload.command_id),
      commandSeq: Number(payload.command_seq),
      traceId: String(message.trace_id),
      payload: resultPayload
    });
    send(
      envelope(
        "command.result",
        resultPayload,
        String(message.trace_id)
      )
    );
    await updateStatus({
      currentTask: payload.node_execution_id,
      lastError: adapterResponse.error?.message
    });
  };

  const handleMessage = async (message: Record<string, any>): Promise<void> => {
    if (!validateMessage(message)) {
      await updateStatus({
        lastError: `协议消息校验失败: ${ajv.errorsText(validateMessage.errors)}`
      });
      return;
    }
    if (
      message.type !== "session.welcome" &&
      message.session_id !== session.sessionId
    ) {
      return;
    }
    if (
      message.type !== "session.welcome" &&
      message.seq <= session.incomingSeq
    ) {
      return;
    }
    session.incomingSeq = message.seq;
    switch (message.type) {
      case "session.welcome": {
        session.sessionId = message.session_id;
        session.incomingSeq = message.seq;
        session.outgoingSeq = 0;
        session.keyId = message.payload.core_signing_key.key_id;
        session.publicKey =
          message.payload.core_signing_key.public_key_spki_base64;
        await browser.storage.local.set({
          resumeToken: message.payload.resume_token,
          resumeTokenExpiresAt: message.payload.resume_token_expires_at
        });
        await updateStatus({
          host: "connected",
          core: "connected",
          protocol: PROTOCOL,
          sessionId: session.sessionId,
          permissions: capability.permissions,
          lastError: undefined
        });
        sendCapabilities();
        await sendPending();
        break;
      }
      case "session.resume":
        await sendPending();
        break;
      case "command.dispatch":
        await handleCommand(message);
        break;
      case "cancel.request": {
        const commandId = String(message.payload.command_id);
        const pending = (await listPendingResults()).some(
          (entry) => entry.commandId === commandId
        );
        const actionStarted = activeCommands.has(commandId);
        send(
          envelope(
            "cancel.ack",
            {
              command_id: commandId,
              node_execution_id: message.payload.node_execution_id,
              fencing_token: message.payload.fencing_token,
              acknowledged: !pending,
              action_started: actionStarted,
              ...(pending ? { reason_code: "RESULT_ALREADY_PRODUCED" } : {})
            },
            message.trace_id
          )
        );
        if (!pending) {
          cancelledCommands.add(commandId);
          send(
            envelope(
              "cancel.effective",
              {
                command_id: commandId,
                node_execution_id: message.payload.node_execution_id,
                fencing_token: message.payload.fencing_token,
                status: "cancelled",
                safe_stop: true
              },
              message.trace_id
            )
          );
        }
        break;
      }
      case "result.ack":
        if (message.payload.accepted) {
          const commandId = String(message.payload.command_id);
          const pending = (await listPendingResults()).find(
            (entry) => entry.commandId === commandId
          );
          if (pending) {
            const stored = await browser.storage.local.get(
              "lastAckedCommandSeq"
            );
            await browser.storage.local.set({
              lastAckedCommandSeq: Math.max(
                Number(stored.lastAckedCommandSeq ?? 0),
                pending.commandSeq
              )
            });
          }
          await removePendingResult(commandId);
        }
        break;
      case "heartbeat.ping":
        send(
          envelope(
            "heartbeat.pong",
            { nonce: message.payload.nonce },
            message.trace_id
          )
        );
        break;
      case "session.error":
        await updateStatus({ lastError: message.payload.message });
        break;
    }
  };

  const connect = async (): Promise<void> => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      port = browser.runtime.connectNative(NATIVE_HOST);
      const stored = await browser.storage.local.get([
        "browserInstanceId",
        "resumeToken",
        "lastAckedCommandSeq"
      ]);
      const browserInstanceId =
        stored.browserInstanceId ?? crypto.randomUUID();
      await browser.storage.local.set({ browserInstanceId });
      delete session.sessionId;
      delete session.keyId;
      delete session.publicKey;
      session.incomingSeq = 0;
      session.outgoingSeq = 0;
      port.onMessage.addListener((message) => {
        void handleMessage(message as Record<string, any>);
      });
      port.onDisconnect.addListener(() => {
        port = undefined;
        void updateStatus({
          host: "disconnected",
          core: "disconnected",
          lastError: browser.runtime.lastError?.message
        });
        reconnectTimer = setTimeout(() => void connect(), 2_000);
      });
      send(
        envelope(
          "session.hello",
          {
            browser_instance_id: browserInstanceId,
            extension_id: browser.runtime.id,
            extension_version: browser.runtime.getManifest().version,
            supported_protocols: [PROTOCOL],
            last_acked_command_seq: Number(
              stored.lastAckedCommandSeq ?? 0
            ),
            ...(stored.resumeToken
              ? { resume_token: stored.resumeToken }
              : {})
          },
          "trace-session"
        )
      );
    } catch (error) {
      await updateStatus({
        host: "disconnected",
        core: "disconnected",
        lastError: error instanceof Error ? error.message : String(error)
      });
      reconnectTimer = setTimeout(() => void connect(), 2_000);
    }
  };

  void connect();
});
