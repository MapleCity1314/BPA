import type { RuntimeOutcome } from "@bpa/node-runtime";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  TeamHandlerError,
  TeamHandlerRegistry
} from "./handler-registry.js";
import {
  decodeTeamJson,
  encodeTeamFrame,
  TEAM_PROTOCOL_VERSION,
  TeamFrameDecoder,
  TeamProtocolViolation,
  type TeamCancel,
  type TeamClientMessage,
  type TeamInvoke,
  type TeamProtocolError,
  type TeamWorkerMessage
} from "./protocol.js";

export interface TeamReadable {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

export interface TeamWritable {
  write(chunk: Buffer): unknown;
}

interface PendingHandler {
  readonly fencingToken: number;
  readonly controller: AbortController;
}

class TeamCancellation extends Error {
  constructor(readonly kind: "cancelled" | "timed_out") {
    super(kind);
  }
}

function failureOutcome(
  status: Exclude<RuntimeOutcome["status"], "succeeded">,
  code: string,
  message: string,
  retryable: boolean
): RuntimeOutcome {
  return {
    status,
    error: { code, message, retryable },
    evidence: [],
    riskSignals: []
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TeamWorkerServer {
  readonly #decoder = new TeamFrameDecoder();
  readonly #pending = new Map<string, PendingHandler>();
  #helloAccepted = false;
  #closed = false;

  readonly #onData = (chunk: Buffer): void => {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        const message = decodeTeamJson<TeamClientMessage>(frame);
        this.#handle(message);
      }
    } catch (error) {
      this.#sendError(
        undefined,
        error instanceof TeamProtocolViolation
          ? error.code
          : "TEAM_PROTOCOL_ERROR",
        error instanceof Error ? error.message : String(error),
        false
      );
      this.close();
    }
  };

  constructor(
    readonly input: TeamReadable,
    readonly output: TeamWritable,
    readonly codeDigest: string,
    readonly handlers: TeamHandlerRegistry,
    readonly clock: () => number = Date.now
  ) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(codeDigest)) {
      throw new Error("Team Worker code digest is invalid");
    }
  }

  start(): void {
    if (this.#closed) throw new Error("Team Worker server is closed");
    this.input.on("data", this.#onData);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.input.off("data", this.#onData);
    for (const pending of this.#pending.values()) {
      pending.controller.abort(new TeamCancellation("cancelled"));
    }
    this.#pending.clear();
    this.#decoder.reset();
  }

  #handle(message: TeamClientMessage): void {
    if (!isObject(message) || typeof message.type !== "string") {
      throw new TeamProtocolViolation(
        "MESSAGE_INVALID",
        "Team message must be an object with a type"
      );
    }
    if (message.type === "hello") {
      this.#handleHello(message);
      return;
    }
    if (!this.#helloAccepted) {
      this.#sendError(
        "requestId" in message ? String(message.requestId) : undefined,
        "HELLO_REQUIRED",
        "Team hello must complete before requests",
        false
      );
      return;
    }
    if (message.type === "invoke") {
      this.#handleInvoke(message);
      return;
    }
    if (message.type === "cancel") {
      this.#handleCancel(message);
      return;
    }
    throw new TeamProtocolViolation(
      "MESSAGE_TYPE_UNKNOWN",
      `Unknown Team message type: ${String(message.type)}`
    );
  }

  #handleHello(message: Extract<TeamClientMessage, { type: "hello" }>): void {
    if (
      this.#helloAccepted ||
      message.protocolVersion !== TEAM_PROTOCOL_VERSION ||
      message.expectedCodeDigest !== this.codeDigest
    ) {
      this.#sendError(
        undefined,
        "HELLO_DIGEST_MISMATCH",
        "Team Worker protocol or code digest does not match",
        false
      );
      return;
    }
    this.#helloAccepted = true;
    this.#send({
      type: "hello.ack",
      protocolVersion: TEAM_PROTOCOL_VERSION,
      codeDigest: this.codeDigest,
      handlers: this.handlers.refs()
    });
  }

  #handleInvoke(message: TeamInvoke): void {
    if (
      typeof message.requestId !== "string" ||
      !message.requestId ||
      !isObject(message.node) ||
      !Number.isFinite(message.deadlineAt) ||
      !Number.isSafeInteger(message.fencingToken) ||
      message.fencingToken < 1
    ) {
      this.#sendError(
        typeof message.requestId === "string"
          ? message.requestId
          : undefined,
        "INVOKE_INVALID",
        "Team invocation fields are invalid",
        false
      );
      return;
    }
    if (this.#pending.has(message.requestId)) {
      this.#sendError(
        message.requestId,
        "INVOKE_DUPLICATE",
        "Team invocation request id is already pending",
        false
      );
      return;
    }
    if (!this.handlers.has(message.node)) {
      this.#sendResult(
        message,
        failureOutcome(
          "rejected",
          "UNKNOWN_TEAM_HANDLER",
          `Unknown Team Handler: ${message.node.id}@${message.node.version}`,
          false
        )
      );
      return;
    }
    const remainingMs = message.deadlineAt - this.clock();
    if (remainingMs <= 0) {
      this.#sendResult(
        message,
        failureOutcome(
          "timed_out",
          "TEAM_HANDLER_TIMEOUT",
          "Team Handler deadline elapsed before dispatch",
          true
        )
      );
      return;
    }

    const controller = new AbortController();
    this.#pending.set(message.requestId, {
      fencingToken: message.fencingToken,
      controller
    });
    const timeout = setTimeout(() => {
      controller.abort(new TeamCancellation("timed_out"));
    }, remainingMs);
    timeout.unref();

    const cancellation = new Promise<RuntimeOutcome>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const kind =
            controller.signal.reason instanceof TeamCancellation
              ? controller.signal.reason.kind
              : "cancelled";
          resolve(
            kind === "timed_out"
              ? failureOutcome(
                  "timed_out",
                  "TEAM_HANDLER_TIMEOUT",
                  "Team Handler exceeded its deadline",
                  true
                )
              : failureOutcome(
                  "cancelled",
                  "TEAM_HANDLER_CANCELLED",
                  "Team Handler was cancelled",
                  false
                )
          );
        },
        { once: true }
      );
    });
    const execution = Promise.resolve()
      .then(() =>
        this.handlers
          .get(message.node)
          .invoke(message.input, controller.signal)
      )
      .then(
        (output): RuntimeOutcome => ({
          status: "succeeded",
          output,
          evidence: [],
          riskSignals: []
        }),
        (error): RuntimeOutcome =>
          error instanceof TeamHandlerError
            ? failureOutcome(
                "failed",
                error.code,
                error.message,
                error.retryable
              )
            : failureOutcome(
                "failed",
                "TEAM_HANDLER_FAILED",
                error instanceof Error ? error.message : String(error),
                false
              )
      );
    void Promise.race([execution, cancellation]).then((outcome) => {
      clearTimeout(timeout);
      const pending = this.#pending.get(message.requestId);
      if (!pending || pending.controller !== controller || this.#closed) return;
      this.#pending.delete(message.requestId);
      this.#sendResult(message, outcome);
    });
  }

  #handleCancel(message: TeamCancel): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (pending.fencingToken !== message.fencingToken) {
      this.#sendError(
        message.requestId,
        "STALE_FENCING_TOKEN",
        "Cancel fencing token does not match the pending invocation",
        false
      );
      return;
    }
    pending.controller.abort(new TeamCancellation("cancelled"));
  }

  #sendResult(message: TeamInvoke, outcome: RuntimeOutcome): void {
    try {
      this.#send({
        type: "result",
        requestId: message.requestId,
        fencingToken: message.fencingToken,
        outcome
      });
    } catch (error) {
      try {
        this.#send({
          type: "result",
          requestId: message.requestId,
          fencingToken: message.fencingToken,
          outcome: failureOutcome(
            "failed",
            "TEAM_RESULT_TOO_LARGE",
            error instanceof TeamProtocolViolation
              ? "Team Handler result exceeds the protocol frame limit"
              : "Team Handler result could not be encoded",
            false
          )
        });
      } catch {
        this.close();
      }
    }
  }

  #sendError(
    requestId: string | undefined,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    const error: TeamProtocolError = {
      type: "error",
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message,
      retryable
    };
    try {
      this.#send(error);
    } catch {
      this.close();
    }
  }

  #send(message: TeamWorkerMessage): void {
    if (!this.#closed) this.output.write(encodeTeamFrame(message));
  }
}
