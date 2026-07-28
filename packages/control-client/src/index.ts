import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  decodeControlEnvelope,
  encodeControlEnvelope,
  parseControlResponse,
  type ControlRequestEnvelope,
  type ControlResponseEnvelope
} from "@bpa/control-protocol";

export interface ControlTransport {
  send(
    request: ControlRequestEnvelope,
    signal: AbortSignal
  ): Promise<unknown>;
}

export interface ControlClientOptions {
  now?: () => number;
  requestId?: () => string;
  timeoutMs?: number;
}

export class ControlClientError extends Error {
  constructor(
    readonly code:
      | "MALFORMED_RESPONSE"
      | "REQUEST_ID_MISMATCH"
      | "DUPLICATE_REQUEST"
      | "DEADLINE_EXCEEDED"
      | "TRANSPORT_ERROR"
      | "REMOTE_ERROR",
    message: string,
    readonly remoteCode?: string
  ) {
    super(message);
  }
}

export class ControlClient {
  readonly #transport: ControlTransport;
  readonly #now: () => number;
  readonly #requestId: () => string;
  readonly #timeoutMs: number;
  readonly #usedRequestIds = new Set<string>();

  constructor(transport: ControlTransport, options: ControlClientOptions = {}) {
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? randomUUID;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<TResult>(
    method: string,
    params: Record<string, unknown> = {},
    options: { requestId?: string; timeoutMs?: number } = {}
  ): Promise<TResult> {
    const requestId = options.requestId ?? this.#requestId();
    if (this.#usedRequestIds.has(requestId)) {
      throw new ControlClientError(
        "DUPLICATE_REQUEST",
        `Control request id was already used: ${requestId}`
      );
    }
    this.#usedRequestIds.add(requestId);
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const startedAt = this.#now();
    const request: ControlRequestEnvelope = {
      version: CONTROL_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      method,
      deadline: new Date(startedAt + timeoutMs).toISOString(),
      params
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let raw: unknown;
    try {
      raw = await this.#transport.send(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.#now() >= startedAt + timeoutMs) {
        throw new ControlClientError(
          "DEADLINE_EXCEEDED",
          `Control request exceeded ${timeoutMs}ms`
        );
      }
      throw new ControlClientError(
        "TRANSPORT_ERROR",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted || this.#now() >= startedAt + timeoutMs) {
      throw new ControlClientError(
        "DEADLINE_EXCEEDED",
        `Control request exceeded ${timeoutMs}ms`
      );
    }
    let response: ControlResponseEnvelope<TResult>;
    try {
      response = parseControlResponse<TResult>(raw);
    } catch (error) {
      throw new ControlClientError(
        "MALFORMED_RESPONSE",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (response.requestId !== requestId) {
      throw new ControlClientError(
        "REQUEST_ID_MISMATCH",
        `Expected response ${requestId}, received ${response.requestId}`
      );
    }
    if (response.kind === "error") {
      throw new ControlClientError(
        "REMOTE_ERROR",
        response.error.message,
        response.error.code
      );
    }
    return response.result;
  }
}

export class UnixSocketControlTransport implements ControlTransport {
  constructor(readonly socketPath: string) {}

  send(
    request: ControlRequestEnvelope,
    signal: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const chunks: Uint8Array[] = [];
      let length = 0;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        callback();
      };
      const onAbort = () =>
        finish(() => reject(new Error("Control request aborted")));
      signal.addEventListener("abort", onAbort, { once: true });
      socket.on("connect", () => socket.write(encodeControlEnvelope(request)));
      socket.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > CONTROL_MAX_MESSAGE_BYTES) {
          finish(() => reject(new Error("Control response exceeds maximum size")));
          return;
        }
        chunks.push(chunk);
        if (chunk.includes(0x0a)) {
          finish(() => {
            const bytes = Buffer.concat(chunks);
            try {
              resolve(decodeControlEnvelope(bytes));
            } catch (error) {
              reject(error);
            }
          });
        }
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("end", () => {
        if (!settled) {
          finish(() => reject(new Error("Control socket closed without response")));
        }
      });
    });
  }
}
