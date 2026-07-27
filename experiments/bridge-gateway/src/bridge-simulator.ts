import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  envelope,
  experimentalMessageSchema,
  type Capability,
  type Command,
  type GatewayCommand,
  type ResultStatus
} from "./protocol.experimental.js";

export interface BridgeResult {
  status: ResultStatus;
  output?: unknown;
  error?: string;
}

export type NodeHandler = (
  input: unknown,
  command: Command
) => Promise<BridgeResult>;

interface PendingResult extends BridgeResult {
  commandSeq: number;
  nodeExecutionId: string;
  idempotencyKey: string;
}

export interface BridgeSimulatorOptions {
  url: string;
  pairingToken: string;
  browserInstanceId: string;
  extensionVersion?: string;
  capabilities: Capability[];
  handlers: Record<string, NodeHandler>;
}

export class BridgeSimulator extends EventEmitter {
  readonly pendingResults = new Map<string, PendingResult>();
  readonly executions = new Map<string, Promise<void>>();

  #options: Required<Omit<BridgeSimulatorOptions, "handlers">> & {
    handlers: Record<string, NodeHandler>;
  };
  #socket: WebSocket | undefined;
  #lastAckedCommandSeq = 0;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #connectPromise: Promise<void> | undefined;

  constructor(options: BridgeSimulatorOptions) {
    super();
    this.#options = {
      ...options,
      extensionVersion: options.extensionVersion ?? "simulator-0"
    };
  }

  connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#options.url);
      this.#socket = socket;
      socket.once("error", reject);
      socket.on("open", () => {
        this.#send(
          envelope("bridge.hello", {
            browserInstanceId: this.#options.browserInstanceId,
            pairingToken: this.#options.pairingToken,
            extensionVersion: this.#options.extensionVersion,
            lastAckedCommandSeq: this.#lastAckedCommandSeq,
            capabilities: this.#options.capabilities,
            pendingResults: [...this.pendingResults.values()]
          })
        );
      });
      socket.on("message", (raw) => {
        const parsed = experimentalMessageSchema.safeParse(
          JSON.parse(raw.toString())
        );
        if (!parsed.success) {
          this.emit("error", parsed.error);
          return;
        }
        const message = parsed.data;
        if (message.type === "gateway.welcome") {
          this.#startHeartbeat(message.payload.heartbeatMs);
          resolve();
          this.emit("connected", message.payload);
          return;
        }
        if (message.type === "gateway.command") {
          this.#receiveCommand(message);
          return;
        }
        if (message.type === "gateway.result_ack") {
          this.pendingResults.delete(message.payload.nodeExecutionId);
          this.#lastAckedCommandSeq = Math.max(
            this.#lastAckedCommandSeq,
            message.payload.commandSeq
          );
          this.emit("result.acked", message.payload.nodeExecutionId);
          return;
        }
        if (message.type === "gateway.heartbeat_ack") {
          this.emit("heartbeat.acked", message.payload.nonce);
          return;
        }
        if (message.type === "session.error") {
          this.emit("session.error", message.payload);
        }
      });
      socket.on("close", () => {
        this.#stopHeartbeat();
        this.#connectPromise = undefined;
        this.emit("disconnected");
      });
    });
    return this.#connectPromise;
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    this.#stopHeartbeat();
    this.#connectPromise = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  terminate(): void {
    this.#stopHeartbeat();
    this.#socket?.terminate();
    this.#connectPromise = undefined;
  }

  #receiveCommand(message: GatewayCommand): void {
    const command = message.payload;
    const existing = this.executions.get(command.nodeExecutionId);
    this.#send(
      envelope("bridge.command_ack", {
        commandSeq: command.commandSeq,
        nodeExecutionId: command.nodeExecutionId,
        accepted: true
      })
    );
    if (existing) {
      const pending = this.pendingResults.get(command.nodeExecutionId);
      if (pending) this.#sendResult(pending);
      return;
    }
    const execution = this.#execute(command);
    this.executions.set(command.nodeExecutionId, execution);
  }

  async #execute(command: Command): Promise<void> {
    const key = `${command.node.id}@${command.node.version}`;
    const handler = this.#options.handlers[key];
    let result: BridgeResult;
    if (!handler) {
      result = {
        status: "rejected",
        error: `No handler registered for ${key}`
      };
    } else {
      try {
        result = await handler(command.input, command);
      } catch (error) {
        result = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    const pending: PendingResult = {
      commandSeq: command.commandSeq,
      nodeExecutionId: command.nodeExecutionId,
      idempotencyKey: command.idempotencyKey,
      ...result
    };
    this.pendingResults.set(command.nodeExecutionId, pending);
    this.#sendResult(pending);
  }

  #sendResult(result: PendingResult): void {
    this.#send(
      envelope("bridge.command_result", {
        commandSeq: result.commandSeq,
        nodeExecutionId: result.nodeExecutionId,
        idempotencyKey: result.idempotencyKey,
        status: result.status,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { error: result.error })
      })
    );
  }

  #startHeartbeat(heartbeatMs: number): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#send(
        envelope("bridge.heartbeat", {
          nonce: `heartbeat_${Date.now()}`
        })
      );
    }, heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}
