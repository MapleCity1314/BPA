import {
  createPageEpoch,
  verifyCommandAuthorization,
  type BrowserCommandPayload
} from "@bpa/browser-bridge";
import validateMessage from "@bpa/schemas/browser-protocol-v2.validator";
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
  listPendingCommandStarts,
  listPendingResults,
  normalizePendingResultForReplay,
  recoverInterruptedCommands,
  removePendingCommandStart,
  removePendingEvidence,
  removePendingResult,
  savePendingEvidenceUpload,
  savePendingCommandStart,
  savePendingResult,
  shouldRemovePendingResultAfterAck
} from "../lib/pending-results";
import {
  AssistancePanelRepository,
  type SafeAssistanceTask
} from "../lib/assistance-panel";
import {
  BROWSER_PROTOCOL,
  BROWSER_FEATURES,
  bridgeCapabilityFor,
  capabilityReport,
  resolveCapability,
  validPageEpoch,
  validateCapabilityRoute
} from "../lib/capability-manifest";
import {
  observerCapabilityForUrl,
  type PageAuthenticationState,
  type PageObservationState
} from "../lib/page-observer-registry";
import { resolveNavigationTarget } from "../lib/navigation-target";
import {
  adapterNodeCommandResultStatus,
  enforceCommandResultPayloadBound,
  executeRegisteredAdapterNode
} from "../lib/adapter-node-registry";
import {
  completeCoreCancellationAfterStageStop,
  requestAllianceStageCancellation
} from "../lib/alliance-retired-background";
import {
  ContentScriptRecovery,
  contentScriptFailureReason
} from "../lib/content-script-recovery";
import {
  shouldForgetTrackedObservation,
  shouldForceNewPageEpoch,
  shouldPreserveTrackedAuthentication,
  shouldReusePageEpoch
} from "../lib/page-observation-lifecycle";
import { matchesFrozenPageBinding } from "../lib/frozen-page-binding";
import {
  ManagedTabLifecycle,
  parseManagedTabObservations,
  type ManagedTabAdmission
} from "../lib/managed-tab-lifecycle";
import { NativeConnectionSupervisor } from "../lib/native-connection-supervisor";
import { measureProfileTabCount } from "../lib/profile-tab-usage";
import {
  EXTENSION_RUNTIME_LIMITS,
  ExtensionRuntimeResourceRegistry
} from "../lib/extension-runtime-resources";

