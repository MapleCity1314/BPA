import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  CONTROL_HELLO_PROTOCOL_VERSION,
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  decodeControlEnvelope,
  encodeControlEnvelope,
  parseControlHelloResponse,
  parseControlResponse,
  type ControlHelloRequestEnvelope,
  type ControlRequestEnvelope,
  type ControlResponseEnvelope
} from "@bpa/control-protocol";
import {
  resolveDefaultBpaHome,
  resolveLocalIpcEndpoint
} from "@bpa/platform-runtime";

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
  maxRememberedRequestIds?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface UnixSocketControlTransportOptions {
  negotiate?: boolean;
  runtime?: {
    name: string;
    version: string;
  };
  features?: string[];
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
  readonly #maxRememberedRequestIds: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #activeRequestIds = new Set<string>();
  readonly #completedRequestIds = new Set<string>();
  readonly #requestIdOrder: string[] = [];

  constructor(transport: ControlTransport, options: ControlClientOptions = {}) {
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? randomUUID;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRememberedRequestIds = options.maxRememberedRequestIds ?? 4096;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as NodeJS.Timeout));
    if (
      !Number.isSafeInteger(this.#maxRememberedRequestIds) ||
      this.#maxRememberedRequestIds < 1
    ) {
      throw new Error("maxRememberedRequestIds must be a positive integer");
    }
  }

  async request<TResult>(
    method: string,
    params: Record<string, unknown> = {},
    options: { requestId?: string; timeoutMs?: number } = {}
  ): Promise<TResult> {
    const requestId = options.requestId ?? this.#requestId();
    if (
      this.#activeRequestIds.has(requestId) ||
      this.#completedRequestIds.has(requestId)
    ) {
      throw new ControlClientError(
        "DUPLICATE_REQUEST",
        `Control request id was already used: ${requestId}`
      );
    }
    this.#activeRequestIds.add(requestId);
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
    const timer = this.#schedule(() => controller.abort(), timeoutMs);
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
      this.#cancelScheduled(timer);
      this.#activeRequestIds.delete(requestId);
      this.#completedRequestIds.add(requestId);
      this.#requestIdOrder.push(requestId);
      if (this.#requestIdOrder.length > this.#maxRememberedRequestIds) {
        const expired = this.#requestIdOrder.shift();
        if (expired) this.#completedRequestIds.delete(expired);
      }
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

export function resolveControlEndpoint(
  root = resolveDefaultBpaHome(
    process.env.BPA_HOME ? { bpaHome: process.env.BPA_HOME } : {}
  ),
  platform: NodeJS.Platform = process.platform
): string {
  return resolveLocalIpcEndpoint(root, "core", platform);
}

/**
 * Compatibility name retained for existing integrations. The returned value
 * is a Unix-domain socket on macOS and a named pipe on Windows.
 */
export function resolveControlSocketPath(
  root = resolveDefaultBpaHome(
    process.env.BPA_HOME ? { bpaHome: process.env.BPA_HOME } : {}
  ),
  platform: NodeJS.Platform = process.platform
): string {
  return resolveControlEndpoint(root, platform);
}

export class UnixSocketControlTransport implements ControlTransport {
  readonly #negotiate: boolean;
  readonly #runtime: { name: string; version: string };
  readonly #features: string[];

  constructor(
    readonly socketPath: string,
    options: UnixSocketControlTransportOptions = {}
  ) {
    this.#negotiate = options.negotiate ?? true;
    this.#runtime = options.runtime ?? {
      name: "bpa-control-client",
      version: "0.6.1"
    };
    this.#features = options.features ?? [];
  }

  send(
    request: ControlRequestEnvelope,
    signal: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffered = Buffer.alloc(0);
      let negotiatedMaxFrameBytes = CONTROL_MAX_MESSAGE_BYTES;
      let waitingForHello = this.#negotiate;
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
      const sendApplicationRequest = () => {
        const encoded = Buffer.from(encodeControlEnvelope(request));
        if (encoded.byteLength > negotiatedMaxFrameBytes) {
          finish(() =>
            reject(
              new Error("Control request exceeds negotiated maximum size")
            )
          );
          return;
        }
        socket.write(encoded);
      };
      socket.on("connect", () => {
        if (!this.#negotiate) {
          sendApplicationRequest();
          return;
        }
        const hello: ControlHelloRequestEnvelope = {
          version: CONTROL_HELLO_PROTOCOL_VERSION,
          kind: "hello",
          requestId: `${request.requestId.slice(0, 193)}:hello`,
          supportedApplicationProtocols: [CONTROL_PROTOCOL_VERSION],
          runtime: this.#runtime,
          maxFrameBytes: CONTROL_MAX_MESSAGE_BYTES,
          features: this.#features
        };
        socket.write(Buffer.from(encodeControlEnvelope(hello)));
      });
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > negotiatedMaxFrameBytes) {
          finish(() => reject(new Error("Control response exceeds maximum size")));
          return;
        }
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0 && !settled) {
          const bytes = buffered.subarray(0, newline + 1);
          buffered = buffered.subarray(newline + 1);
          let message: unknown;
          try {
            message = decodeControlEnvelope(bytes);
          } catch (error) {
            finish(() => reject(error));
            return;
          }
          if (waitingForHello) {
            try {
              const hello = parseControlHelloResponse(message);
              if (hello.kind === "error") {
                finish(() =>
                  reject(
                    new Error(
                      `Control negotiation failed: ${hello.error.code}: ${hello.error.message}`
                    )
                  )
                );
                return;
              }
              if (hello.applicationProtocol !== CONTROL_PROTOCOL_VERSION) {
                finish(() =>
                  reject(
                    new Error(
                      `Unsupported negotiated control protocol: ${hello.applicationProtocol}`
                    )
                  )
                );
                return;
              }
              negotiatedMaxFrameBytes = hello.maxFrameBytes;
              waitingForHello = false;
              sendApplicationRequest();
            } catch (error) {
              finish(() =>
                reject(
                  new Error(
                    `Control negotiation response is invalid: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                )
              );
            }
            return;
          }
          finish(() => resolve(message));
          newline = buffered.indexOf(0x0a);
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

export {
  UnixSocketControlTransport as LocalSocketControlTransport
};
