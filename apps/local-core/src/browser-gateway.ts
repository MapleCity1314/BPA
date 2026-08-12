import { createHash, randomBytes, randomUUID } from "node:crypto";
import { compileWorkflow, contentDigest, MemoryNodeCatalog } from "@bpa/compiler";
import type { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import {
  BROWSER_PROTOCOL,
  BROWSER_PROTOCOL_MAX_MESSAGE_BYTES,
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BPA_EXTENSION_ID,
  ProtocolSessionGuard,
  RESUME_TOKEN_TTL_MS,
  assertNativeHostOrigin,
  signPermissionGrant,
  type CoreSigningKey,
  type PermissionGrantBody
} from "@bpa/gateway-core";
import type {
  AuthoringStore,
  BrowserObservationStore,
  BrowserCapabilityRecord,
  ExecutionStore,
  GatewayCommandRecord,
  GatewayCommandStore,
  RecoveryStateStore,
  RegistryStore
} from "@bpa/persistence";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import type {
  BrowserProtocolMessage,
  NodeDefinition,
  RiskSignal,
  RiskLevel,
  WorkflowDefinition
} from "@bpa/schemas";
import {
  BrowserEvidenceError,
  type BrowserEvidenceAcknowledgement,
  type BrowserEvidenceReceiver
} from "./browser-evidence.js";
import { PageProbeRegistry } from "./page-probe-registry.js";

type Message = BrowserProtocolMessage & {
  payload: Record<string, unknown>;
};

type BrowserGatewayPersistence = BrowserObservationStore &
  ExecutionStore &
  GatewayCommandStore &
  RecoveryStateStore &
  RegistryStore &
  Pick<AuthoringStore, "getDesignModeGrant">;

export interface BrowserGatewayStatus {
  connected: boolean;
  ready: boolean;
  activeSessionCount?: number;
  sessionId?: string;
  browserInstanceId?: string;
  extensionId: string;
  capabilityCount: number;
  resourceUsage: {
    connectionCount: number;
    readySessionCount: number;
    pendingCancelRequestCount: number;
    nativeHostPids: number[];
    queue: {
      pendingBrowserOutbox: number;
      queuedCommands: number;
      inFlightCommands: number;
      terminalResultsPendingApplication: number;
      totalPending: number;
    };
    pageProbes: {
      active: number;
      capacity: number;
      ttlMs: number;
    };
    extension: ExtensionResourceUsage | null;
  };
  lastError?: string;
}

export interface ExtensionResourceUsage {
  activeCommands: number;
  activeTabCommands: number;
  activeAllianceStages: number;
  cancellationRequests: number;
  cancellationStopBarriers: number;
  observedTabs: number;
  observationCapacity: number;
  profileTabs: number;
  managedTabs: number;
  managedTabReservations: number;
  managedTabCapacity: number;
  pacingReservations: {
    active: number;
    capacity: number;
    ttlMs: number;
  };
  probes: {
    active: number;
    capacity: number;
    ttlMs: number;
  };
}

interface ActiveSession {
  id: string;
  browserInstanceId: string;
  extensionVersion: string;
  bridgeBuildId: string;
  connectedAt: number;
  incoming: ProtocolSessionGuard;
  incomingSeq: number;
  outgoingSeq: number;
  lastAckedCommandSeq: number;
  ready: boolean;
  capabilities: BrowserCapabilityRecord[];
  extensionResourceUsage?: ExtensionResourceUsage;
  lastHeartbeatSentAt?: number;
  pendingHeartbeatNonce?: string;
}

const BROWSER_HEARTBEAT_INTERVAL_MS = 20_000;

interface BrowserConnection {
  id: string;
  attachedOrder: number;
  nativeHostPid: number;
  send: (message: Message) => void;
  session?: ActiveSession;
  lastError?: string;
  cancelRequests: Set<string>;
}

export function observationCoversFrozenRevision(
  currentRevision: number,
  frozenRevision: number
): boolean {
  return (
    Number.isSafeInteger(currentRevision) &&
    Number.isSafeInteger(frozenRevision) &&
    currentRevision >= frozenRevision
  );
}

function parseExtensionResourceUsage(
  value: unknown
): ExtensionResourceUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const pacing = record.pacing_reservations;
  const probes = record.probes;
  if (
    pacing === null ||
    typeof pacing !== "object" ||
    Array.isArray(pacing) ||
    probes === null ||
    typeof probes !== "object" ||
    Array.isArray(probes)
  ) {
    return undefined;
  }
  const pacingRecord = pacing as Record<string, unknown>;
  const probeRecord = probes as Record<string, unknown>;
  const integers = [
    record.active_commands,
    record.active_tab_commands,
    record.active_alliance_stages,
    record.cancellation_requests,
    record.cancellation_stop_barriers,
    record.observed_tabs,
    record.observation_capacity,
    record.profile_tabs,
    record.managed_tabs,
    record.managed_tab_reservations,
    record.managed_tab_capacity,
    pacingRecord.active,
    pacingRecord.capacity,
    pacingRecord.ttl_ms,
    probeRecord.active,
    probeRecord.capacity,
    probeRecord.ttl_ms
  ];
  if (
    !integers.every(
      (candidate) => Number.isSafeInteger(candidate) && Number(candidate) >= 0
    )
  ) {
    return undefined;
  }
  const usage = {
    activeCommands: Number(record.active_commands),
    activeTabCommands: Number(record.active_tab_commands),
    activeAllianceStages: Number(record.active_alliance_stages),
    cancellationRequests: Number(record.cancellation_requests),
    cancellationStopBarriers: Number(record.cancellation_stop_barriers),
    observedTabs: Number(record.observed_tabs),
    observationCapacity: Number(record.observation_capacity),
    profileTabs: Number(record.profile_tabs),
    managedTabs: Number(record.managed_tabs),
    managedTabReservations: Number(record.managed_tab_reservations),
    managedTabCapacity: Number(record.managed_tab_capacity),
    pacingReservations: {
      active: Number(pacingRecord.active),
      capacity: Number(pacingRecord.capacity),
      ttlMs: Number(pacingRecord.ttl_ms)
    },
    probes: {
      active: Number(probeRecord.active),
      capacity: Number(probeRecord.capacity),
      ttlMs: Number(probeRecord.ttl_ms)
    }
  } satisfies ExtensionResourceUsage;
  return usage.activeCommands <= 32 &&
    usage.activeTabCommands <= usage.activeCommands &&
    usage.activeAllianceStages <= usage.activeCommands &&
    usage.cancellationRequests <= usage.activeCommands &&
    usage.cancellationStopBarriers === usage.cancellationRequests &&
    usage.observationCapacity === 64 &&
    usage.observedTabs <= usage.observationCapacity &&
    usage.profileTabs <= 1024 &&
    usage.managedTabCapacity === 8 &&
    usage.managedTabs + usage.managedTabReservations <=
      usage.managedTabCapacity &&
    usage.pacingReservations.capacity === 64 &&
    usage.pacingReservations.active <= usage.pacingReservations.capacity &&
    usage.pacingReservations.ttlMs === 120_000 &&
    usage.probes.capacity === 32 &&
    usage.probes.active <= usage.probes.capacity &&
    usage.probes.ttlMs === 30_000
    ? usage
    : undefined;
}

function compareExtensionVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const difference =
      (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function rejectDesignCapture(
  code: string,
  message: string
): RuntimeOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

export function validateDesignCaptureInvocation(
  persistence: Pick<AuthoringStore, "getDesignModeGrant">,
  invocation: RuntimeInvocation
): RuntimeOutcome | undefined {
  if (invocation.node.id !== "browser.design.snapshot.capture") {
    return undefined;
  }
  const input =
    invocation.input !== null &&
    typeof invocation.input === "object" &&
    !Array.isArray(invocation.input)
      ? (invocation.input as Record<string, JsonValue>)
      : undefined;
  if (!input) {
    return rejectDesignCapture(
      "DESIGN_GRANT_INVALID",
      "Design capture requires a governed object input."
    );
  }
  const grantId = input.designGrantId;
  const grant =
    typeof grantId === "string"
      ? persistence.getDesignModeGrant(grantId)
      : undefined;
  if (!grant) {
    return rejectDesignCapture(
      "DESIGN_GRANT_MISSING",
      "The exact Design Mode Grant is unavailable."
    );
  }
  if (
    grant.state !== "active" ||
    Date.parse(grant.expiresAt) <= Date.now()
  ) {
    return rejectDesignCapture(
      "DESIGN_GRANT_INACTIVE",
      "The Design Mode Grant is inactive or expired."
    );
  }
  const boundSessionIds = [
    ...new Set(
      Object.values(invocation.resourceBindings ?? {}).map(
        (resource) => resource.binding.sessionId
      )
    )
  ];
  const boundOrigins = [
    ...new Set(
      Object.values(invocation.resourceBindings ?? {}).map(
        (resource) => resource.binding.origin
      )
    )
  ];
  if (
    boundSessionIds.length !== 1 ||
    boundSessionIds[0] !== grant.browserSessionId ||
    boundOrigins.length !== 1 ||
    boundOrigins[0] !== grant.origin
  ) {
    return rejectDesignCapture(
      "DESIGN_GRANT_RESOURCE_MISMATCH",
      "The frozen Browser Resource differs from the Design Mode Grant."
    );
  }
  if (
    input.authoringSessionId !== grant.authoringSessionId ||
    input.profileId !== grant.profileId ||
    input.pageEpoch !== grant.pageEpoch ||
    !grant.pageEpoch.startsWith(`tab-${grant.tabId}:`) ||
    !grant.allowedOperations.includes("semantic_snapshot")
  ) {
    return rejectDesignCapture(
      "DESIGN_GRANT_CONTEXT_MISMATCH",
      "Session, profile, tab, page epoch, or operation differs from the grant."
    );
  }
  return undefined;
}

export class LocalBrowserGateway implements RuntimeProvider {
  readonly id = "browser";
  readonly #extensionId: string;
  readonly #connections = new Map<string, BrowserConnection>();
  #attachedOrder = 0;
  readonly #pageProbes = new PageProbeRegistry();

  constructor(
    readonly persistence: BrowserGatewayPersistence,
    readonly engine: LocalWorkflowEngine,
    readonly signingKey: CoreSigningKey,
    extensionId =
      process.env.BPA_EXTENSION_ID ?? DEFAULT_BPA_EXTENSION_ID,
    readonly evidence?: BrowserEvidenceReceiver,
    readonly expectedBridgeBuildId = process.env.BPA_RUNTIME_ID?.trim()
  ) {
    this.#extensionId = extensionId;
    this.persistence.pruneBrowserPageObservations({
      observedBefore: new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1_000
      ).toISOString()
    });
  }

  attach(
    origin: string,
    nativeHostPid: number,
    send: (message: Message) => void
  ): string {
    assertNativeHostOrigin(origin, this.#extensionId);
    if (!Number.isSafeInteger(nativeHostPid) || nativeHostPid <= 0) {
      throw new Error("Native Host process ID is invalid");
    }
    if (
      [...this.#connections.values()].some(
        (connection) => connection.nativeHostPid === nativeHostPid
      )
    ) {
      throw new Error("Native Host process already has an active connection");
    }
    const connectionId = randomUUID();
    this.#connections.set(connectionId, {
      id: connectionId,
      attachedOrder: ++this.#attachedOrder,
      nativeHostPid,
      send,
      cancelRequests: new Set()
    });
    return connectionId;
  }

  detach(connectionId?: string): void {
    const connection = connectionId
      ? this.#connections.get(connectionId)
      : this.#primaryConnection(false);
    if (!connection) return;
    if (connection.session) {
      const disconnectedAt = new Date().toISOString();
      this.persistence.updateBrowserSession({
        id: connection.session.id,
        disconnectedAt
      });
      this.persistence.invalidateBrowserPageObservations({
        sessionId: connection.session.id,
        observedAt: disconnectedAt,
        reasonCode: "BROWSER_BRIDGE_DISCONNECTED"
      });
      this.#pageProbes.forgetPrefix(`${connection.session.id}:`);
    }
    this.#connections.delete(connection.id);
  }

  status(): BrowserGatewayStatus {
    const primary =
      this.#primaryConnection() ?? this.#primaryConnection(false);
    const readySessionCount = [...this.#connections.values()].filter(
      (connection) => connection.session?.ready
    ).length;
    const commands = this.persistence.listPendingGatewayCommands();
    const pendingBrowserOutbox = this.persistence
      .listPendingEngineOutbox()
      .filter((message) => message.topic === "browser.command.requested")
      .length;
    const queuedCommands = commands.filter(
      (command) => command.state === "queued"
    ).length;
    const inFlightCommands = commands.length - queuedCommands;
    const terminalResultsPendingApplication =
      this.persistence.listGatewayCommandsNeedingApplication().length;
    return {
      connected: this.#connections.size > 0,
      ready: Boolean(primary?.session?.ready),
      activeSessionCount: readySessionCount,
      ...(primary?.session ? { sessionId: primary.session.id } : {}),
      ...(primary?.session
        ? { browserInstanceId: primary.session.browserInstanceId }
        : {}),
      extensionId: this.#extensionId,
      capabilityCount: primary?.session?.capabilities.length ?? 0,
      resourceUsage: {
        connectionCount: this.#connections.size,
        readySessionCount,
        pendingCancelRequestCount: [...this.#connections.values()].reduce(
          (total, connection) => total + connection.cancelRequests.size,
          0
        ),
        nativeHostPids: [...this.#connections.values()]
          .map((connection) => connection.nativeHostPid)
          .sort((left, right) => left - right),
        queue: {
          pendingBrowserOutbox,
          queuedCommands,
          inFlightCommands,
          terminalResultsPendingApplication,
          totalPending:
            pendingBrowserOutbox +
            queuedCommands +
            inFlightCommands +
            terminalResultsPendingApplication
        },
        pageProbes: this.#pageProbes.usage(),
        extension: primary?.session?.extensionResourceUsage ?? null
      },
      ...(primary?.lastError ? { lastError: primary.lastError } : {})
    };
  }

  requestPageProbe(input: {
    sessionId: string;
    browserInstanceId: string;
    tabId: number;
    windowId?: number;
    origin: string;
    timeoutMs?: number;
    requestId?: string;
  }): { requestId: string; deadline: string } {
    const connection = [...this.#connections.values()].find(
      (candidate) =>
        candidate.session?.ready === true &&
        candidate.session.id === input.sessionId &&
        candidate.session.browserInstanceId === input.browserInstanceId
    );
    if (!connection) throw new Error("BROWSER_BRIDGE_DISCONNECTED");
    const requestId = input.requestId ?? randomUUID();
    const reservedHere = input.requestId === undefined;
    if (reservedHere) {
      const reservation = this.#pageProbes.reserve(
        `${input.sessionId}:${input.tabId}`,
        requestId,
        Date.now()
      );
      if (reservation === "throttled") {
        throw new Error("PAGE_PROBE_THROTTLED");
      }
      if (reservation === "capacity_exceeded") {
        throw new Error("PAGE_PROBE_CAPACITY_EXCEEDED");
      }
    }
    const deadline = new Date(
      Date.now() + Math.min(10_000, Math.max(500, input.timeoutMs ?? 5_000))
    ).toISOString();
    try {
      this.#sendMessage(
        connection,
        "page.probe.request",
        {
          request_id: requestId,
          tab_ref: {
            browser_instance_id: input.browserInstanceId,
            tab_id: input.tabId,
            ...(input.windowId === undefined
              ? {}
              : { window_id: input.windowId }),
            origin: input.origin
          },
          deadline
        },
        `trace-page-probe-${requestId}`
      );
    } catch (error) {
      if (reservedHere) this.#pageProbes.complete(requestId);
      throw error;
    }
    return { requestId, deadline };
  }

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    const published = this.persistence.getPublished(
      "node",
      node.id,
      node.version
    );
    return (
      published !== undefined &&
      published.digest === node.digest &&
      (published.content as { runtime?: unknown }).runtime === "browser"
    );
  }

  invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (!this.supports(invocation.node)) {
      return Promise.resolve({
        status: "rejected",
        error: {
          code: "BROWSER_NODE_NOT_PUBLISHED",
          message: `Published browser Node is unavailable: ${invocation.node.id}@${invocation.node.version}`,
          retryable: false
        },
        evidence: [],
        riskSignals: []
      });
    }
    const designRejection = validateDesignCaptureInvocation(
      this.persistence,
      invocation
    );
    if (designRejection) return Promise.resolve(designRejection);
    const boundSessionIds = [
      ...new Set(
        Object.values(invocation.resourceBindings ?? {}).map(
          (resource) => resource.binding.sessionId
        )
      )
    ];
    if (boundSessionIds.length > 1) {
      return Promise.resolve({
        status: "rejected",
        error: {
          code: "BROWSER_MULTI_SESSION_NODE_UNSUPPORTED",
          message:
            "One Browser Node invocation cannot span multiple Browser Sessions.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      });
    }
    const commandId = this.#runtimeCommandId(invocation.invocationId);
    if (!this.persistence.getGatewayCommand(commandId)) {
      this.#enqueueRuntimeInvocation(commandId, invocation);
    }
    this.dispatchPending();
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: RuntimeOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => {
        this.#cancelRuntimeCommand(commandId);
        finish({
          status: "timed_out",
          error: {
            code: "BROWSER_DEADLINE_EXCEEDED",
            message: "Browser invocation exceeded its frozen deadline.",
            retryable: true
          },
          evidence: [],
          riskSignals: []
        });
      };
      const poll = () => {
        const command = this.persistence.getGatewayCommand(commandId);
        if (command?.state === "terminal" && command.result !== undefined) {
          finish(this.#runtimeOutcome(command.result));
          return;
        }
        if (signal.aborted || Date.now() >= invocation.deadlineAt) {
          onAbort();
          return;
        }
        timer = setTimeout(poll, 50);
        timer.unref();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      poll();
    });
  }

  async cancel(
    invocationId: string,
    _fencingToken: number
  ): Promise<void> {
    this.#cancelRuntimeCommand(this.#runtimeCommandId(invocationId));
  }

  handle(message: unknown, connectionId?: string): void {
    const connection = this.#resolveConnection(connectionId);
    try {
      const candidate = message as Message;
      if (!connection.session) {
        const features = Array.isArray(candidate.payload?.features)
          ? candidate.payload.features.map(String)
          : [];
        if (
          candidate.type === "session.hello" &&
          (!features.includes("page_observation_v2") ||
            !features.includes("exact_tab_binding_v2") ||
            !features.includes("active_page_probe_v1"))
        ) {
          throw new Error("BROWSER_BRIDGE_FEATURE_MISMATCH");
        }
        if (
          this.expectedBridgeBuildId &&
          candidate.payload?.bridge_build_id !== this.expectedBridgeBuildId
        ) {
          throw new Error("BROWSER_BRIDGE_BUILD_MISMATCH");
        }
        this.#handleHello(connection, candidate);
        return;
      }
      if (
        candidate.type === "capability.report" &&
        (!Array.isArray(candidate.payload?.features) ||
          !candidate.payload.features.includes("page_observation_v2") ||
          !candidate.payload.features.includes("exact_tab_binding_v2") ||
          !candidate.payload.features.includes("active_page_probe_v1"))
      ) {
        throw new Error("BROWSER_BRIDGE_FEATURE_MISMATCH");
      }
      const acceptance = connection.session.incoming.accept(candidate);
      if (acceptance.status === "duplicate") {
        if (candidate.type === "command.result") {
          this.#handleResult(connection, candidate);
        }
        return;
      }
      connection.session.incomingSeq = candidate.seq;
      this.persistence.updateBrowserSession({
        id: connection.session.id,
        incomingSeq: candidate.seq
      });
      switch (candidate.type) {
        case "capability.report":
          this.#handleCapabilities(connection, candidate);
          break;
        case "page.observation":
          this.#handlePageObservation(connection, candidate);
          this.dispatchPending();
          break;
        case "page.probe.result":
          this.#pageProbes.complete(String(candidate.payload.request_id));
          break;
        case "command.ack":
          this.#handleCommandAck(connection, candidate);
          break;
        case "command.result":
          this.#handleResult(connection, candidate);
          break;
        case "heartbeat.pong":
          {
            if (
              candidate.payload.nonce !==
              connection.session.pendingHeartbeatNonce
            ) {
              connection.lastError = "BROWSER_HEARTBEAT_NONCE_INVALID";
              break;
            }
            const usage = parseExtensionResourceUsage(
              candidate.payload.resource_usage
            );
            if (!usage) {
              delete connection.session.extensionResourceUsage;
              connection.lastError =
                "BROWSER_EXTENSION_RESOURCE_USAGE_INVALID";
              break;
            }
            connection.session.extensionResourceUsage = usage;
            delete connection.session.pendingHeartbeatNonce;
            if (
              connection.lastError ===
                "BROWSER_EXTENSION_RESOURCE_USAGE_INVALID" ||
              connection.lastError === "BROWSER_HEARTBEAT_NONCE_INVALID" ||
              connection.lastError === "BROWSER_HEARTBEAT_TIMEOUT"
            ) {
              delete connection.lastError;
            }
          }
          break;
        case "cancel.ack":
          break;
        case "cancel.effective":
          this.#handleCancelEffective(connection, candidate);
          break;
        case "evidence.begin":
        case "evidence.chunk":
        case "evidence.complete":
          this.#handleEvidence(connection, candidate);
          break;
        default:
          this.#sendError(
            connection,
            "UNEXPECTED_MESSAGE",
            `Bridge message is not valid in the current state: ${candidate.type}`,
            candidate.message_id
          );
      }
    } catch (error) {
      connection.lastError =
        error instanceof Error ? error.message : String(error);
      this.#sendError(
        connection,
        "PROTOCOL_VIOLATION",
        connection.lastError,
        undefined,
        true
      );
    }
  }

  #handlePageObservation(
    connection: BrowserConnection,
    message: Message
  ): void {
    if (message.type !== "page.observation" || !connection.session?.ready) {
      throw new Error("Page observation requires a ready Browser Session");
    }
    const payload = (
      message as Extract<BrowserProtocolMessage, { type: "page.observation" }>
    ).payload;
    if (
      payload.tab_ref.browser_instance_id !==
      connection.session.browserInstanceId
    ) {
      throw new Error(
        "Page observation Browser Instance differs from the Session"
      );
    }
    this.persistence.upsertBrowserPageObservation({
      sessionId: connection.session.id,
      browserInstanceId: payload.tab_ref.browser_instance_id,
      tabId: payload.tab_ref.tab_id,
      ...(payload.tab_ref.window_id === undefined
        ? {}
        : { windowId: payload.tab_ref.window_id }),
      origin: payload.tab_ref.origin,
      pathname: payload.pathname,
      contentScriptReady: payload.content_script_ready,
      authentication: payload.authentication.state,
      ...(!("context_ref" in payload.authentication)
        ? {}
        : {
            authenticationContextRef: payload.authentication.context_ref
          }),
      observationState: payload.observation_state,
      pageEpoch: payload.page_epoch,
      observerCapabilityId: payload.observer_capability_id,
      revision: payload.observation_revision,
      observedAt: payload.observed_at,
      ...(payload.reason_code
        ? { reasonCode: payload.reason_code }
        : {})
    });
  }

  dispatchPending(): number {
    if (!this.#primaryConnection()) return 0;
    this.recoverCancellations();
    this.#promoteEngineMessages();
    let dispatched = 0;
    const pending = this.persistence.listPendingGatewayCommands();
    const occupiedTabs = new Map<string, string>();
    for (const command of pending) {
      const tabKey = this.#commandTabKey(command);
      if (tabKey && command.state !== "queued") {
        occupiedTabs.set(tabKey, command.id);
      }
    }
    for (const command of pending) {
      if (command.state !== "queued") continue;
      if (this.#runIsCancelled(command)) continue;
      const tabKey = this.#commandTabKey(command);
      const occupyingCommand = tabKey
        ? occupiedTabs.get(tabKey)
        : undefined;
      if (occupyingCommand && occupyingCommand !== command.id) {
        continue;
      }
      const boundPageError = this.#boundPageError(command);
      if (boundPageError) {
        if (
          boundPageError === "BROWSER_OBSERVATION_STALE" &&
          this.#requestBoundPageRefresh(command)
        ) {
          continue;
        }
        this.#commitResult(`stale-page-${command.id}`, {
          command_seq: command.commandSeq,
          command_id: command.id,
          node_execution_id: command.nodeExecutionId,
          idempotency_key: command.idempotencyKey,
          fencing_token: command.fencingToken,
          status: "rejected",
          error: {
            code: boundPageError,
            message:
              boundPageError === "BROWSER_ORIGIN_MISMATCH"
                ? "The observed browser page Origin differs from the frozen binding."
                : "The frozen browser page observation is no longer current.",
            retryable: false
          }
        });
        continue;
      }
      const connection = this.#connectionForCommand(command);
      if (!connection || !this.#supports(connection, command)) continue;
      this.#sendMessage(
        connection,
        "command.dispatch",
        command.payload as Record<string, unknown>,
        `trace-${command.nodeExecutionId}`
      );
      this.persistence.markGatewayCommandState(
        command.id,
        "delivered",
        new Date().toISOString()
      );
      if (tabKey) occupiedTabs.set(tabKey, command.id);
      dispatched += 1;
    }
    return dispatched;
  }

  tick(at = new Date()): { timedOut: number; dispatched: number } {
    this.#pageProbes.prune(at.getTime());
    for (const connection of this.#connections.values()) {
      const session = connection.session;
      if (
        !session?.ready ||
        (session.lastHeartbeatSentAt !== undefined &&
          at.getTime() - session.lastHeartbeatSentAt <
            BROWSER_HEARTBEAT_INTERVAL_MS)
      ) {
        continue;
      }
      if (session.pendingHeartbeatNonce !== undefined) {
        delete session.extensionResourceUsage;
        connection.lastError = "BROWSER_HEARTBEAT_TIMEOUT";
      }
      session.lastHeartbeatSentAt = at.getTime();
      const nonce = randomUUID();
      session.pendingHeartbeatNonce = nonce;
      this.#sendMessage(
        connection,
        "heartbeat.ping",
        { nonce },
        "trace-heartbeat"
      );
    }
    this.recoverCancellations();
    this.recoverTerminalResults();
    let timedOut = 0;
    for (const command of this.persistence.listPendingGatewayCommands()) {
      if (this.#runIsCancelled(command)) continue;
      const payload = command.payload as Record<string, unknown>;
      if (Date.parse(String(payload.deadline)) > at.getTime()) continue;
      this.#commitResult(`timeout-${command.id}-${at.getTime()}`, {
        command_seq: command.commandSeq,
        command_id: command.id,
        node_execution_id: command.nodeExecutionId,
        idempotency_key: command.idempotencyKey,
        fencing_token: command.fencingToken,
        status: "timed_out",
        error: {
          code: "NODE_TIMEOUT",
          message: "Browser command deadline elapsed.",
          retryable: true
        }
      });
      timedOut += 1;
    }
    return { timedOut, dispatched: this.dispatchPending() };
  }

  recoverTerminalResults(): number {
    let recovered = 0;
    for (const command of this.persistence.listGatewayCommandsNeedingApplication()) {
      this.#commitResult(`recovery-${command.id}-${randomUUID()}`, {
        ...(command.result as Record<string, unknown>),
        command_id: command.id,
        node_execution_id: command.nodeExecutionId,
        idempotency_key: command.idempotencyKey,
        fencing_token: command.fencingToken,
        command_seq: command.commandSeq
      });
      recovered += 1;
    }
    return recovered;
  }

  recoverCancellations(): number {
    const runIds = new Set<string>();
    for (const command of this.persistence.listPendingGatewayCommands()) {
      const runId = this.#runId(command);
      if (runId && this.persistence.getRun(runId)?.status === "cancelled") {
        runIds.add(runId);
      }
    }
    let recovered = 0;
    for (const runId of runIds) {
      recovered += this.requestCancel(runId, "RECOVERED_RUN_CANCELLED");
    }
    return recovered;
  }

  requestCancel(runId: string, reasonCode = "USER_REQUESTED"): number {
    let requested = 0;
    const commands = new Map<string, GatewayCommandRecord>();
    for (const command of this.persistence.listGatewayCommandsForRun(runId)) {
      commands.set(command.id, command);
    }
    for (const command of this.persistence.listPendingGatewayCommands()) {
      if (this.#runId(command) === runId) commands.set(command.id, command);
    }
    for (const command of commands.values()) {
      if (
        command.state !== "terminal" &&
        this.#requestCommandCancel(command, reasonCode)
      ) {
        requested += 1;
      }
    }
    return requested;
  }

  #handleHello(connection: BrowserConnection, message: Message): void {
    const guard = new ProtocolSessionGuard();
    guard.accept(message);
    const payload = message.payload;
    const extensionId = String(payload.extension_id);
    if (extensionId !== this.#extensionId) {
      throw new Error(`Extension ID mismatch: ${extensionId}`);
    }
    const now = new Date();
    const sessionId = randomUUID();
    // Browser Protocol identifiers must start with an alphanumeric
    // character. Raw base64url can start with "-" or "_" and would make an
    // otherwise valid resume handshake fail nondeterministically.
    const resumeToken = `r-${randomBytes(32).toString("base64url")}`;
    const resumeTokenDigest = this.#tokenDigest(resumeToken);
    const expiresAt = new Date(
      now.getTime() + RESUME_TOKEN_TTL_MS
    ).toISOString();
    const opened = this.persistence.openBrowserSession({
      session: {
        id: sessionId,
        browserInstanceId: String(payload.browser_instance_id),
        extensionId,
        extensionVersion: String(payload.extension_version),
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        incomingSeq: 0,
        outgoingSeq: 0,
        lastAckedCommandSeq: Number(payload.last_acked_command_seq),
        resumeTokenDigest,
        resumeTokenExpiresAt: expiresAt,
        connectedAt: now.toISOString()
      },
      ...(typeof payload.resume_token === "string"
        ? { presentedResumeTokenDigest: this.#tokenDigest(payload.resume_token) }
        : {}),
      now: now.toISOString()
    });
    const activeSessionId = opened.session.id;
    if (opened.resumedFrom) {
      // A resumed extension process has lost its in-memory page revision
      // namespace. Remove the disconnected observations before accepting the
      // new process' revision 1 reports; every existing binding remains stale
      // and must be resolved again from fresh page facts.
      this.persistence.resetBrowserPageObservations(activeSessionId);
      for (const [otherId, other] of this.#connections) {
        if (
          otherId !== connection.id &&
          other.session?.id === activeSessionId
        ) {
          other.lastError = "BROWSER_SESSION_SUPERSEDED";
          this.#connections.delete(otherId);
        }
      }
    }
    guard.establish(activeSessionId, 0);
    connection.session = {
      id: activeSessionId,
      browserInstanceId: opened.session.browserInstanceId,
      extensionVersion: opened.session.extensionVersion,
      bridgeBuildId: String(payload.bridge_build_id ?? "unknown"),
      connectedAt: Date.parse(opened.session.connectedAt),
      incoming: guard,
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: opened.session.lastAckedCommandSeq,
      ready: false,
      capabilities: []
    };
    this.#sendMessage(
      connection,
      "session.welcome",
      {
        selected_protocol: BROWSER_PROTOCOL,
        heartbeat_ms: 20_000,
        resume_token: resumeToken,
        resume_token_expires_at: expiresAt,
        core_signing_key: {
          key_id: this.signingKey.keyId,
          algorithm: "Ed25519",
          public_key_spki_base64: this.signingKey.publicKeySpkiBase64
        },
        max_message_bytes: BROWSER_PROTOCOL_MAX_MESSAGE_BYTES
      },
      message.trace_id
    );
    if (opened.resumedFrom) {
      this.#sendMessage(
        connection,
        "session.resume",
        {
          accepted: true,
          replay_from_command_seq:
            opened.resumedFrom.lastAckedCommandSeq + 1
        },
        message.trace_id
      );
    }
  }

  #handleCapabilities(
    connection: BrowserConnection,
    message: Message
  ): void {
    const session = connection.session!;
    const features = new Set(
      Array.isArray(message.payload.features)
        ? message.payload.features.map(String)
        : []
    );
    if (
      !features.has("page_observation_v2") ||
      !features.has("exact_tab_binding_v2") ||
      !features.has("active_page_probe_v1")
    ) {
      connection.lastError = "BROWSER_BRIDGE_FEATURE_MISMATCH";
      throw new Error("BROWSER_BRIDGE_FEATURE_MISMATCH");
    }
    const reported = message.payload.capabilities as Array<{
      node_id: string;
      versions: string[];
      risk_level: string;
      permissions: string[];
      routes: Array<{
        origin: string;
        pathname_prefixes: string[];
        observer_capability_id: string;
      }>;
      adapter_id?: string;
      adapter_version?: string;
    }>;
    const capabilities = reported.flatMap((capability) =>
      capability.versions.map((version) => ({
        nodeId: capability.node_id,
        nodeVersion: version,
        riskLevel: capability.risk_level,
        permissions: capability.permissions,
        routes: capability.routes.map((route) => ({
          origin: route.origin,
          pathnamePrefixes: route.pathname_prefixes,
          observerCapabilityId: route.observer_capability_id
        })),
        ...(capability.adapter_id === undefined
          ? {}
          : { adapterId: capability.adapter_id }),
        ...(capability.adapter_version === undefined
          ? {}
          : { adapterVersion: capability.adapter_version })
      }))
    );
    this.persistence.replaceBrowserCapabilities(session.id, capabilities);
    this.persistence.updateBrowserSession({
      id: session.id,
      capabilityDigest: String(message.payload.manifest_digest)
    });
    session.capabilities = capabilities;
    session.ready = true;
    delete connection.lastError;
    this.dispatchPending();
  }

  #handleCommandAck(
    connection: BrowserConnection,
    message: Message
  ): void {
    const payload = message.payload;
    const command = this.persistence.getGatewayCommand(
      String(payload.command_id)
    );
    if (
      !command ||
      command.nodeExecutionId !== String(payload.node_execution_id) ||
      command.fencingToken !== Number(payload.fencing_token)
    ) {
      throw new Error("Command ACK does not match an active command");
    }
    this.#assertCommandSession(connection, command);
    if (payload.accepted === true) {
      this.persistence.markGatewayCommandState(
        command.id,
        "accepted",
        new Date().toISOString()
      );
      return;
    }
    const synthetic = {
      command_seq: command.commandSeq,
      command_id: command.id,
      node_execution_id: command.nodeExecutionId,
      idempotency_key: command.idempotencyKey,
      fencing_token: command.fencingToken,
      status: "rejected",
      error: {
        code: String(payload.reason_code ?? "BRIDGE_REJECTED"),
        message: "Bridge rejected the command before execution.",
        retryable: false
      }
    };
    this.#commitResult(message.message_id, synthetic);
  }

  #handleResult(
    connection: BrowserConnection,
    message: Message
  ): void {
    const command = this.persistence.getGatewayCommand(
      String(message.payload.command_id)
    );
    if (command) this.#assertCommandSession(connection, command);
    let outcome:
      | "accepted"
      | "duplicate"
      | "stale"
      | "evidence_not_ready"
      | "evidence_invalid";
    try {
      outcome = this.#commitResult(message.message_id, message.payload);
    } catch (error) {
      if (!(error instanceof BrowserEvidenceError)) throw error;
      outcome =
        error.code === "EVIDENCE_NOT_READY"
          ? "evidence_not_ready"
          : "evidence_invalid";
    }
    connection.cancelRequests.delete(String(message.payload.command_id));
    const accepted = outcome === "accepted" || outcome === "duplicate";
    if (accepted) delete connection.lastError;
    if (accepted) {
      const acceptedCommand =
        command ??
        this.persistence.getGatewayCommand(
          String(message.payload.command_id)
        );
      if (acceptedCommand) {
        connection.session!.lastAckedCommandSeq = Math.max(
          connection.session!.lastAckedCommandSeq,
          acceptedCommand.commandSeq
        );
        this.persistence.updateBrowserSession({
          id: connection.session!.id,
          lastAckedCommandSeq:
            connection.session!.lastAckedCommandSeq
        });
      }
    }
    this.#sendMessage(
      connection,
      "result.ack",
      {
        command_id: String(message.payload.command_id),
        node_execution_id: String(message.payload.node_execution_id),
        accepted,
        ...(accepted
          ? {}
          : {
              reason_code:
                outcome === "stale"
                  ? "STALE_FENCING_TOKEN"
                  : outcome === "evidence_not_ready"
                    ? "EVIDENCE_NOT_READY"
                    : "EVIDENCE_INVALID"
            })
      },
      message.trace_id
    );
  }

  #handleCancelEffective(
    connection: BrowserConnection,
    message: Message
  ): void {
    const command = this.persistence.getGatewayCommand(
      String(message.payload.command_id)
    );
    if (
      !command ||
      command.nodeExecutionId !==
        String(message.payload.node_execution_id) ||
      command.fencingToken !== Number(message.payload.fencing_token)
    ) {
      throw new Error("Cancel Effective does not match an active command");
    }
    this.#assertCommandSession(connection, command);
    this.#commitResult(message.message_id, {
      command_seq: command.commandSeq,
      command_id: command.id,
      node_execution_id: command.nodeExecutionId,
      idempotency_key: command.idempotencyKey,
      fencing_token: command.fencingToken,
      status: message.payload.status
    });
    connection.cancelRequests.delete(command.id);
  }

  #commitResult(
    inboxMessageId: string,
    payload: Record<string, unknown>
  ):
    | "accepted"
    | "duplicate"
    | "stale"
    | "evidence_not_ready"
    | "evidence_invalid" {
    const commandId = String(payload.command_id);
    const command = this.persistence.getGatewayCommand(commandId);
    if (!command) throw new Error(`Gateway command not found: ${commandId}`);
    const evidenceIds = Array.isArray(payload.evidence_refs)
      ? payload.evidence_refs.map(String)
      : [];
    const outcome =
      evidenceIds.length === 0
        ? this.persistence.acceptResult({
            commandId,
            fencingToken: Number(payload.fencing_token),
            result: payload,
            inboxMessageId,
            receivedAt: new Date().toISOString()
          })
        : this.evidence
          ? this.evidence.acceptResult({
              command,
              payload,
              inboxMessageId,
              receivedAt: new Date().toISOString()
            })
          : "evidence_not_ready";
    if (
      outcome === "stale" ||
      outcome === "evidence_not_ready" ||
      outcome === "evidence_invalid"
    ) {
      return outcome;
    }
    if (command.id.startsWith("ir2:")) {
      return outcome;
    }
    const execution = this.persistence.getNodeExecution(
      command.nodeExecutionId
    );
    if (!execution) {
      throw new Error(`Node execution not found: ${command.nodeExecutionId}`);
    }
    const run = this.persistence.getRun(execution.runId);
    if (!run) throw new Error(`Run not found: ${execution.runId}`);
    const workflow = this.persistence.getPublished(
      "workflow",
      run.workflowId,
      run.workflowVersion
    );
    if (!workflow) {
      throw new Error(
        `Published workflow missing: ${run.workflowId}@${run.workflowVersion}`
      );
    }
    this.engine.acceptBrowserResult(
      compileWorkflow(workflow.content, this.#nodeCatalog()),
      execution.id,
      {
        status: payload.status as
          | "succeeded"
          | "rejected"
          | "failed"
          | "timed_out"
          | "cancelled"
          | "uncertain",
        ...(payload.output === undefined ? {} : { output: payload.output }),
        ...(payload.error === undefined
          ? {}
          : {
              error: payload.error as {
                code: string;
                message: string;
                retryable?: boolean;
              }
            }),
        ...(payload.risk_signals === undefined
          ? {}
          : { riskSignals: payload.risk_signals as RiskSignal[] }),
        ...(payload.timing_observation === undefined
          ? {}
          : {
              timingObservation: payload.timing_observation as {
                rate_limit_wait_ms: number;
                readiness_wait_ms?: number;
                stable_for_ms?: number;
              }
            }),
        fencingToken: Number(payload.fencing_token)
      }
    );
    return outcome;
  }

  #promoteEngineMessages(): void {
    for (const message of this.persistence.listPendingEngineOutbox()) {
      if (message.topic !== "browser.command.requested") continue;
      const source = message.payload as Record<string, unknown>;
      const node = source.node as { id: string; version: string };
      const definition = this.persistence.getPublished(
        "node",
        node.id,
        node.version
      )?.content as NodeDefinition | undefined;
      if (!definition || definition.runtime !== "browser") {
        throw new Error(`Published browser node missing: ${node.id}@${node.version}`);
      }
      const commandId = randomUUID();
      const commandSeq = this.persistence.nextGatewayCommandSequence();
      const now = new Date();
      const deadline = new Date(
        now.getTime() + Number(source.timeout_ms)
      ).toISOString();
      const grantBody: PermissionGrantBody = {
        grant_id: randomUUID(),
        permissions: definition.risk.permissions,
        domains: definition.risk.domains ?? [],
        risk_level: definition.risk.level,
        expires_at: deadline,
        run_id: String(source.run_id),
        node_execution_id: String(source.node_execution_id),
        node_id: node.id,
        node_version: node.version,
        fencing_token: Number(source.fencing_token)
      };
      const permissionGrant = signPermissionGrant(
        grantBody,
        this.signingKey.keyId,
        this.signingKey.privateKey
      );
      const payload = {
        command_seq: commandSeq,
        run_id: source.run_id,
        workflow_id: source.workflow_id,
        workflow_version: source.workflow_version,
        node_execution_id: source.node_execution_id,
        command_id: commandId,
        idempotency_key: source.idempotency_key,
        fencing_token: source.fencing_token,
        attempt: source.attempt,
        node,
        input: source.input,
        ...(source.timing_policy === undefined
          ? {}
          : { timing_policy: source.timing_policy }),
        permission_grant: permissionGrant,
        deadline
      };
      const command: GatewayCommandRecord = {
        id: commandId,
        nodeExecutionId: String(source.node_execution_id),
        commandSeq,
        idempotencyKey: String(source.idempotency_key),
        fencingToken: Number(source.fencing_token),
        state: "queued",
        payload,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.persistence.promoteEngineOutbox(
        message.id,
        command,
        {
          id: randomUUID(),
          topic: "command.dispatch",
          aggregateId: commandId,
          payload,
          createdAt: now.toISOString()
        },
        now.toISOString()
      );
    }
  }

  #enqueueRuntimeInvocation(
    commandId: string,
    invocation: RuntimeInvocation
  ): void {
    const published = this.persistence.getPublished(
      "node",
      invocation.node.id,
      invocation.node.version
    );
    if (
      !published ||
      published.digest !== invocation.node.digest ||
      (published.content as { runtime?: unknown }).runtime !== "browser"
    ) {
      throw new Error(
        `Published browser Node missing or drifted: ${invocation.node.id}@${invocation.node.version}`
      );
    }
    const run = this.persistence.getRun(invocation.identity.runId);
    if (!run) {
      throw new Error(`IR2 Run not found: ${invocation.identity.runId}`);
    }
    const commandSeq = this.persistence.nextGatewayCommandSequence();
    const now = new Date();
    const deadline = new Date(invocation.deadlineAt).toISOString();
    const definition = published.content as NodeDefinition;
    const protocolIdempotencyKey = `ir2-${createHash("sha256")
      .update(invocation.idempotencyKey)
      .digest("hex")}`;
    const grantBody: PermissionGrantBody = {
      grant_id: randomUUID(),
      permissions: [...invocation.permissionSnapshot.permissions],
      domains: [...invocation.permissionSnapshot.domains],
      risk_level: invocation.permissionSnapshot.riskLevel,
      expires_at: deadline,
      run_id: invocation.identity.runId,
      node_execution_id: invocation.invocationId,
      node_id: invocation.node.id,
      node_version: invocation.node.version,
      fencing_token: invocation.fencingToken
    };
    const permissionGrant = signPermissionGrant(
      grantBody,
      this.signingKey.keyId,
      this.signingKey.privateKey
    );
    const frozenBindings = Object.values(
      invocation.resourceBindings ?? {}
    ).map((resource) => resource.binding);
    const frozenPage =
      frozenBindings.length === 1 ? frozenBindings[0] : undefined;
    const adapterRef = (() => {
      if (!definition.adapter) return undefined;
      const closure = this.persistence.getRunPlanSnapshot(
        invocation.identity.runId
      )?.planJson.artifactClosure.entries;
      const candidates = (closure ?? []).filter(
        (entry) =>
          entry.kind === "adapter" &&
          entry.id === definition.adapter!.id &&
          definition.adapter!.versions.includes(entry.version)
      );
      if (candidates.length !== 1) {
        throw new Error(
          `Browser Node adapter closure is not exact: ${invocation.node.id}@${invocation.node.version}`
        );
      }
      const candidate = candidates[0]!;
      const published = this.persistence.getPublished(
        "adapter",
        candidate.id,
        candidate.version
      );
      if (!published || published.digest !== candidate.digest) {
        throw new Error(
          `Published browser Adapter missing or drifted: ${candidate.id}@${candidate.version}`
        );
      }
      const minimumExtensionVersion = (
        published.content as {
          extension?: { minimumVersion?: unknown };
        }
      ).extension?.minimumVersion;
      if (typeof minimumExtensionVersion !== "string") {
        throw new Error(
          `Browser Adapter extension floor is missing: ${candidate.id}@${candidate.version}`
        );
      }
      return {
        id: candidate.id,
        version: candidate.version,
        digest: candidate.digest,
        minimum_extension_version: minimumExtensionVersion
      };
    })();
    const payload = {
      command_seq: commandSeq,
      run_id: invocation.identity.runId,
      workflow_id: run.workflowId,
      workflow_version: run.workflowVersion,
      node_execution_id: invocation.invocationId,
      command_id: commandId,
      idempotency_key: protocolIdempotencyKey,
      fencing_token: invocation.fencingToken,
      attempt: invocation.identity.attempt,
      node: {
        id: invocation.node.id,
        version: invocation.node.version
      },
      ...(adapterRef ? { adapter_ref: adapterRef } : {}),
      input: invocation.input,
      ...((definition.execution as { timingPolicy?: unknown } | undefined)
        ?.timingPolicy === undefined
        ? {}
        : {
            timing_policy: (
              definition.execution as { timingPolicy: unknown }
            ).timingPolicy
          }),
      permission_grant: permissionGrant,
      deadline,
      ...(frozenPage
        ? {
            tab_ref: {
              browser_instance_id: frozenPage.browserInstanceId,
              tab_id: frozenPage.tabId,
              ...(frozenPage.windowId === undefined
                ? {}
                : { window_id: frozenPage.windowId }),
              origin: frozenPage.origin
            },
            page_epoch: frozenPage.pageEpoch,
            observation_revision: frozenPage.revision,
            ...(frozenPage.authenticationContextRef === undefined
              ? {}
              : {
                  authentication_context_ref:
                    frozenPage.authenticationContextRef
                })
          }
        : {})
    };
    this.persistence.enqueueCommand(
      {
        id: commandId,
        nodeExecutionId: invocation.invocationId,
        commandSeq,
        idempotencyKey: protocolIdempotencyKey,
        fencingToken: invocation.fencingToken,
        state: "queued",
        payload,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      {
        id: `gateway:${commandId}`,
        topic: "command.dispatch",
        aggregateId: commandId,
        payload,
        createdAt: now.toISOString()
      }
    );
  }

  #cancelRuntimeCommand(commandId: string): void {
    const command = this.persistence.getGatewayCommand(commandId);
    if (!command || command.state === "terminal") return;
    this.#requestCommandCancel(command, "RUNTIME_CANCELLED");
  }

  #requestCommandCancel(
    command: GatewayCommandRecord,
    reasonCode: string
  ): boolean {
    if (command.state === "queued") {
      this.#commitResult(`cancel-local-${command.id}`, {
        command_seq: command.commandSeq,
        command_id: command.id,
        node_execution_id: command.nodeExecutionId,
        idempotency_key: command.idempotencyKey,
        fencing_token: command.fencingToken,
        status: "cancelled"
      });
      return true;
    }
    const connection = this.#connectionForCommand(command);
    if (connection?.session?.ready) {
      if (connection.cancelRequests.has(command.id)) return false;
      this.#sendMessage(
        connection,
        "cancel.request",
        {
          command_id: command.id,
          node_execution_id: command.nodeExecutionId,
          fencing_token: command.fencingToken,
          reason_code: reasonCode
        },
        `trace-${command.nodeExecutionId}`
      );
      connection.cancelRequests.add(command.id);
      return true;
    }
    if (command.id.startsWith("ir2:")) {
      // The cancelled checkpoint is the durable cancellation intent. Preserve
      // the delivered command until a browser session can receive it.
      return false;
    }
    this.#commitResult(`cancel-uncertain-${command.id}`, {
      command_seq: command.commandSeq,
      command_id: command.id,
      node_execution_id: command.nodeExecutionId,
      idempotency_key: command.idempotencyKey,
      fencing_token: command.fencingToken,
      status: "uncertain",
      error: {
        code: "CANCEL_DELIVERY_UNCERTAIN",
        message:
          "The browser disconnected after delivery; cancellation could not be confirmed.",
        retryable: false
      }
    });
    return true;
  }

  #runId(command: GatewayCommandRecord): string | undefined {
    const runId = (command.payload as Record<string, unknown>).run_id;
    return typeof runId === "string" && runId.length > 0 ? runId : undefined;
  }

  #resolveConnection(connectionId?: string): BrowserConnection {
    if (connectionId) {
      const connection = this.#connections.get(connectionId);
      if (!connection) {
        throw new Error(`Browser connection is unavailable: ${connectionId}`);
      }
      return connection;
    }
    if (this.#connections.size === 1) {
      return this.#connections.values().next().value as BrowserConnection;
    }
    throw new Error(
      "Browser connection identity is required when multiple sessions are attached"
    );
  }

  #primaryConnection(
    readyOnly = true
  ): BrowserConnection | undefined {
    return [...this.#connections.values()]
      .filter(
        (connection) =>
          !readyOnly || connection.session?.ready === true
      )
      .sort((left, right) => {
        const versionOrder = compareExtensionVersions(
          right.session?.extensionVersion ?? "0.0.0",
          left.session?.extensionVersion ?? "0.0.0"
        );
        if (versionOrder !== 0) return versionOrder;
        const connectedOrder =
          (right.session?.connectedAt ?? 0) -
          (left.session?.connectedAt ?? 0);
        return connectedOrder !== 0
          ? connectedOrder
          : right.attachedOrder - left.attachedOrder;
      })[0];
  }

  #connectionForCommand(
    command: GatewayCommandRecord
  ): BrowserConnection | undefined {
    const requiredSessionIds = this.#requiredSessionIds(command);
    if (requiredSessionIds === undefined || requiredSessionIds.length > 1) {
      return undefined;
    }
    if (requiredSessionIds.length === 0) {
      return this.#primaryConnection();
    }
    return [...this.#connections.values()].find(
      (connection) =>
        connection.session?.ready === true &&
        connection.session.id === requiredSessionIds[0]
    );
  }

  #boundPageError(
    command: GatewayCommandRecord
  ): "BROWSER_ORIGIN_MISMATCH" | "BROWSER_OBSERVATION_STALE" | undefined {
    const payload = command.payload as {
      tab_ref?: {
        browser_instance_id?: unknown;
        tab_id?: unknown;
        origin?: unknown;
      };
      page_epoch?: unknown;
      observation_revision?: unknown;
    };
    if (!payload.tab_ref) return undefined;
    const sessionIds = this.#requiredSessionIds(command);
    if (!sessionIds || sessionIds.length !== 1) {
      return "BROWSER_OBSERVATION_STALE";
    }
    const page = this.persistence.getBrowserPageObservation(
      sessionIds[0]!,
      Number(payload.tab_ref.tab_id)
    );
    if (page && page.origin !== payload.tab_ref.origin) {
      return "BROWSER_ORIGIN_MISMATCH";
    }
    return Boolean(
      page &&
        page.observationState === "ready" &&
        page.contentScriptReady &&
        Date.now() - Date.parse(page.observedAt) <= 30_000 &&
        page.browserInstanceId === payload.tab_ref.browser_instance_id &&
        page.origin === payload.tab_ref.origin &&
        page.pageEpoch === payload.page_epoch &&
        observationCoversFrozenRevision(
          page.revision,
          Number(payload.observation_revision)
        ) &&
        page.authenticationContextRef ===
          (payload as { authentication_context_ref?: unknown })
            .authentication_context_ref
    )
      ? undefined
      : "BROWSER_OBSERVATION_STALE";
  }

  #requestBoundPageRefresh(command: GatewayCommandRecord): boolean {
    const payload = command.payload as {
      tab_ref?: {
        browser_instance_id?: unknown;
        tab_id?: unknown;
        window_id?: unknown;
        origin?: unknown;
      };
      page_epoch?: unknown;
      observation_revision?: unknown;
      authentication_context_ref?: unknown;
    };
    const sessionIds = this.#requiredSessionIds(command);
    if (!payload.tab_ref || !sessionIds || sessionIds.length !== 1) {
      return false;
    }
    const sessionId = sessionIds[0]!;
    const tabId = Number(payload.tab_ref.tab_id);
    const page = this.persistence.getBrowserPageObservation(sessionId, tabId);
    if (
      !page ||
      page.observationState !== "ready" ||
      !page.contentScriptReady ||
      page.browserInstanceId !== payload.tab_ref.browser_instance_id ||
      page.origin !== payload.tab_ref.origin ||
      page.pageEpoch !== payload.page_epoch ||
      !observationCoversFrozenRevision(
        page.revision,
        Number(payload.observation_revision)
      ) ||
      page.authenticationContextRef !==
        payload.authentication_context_ref ||
      Date.now() - Date.parse(page.observedAt) <= 30_000
    ) {
      return false;
    }
    const key = `${sessionId}:${tabId}`;
    const now = Date.now();
    const requestId = randomUUID();
    const reservation = this.#pageProbes.reserve(key, requestId, now);
    if (reservation === "throttled") {
      return true;
    }
    if (reservation === "capacity_exceeded") return false;
    try {
      this.requestPageProbe({
        sessionId,
        browserInstanceId: page.browserInstanceId,
        tabId: page.tabId,
        ...(page.windowId === undefined ? {} : { windowId: page.windowId }),
        origin: page.origin,
        timeoutMs: 5_000,
        requestId
      });
    } catch (error) {
      this.#pageProbes.complete(requestId);
      throw error;
    }
    return true;
  }

  #commandTabKey(command: GatewayCommandRecord): string | undefined {
    const payload = command.payload as {
      tab_ref?: {
        browser_instance_id?: unknown;
        tab_id?: unknown;
      };
    };
    const sessionIds = this.#requiredSessionIds(command);
    if (
      !payload.tab_ref ||
      !sessionIds ||
      sessionIds.length !== 1 ||
      typeof payload.tab_ref.browser_instance_id !== "string" ||
      !Number.isSafeInteger(payload.tab_ref.tab_id)
    ) {
      return undefined;
    }
    return `${sessionIds[0]}:${payload.tab_ref.browser_instance_id}:${String(
      payload.tab_ref.tab_id
    )}`;
  }

  #assertCommandSession(
    connection: BrowserConnection,
    command: GatewayCommandRecord
  ): void {
    const requiredSessionIds = this.#requiredSessionIds(command);
    if (
      requiredSessionIds === undefined ||
      requiredSessionIds.length > 1 ||
      (requiredSessionIds.length === 1 &&
        requiredSessionIds[0] !== connection.session?.id)
    ) {
      throw new Error(
        "Browser message does not match the command's frozen Session"
      );
    }
  }

  #requiredSessionIds(
    command: GatewayCommandRecord
  ): readonly string[] | undefined {
    const runId = this.#runId(command);
    if (!runId) return [];
    const snapshot =
      this.persistence.getRunResourceBindingSnapshot(runId);
    if (!snapshot) return [];
    const payload = command.payload as {
      tab_ref?: {
        browser_instance_id?: unknown;
        tab_id?: unknown;
        origin?: unknown;
      };
      page_epoch?: unknown;
    };
    if (
      payload.tab_ref &&
      typeof payload.tab_ref.browser_instance_id === "string" &&
      Number.isSafeInteger(payload.tab_ref.tab_id)
    ) {
      const bindings = Object.values(snapshot.bindings).filter(
        (binding) =>
          binding.browserInstanceId === payload.tab_ref!.browser_instance_id &&
          binding.tabId === payload.tab_ref!.tab_id &&
          (typeof payload.tab_ref!.origin !== "string" ||
            binding.origin === payload.tab_ref!.origin) &&
          (typeof payload.page_epoch !== "string" ||
            binding.pageEpoch === payload.page_epoch)
      );
      if (bindings.length !== 1) return undefined;
      return [bindings[0]!.sessionId];
    }
    const checkpoint = this.persistence.getEngineCheckpoint(runId);
    const state = checkpoint?.state as
      | {
          active?: {
            kind?: unknown;
            invocation?: {
              invocationId?: unknown;
              resourceMappings?: Record<
                string,
                { slotName?: unknown }
              >;
            };
          };
        }
      | undefined;
    const invocation =
      state?.active?.kind === "call"
        ? state.active.invocation
        : undefined;
    if (
      !invocation ||
      invocation.invocationId !== command.nodeExecutionId ||
      !invocation.resourceMappings
    ) {
      return undefined;
    }
    const sessionIds = new Set<string>();
    for (const mapping of Object.values(invocation.resourceMappings)) {
      if (typeof mapping.slotName !== "string") return undefined;
      const binding = snapshot.bindings[mapping.slotName];
      if (!binding) return undefined;
      sessionIds.add(binding.sessionId);
    }
    return [...sessionIds].sort();
  }

  #runIsCancelled(command: GatewayCommandRecord): boolean {
    const runId = this.#runId(command);
    return (
      runId !== undefined &&
      this.persistence.getRun(runId)?.status === "cancelled"
    );
  }

  #runtimeCommandId(invocationId: string): string {
    return `ir2:${invocationId}`;
  }

  #runtimeOutcome(result: unknown): RuntimeOutcome {
    const payload = result as Record<string, unknown>;
    const evidenceIds = Array.isArray(payload.evidence_refs)
      ? payload.evidence_refs.map(String)
      : [];
    const evidence: RuntimeOutcome["evidence"] =
      evidenceIds.length === 0
        ? []
        : (this.evidence?.runtimeEvidence(evidenceIds) ?? []);
    const riskSignals = Array.isArray(payload.risk_signals)
      ? (payload.risk_signals as RiskSignal[])
      : [];
    if (payload.status === "succeeded") {
      return {
        status: "succeeded",
        output: (payload.output ?? null) as JsonValue,
        evidence,
        riskSignals
      };
    }
    const status = [
      "failed",
      "rejected",
      "timed_out",
      "cancelled",
      "uncertain"
    ].includes(String(payload.status))
      ? (payload.status as Exclude<RuntimeOutcome["status"], "succeeded">)
      : "failed";
    const error = payload.error as
      | { code?: unknown; message?: unknown; retryable?: unknown }
      | undefined;
    return {
      status,
      error: {
        code: String(error?.code ?? "BROWSER_COMMAND_FAILED"),
        message: String(
          error?.message ?? "Browser command returned a terminal failure."
        ),
        retryable: error?.retryable === true
      },
      ...(payload.output === undefined
        ? {}
        : { output: payload.output as JsonValue }),
      evidence,
      riskSignals
    };
  }

  #supports(
    connection: BrowserConnection,
    command: GatewayCommandRecord
  ): boolean {
    const payload = command.payload as Record<string, unknown>;
    const node = payload.node as { id: string; version: string };
    const grant = payload.permission_grant as {
      permissions: string[];
      risk_level: RiskLevel;
    };
    const adapterRef = payload.adapter_ref as
      | {
          id?: unknown;
          version?: unknown;
          minimum_extension_version?: unknown;
        }
      | undefined;
    return (
      connection.session?.capabilities.some(
        (capability) =>
          capability.nodeId === node.id &&
          capability.nodeVersion === node.version &&
          capability.riskLevel === grant.risk_level &&
          grant.permissions.every((permission) =>
            capability.permissions.includes(permission)
          ) &&
          (adapterRef === undefined ||
            (typeof adapterRef.id === "string" &&
              typeof adapterRef.version === "string" &&
              typeof adapterRef.minimum_extension_version === "string" &&
              capability.adapterId === adapterRef.id &&
              capability.adapterVersion === adapterRef.version &&
              compareExtensionVersions(
                connection.session!.extensionVersion,
                adapterRef.minimum_extension_version
              ) >= 0))
      ) ?? false
    );
  }

  #sendMessage(
    connection: BrowserConnection,
    type: string,
    payload: Record<string, unknown>,
    traceId: string
  ): void {
    const session = connection.session;
    if (!session) {
      throw new Error("Browser session is not attached");
    }
    session.outgoingSeq += 1;
    const message = {
      protocol: BROWSER_PROTOCOL,
      version: BROWSER_PROTOCOL_VERSION,
      message_id: randomUUID(),
      session_id: session.id,
      seq: session.outgoingSeq,
      sent_at: new Date().toISOString(),
      type,
      trace_id: traceId,
      payload
    } as Message;
    this.persistence.updateBrowserSession({
      id: session.id,
      outgoingSeq: session.outgoingSeq
    });
    connection.send(message);
  }

  #handleEvidence(
    connection: BrowserConnection,
    message: Message
  ): void {
    const evidenceId = String(message.payload.evidence_id);
    if (!this.evidence) {
      this.#sendEvidenceAcknowledgement(
        connection,
        {
          evidenceId,
          accepted: false,
          reasonCode: "EVIDENCE_NOT_ENABLED"
        },
        message.trace_id
      );
      return;
    }
    try {
      if (message.type === "evidence.begin") {
        this.evidence.begin(connection.session!.id, message.payload);
        return;
      }
      if (message.type === "evidence.chunk") {
        this.evidence.chunk(connection.session!.id, message.payload);
        return;
      }
      this.#sendEvidenceAcknowledgement(
        connection,
        this.evidence.complete(connection.session!.id, message.payload),
        message.trace_id
      );
    } catch (error) {
      if (!(error instanceof BrowserEvidenceError)) throw error;
      this.#sendEvidenceAcknowledgement(
        connection,
        {
          evidenceId,
          accepted: false,
          ...(error.nextChunkIndex === undefined
            ? {}
            : { nextChunkIndex: error.nextChunkIndex }),
          reasonCode: error.code
        },
        message.trace_id
      );
    }
  }

  #sendEvidenceAcknowledgement(
    connection: BrowserConnection,
    acknowledgement: BrowserEvidenceAcknowledgement,
    traceId: string
  ): void {
    this.#sendMessage(
      connection,
      "evidence.ack",
      {
        evidence_id: acknowledgement.evidenceId,
        accepted: acknowledgement.accepted,
        ...(acknowledgement.nextChunkIndex === undefined
          ? {}
          : { next_chunk_index: acknowledgement.nextChunkIndex }),
        ...(acknowledgement.reasonCode === undefined
          ? {}
          : { reason_code: acknowledgement.reasonCode })
      },
      traceId
    );
  }

  #sendError(
    connection: BrowserConnection,
    code: string,
    detail: string,
    relatedMessageId?: string,
    fatal = false
  ): void {
    if (!connection.session) return;
    this.#sendMessage(
      connection,
      "session.error",
      {
        code,
        message: detail.slice(0, 4000),
        fatal,
        ...(relatedMessageId
          ? { related_message_id: relatedMessageId }
          : {})
      },
      `trace-error-${randomUUID()}`
    );
  }

  #tokenDigest(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  #nodeCatalog(): MemoryNodeCatalog {
    return new MemoryNodeCatalog(
      this.persistence
        .listPublished("node")
        .map((artifact) => artifact.content as NodeDefinition)
    );
  }
}
