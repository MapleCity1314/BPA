import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  bridgeCommandResultSchema,
  bridgeHelloSchema,
  envelope,
  experimentalMessageSchema,
  type BridgeCommandResult,
  type Capability,
  type Command,
  type ExperimentalMessage,
  type ResultStatus
} from "./protocol.experimental.js";
import {
  MemoryGatewayStateStore,
  type GatewayStateStore
} from "./state-store.js";

export interface GatewayOptions {
  host?: string;
  port?: number;
  pairingToken: string;
  heartbeatMs?: number;
  resultAckDelayMs?: number;
  stateStore?: GatewayStateStore;
}

export interface StoredCommand extends Command {
  browserInstanceId: string;
  state: "queued" | "delivered" | "accepted" | "terminal";
  result?: {
    status: ResultStatus;
    output?: unknown;
    error?: string;
  };
}

interface BrowserSession {
  browserInstanceId: string;
  sessionId: string;
  socket: WebSocket;
  capabilities: Capability[];
  connectedAt: number;
}

export class ExperimentalGateway extends EventEmitter {
  readonly commands = new Map<string, StoredCommand>();
  readonly resultsByIdempotencyKey = new Map<
    string,
    StoredCommand["result"] & object
  >();

  #options: Required<GatewayOptions>;
  #server: WebSocketServer | undefined;
  #sessions = new Map<string, BrowserSession>();
  #nextCommandSeq = 0;
  #stateStore: GatewayStateStore;
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(options: GatewayOptions) {
    super();
    this.#stateStore =
      options.stateStore ?? new MemoryGatewayStateStore();
    this.#options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      pairingToken: options.pairingToken,
      heartbeatMs: options.heartbeatMs ?? 20_000,
      resultAckDelayMs: options.resultAckDelayMs ?? 0,
      stateStore: this.#stateStore
    };
  }

  async start(): Promise<number> {
    if (this.#server) throw new Error("Gateway already started");
    const snapshot = await this.#stateStore.load();
    if (snapshot) {
      this.#nextCommandSeq = snapshot.nextCommandSeq;
      this.commands.clear();
      this.resultsByIdempotencyKey.clear();
      for (const command of snapshot.commands) {
        this.commands.set(command.nodeExecutionId, command);
        if (command.result) {
          this.resultsByIdempotencyKey.set(
            command.idempotencyKey,
            command.result
          );
        }
      }
    }
    const server = new WebSocketServer({
      host: this.#options.host,
      port: this.#options.port
    });
    this.#server = server;
    server.on("connection", (socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    for (const session of this.#sessions.values()) {
      session.socket.close();
    }
    this.#sessions.clear();
    await this.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = undefined;
  }

  get connectedBrowsers(): string[] {
    return [...this.#sessions.keys()];
  }

  dispatch(
    browserInstanceId: string,
    request: Omit<Command, "commandSeq">
  ): StoredCommand {
    const existingResult = this.resultsByIdempotencyKey.get(
      request.idempotencyKey
    );
    if (existingResult) {
      throw new Error(
        `Idempotency key already has terminal result: ${request.idempotencyKey}`
      );
    }
    if (this.commands.has(request.nodeExecutionId)) {
      throw new Error(
        `Node execution already exists: ${request.nodeExecutionId}`
      );
    }
    const session = this.#sessions.get(browserInstanceId);
    if (!session) throw new Error(`Browser is offline: ${browserInstanceId}`);
    if (!this.#supports(session.capabilities, request.node)) {
      throw new Error(
        `Browser does not support ${request.node.id}@${request.node.version}`
      );
    }
    this.#nextCommandSeq += 1;
    const command: StoredCommand = {
      ...request,
      commandSeq: this.#nextCommandSeq,
      browserInstanceId,
      state: "queued"
    };
    this.commands.set(command.nodeExecutionId, command);
    this.#persist();
    this.#sendCommand(session, command);
    return command;
  }

  waitForResult(
    nodeExecutionId: string,
    timeoutMs = 5_000
  ): Promise<StoredCommand["result"] & object> {
    const current = this.commands.get(nodeExecutionId);
    if (current?.result) return Promise.resolve(current.result);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off(`result:${nodeExecutionId}`, onResult);
        reject(new Error(`Timed out waiting for ${nodeExecutionId}`));
      }, timeoutMs);
      const onResult = (result: StoredCommand["result"] & object) => {
        clearTimeout(timeout);
        resolve(result);
      };
      this.once(`result:${nodeExecutionId}`, onResult);
    });
  }

  disconnectBrowser(browserInstanceId: string): void {
    this.#sessions.get(browserInstanceId)?.socket.terminate();
  }

  async flush(): Promise<void> {
    await this.#persistQueue;
  }

  #onConnection(socket: WebSocket): void {
    let session: BrowserSession | undefined;
    socket.on("message", (raw) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        this.#sendError(socket, "INVALID_MESSAGE", "Message is not valid JSON");
        return;
      }
      const parsed = experimentalMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        this.#sendError(
          socket,
          "INVALID_MESSAGE",
          parsed.error.issues[0]?.message ?? "Message schema rejected"
        );
        return;
      }
      const message = parsed.data;
      if (message.type === "bridge.hello") {
        session = this.#acceptHello(socket, message);
        return;
      }
      if (!session) {
        this.#sendError(
          socket,
          "SESSION_NOT_READY",
          "bridge.hello must be the first message"
        );
        return;
      }
      this.#handleSessionMessage(session, message);
    });
    socket.on("close", () => {
      if (
        session &&
        this.#sessions.get(session.browserInstanceId)?.socket === socket
      ) {
        this.#sessions.delete(session.browserInstanceId);
        this.emit("browser.disconnected", session.browserInstanceId);
      }
    });
  }

  #acceptHello(
    socket: WebSocket,
    message: ReturnType<typeof bridgeHelloSchema.parse>
  ): BrowserSession | undefined {
    if (message.payload.pairingToken !== this.#options.pairingToken) {
      this.#sendError(socket, "PAIRING_REJECTED", "Pairing token rejected");
      socket.close(1008, "Pairing rejected");
      return undefined;
    }
    const existing = this.#sessions.get(message.payload.browserInstanceId);
    existing?.socket.close(4001, "Replaced by resumed connection");
    const resumed =
      [...this.commands.values()].some(
        (command) =>
          command.browserInstanceId === message.payload.browserInstanceId
      ) || message.payload.pendingResults.length > 0;
    const session: BrowserSession = {
      browserInstanceId: message.payload.browserInstanceId,
      sessionId: randomUUID(),
      socket,
      capabilities: message.payload.capabilities,
      connectedAt: Date.now()
    };
    this.#sessions.set(session.browserInstanceId, session);
    this.#send(
      socket,
      envelope("gateway.welcome", {
        sessionId: session.sessionId,
        heartbeatMs: this.#options.heartbeatMs,
        resumed
      })
    );
    for (const result of message.payload.pendingResults) {
      this.#acceptResult(
        session,
        bridgeCommandResultSchema.parse(
          envelope("bridge.command_result", result)
        )
      );
    }
    for (const command of this.commands.values()) {
      if (
        command.browserInstanceId === session.browserInstanceId &&
        command.state !== "terminal"
      ) {
        this.#sendCommand(session, command);
      }
    }
    this.emit("browser.connected", session.browserInstanceId);
    return session;
  }

  #handleSessionMessage(
    session: BrowserSession,
    message: ExperimentalMessage
  ): void {
    switch (message.type) {
      case "bridge.command_ack": {
        const command = this.commands.get(message.payload.nodeExecutionId);
        if (!command || command.commandSeq !== message.payload.commandSeq) return;
        command.state = message.payload.accepted ? "accepted" : "terminal";
        if (!message.payload.accepted) {
          command.result = {
            status: "rejected",
            error: message.payload.reason ?? "Bridge rejected command"
          };
          this.#complete(command);
        }
        this.#persist();
        break;
      }
      case "bridge.command_result":
        this.#acceptResult(session, message);
        break;
      case "bridge.heartbeat":
        this.#send(
          session.socket,
          envelope("gateway.heartbeat_ack", {
            nonce: message.payload.nonce
          })
        );
        break;
      default:
        break;
    }
  }

  #acceptResult(
    session: BrowserSession,
    message: BridgeCommandResult
  ): void {
    const command = this.commands.get(message.payload.nodeExecutionId);
    if (
      !command ||
      command.browserInstanceId !== session.browserInstanceId ||
      command.commandSeq !== message.payload.commandSeq ||
      command.idempotencyKey !== message.payload.idempotencyKey
    ) {
      return;
    }
    if (!command.result) {
      command.result = {
        status: message.payload.status,
        ...(message.payload.output === undefined
          ? {}
          : { output: message.payload.output }),
        ...(message.payload.error === undefined
          ? {}
          : { error: message.payload.error })
      };
      command.state = "terminal";
      this.resultsByIdempotencyKey.set(
        command.idempotencyKey,
        command.result
      );
      this.#complete(command);
      this.#persist();
    }
    const sendAck = () => {
      this.#send(
        session.socket,
        envelope("gateway.result_ack", {
          commandSeq: command.commandSeq,
          nodeExecutionId: command.nodeExecutionId
        })
      );
    };
    if (this.#options.resultAckDelayMs > 0) {
      setTimeout(sendAck, this.#options.resultAckDelayMs);
    } else {
      sendAck();
    }
  }

  #complete(command: StoredCommand): void {
    if (!command.result) return;
    this.emit(`result:${command.nodeExecutionId}`, command.result);
    this.emit("command.completed", command);
  }

  #sendCommand(session: BrowserSession, command: StoredCommand): void {
    command.state = "delivered";
    this.#send(
      session.socket,
      envelope("gateway.command", {
        commandSeq: command.commandSeq,
        nodeExecutionId: command.nodeExecutionId,
        idempotencyKey: command.idempotencyKey,
        node: command.node,
        input: command.input,
        leaseMs: command.leaseMs
      })
    );
  }

  #supports(
    capabilities: Capability[],
    node: Command["node"]
  ): boolean {
    return capabilities.some(
      (capability) =>
        capability.nodeId === node.id &&
        capability.versions.includes(node.version)
    );
  }

  #sendError(
    socket: WebSocket,
    code:
      | "INVALID_MESSAGE"
      | "PAIRING_REJECTED"
      | "DUPLICATE_BROWSER"
      | "CAPABILITY_MISSING"
      | "SESSION_NOT_READY",
    message: string
  ): void {
    this.#send(socket, envelope("session.error", { code, message }));
  }

  #send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  #persist(): void {
    const snapshot = {
      nextCommandSeq: this.#nextCommandSeq,
      commands: [...this.commands.values()]
    };
    this.#persistQueue = this.#persistQueue.then(() =>
      this.#stateStore.save(structuredClone(snapshot))
    );
  }
}
