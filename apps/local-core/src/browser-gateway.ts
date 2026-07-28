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

type Message = BrowserProtocolMessage & {
  payload: Record<string, unknown>;
};

export interface BrowserGatewayStatus {
  connected: boolean;
  ready: boolean;
  sessionId?: string;
  browserInstanceId?: string;
  extensionId: string;
  capabilityCount: number;
  lastError?: string;
}

interface ActiveSession {
  id: string;
  browserInstanceId: string;
  incoming: ProtocolSessionGuard;
  incomingSeq: number;
  outgoingSeq: number;
  lastAckedCommandSeq: number;
  ready: boolean;
  capabilities: BrowserCapabilityRecord[];
}

export class LocalBrowserGateway implements RuntimeProvider {
  readonly id = "browser";
  readonly #extensionId: string;
  #send: ((message: Message) => void) | undefined;
  #session: ActiveSession | undefined;
  #lastError: string | undefined;
  #connectionId: string | undefined;
  readonly #cancelRequests = new Set<string>();

  constructor(
    readonly persistence: Persistence,
    readonly engine: LocalWorkflowEngine,
    readonly signingKey: CoreSigningKey,
    extensionId =
      process.env.BPA_EXTENSION_ID ?? DEFAULT_BPA_EXTENSION_ID
  ) {
    this.#extensionId = extensionId;
  }

