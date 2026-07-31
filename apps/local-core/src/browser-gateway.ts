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
  BrowserCapabilityRecord,
  GatewayCommandRecord,
  Persistence
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

type Message = BrowserProtocolMessage & {
  payload: Record<string, unknown>;
};

export interface BrowserGatewayStatus {
  connected: boolean;
  ready: boolean;
  activeSessionCount?: number;
  sessionId?: string;
  browserInstanceId?: string;
  extensionId: string;
  capabilityCount: number;
  lastError?: string;
}

interface ActiveSession {
  id: string;
  browserInstanceId: string;
  extensionVersion: string;
  connectedAt: number;
  incoming: ProtocolSessionGuard;
  incomingSeq: number;
  outgoingSeq: number;
  lastAckedCommandSeq: number;
  ready: boolean;
  capabilities: BrowserCapabilityRecord[];
}

interface BrowserConnection {
  id: string;
  attachedOrder: number;
  send: (message: Message) => void;
  session?: ActiveSession;
  lastError?: string;
  cancelRequests: Set<string>;
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
  persistence: Pick<Persistence, "getDesignModeGrant">,
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

  constructor(
    readonly persistence: Persistence,
    readonly engine: LocalWorkflowEngine,
    readonly signingKey: CoreSigningKey,
    extensionId =
      process.env.BPA_EXTENSION_ID ?? DEFAULT_BPA_EXTENSION_ID,
    readonly evidence?: BrowserEvidenceReceiver
  ) {
    this.#extensionId = extensionId;
  }

  attach(origin: string, send: (message: Message) => void): string {
    assertNativeHostOrigin(origin, this.#extensionId);
    const connectionId = randomUUID();
    this.#connections.set(connectionId, {
      id: connectionId,
      attachedOrder: ++this.#attachedOrder,
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
      this.persistence.updateBrowserSession({
        id: connection.session.id,
        disconnectedAt: new Date().toISOString()
      });
    }
    this.#connections.delete(connection.id);
  }

  status(): BrowserGatewayStatus {
    const primary =
      this.#primaryConnection() ?? this.#primaryConnection(false);
    return {
      connected: this.#connections.size > 0,
      ready: Boolean(primary?.session?.ready),
      activeSessionCount: [...this.#connections.values()].filter(
        (connection) => connection.session?.ready
      ).length,
      ...(primary?.session ? { sessionId: primary.session.id } : {}),
      ...(primary?.session
        ? { browserInstanceId: primary.session.browserInstanceId }
        : {}),
      extensionId: this.#extensionId,
      capabilityCount: primary?.session?.capabilities.length ?? 0,
      ...(primary?.lastError ? { lastError: primary.lastError } : {})
    };
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
        this.#handleHello(connection, candidate);
        return;
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
        case "command.ack":
          this.#handleCommandAck(connection, candidate);
          break;
        case "command.result":
          this.#handleResult(connection, candidate);
          break;
        case "heartbeat.pong":
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

  dispatchPending(): number {
    if (!this.#primaryConnection()) return 0;
    this.recoverCancellations();
    this.#promoteEngineMessages();
    let dispatched = 0;
    for (const command of this.persistence.listPendingGatewayCommands()) {
      if (this.#runIsCancelled(command)) continue;
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
      dispatched += 1;
    }
    return dispatched;
  }

  tick(at = new Date()): { timedOut: number; dispatched: number } {
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
    guard.establish(activeSessionId, 0);
    connection.session = {
      id: activeSessionId,
      browserInstanceId: opened.session.browserInstanceId,
      extensionVersion: opened.session.extensionVersion,
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
    const reported = message.payload.capabilities as Array<{
      node_id: string;
      versions: string[];
      risk_level: string;
      permissions: string[];
    }>;
    const capabilities = reported.flatMap((capability) =>
      capability.versions.map((version) => ({
        nodeId: capability.node_id,
        nodeVersion: version,
        riskLevel: capability.risk_level,
        permissions: capability.permissions
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
      deadline
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
    return (
      connection.session?.capabilities.some(
        (capability) =>
          capability.nodeId === node.id &&
          capability.nodeVersion === node.version &&
          capability.riskLevel === grant.risk_level &&
          grant.permissions.every((permission) =>
            capability.permissions.includes(permission)
          )
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
