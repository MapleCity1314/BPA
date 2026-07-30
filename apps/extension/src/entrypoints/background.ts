import {
  createPageEpoch,
  verifyCommandAuthorization,
  type BrowserCommandPayload
} from "@bpa/browser-bridge";
import validateMessage from "@bpa/schemas/browser-protocol-v1.validator";
import {
  firstBlockingRiskSignal,
  reserveRateLimit
} from "@bpa/node-runtime";
import type { RiskSignal, TimingPolicy } from "@bpa/schemas";
import {
  createJsonEvidenceUpload,
  evidenceTransferMessages,
  interpretEvidenceAcknowledgement,
  type PendingEvidenceUpload
} from "../lib/evidence-transfer";
import {
  listPendingEvidenceUploads,
  listPendingResults,
  normalizePendingResultForReplay,
  removePendingEvidence,
  removePendingResult,
  savePendingEvidenceUpload,
  savePendingResult
} from "../lib/pending-results";
import {
  AssistancePanelRepository,
  type SafeAssistanceTask
} from "../lib/assistance-panel";
import {
  BROWSER_PROTOCOL,
  bridgeCapabilityFor,
  capabilityReport,
  validPageEpoch,
  validateCapabilityRoute
} from "../lib/capability-manifest";
import { resolveNavigationTarget } from "../lib/navigation-target";