const NATIVE_HOST = "com.bpa.browser";
const PROTOCOL = BROWSER_PROTOCOL;
const VERSION = "2.0.0";
const MANAGED_TABS_STORAGE_KEY = "bpaManagedCommandTabs";

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
  let connect: () => Promise<void>;
  const connectionSupervisor = new NativeConnectionSupervisor({
    onReconnect: () => void connect()
  });
  const activeCommands = new Set<string>();
  const activeTabCommands = new Map<number, string>();
  const managedTabs = new ManagedTabLifecycle();
  const cancelledCommands = new Set<string>();
  const activeAllianceStages = new Map<
    string,
    { readonly tabId: number; readonly requestId: string }
  >();
  const cancellationStopBarriers = new Map<string, Promise<boolean>>();
  const runtimeResources = new ExtensionRuntimeResourceRegistry();
  const observedTabs = new Map<
    number,
    {
      url: string;
      pageEpoch: string;
      observerCapabilityId: string;
      revision: number;
      lastObservationSignature?: string;
      contentScriptReady?: boolean;
      observationState?: PageObservationState;
      authenticationState?: PageAuthenticationState;
      authenticationContextRef?: string;
      windowId?: number;
    }
  >();
  const contentScriptRecovery = new ContentScriptRecovery();
  const assistancePanel = new AssistancePanelRepository({
    get: (key) => browser.storage.local.get(key),
    set: (value) => browser.storage.local.set(value)
  });
  let managedTabsPersistence: Promise<void> = Promise.resolve();
  const persistManagedTabs = async (): Promise<void> => {
    const snapshot = managedTabs.snapshot();
    managedTabsPersistence = managedTabsPersistence
      .catch(() => undefined)
      .then(() =>
        browser.storage.local.set({
          [MANAGED_TABS_STORAGE_KEY]: snapshot
        })
      );
    await managedTabsPersistence;
  };

  const handleManagedTabAdmission = async (
    admission: ManagedTabAdmission
  ): Promise<void> => {
    if (admission.status === "unmanaged") return;
    if (admission.status === "managed") {
      await persistManagedTabs();
      return;
    }
    cancelledCommands.add(admission.commandId);
    const closed = await browser.tabs
      .remove(admission.tabId)
      .then(() => true)
      .catch(() => false);
    await updateStatus({
      lastError: closed
        ? "BROWSER_MANAGED_TAB_UNRESERVED"
        : "BROWSER_MANAGED_TAB_OVERFLOW_CLOSE_FAILED"
    });
  };

  const recoverManagedTabs = async (): Promise<void> => {
    const stored = await browser.storage.local.get(MANAGED_TABS_STORAGE_KEY);
    const records = parseManagedTabObservations(
      stored[MANAGED_TABS_STORAGE_KEY]
    );
    const retained = [];
    for (const record of records) {
      const tab = await browser.tabs.get(record.tabId).catch(() => undefined);
      if (!tab) continue;
      const closed = await browser.tabs
        .remove(record.tabId)
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        retained.push(record);
        managedTabs.restore(record);
      }
    }
    await browser.storage.local.set({
      [MANAGED_TABS_STORAGE_KEY]: retained
    });
  };

  const startupRecovery = Promise.all([
    recoverInterruptedCommands(),
    recoverManagedTabs()
  ]);

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

  const sendCapabilities = async (): Promise<
    Awaited<ReturnType<typeof capabilityReport>>
  > => {
    const report = await capabilityReport();
    send(
      envelope(
        "capability.report",
        { ...report },
        "trace-capabilities"
      )
    );
    return report;
  };

  const supportedSourceUrl = (
    value: string | undefined
  ): URL | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return observerCapabilityForUrl(url.href) ? url : undefined;
    } catch {
      return undefined;
    }
  };

  const pageEpochFor = (
    tabId: number,
    url: string,
    windowId?: number,
    forceNew = false
  ): string => {
    const current = observedTabs.get(tabId);
    if (current && shouldReusePageEpoch(current, url, forceNew)) {
      return current.pageEpoch;
    }
    if (
      !current &&
      observedTabs.size >= EXTENSION_RUNTIME_LIMITS.observations
    ) {
      throw new Error("BROWSER_OBSERVATION_CAPACITY_EXCEEDED");
    }
    const pageEpoch = createPageEpoch(tabId);
    const observerCapabilityId = observerCapabilityForUrl(url);
    if (!observerCapabilityId) throw new Error("PAGE_OBSERVER_NOT_FOUND");
    observedTabs.set(tabId, {
      url,
      pageEpoch,
      observerCapabilityId,
      revision: current?.revision ?? 0,
      ...(windowId === undefined ? {} : { windowId })
    });
    return pageEpoch;
  };

  const reportPage = async (input: {
    tabId: number;
    windowId?: number;
    url: URL;
    contentScriptReady: boolean;
    authentication: {
      state: PageAuthenticationState;
      contextRef?: string;
    };
    observationState: PageObservationState;
    pageEpoch: string;
    observerCapabilityId: string;
    reasonCode?: string;
  }): Promise<void> => {
    const signature = JSON.stringify({
      url: input.url.href,
      contentScriptReady: input.contentScriptReady,
      authentication: input.authentication,
      observationState: input.observationState,
      pageEpoch: input.pageEpoch,
      observerCapabilityId: input.observerCapabilityId,
      reasonCode: input.reasonCode
    });
    const tracked = observedTabs.get(input.tabId);
    const preserveTrackedAuthentication = shouldPreserveTrackedAuthentication(
      input.observationState,
      input.authentication.state
    );
    const trackedAuthenticationState = preserveTrackedAuthentication
      ? tracked?.authenticationState
      : input.authentication.state;
    const trackedAuthenticationContextRef = preserveTrackedAuthentication
      ? tracked?.authenticationContextRef
      : input.authentication.contextRef;
    const revision =
      tracked?.lastObservationSignature === signature
        ? tracked.revision
        : (tracked?.revision ?? 0) + 1;
    observedTabs.set(input.tabId, {
      url: input.url.href,
      pageEpoch: input.pageEpoch,
      observerCapabilityId: input.observerCapabilityId,
      revision,
      lastObservationSignature: signature,
      contentScriptReady: input.contentScriptReady,
      observationState: input.observationState,
      ...(trackedAuthenticationState === undefined
        ? {}
        : { authenticationState: trackedAuthenticationState }),
      ...(trackedAuthenticationContextRef === undefined
        ? {}
        : { authenticationContextRef: trackedAuthenticationContextRef }),
      ...(input.windowId === undefined ? {} : { windowId: input.windowId })
    });
    if (!port || !session.sessionId) return;
    const stored = await browser.storage.local.get("browserInstanceId");
    if (typeof stored.browserInstanceId !== "string") return;
    send(
      envelope(
        "page.observation",
        {
          tab_ref: {
            browser_instance_id: stored.browserInstanceId,
            tab_id: input.tabId,
            ...(input.windowId === undefined
              ? {}
              : { window_id: input.windowId }),
            origin: input.url.origin
          },
          pathname: input.url.pathname,
          content_script_ready: input.contentScriptReady,
          authentication: {
            state: input.authentication.state,
            ...(input.authentication.contextRef
              ? { context_ref: input.authentication.contextRef }
              : {})
          },
          observation_state: input.observationState,
          page_epoch: input.pageEpoch,
          observation_revision: revision,
          observer_capability_id: input.observerCapabilityId,
          observed_at: new Date().toISOString(),
          ...(input.reasonCode ? { reason_code: input.reasonCode } : {})
        },
        `trace-page-${input.tabId}`
      )
    );
  };

  const invalidateTrackedTab = async (
    tabId: number,
    reasonCode: string
  ): Promise<void> => {
    const tracked = observedTabs.get(tabId);
    if (!tracked) return;
    const url = supportedSourceUrl(tracked.url);
    if (url) {
      await reportPage({
        tabId,
        ...(tracked.windowId === undefined
          ? {}
          : { windowId: tracked.windowId }),
        url,
        contentScriptReady: false,
        authentication: { state: "unknown" },
        observationState: "departed",
        pageEpoch: tracked.pageEpoch,
        observerCapabilityId: tracked.observerCapabilityId,
        reasonCode
      });
    }
    // Keep the last revision while a tab temporarily leaves a supported URL.
    // Login redirects can later return the same tab to the same source URL;
    // forgetting it here would restart the revision counter and make Core
    // reject the recovered observation as a conflicting stale update.
    if (shouldForgetTrackedObservation(reasonCode)) {
      observedTabs.delete(tabId);
    }
  };

  const probeTab = async (
    tabId: number,
    options: { forceNewEpoch?: boolean } = {}
  ): Promise<void> => {
    const generation = runtimeResources.beginProbe(tabId);
    if (generation === undefined) {
      await updateStatus({
        lastError: "BROWSER_PROBE_CAPACITY_EXCEEDED"
      });
      return;
    }
    try {
      const isCurrentProbe = (pageEpoch: string): boolean =>
        runtimeResources.isCurrentProbe(tabId, generation) &&
        observedTabs.get(tabId)?.pageEpoch === pageEpoch;
      let tab: Browser.tabs.Tab;
      try {
        tab = await browser.tabs.get(tabId);
      } catch {
        await invalidateTrackedTab(tabId, "TAB_CLOSED");
        return;
      }
      const url = supportedSourceUrl(tab.url);
      if (!url) {
        await invalidateTrackedTab(tabId, "PAGE_LEFT_SUPPORTED_SCOPE");
        return;
      }
      const observerCapabilityId = observerCapabilityForUrl(url.href);
      if (!observerCapabilityId) {
        await invalidateTrackedTab(tabId, "PAGE_OBSERVER_NOT_FOUND");
        return;
      }
      let pageEpoch: string;
      try {
        pageEpoch = pageEpochFor(
          tabId,
          url.href,
          tab.windowId,
          options.forceNewEpoch
        );
      } catch (error) {
        await updateStatus({
          lastError: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (tab.status !== "complete") {
        await reportPage({
          tabId,
          windowId: tab.windowId,
          url,
          contentScriptReady: false,
          authentication: { state: "unknown" },
          observationState: "loading",
          pageEpoch,
          observerCapabilityId,
          reasonCode: "PAGE_LOADING"
        });
        return;
      }
      try {
        const response = (await contentScriptRecovery.probe({
          tabId,
          probe: () =>
            browser.tabs.sendMessage(tabId, {
              type: "bpa.content.probe",
              pageEpoch
            }),
          inject: async () => {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ["/content-scripts/content.js"]
            });
          }
        })) as {
          pageEpoch?: string;
          observerCapabilityId?: string;
          authentication?: {
            state: PageAuthenticationState;
            contextRef?: string;
          };
          observationState?:
            | "loading"
            | "probing"
            | "auth_required"
            | "challenge"
            | "ready"
            | "departed"
            | "stale";
          reasonCode?: string;
        };
        if (
          response?.pageEpoch !== pageEpoch ||
          response.observerCapabilityId !== observerCapabilityId ||
          !response.authentication ||
          !response.observationState
        ) {
          throw new Error("CONTENT_PROBE_INVALID");
        }
        if (!isCurrentProbe(pageEpoch)) return;
        const tracked = observedTabs.get(tabId);
        const authenticationChanged =
          tracked?.lastObservationSignature !== undefined &&
          (tracked.authenticationState !== response.authentication.state ||
            tracked.authenticationContextRef !==
              response.authentication.contextRef);
        const observationEpoch = authenticationChanged
          ? pageEpochFor(tabId, url.href, tab.windowId, true)
          : pageEpoch;
        await reportPage({
          tabId,
          windowId: tab.windowId,
          url,
          contentScriptReady: true,
          authentication: response.authentication,
          observationState: response.observationState,
          pageEpoch: observationEpoch,
          observerCapabilityId,
          ...(response.reasonCode ? { reasonCode: response.reasonCode } : {})
        });
      } catch (error) {
        if (!isCurrentProbe(pageEpoch)) return;
        const reasonCode = contentScriptFailureReason(error);
        await reportPage({
          tabId,
          windowId: tab.windowId,
          url,
          contentScriptReady: false,
          authentication: { state: "unknown" },
          observationState:
            reasonCode === "BROWSER_CONTENT_SCRIPT_MISSING"
              ? "content_script_missing"
              : "stale",
          pageEpoch,
          observerCapabilityId,
          reasonCode
        });
      }
    } finally {
      runtimeResources.completeProbe(tabId, generation);
    }
  };

  const probeAllSourceTabs = async (): Promise<void> => {
    for (const tab of await browser.tabs.query({})) {
      if (tab.id != null && supportedSourceUrl(tab.url)) {
        await probeTab(tab.id);
      }
    }
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
    const boundTabId =
      typeof payload.tab_ref?.tab_id === "number"
        ? payload.tab_ref.tab_id
        : undefined;
    const tab =
      boundTabId === undefined
        ? undefined
        : await browser.tabs.get(boundTabId).catch(() => undefined);
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
    const storedBrowser = await browser.storage.local.get(
      "browserInstanceId"
    );
    const trackedPage =
      tab?.id == null ? undefined : observedTabs.get(tab.id);
    const frozenPage = boundTabId === undefined
      ? undefined
      : {
          browserInstanceId: String(
            payload.tab_ref.browser_instance_id
          ),
          tabId: boundTabId,
          ...(payload.tab_ref.window_id === undefined
            ? {}
            : { windowId: Number(payload.tab_ref.window_id) }),
          origin: String(payload.tab_ref.origin),
          pageEpoch: String(payload.page_epoch),
          observationRevision: Number(payload.observation_revision),
          ...(payload.authentication_context_ref === undefined
            ? {}
            : {
                authenticationContextRef: String(
                  payload.authentication_context_ref
                )
              })
        };
    const boundPageValid = Boolean(
      frozenPage &&
        matchesFrozenPageBinding(frozenPage, {
          browserInstanceId: storedBrowser.browserInstanceId,
          tabId: tab?.id,
          windowId: tab?.windowId,
          url: currentUrl,
          pageEpoch: trackedPage?.pageEpoch,
          revision: trackedPage?.revision,
          contentScriptReady: trackedPage?.contentScriptReady,
          observationState: trackedPage?.observationState,
          authenticationContextRef:
            trackedPage?.authenticationContextRef
        })
    );
    if (!authorization.valid || tab?.id == null || !boundPageValid) {
      send(
        envelope(
          "command.ack",
          {
            command_seq: payload.command_seq,
            command_id: payload.command_id,
            node_execution_id: payload.node_execution_id,
            accepted: false,
            fencing_token: payload.fencing_token,
            reason_code: !authorization.valid
              ? authorization.reason
              : tab?.id == null
                ? "BROWSER_PAGE_NOT_FOUND"
                : "BROWSER_OBSERVATION_STALE"
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
    const executingTabId = tab.id;
    const commandId = String(payload.command_id);
    const previouslyCompleted = (await listPendingResults()).find(
      (entry) => entry.commandId === commandId
    );
    if (previouslyCompleted) {
      await sendStoredResult(previouslyCompleted);
      return;
    }
    if (activeCommands.has(commandId)) {
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
      return;
    }
    if (
      (await listPendingCommandStarts()).some(
        (entry) => entry.commandId === commandId
      )
    ) {
      await recoverInterruptedCommands();
      const interrupted = (await listPendingResults()).find(
        (entry) => entry.commandId === commandId
      );
      if (interrupted) await sendStoredResult(interrupted);
      return;
    }
    if (activeCommands.size >= EXTENSION_RUNTIME_LIMITS.activeCommands) {
      send(
        envelope(
          "command.ack",
          {
            command_seq: payload.command_seq,
            command_id: payload.command_id,
            node_execution_id: payload.node_execution_id,
            accepted: false,
            fencing_token: payload.fencing_token,
            reason_code: "BROWSER_COMMAND_CAPACITY_EXCEEDED"
          },
          String(message.trace_id)
        )
      );
      return;
    }
    const occupyingCommand = activeTabCommands.get(executingTabId);
    if (occupyingCommand && occupyingCommand !== commandId) {
      send(
        envelope(
          "command.ack",
          {
            command_seq: payload.command_seq,
            command_id: payload.command_id,
            node_execution_id: payload.node_execution_id,
            accepted: false,
            fencing_token: payload.fencing_token,
            reason_code: "BROWSER_TAB_BUSY"
          },
          String(message.trace_id)
        )
      );
      return;
    }
    const nodeInput =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : {};
    let pageEpoch =
      typeof payload.page_epoch === "string" &&
      validPageEpoch(payload.page_epoch, tab.id)
        ? payload.page_epoch
        : payload.node.id === "browser.design.snapshot.capture" &&
      validPageEpoch(nodeInput.pageEpoch, tab.id)
        ? nodeInput.pageEpoch
        : createPageEpoch(tab.id);
    await savePendingCommandStart({
      commandId,
      commandSeq: Number(payload.command_seq),
      nodeExecutionId: String(payload.node_execution_id),
      idempotencyKey: String(payload.idempotency_key),
      fencingToken: Number(payload.fencing_token),
      traceId: String(message.trace_id),
      pageEpoch,
      startedAt: new Date().toISOString()
    });
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
    activeTabCommands.set(executingTabId, commandId);
    const releaseCommand = async (): Promise<void> => {
      activeCommands.delete(commandId);
      if (activeTabCommands.get(executingTabId) === commandId) {
        activeTabCommands.delete(executingTabId);
      }
      cancelledCommands.delete(commandId);
      cancellationStopBarriers.delete(commandId);
      activeAllianceStages.delete(commandId);
      const childTabIds = managedTabs.finish(commandId);
      for (const childTabId of childTabIds) {
        const closed = await browser.tabs
          .remove(childTabId)
          .then(() => true)
          .catch(() => false);
        if (closed) managedTabs.forget(childTabId);
      }
      await persistManagedTabs();
    };
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
      const rateKey =
        rateScope === "domain"
          ? `domain:${origin}`
          : rateScope === "authentication_context"
            ? `authentication-context:${origin}:${String(
                payload.authentication_context_ref ?? "anonymous"
              )}`
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
          runtimeResources.pacingReservation(rateKey)
        ),
        deadline: Date.parse(payload.deadline),
        policy: timingPolicy
      });
      if (!reservation.accepted) {
        throw new Error(reservation.reason);
      }
      if (!runtimeResources.reservePacing(rateKey, reservation.executeAt)) {
        throw new Error("RATE_LIMIT_QUEUE_EXCEEDED");
      }
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
      if (cancelledCommands.has(commandId)) {
        const safeStop =
          cancellationStopBarriers.get(commandId) ?? Promise.resolve(true);
        cancelledCommands.delete(commandId);
        cancellationStopBarriers.delete(commandId);
        const completed = await completeCoreCancellationAfterStageStop({
          safeStop,
          onStopped: async () => {
            await removePendingCommandStart(commandId);
            await releaseCommand();
            sendCancelled();
          }
        });
        if (!completed) {
          throw new Error("BROWSER_DISCONNECTED");
        }
        return;
      }
      if (Date.now() >= Date.parse(payload.deadline)) {
        throw new Error("DEADLINE_EXCEEDED");
      }
      await probeTab(tab.id);
      let currentTab = await browser.tabs.get(tab.id).catch(() => undefined);
      const refreshedPage = observedTabs.get(tab.id);
      const bindingStillValid = Boolean(
        frozenPage &&
          matchesFrozenPageBinding(frozenPage, {
            browserInstanceId: storedBrowser.browserInstanceId,
            tabId: currentTab?.id,
            windowId: currentTab?.windowId,
            url: currentTab?.url,
            pageEpoch: refreshedPage?.pageEpoch,
            revision: refreshedPage?.revision,
            contentScriptReady: refreshedPage?.contentScriptReady,
            observationState: refreshedPage?.observationState,
            authenticationContextRef:
              refreshedPage?.authenticationContextRef
          })
      );
      let navigationReady = true;
      let navigationBlocked = false;
      if (!bindingStillValid) {
        navigationBlocked = true;
        adapterResponse = {
          ok: false,
          error: {
            code: "BROWSER_OBSERVATION_STALE",
            message:
              "The frozen page or authentication context changed before execution.",
            retryable: false
          },
          riskSignals: [
            {
              code: "PAGE_CONTEXT_CHANGED",
              category: "page_context",
              severity: "blocking",
              source: "bridge",
              detected_at: new Date().toISOString(),
              detail: "执行前页面观察或认证上下文已变化，命令已停止。"
            }
          ]
        };
      } else if (
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
        currentTab = await browser.tabs.get(tab.id).catch(() => undefined);
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
        // Limit ownership to the actual adapter execution window. Pacing,
        // preflight, and navigation waits must not claim a tab opened by a
        // human or another RPA that happens to share the source page.
        managedTabs.start(commandId, executingTabId);
        const registeredResponse = await executeRegisteredAdapterNode(
          payload.node.id,
          nodeInput,
          {
            sourceTabId: tab.id,
            deadline: String(payload.deadline),
            isCancelled: () => cancelledCommands.has(commandId),
            reserveManagedTab: () => managedTabs.reserve(commandId),
            releaseManagedTabReservation: () =>
              managedTabs.releaseReservation(commandId),
            onAllianceStageStarted: (stage) => {
              activeAllianceStages.set(commandId, stage);
            },
            onAllianceStageStopped: (requestId) => {
              if (
                activeAllianceStages.get(commandId)?.requestId === requestId
              ) {
                activeAllianceStages.delete(commandId);
              }
            }
          }
        );
        if (registeredResponse) {
          adapterResponse = { ...registeredResponse, pageEpoch };
          await probeTab(tab.id);
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
        }
        const completedTab = await browser.tabs
          .get(tab.id)
          .catch(() => undefined);
        if (
          completedTab?.id !== tab.id ||
          completedTab.url !== executionUrl
        ) {
          adapterResponse = {
            ok: false,
            error: {
              code: "PAGE_CONTEXT_CHANGED",
              message: "The bound page changed before result validation.",
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
    if (cancelledCommands.has(commandId)) {
      const safeStop =
        cancellationStopBarriers.get(commandId) ?? Promise.resolve(true);
      cancelledCommands.delete(commandId);
      cancellationStopBarriers.delete(commandId);
      const completed = await completeCoreCancellationAfterStageStop({
        safeStop,
        onStopped: async () => {
          await releaseCommand();
          sendCancelled();
        }
      });
      if (!completed) {
        adapterResponse = {
          ok: false,
          error: {
            code: "BROWSER_DISCONNECTED",
            message: "Active Alliance stage cancellation was not confirmed.",
            retryable: false
          }
        };
      } else return;
    }
    const resultPayload = enforceCommandResultPayloadBound({
        command_seq: payload.command_seq,
        command_id: payload.command_id,
        node_execution_id: payload.node_execution_id,
        idempotency_key: payload.idempotency_key,
        fencing_token: payload.fencing_token,
        status: adapterNodeCommandResultStatus(adapterResponse),
        ...(adapterResponse.output
          ? {
              output: {
                ...adapterResponse.output,
                ...(resolveCapability(
                  payload.node.id,
                  payload.node.version
                )?.includePageContext
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
      });
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
      await removePendingCommandStart(commandId);
      await sendEvidenceUpload(evidenceUpload);
    } finally {
      await releaseCommand();
    }
    if (resultPayload.status === "succeeded") {
      await assistancePanel.remove(String(payload.node_execution_id));
    } else {
      const blockingRisk = firstBlockingRiskSignal(
        resultPayload.risk_signals ?? []
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
          : resultPayload.error?.code === "PAGE_CONTEXT_CHANGED" ||
              resultPayload.error?.code === "PAGE_EPOCH_MISMATCH"
            ? "page_attention"
            : "adapter_attention"
      });
    }
    await updateStatus({
      currentTask: payload.node_execution_id,
      lastError: resultPayload.error?.message
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
        const capabilityReportPayload = await sendCapabilities();
        await updateStatus({
          host: "connected",
          core: "connected",
          protocol: PROTOCOL,
          sessionId: session.sessionId,
          permissions: [
            ...new Set(
              capabilityReportPayload.capabilities.flatMap(
                (capability) => capability.permissions
              )
            )
          ],
          lastError: undefined
        });
        await probeAllSourceTabs();
        await sendPending();
        break;
      }
      case "session.resume":
        await sendPending();
        break;
      case "page.probe.request": {
        const requestId = message.payload.request_id;
        const tabRef = message.payload.tab_ref;
        const deadline = Date.parse(message.payload.deadline);
        const stored = await browser.storage.local.get("browserInstanceId");
        const validInstance =
          stored.browserInstanceId === tabRef.browser_instance_id;
        const validDeadline = Number.isFinite(deadline) && Date.now() < deadline;
        const tab = validInstance
          ? await browser.tabs.get(tabRef.tab_id).catch(() => undefined)
          : undefined;
        let accepted = false;
        let reasonCode: string | undefined;
        if (!validInstance) reasonCode = "BROWSER_INSTANCE_MISMATCH";
        else if (!validDeadline) reasonCode = "PAGE_PROBE_DEADLINE_EXCEEDED";
        else if (!tab?.url) reasonCode = "BROWSER_PAGE_NOT_FOUND";
        else if (new URL(tab.url).origin !== tabRef.origin) {
          reasonCode = "BROWSER_ORIGIN_MISMATCH";
        } else {
          await probeTab(tabRef.tab_id);
          accepted = observedTabs.has(tabRef.tab_id);
          if (!accepted) reasonCode = "BROWSER_OBSERVATION_PENDING";
        }
        send(
          envelope(
            "page.probe.result",
            {
              request_id: requestId,
              tab_ref: tabRef,
              accepted,
              observation_revision:
                observedTabs.get(tabRef.tab_id)?.revision ?? 1,
              ...(reasonCode ? { reason_code: reasonCode } : {})
            },
            message.trace_id
          )
        );
        break;
      }
      case "command.dispatch":
        await handleCommand(message);
        break;
      case "cancel.request": {
        const commandId = String(message.payload.command_id);
        const pending = (await listPendingResults()).some(
          (entry) => entry.commandId === commandId
        );
        const actionStarted = activeCommands.has(commandId);
        const activeAllianceStage = activeAllianceStages.get(commandId);
        const safeStop = activeAllianceStage
          ? requestAllianceStageCancellation(
              activeAllianceStage.tabId,
              activeAllianceStage.requestId
            )
          : Promise.resolve(true);
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
          cancellationStopBarriers.set(commandId, safeStop);
          if (!actionStarted) {
            cancelledCommands.delete(commandId);
            cancellationStopBarriers.delete(commandId);
            await completeCoreCancellationAfterStageStop({
              safeStop,
              onStopped: () => {
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
            });
          }
        }
        break;
      }
      case "result.ack":
        if (
          shouldRemovePendingResultAfterAck({
            accepted: message.payload.accepted === true,
            ...(typeof message.payload.reason_code === "string"
              ? { reasonCode: message.payload.reason_code }
              : {})
          })
        ) {
          const commandId = String(message.payload.command_id);
          const pending = (await listPendingResults()).find(
            (entry) => entry.commandId === commandId
          );
          if (pending && message.payload.accepted) {
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
      case "heartbeat.ping": {
        const profileTabs = await measureProfileTabCount(() =>
          browser.tabs.query({})
        );
        const usage = runtimeResources.usage();
        const managedTabUsage = managedTabs.usage();
        send(
          envelope(
            "heartbeat.pong",
            {
              nonce: message.payload.nonce,
              resource_usage: {
                active_commands: activeCommands.size,
                active_tab_commands: activeTabCommands.size,
                active_alliance_stages: activeAllianceStages.size,
                cancellation_requests: cancelledCommands.size,
                cancellation_stop_barriers: cancellationStopBarriers.size,
                observed_tabs: observedTabs.size,
                observation_capacity: EXTENSION_RUNTIME_LIMITS.observations,
                profile_tabs: profileTabs,
                managed_tabs: managedTabUsage.active,
                managed_tab_reservations: managedTabUsage.reserved,
                managed_tab_capacity: managedTabUsage.capacity,
                pacing_reservations: {
                  active: usage.pacingReservations.active,
                  capacity: usage.pacingReservations.capacity,
                  ttl_ms: usage.pacingReservations.ttlMs
                },
                probes: {
                  active: usage.probes.active,
                  capacity: usage.probes.capacity,
                  ttl_ms: usage.probes.ttlMs
                }
              }
            },
            message.trace_id
          )
        );
        break;
      }
      case "session.error":
        await updateStatus({ lastError: message.payload.message });
        break;
    }
  };

  connect = async (): Promise<void> => {
    const generation = connectionSupervisor.begin();
    if (generation === undefined) return;
    let candidatePort: Browser.runtime.Port | undefined;
    try {
      await startupRecovery;
      const stored = await browser.storage.local.get([
        "browserInstanceId",
        "resumeToken",
        "lastAckedCommandSeq"
      ]);
      const browserInstanceId =
        stored.browserInstanceId ?? crypto.randomUUID();
      await browser.storage.local.set({ browserInstanceId });
      if (!connectionSupervisor.connecting(generation)) return;
      candidatePort = browser.runtime.connectNative(NATIVE_HOST);
      const activePort = candidatePort;
      if (!connectionSupervisor.connected(generation)) {
        activePort.disconnect();
        return;
      }
      port = activePort;
      delete session.sessionId;
      delete session.keyId;
      delete session.publicKey;
      session.incomingSeq = 0;
      session.outgoingSeq = 0;
      activePort.onMessage.addListener((message) => {
        if (
          !connectionSupervisor.accepts(generation) ||
          port !== activePort
        ) {
          return;
        }
        const nativeMessage = message as Record<string, any>;
        void handleMessage(nativeMessage)
          .then(async () => {
            if (nativeMessage.type !== "session.welcome") return;
            if (typeof session.sessionId !== "string") {
              const retryDelayMs = connectionSupervisor.failed(generation);
              if (retryDelayMs === undefined) return;
              if (port === activePort) port = undefined;
              activePort.disconnect();
              await updateStatus({
                host: "disconnected",
                core: "disconnected",
                lastError: "Native Host 会话握手未建立。",
                reconnectInMs: retryDelayMs
              });
              return;
            }
            connectionSupervisor.ready(generation);
          })
          .catch(async (error) => {
            if (
              !connectionSupervisor.accepts(generation) ||
              port !== activePort
            ) {
              return;
            }
            if (nativeMessage.type !== "session.welcome") {
              await updateStatus({
                lastError:
                  error instanceof Error ? error.message : String(error)
              });
              return;
            }
            const retryDelayMs = connectionSupervisor.failed(generation);
            if (retryDelayMs === undefined) return;
            if (port === activePort) port = undefined;
            activePort.disconnect();
            await updateStatus({
              host: "disconnected",
              core: "disconnected",
              lastError:
                error instanceof Error ? error.message : String(error),
              reconnectInMs: retryDelayMs
            });
          });
      });
      activePort.onDisconnect.addListener(() => {
        const retryDelayMs = connectionSupervisor.disconnected(generation);
        if (retryDelayMs === undefined) return;
        if (port === activePort) port = undefined;
        void updateStatus({
          host: "disconnected",
          core: "disconnected",
          lastError: browser.runtime.lastError?.message,
          reconnectInMs: retryDelayMs
        });
      });
      send(
        envelope(
          "session.hello",
          {
            browser_instance_id: browserInstanceId,
            extension_id: browser.runtime.id,
            extension_version: browser.runtime.getManifest().version,
            bridge_build_id:
              browser.runtime.getManifest().version_name ??
              browser.runtime.getManifest().version,
            supported_protocols: [PROTOCOL],
            features: [...BROWSER_FEATURES],
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
      const retryDelayMs = connectionSupervisor.failed(generation);
      if (retryDelayMs === undefined) return;
      if (port === candidatePort) port = undefined;
      candidatePort?.disconnect();
      await updateStatus({
        host: "disconnected",
        core: "disconnected",
        lastError: error instanceof Error ? error.message : String(error),
        reconnectInMs: retryDelayMs
      });
    }
  };

  browser.runtime.onSuspend.addListener(() => {
    connectionSupervisor.stop();
    const activePort = port;
    port = undefined;
    activePort?.disconnect();
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type ===
        "bpa.page.observation.get"
    ) {
      const tabId = Number((message as { tabId?: unknown }).tabId);
      if (!Number.isSafeInteger(tabId) || tabId < 0) {
        return Promise.resolve({
          ok: false,
          error: "BROWSER_PAGE_NOT_FOUND"
        });
      }
      return (async () => {
        await probeTab(tabId);
        const tracked = observedTabs.get(tabId);
        const tab = await browser.tabs.get(tabId).catch(() => undefined);
        const stored = await browser.storage.local.get("browserInstanceId");
        if (!tracked || !tab?.url || !stored.browserInstanceId) {
          return { ok: false, error: "BROWSER_OBSERVATION_PENDING" };
        }
        const url = new URL(tab.url);
        return {
          ok: true,
          observation: {
            browserInstanceId: stored.browserInstanceId,
            tabId,
            ...(tracked.windowId === undefined
              ? {}
              : { windowId: tracked.windowId }),
            origin: url.origin,
            pathname: url.pathname,
            pageEpoch: tracked.pageEpoch,
            revision: tracked.revision,
            contentScriptReady: tracked.contentScriptReady === true,
            authentication: tracked.authenticationState ?? "unknown",
            observationState: tracked.observationState ?? "probing"
          }
        };
      })();
    }
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "bpa.content.ready" &&
      sender.tab?.id != null
    ) {
      if (!activeTabCommands.has(sender.tab.id)) {
        void probeTab(sender.tab.id);
      }
    }
    return undefined;
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      void probeTab(tabId, {
        forceNewEpoch: shouldForceNewPageEpoch(
          observedTabs.get(tabId),
          changeInfo
        )
      });
    } else if (changeInfo.status === "complete" || changeInfo.url) {
      void probeTab(tabId);
    }
  });
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void probeTab(tabId);
  });
  browser.tabs.onCreated.addListener((tab) => {
    void handleManagedTabAdmission(managedTabs.observeCreated(tab));
  });
  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void handleManagedTabAdmission(
      managedTabs.observeAttributed(details.tabId, details.sourceTabId)
    );
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    managedTabs.forget(tabId);
    void persistManagedTabs();
    contentScriptRecovery.forget(tabId);
    runtimeResources.forgetProbe(tabId);
    void invalidateTrackedTab(tabId, "TAB_CLOSED");
  });
  setInterval(() => void probeAllSourceTabs(), 10_000);
  void connect();
});