  attach(origin: string, send: (message: Message) => void): string {
    assertNativeHostOrigin(origin, this.#extensionId);
    const connectionId = randomUUID();
    this.#connectionId = connectionId;
    this.#send = send;
    this.#session = undefined;
    this.#lastError = undefined;
    this.#cancelRequests.clear();
    return connectionId;
  }

  detach(connectionId?: string): void {
    if (connectionId && connectionId !== this.#connectionId) return;
    if (this.#session) {
      this.persistence.updateBrowserSession({
        id: this.#session.id,
        disconnectedAt: new Date().toISOString()
      });
    }
    this.#send = undefined;
    this.#session = undefined;
    this.#connectionId = undefined;
    this.#cancelRequests.clear();
  }

  status(): BrowserGatewayStatus {
    return {
      connected: Boolean(this.#send),
      ready: this.#session?.ready ?? false,
      ...(this.#session ? { sessionId: this.#session.id } : {}),
      ...(this.#session
        ? { browserInstanceId: this.#session.browserInstanceId }
        : {}),
      extensionId: this.#extensionId,
      capabilityCount: this.#session?.capabilities.length ?? 0,
      ...(this.#lastError ? { lastError: this.#lastError } : {})
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

  handle(message: unknown): void {
    try {
      const candidate = message as Message;
      if (!this.#session) {
        this.#handleHello(candidate);
        return;
      }
      const acceptance = this.#session.incoming.accept(candidate);
      if (acceptance.status === "duplicate") {
        if (candidate.type === "command.result") {
          this.#handleResult(candidate);
        }
        return;
      }
      this.#session.incomingSeq = candidate.seq;
      this.persistence.updateBrowserSession({
        id: this.#session.id,
        incomingSeq: candidate.seq
      });
      switch (candidate.type) {
        case "capability.report":
          this.#handleCapabilities(candidate);
          break;
        case "command.ack":
          this.#handleCommandAck(candidate);
          break;
        case "command.result":
          this.#handleResult(candidate);
          break;
        case "heartbeat.pong":
          break;
        case "cancel.ack":
          break;
        case "cancel.effective":
          this.#handleCancelEffective(candidate);
          break;
        case "evidence.begin":
        case "evidence.chunk":
        case "evidence.complete":
          this.#sendError(
            "EVIDENCE_NOT_ENABLED",
            "Evidence transport is reserved by v1 but disabled for the first read-only milestone.",
            candidate.message_id
          );
          break;
        default:
          this.#sendError(
            "UNEXPECTED_MESSAGE",
            `Bridge message is not valid in the current state: ${candidate.type}`,
            candidate.message_id
          );
      }
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#sendError("PROTOCOL_VIOLATION", this.#lastError, undefined, true);
    }
  }

  dispatchPending(): number {
    const session = this.#session;
    if (!session?.ready) return 0;
    this.recoverCancellations();
    this.#promoteEngineMessages();
    let dispatched = 0;
    for (const command of this.persistence.listPendingGatewayCommands(
      session.lastAckedCommandSeq
    )) {
      if (this.#runIsCancelled(command)) continue;
      if (!this.#supports(command)) continue;
      this.#sendMessage(
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

  #handleHello(message: Message): void {
    const guard = new ProtocolSessionGuard();
    guard.accept(message);
    const payload = message.payload;
    const extensionId = String(payload.extension_id);
    if (extensionId !== this.#extensionId) {
      throw new Error(`Extension ID mismatch: ${extensionId}`);
    }
    const now = new Date();
    const sessionId = randomUUID();
    const resumeToken = randomBytes(32).toString("base64url");
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
    guard.establish(sessionId, 0);
    this.#session = {
      id: sessionId,
      browserInstanceId: opened.session.browserInstanceId,
      incoming: guard,
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: opened.session.lastAckedCommandSeq,
      ready: false,
      capabilities: []
    };
    this.#sendMessage(
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

  #handleCapabilities(message: Message): void {
    const session = this.#session!;
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
    this.#lastError = undefined;
    this.dispatchPending();
  }

  #handleCommandAck(message: Message): void {
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

  #handleResult(message: Message): void {
    const outcome = this.#commitResult(message.message_id, message.payload);
    this.#cancelRequests.delete(String(message.payload.command_id));
    if (outcome !== "stale") this.#lastError = undefined;
    if (outcome !== "stale") {
      const command = this.persistence.getGatewayCommand(
        String(message.payload.command_id)
      );
      if (command) {
        this.#session!.lastAckedCommandSeq = Math.max(
          this.#session!.lastAckedCommandSeq,
          command.commandSeq
        );
        this.persistence.updateBrowserSession({
          id: this.#session!.id,
          lastAckedCommandSeq: this.#session!.lastAckedCommandSeq
        });
      }
    }
    this.#sendMessage(
      "result.ack",
      {
        command_id: String(message.payload.command_id),
        node_execution_id: String(message.payload.node_execution_id),
        accepted: outcome !== "stale",
        ...(outcome === "stale" ? { reason_code: "STALE_FENCING_TOKEN" } : {})
      },
      message.trace_id
    );
  }

  #handleCancelEffective(message: Message): void {
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
    this.#commitResult(message.message_id, {
      command_seq: command.commandSeq,
      command_id: command.id,
      node_execution_id: command.nodeExecutionId,
      idempotency_key: command.idempotencyKey,
      fencing_token: command.fencingToken,
      status: message.payload.status
    });
    this.#cancelRequests.delete(command.id);
  }

  #commitResult(
    inboxMessageId: string,
    payload: Record<string, unknown>
  ): "accepted" | "duplicate" | "stale" {
    const commandId = String(payload.command_id);
    const outcome = this.persistence.acceptResult({
      commandId,
      fencingToken: Number(payload.fencing_token),
      result: payload,
      inboxMessageId,
      receivedAt: new Date().toISOString()
    });
    if (outcome === "stale") return outcome;
    const command = this.persistence.getGatewayCommand(commandId);
    if (!command) throw new Error(`Gateway command not found: ${commandId}`);
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
    if (this.#session?.ready) {
      if (this.#cancelRequests.has(command.id)) return false;
      this.#sendMessage(
        "cancel.request",
        {
          command_id: command.id,
          node_execution_id: command.nodeExecutionId,
          fencing_token: command.fencingToken,
          reason_code: reasonCode
        },
        `trace-${command.nodeExecutionId}`
      );
      this.#cancelRequests.add(command.id);
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
    // Browser Protocol v1 carries evidence ids only, while RuntimeOutcome
    // requires verified digest-bearing refs. Evidence transport is disabled in
    // this milestone, so ids are not promoted into trusted Runtime evidence.
    const evidence: RuntimeOutcome["evidence"] = [];
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

  #supports(command: GatewayCommandRecord): boolean {
    const payload = command.payload as Record<string, unknown>;
    const node = payload.node as { id: string; version: string };
    const grant = payload.permission_grant as {
      permissions: string[];
      risk_level: RiskLevel;
    };
    return (
      this.#session?.capabilities.some(
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
    type: string,
    payload: Record<string, unknown>,
    traceId: string
  ): void {
    const session = this.#session;
    if (!session || !this.#send) {
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
    this.#send(message);
  }

  #sendError(
    code: string,
    detail: string,
    relatedMessageId?: string,
    fatal = false
  ): void {
    if (!this.#session || !this.#send) return;
    this.#sendMessage(
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