const NATIVE_HOST = "com.bpa.browser";
const PROTOCOL = BROWSER_PROTOCOL;
const VERSION = "1.0.0";

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
  const assistancePanel = new AssistancePanelRepository({
    get: (key) => browser.storage.local.get(key),
    set: (value) => browser.storage.local.set(value)
  });

  const waitForTabReady = async (
    tabId: number,
    expectedUrl: string,
    deadline: string
  ): Promise<boolean> => {
    while (Date.now() < Date.parse(deadline)) {
      const current = await browser.tabs.get(tabId);
      if (current.url === expectedUrl && current.status === "complete") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

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
        capabilityReport(),
        "trace-capabilities"
      )
    );
  };

  const sendStoredResult = async (
    storedPending: Awaited<ReturnType<typeof listPendingResults>>[number]
  ): Promise<void> => {
    const pending = normalizePendingResultForReplay(storedPending);
    const message = envelope(
      "command.result",
      pending.payload,
      pending.traceId
    );
    await savePendingResult(pending);
    send(message);
  };

  const sendReadyPendingResults = async (): Promise<void> => {
    const pendingEvidenceIds = new Set(
      (await listPendingEvidenceUploads()).map((upload) => upload.evidenceId)
    );
    for (const pending of await listPendingResults()) {
      const evidenceRefs = Array.isArray(pending.payload.evidence_refs)
        ? pending.payload.evidence_refs.filter(
            (value): value is string => typeof value === "string"
          )
        : [];
      if (
        evidenceRefs.some((evidenceId) => pendingEvidenceIds.has(evidenceId))
      ) {
        continue;
      }
      await sendStoredResult(pending);
    }
  };

  const sendEvidenceUpload = async (
    upload: PendingEvidenceUpload,
    options: {
      readonly includeBegin?: boolean;
      readonly startChunkIndex?: number;
    } = {}
  ): Promise<void> => {
    await savePendingEvidenceUpload(upload);
    for (const message of evidenceTransferMessages(upload, options)) {
      send(envelope(message.type, message.payload, upload.traceId));
    }
  };

  const sendPending = async (): Promise<void> => {
    const uploads = await listPendingEvidenceUploads();
    for (const upload of uploads) {
      await sendEvidenceUpload(upload);
    }
    await sendReadyPendingResults();
  };

  const recordAssistanceAttention = async (input: {
    taskId: string;
    deadline?: string;
    actionRequired: boolean;
    profileId: "auth_takeover" | "scope_review" | "adapter_anomaly_review";
    summaryCode: SafeAssistanceTask["summaryCode"];
  }): Promise<void> => {
    await assistancePanel.upsert({
      taskId: input.taskId,
      mode: input.actionRequired ? "human_action" : "ai_review",
      status: "queued",
      profileId: input.profileId,
      summaryCode: input.summaryCode,
      updatedAt: new Date().toISOString(),
      ...(input.actionRequired ? { ownerType: "human" as const } : {}),
      ...(input.deadline ? { deadline: input.deadline } : {})
    });
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
    const navigationTarget = resolveNavigationTarget({
      nodeId: payload.node.id,
      payloadInput: payload.input,
      currentUrl
    });
    const executionUrl = navigationTarget.valid
      ? navigationTarget.executionUrl
      : currentUrl;
    const grantedPermissions = Array.isArray(
      payload.permission_grant?.permissions
    )
      ? payload.permission_grant.permissions.filter(
          (permission): permission is string =>
            typeof permission === "string"
        )
      : [];
    const route = navigationTarget.valid
      ? validateCapabilityRoute({
          nodeId: payload.node.id,
          nodeVersion: payload.node.version,
          currentUrl: executionUrl,
          grantedPermissions
        })
      : ({ valid: false, reason: navigationTarget.reason } as const);
    const authorization =
      route.valid && session.keyId && session.publicKey
        ? await verifyCommandAuthorization({
            command: payload,
            publicKeySpkiBase64: session.publicKey,
            keyId: session.keyId,
            capability: bridgeCapabilityFor(
              payload.node.id,
              payload.node.version
            ),
            currentUrl: executionUrl
          })
        : {
            valid: false as const,
            reason: route.valid ? "SESSION_KEY_MISSING" : route.reason
          };
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
      await recordAssistanceAttention({
        taskId: String(payload.node_execution_id),
        ...(typeof payload.deadline === "string"
          ? { deadline: payload.deadline }
          : {}),
        actionRequired:
          tab?.id == null ||
          authorization.valid ||
          [
            "SESSION_KEY_MISSING",
            "PAGE_ORIGIN_NOT_GRANTED",
            "PERMISSION_MISMATCH"
          ].includes(authorization.reason),
        profileId:
          tab?.id == null ||
          authorization.valid ||
          authorization.reason === "SESSION_KEY_MISSING"
            ? "auth_takeover"
            : payload.node.id === "doudian.product.scope.collect"
              ? "scope_review"
              : "adapter_anomaly_review",
        summaryCode:
          tab?.id == null ||
          authorization.valid ||
          authorization.reason === "SESSION_KEY_MISSING"
            ? "authorization_required"
            : "page_attention"
      });
      return;
    }
    const nodeInput =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : {};
    let pageEpoch =
      payload.node.id === "browser.design.snapshot.capture" &&
      validPageEpoch(nodeInput.pageEpoch, tab.id)
        ? nodeInput.pageEpoch
        : createPageEpoch(tab.id);
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
      pageEpoch?: string;
      riskSignals?: RiskSignal[];
      timingObservation?: {
        readiness_wait_ms?: number;
        stable_for_ms?: number;
      };
    } = {
      ok: false,
      error: {
        code: "ADAPTER_RESPONSE_MISSING",
        message: "The content action did not produce a result.",
        retryable: false
      }
    };
    let rateLimitWaitMs = 0;
    try {
      const timingPolicy = payload.timing_policy as TimingPolicy | undefined;
      const origin = new URL(executionUrl).origin;
      const rateScope = timingPolicy?.rateLimit?.scope ?? "tab";
      const shopId = String(
        nodeInput.shop_id ?? nodeInput.shopId ?? ""
      );
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
      let [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true
      });
      let navigationReady = true;
      let navigationBlocked = false;
      if (
        currentTab?.id === tab.id &&
        currentTab.url === currentUrl &&
        navigationTarget.valid &&
        navigationTarget.navigate
      ) {
        const preflight = (await browser.tabs.sendMessage(tab.id, {
          type: "bpa.risk.preflight"
        })) as { riskSignals?: RiskSignal[] };
        const blockingRisk = firstBlockingRiskSignal(
          preflight.riskSignals ?? []
        );
        if (blockingRisk) {
          navigationBlocked = true;
          adapterResponse = {
            ok: false,
            pageEpoch,
            error: {
              code: blockingRisk.code,
              message: "The current page requires human attention.",
              retryable: false
            },
            ...(preflight.riskSignals?.length
              ? { riskSignals: preflight.riskSignals }
              : {})
          };
        } else {
          await browser.tabs.update(tab.id, { url: executionUrl });
          navigationReady = await waitForTabReady(
            tab.id,
            executionUrl,
            payload.deadline
          );
        }
        [currentTab] = await browser.tabs.query({
          active: true,
          currentWindow: true
        });
        pageEpoch = createPageEpoch(tab.id);
      }
      if (navigationBlocked) {
        // Preserve the rejected risk response; never navigate through a
        // challenge, expired session, or platform risk-control page.
      } else if (!navigationReady) {
        adapterResponse = {
          ok: false,
            pageEpoch,
            error: {
              code: "NAVIGATION_UNCERTAIN",
              message: "The reviewed destination did not become ready before deadline.",
              retryable: true
            }
        };
      } else if (
        currentTab?.id !== tab.id ||
        currentTab.url !== executionUrl
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
          new URL(executionUrl).pathname
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
          input: nodeInput,
          pageEpoch,
          grantedPermissions,
          timingPolicy,
          deadline: payload.deadline
        });
        const [completedTab] = await browser.tabs.query({
          active: true,
          currentWindow: true
        });
        if (
          completedTab?.id !== tab.id ||
          completedTab.url !== executionUrl
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
        } else if (
          adapterResponse.pageEpoch !== pageEpoch ||
          !validPageEpoch(adapterResponse.pageEpoch, tab.id)
        ) {
          adapterResponse = {
            ok: false,
            pageEpoch,
            error: {
              code: "PAGE_EPOCH_MISMATCH",
              message: "The content action returned a different page epoch.",
              retryable: false
            },
            riskSignals: [
              {
                code: "PAGE_CONTEXT_CHANGED",
                category: "page_context",
                severity: "blocking",
                source: "bridge",
                detected_at: new Date().toISOString(),
                detail: "Content action 返回的页面执行纪元不匹配。"
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
            : adapterResponse.error?.code === "NAVIGATION_UNCERTAIN"
              ? "uncertain"
            : "failed",
        ...(adapterResponse.output
          ? {
              output: {
                ...adapterResponse.output,
                ...(payload.node.id === "doudian.shop.context.read" ||
                payload.node.id === "doudian.product.editor.open" ||
                payload.node.id === "browser.design.snapshot.capture"
                  ? {
                      page_epoch: pageEpoch,
                      tab_ref: {
                        browser_instance_id: (
                          await browser.storage.local.get("browserInstanceId")
                        ).browserInstanceId,
                        tab_id: tab.id,
                        ...(tab.windowId == null
                          ? {}
                          : { window_id: tab.windowId }),
                        origin: new URL(executionUrl).origin
                      }
                    }
                  : {})
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
        evidence_refs: [] as string[],
        page_epoch: pageEpoch
      };
    try {
      const evidenceId = `evidence-${crypto.randomUUID()}`;
      const pageUrl = new URL(executionUrl);
      const evidenceUpload = await createJsonEvidenceUpload({
        evidenceId,
        traceId: String(message.trace_id),
        runId: String(payload.run_id),
        nodeExecutionId: String(payload.node_execution_id),
        value: {
          schema: "bpa.browser-evidence/1",
          captured_at: new Date().toISOString(),
          node: {
            id: String(payload.node.id),
            version: String(payload.node.version)
          },
          page: {
            origin: pageUrl.origin,
            pathname: pageUrl.pathname,
            epoch: pageEpoch
          },
          status: resultPayload.status,
          ...(resultPayload.output === undefined
            ? {}
            : { output: resultPayload.output }),
          ...(resultPayload.error === undefined
            ? {}
            : { error: resultPayload.error }),
          ...(resultPayload.risk_signals === undefined
            ? {}
            : { risk_signals: resultPayload.risk_signals })
        }
      });
      resultPayload.evidence_refs = [evidenceId];
      await savePendingEvidenceUpload(evidenceUpload);
      await savePendingResult({
        commandId,
        commandSeq: Number(payload.command_seq),
        traceId: String(message.trace_id),
        payload: resultPayload
      });
      await sendEvidenceUpload(evidenceUpload);
    } finally {
      activeCommands.delete(commandId);
    }
    if (adapterResponse.ok) {
      await assistancePanel.remove(String(payload.node_execution_id));
    } else {
      const blockingRisk = firstBlockingRiskSignal(
        adapterResponse.riskSignals ?? []
      );
      const actionRequired = Boolean(
        blockingRisk &&
          [
            "CAPTCHA_REQUIRED",
            "SESSION_EXPIRED",
            "RISK_CONTROL"
          ].includes(blockingRisk.code)
      );
      await recordAssistanceAttention({
        taskId: String(payload.node_execution_id),
        ...(typeof payload.deadline === "string"
          ? { deadline: payload.deadline }
          : {}),
        actionRequired,
        profileId: actionRequired
          ? "auth_takeover"
          : payload.node.id === "doudian.product.scope.collect"
            ? "scope_review"
            : "adapter_anomaly_review",
        summaryCode: actionRequired
          ? "authorization_required"
          : adapterResponse.error?.code === "PAGE_CONTEXT_CHANGED" ||
              adapterResponse.error?.code === "PAGE_EPOCH_MISMATCH"
            ? "page_attention"
            : "adapter_attention"
      });
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
          permissions: [
            ...new Set(
              capabilityReport().capabilities.flatMap(
                (capability) => capability.permissions
              )
            )
          ],
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
      case "evidence.ack": {
        const evidenceId = String(message.payload.evidence_id);
        const upload = (await listPendingEvidenceUploads()).find(
          (candidate) => candidate.evidenceId === evidenceId
        );
        if (!upload) break;
        const acknowledgement = interpretEvidenceAcknowledgement(upload, {
          accepted: message.payload.accepted === true,
          ...(typeof message.payload.next_chunk_index === "number"
            ? { nextChunkIndex: message.payload.next_chunk_index }
            : {}),
          ...(typeof message.payload.reason_code === "string"
            ? { reasonCode: message.payload.reason_code }
            : {})
        });
        if (acknowledgement.state === "rejected") {
          await updateStatus({
            lastError: `证据上传被拒绝: ${acknowledgement.reasonCode}`
          });
          break;
        }
        if (acknowledgement.state === "complete") {
          await removePendingEvidence(evidenceId);
          await sendReadyPendingResults();
          break;
        }
        await sendEvidenceUpload(upload, {
          includeBegin: false,
          startChunkIndex: acknowledgement.nextChunkIndex
        });
        break;
      }
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
