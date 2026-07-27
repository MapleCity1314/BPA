import {
  createPageEpoch,
  verifyCommandAuthorization,
  type BridgeCapability,
  type BrowserCommandPayload
} from "@bpa/browser-bridge";
import validateMessage from "@bpa/schemas/browser-protocol-v1.validator";
import {
  firstBlockingRiskSignal,
  reserveRateLimit
} from "@bpa/node-runtime";
import type { RiskSignal, TimingPolicy } from "@bpa/schemas";
import {
  listPendingResults,
  normalizePendingResultForReplay,
  removePendingResult,
  savePendingResult
} from "../lib/pending-results";

const NATIVE_HOST = "com.bpa.browser";
const PROTOCOL = "bpa.browser/1";
const VERSION = "1.0.0";
const NODE_VERSIONS = ["1.0.0", "1.1.0"] as const;
const capabilityBase = {
  nodeId: "doudian.shop.context.read",
  riskLevel: "R0",
  permissions: ["browser.dom.read", "browser.tabs.read"]
};

function capabilityForVersion(version: string): BridgeCapability {
  return {
    ...capabilityBase,
    nodeVersion: NODE_VERSIONS.includes(
      version as (typeof NODE_VERSIONS)[number]
    )
      ? version
      : "unsupported"
  };
}
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
  const pacingReservations = new Map<string, number>();

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
              node_id: capabilityBase.nodeId,
              versions: [...NODE_VERSIONS],
              risk_level: capabilityBase.riskLevel,
              permissions: capabilityBase.permissions,
              adapter_id: "doudian",
              adapter_version: "1.1.0"
            }
          ],
          manifest_digest:
            "sha256:24c82765fef8e4b128cef512968bfb4ee1532f31f2aa2b1b23f97d7b770c724d"
        },
        "trace-capabilities"
      )
    );
  };

  const sendPending = async (): Promise<void> => {
    for (const storedPending of await listPendingResults()) {
      const pending = normalizePendingResultForReplay(storedPending);
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
            capability: capabilityForVersion(payload.node.version),
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
    const pageEpoch = createPageEpoch(tab.id);
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
    const commandId = String(payload.command_id);
    const sendCancelled = (): void => {
      send(
        envelope(
          "cancel.effective",
          {
            command_id: commandId,
            node_execution_id: payload.node_execution_id,
            fencing_token: payload.fencing_token,
            status: "cancelled",
            safe_stop: true
          },
          String(message.trace_id)
        )
      );
    };
    let adapterResponse: {
      ok: boolean;
      output?: Record<string, unknown>;
      error?: { code: string; message: string; retryable?: boolean };
      riskSignals?: RiskSignal[];
      timingObservation?: {
        readiness_wait_ms?: number;
        stable_for_ms?: number;
      };
    };
    let rateLimitWaitMs = 0;
    try {
      const timingPolicy = payload.timing_policy as TimingPolicy | undefined;
      const origin = new URL(currentUrl).origin;
      const rateScope = timingPolicy?.rateLimit?.scope ?? "tab";
      const input =
        payload.input && typeof payload.input === "object"
          ? (payload.input as Record<string, unknown>)
          : {};
      const shopId = String(input.shop_id ?? input.shopId ?? "");
      const rateKey =
        rateScope === "domain"
          ? `domain:${origin}`
          : rateScope === "shop"
            ? `shop:${origin}:${shopId || "unresolved"}`
            : `tab:${origin}:${tab.id}`;
      const rateStorageKey = `bpaPacing:${rateKey}`;
      const storedPacing =
        await browser.storage.local.get(rateStorageKey);
      const persistedLastExecutedAt = Number(
        storedPacing[rateStorageKey] ?? 0
      );
      const reservation = reserveRateLimit({
        now: Date.now(),
        lastExecutedAt: Math.max(
          persistedLastExecutedAt,
          pacingReservations.get(rateKey) ?? 0
        ),
        deadline: Date.parse(payload.deadline),
        policy: timingPolicy
      });
      if (!reservation.accepted) {
        throw new Error(reservation.reason);
      }
      pacingReservations.set(rateKey, reservation.executeAt);
      rateLimitWaitMs = reservation.waitMs;
      if (reservation.waitMs > 0) {
        await updateStatus({
          currentTask: payload.node_execution_id,
          pacingWaitMs: reservation.waitMs
        });
        await new Promise((resolve) =>
          setTimeout(resolve, reservation.waitMs)
        );
      }
      if (cancelledCommands.delete(commandId)) {
        activeCommands.delete(commandId);
        sendCancelled();
        return;
      }
      if (Date.now() >= Date.parse(payload.deadline)) {
        throw new Error("DEADLINE_EXCEEDED");
      }
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true
      });
      if (
        currentTab?.id !== tab.id ||
        currentTab.url !== currentUrl
      ) {
        adapterResponse = {
          ok: false,
          error: {
            code: "PAGE_CONTEXT_CHANGED",
            message: "The active page changed while the command was paced.",
            retryable: false
          },
          riskSignals: [
            {
              code: "PAGE_CONTEXT_CHANGED",
              category: "page_context",
              severity: "blocking",
              source: "bridge",
              detected_at: new Date().toISOString(),
              detail: "节奏等待期间活动标签页或 URL 已发生变化。"
            }
          ]
        };
      } else if (
        /login|passport|signin|authorize/i.test(
          new URL(currentUrl).pathname
        )
      ) {
        adapterResponse = {
          ok: false,
          error: {
            code: "SESSION_EXPIRED",
            message: "The active page requires login or authorization.",
            retryable: false
          },
          riskSignals: [
            {
              code: "SESSION_EXPIRED",
              category: "session",
              severity: "blocking",
              source: "bridge",
              detected_at: new Date().toISOString(),
              detail: "当前标签页处于登录或授权流程，需要人工恢复会话。"
            }
          ]
        };
      } else {
        await browser.storage.local.set({
          [rateStorageKey]: Date.now()
        });
        adapterResponse = await browser.tabs.sendMessage(tab.id, {
          type: "bpa.execute",
          node: payload.node,
          pageEpoch,
          timingPolicy,
          deadline: payload.deadline
        });
        const [completedTab] = await browser.tabs.query({
          active: true,
          currentWindow: true
        });
        if (
          completedTab?.id !== tab.id ||
          completedTab.url !== currentUrl
        ) {
          adapterResponse = {
            ok: false,
            error: {
              code: "PAGE_CONTEXT_CHANGED",
              message: "The active page changed before result validation.",
              retryable: false
            },
            riskSignals: [
              {
                code: "PAGE_CONTEXT_CHANGED",
                category: "page_context",
                severity: "blocking",
                source: "bridge",
                detected_at: new Date().toISOString(),
                detail: "节点返回后、Result 验证前活动页面发生了变化。"
              }
            ]
          };
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const rateLimited =
        code === "RATE_LIMIT_QUEUE_EXCEEDED" ||
        code === "DEADLINE_EXCEEDED";
      adapterResponse = {
        ok: false,
        error: {
          code: rateLimited ? code : "CONTENT_SCRIPT_UNAVAILABLE",
          message: code,
          retryable: !rateLimited
        },
        ...(rateLimited
          ? {
              riskSignals: [
                {
                  code: "RATE_LIMITED",
                  category: "throttle",
                  severity: "blocking",
                  source: "bridge",
                  detected_at: new Date().toISOString(),
                  detail: "本地节奏策略拒绝了超出排队或 Deadline 的执行。"
                }
              ] satisfies RiskSignal[]
            }
          : {})
      };
    }
    if (cancelledCommands.delete(commandId)) {
      activeCommands.delete(commandId);
      sendCancelled();
      return;
    }
    const resultPayload = {
        command_seq: payload.command_seq,
        command_id: payload.command_id,
        node_execution_id: payload.node_execution_id,
        idempotency_key: payload.idempotency_key,
        fencing_token: payload.fencing_token,
        status: adapterResponse.ok
          ? "succeeded"
          : firstBlockingRiskSignal(adapterResponse.riskSignals ?? [])
            ? "rejected"
            : "failed",
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
        ...(adapterResponse.riskSignals?.length
          ? { risk_signals: adapterResponse.riskSignals }
          : {}),
        timing_observation: {
          rate_limit_wait_ms: rateLimitWaitMs,
          ...adapterResponse.timingObservation
        },
        evidence_refs: [],
        page_epoch: pageEpoch
      };
    try {
      await savePendingResult({
        commandId,
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
    } finally {
      activeCommands.delete(commandId);
    }
    await updateStatus({
      currentTask: payload.node_execution_id,
      lastError: adapterResponse.error?.message
    });
  };

  const handleMessage = async (message: Record<string, any>): Promise<void> => {
    if (!validateMessage(message)) {
      const validationErrors = (
        validateMessage as typeof validateMessage & {
          errors?: Array<{ instancePath?: string; message?: string }>;
        }
      ).errors;
      const details = (validationErrors ?? [])
        .slice(0, 5)
        .map(
          (error) =>
            `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
        )
        .join("; ");
      await updateStatus({
        lastError: `协议消息校验失败: ${details}`
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
          permissions: capabilityBase.permissions,
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
          if (!actionStarted) {
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
