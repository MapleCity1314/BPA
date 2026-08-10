import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  RuntimeInvocation,
  RuntimeOutcome
} from "@bpa/node-runtime";
import {
  decodeTeamJson,
  encodeTeamFrame,
  TEAM_PROTOCOL_VERSION,
  TeamFrameDecoder,
  TeamProtocolViolation,
  teamNodeRef,
  type TeamClientMessage,
  type TeamWorkerMessage
} from "./protocol.js";

export interface TeamWorkerProcessSpec {
  /**
   * Trusted installation configuration only. Protocol inputs can never select
   * an executable, working directory, module, or Handler path.
   */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TeamWorkerClientOptions {
  readonly process: TeamWorkerProcessSpec;
  readonly expectedCodeDigest: string;
  readonly expectedHandlerRefs: readonly string[];
  readonly helloTimeoutMs?: number;
}

export interface TeamWorkerClientStatus {
  readonly state: "stopped" | "starting" | "ready";
  readonly pid: number | null;
  readonly pendingInvocationCount: number;
}

interface PendingInvocation {
  readonly fencingToken: number;
  readonly resolve: (outcome: RuntimeOutcome) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface Handshake {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function failedOutcome(
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

function exactStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index]
    )
  );
}

export class TeamWorkerClient {
  readonly #decoder = new TeamFrameDecoder();
  readonly #pending = new Map<string, PendingInvocation>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #handshake: Handshake | undefined;
  #stderr = "";
  #stopping = false;
  #ready = false;

  constructor(readonly options: TeamWorkerClientOptions) {
    if (!isAbsolute(options.process.command)) {
      throw new Error("Team Worker command must be an absolute path");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.expectedCodeDigest)) {
      throw new Error("Expected Team Worker code digest is invalid");
    }
  }

  async start(): Promise<void> {
    if (this.#child && this.#handshake) return this.#handshake.promise;
    this.#stopping = false;
    this.#ready = false;
    this.#decoder.reset();
    this.#stderr = "";
    const child = spawn(
      this.options.process.command,
      [...this.options.process.args],
      {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.process.cwd === undefined
          ? {}
          : { cwd: this.options.process.cwd }),
        env: Object.fromEntries(
          Object.entries(this.options.process.env ?? {}).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string"
          )
        )
      }
    );
    this.#child = child;
    let resolveHandshake!: () => void;
    let rejectHandshake!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const timer = setTimeout(() => {
      this.#protocolFailure(
        child,
        "TEAM_WORKER_HELLO_TIMEOUT",
        "Team Worker did not complete hello in time",
        true
      );
    }, this.options.helloTimeoutMs ?? 5_000);
    timer.unref();
    this.#handshake = {
      promise,
      resolve: resolveHandshake,
      reject: rejectHandshake,
      timer
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return;
      try {
        for (const frame of this.#decoder.push(chunk)) {
          this.#handleMessage(
            child,
            decodeTeamJson<TeamWorkerMessage>(frame)
          );
        }
      } catch (error) {
        this.#protocolFailure(
          child,
          error instanceof TeamProtocolViolation
            ? error.code
            : "TEAM_WORKER_PROTOCOL_ERROR",
          error instanceof Error ? error.message : String(error),
          false
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return;
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("error", (error) => {
      this.#workerExited(child, `Failed to spawn Team Worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.#workerExited(
        child,
        `Team Worker exited (${code ?? "null"}/${signal ?? "none"})${
          this.#stderr ? `: ${this.#stderr}` : ""
        }`
      );
    });
    this.#send({
      type: "hello",
      protocolVersion: TEAM_PROTOCOL_VERSION,
      expectedCodeDigest: this.options.expectedCodeDigest
    });
    return promise;
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (
      !this.options.expectedHandlerRefs.includes(teamNodeRef(invocation.node))
    ) {
      return failedOutcome(
        "rejected",
        "UNKNOWN_TEAM_HANDLER",
        `Unknown Team Handler: ${teamNodeRef(invocation.node)}`,
        false
      );
    }
    if (signal.aborted) {
      return failedOutcome(
        "cancelled",
        "TEAM_HANDLER_CANCELLED",
        "Team invocation was cancelled before dispatch",
        false
      );
    }
    try {
      await this.start();
    } catch (error) {
      return failedOutcome(
        "failed",
        error instanceof TeamClientError
          ? error.code
          : "TEAM_WORKER_START_FAILED",
        error instanceof Error ? error.message : String(error),
        error instanceof TeamClientError ? error.retryable : true
      );
    }
    if (signal.aborted) {
      return failedOutcome(
        "cancelled",
        "TEAM_HANDLER_CANCELLED",
        "Team invocation was cancelled before dispatch",
        false
      );
    }
    const remainingMs = invocation.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return failedOutcome(
        "timed_out",
        "TEAM_HANDLER_TIMEOUT",
        "Team invocation deadline elapsed before dispatch",
        true
      );
    }
    return new Promise<RuntimeOutcome>((resolve) => {
      const onAbort = (): void => {
        this.cancel(invocation.invocationId, invocation.fencingToken);
      };
      const timer = setTimeout(() => {
        this.#sendCancel(invocation.invocationId, invocation.fencingToken);
        this.#settle(
          invocation.invocationId,
          failedOutcome(
            "timed_out",
            "TEAM_HANDLER_TIMEOUT",
            "Team invocation exceeded its deadline",
            true
          )
        );
      }, remainingMs);
      timer.unref();
      this.#pending.set(invocation.invocationId, {
        fencingToken: invocation.fencingToken,
        resolve,
        timer,
        signal,
        onAbort
      });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.#send({
          type: "invoke",
          requestId: invocation.invocationId,
          node: invocation.node,
          input: invocation.input,
          deadlineAt: invocation.deadlineAt,
          fencingToken: invocation.fencingToken
        });
      } catch (error) {
        this.#settle(
          invocation.invocationId,
          failedOutcome(
            "failed",
            "TEAM_WORKER_WRITE_FAILED",
            error instanceof Error ? error.message : String(error),
            true
          )
        );
      }
    });
  }

  cancel(invocationId: string, fencingToken: number): void {
    const pending = this.#pending.get(invocationId);
    if (!pending || pending.fencingToken !== fencingToken) return;
    this.#sendCancel(invocationId, fencingToken);
    this.#settle(
      invocationId,
      failedOutcome(
        "cancelled",
        "TEAM_HANDLER_CANCELLED",
        "Team invocation was cancelled",
        false
      )
    );
  }

  status(): TeamWorkerClientStatus {
    const pid = this.#child?.pid;
    return {
      state: this.#child ? (this.#ready ? "ready" : "starting") : "stopped",
      pid: Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : null,
      pendingInvocationCount: this.#pending.size
    };
  }

  stop(): void {
    this.#stopping = true;
    this.#ready = false;
    const child = this.#child;
    this.#child = undefined;
    this.#rejectHandshake(
      new TeamClientError(
        "TEAM_WORKER_STOPPED",
        "Team Worker client stopped",
        true
      )
    );
    for (const invocationId of [...this.#pending.keys()]) {
      this.#settle(
        invocationId,
        failedOutcome(
          "cancelled",
          "TEAM_WORKER_STOPPED",
          "Team Worker client stopped",
          true
        )
      );
    }
    child?.kill("SIGTERM");
  }

  #handleMessage(
    child: ChildProcessWithoutNullStreams,
    message: TeamWorkerMessage
  ): void {
    if (!message || typeof message !== "object" || !("type" in message)) {
      this.#protocolFailure(
        child,
        "TEAM_WORKER_MESSAGE_INVALID",
        "Team Worker message is invalid",
        false
      );
      return;
    }
    if (message.type === "hello.ack") {
      if (
        message.protocolVersion !== TEAM_PROTOCOL_VERSION ||
        message.codeDigest !== this.options.expectedCodeDigest
      ) {
        this.#protocolFailure(
          child,
          "TEAM_WORKER_DIGEST_MISMATCH",
          "Team Worker hello digest does not match",
          false
        );
        return;
      }
      if (
        !exactStrings(
          message.handlers,
          this.options.expectedHandlerRefs
        )
      ) {
        this.#protocolFailure(
          child,
          "TEAM_WORKER_HANDLER_MANIFEST_MISMATCH",
          "Team Worker Handler manifest does not match",
          false
        );
        return;
      }
      const handshake = this.#handshake;
      if (!handshake) return;
      clearTimeout(handshake.timer);
      this.#ready = true;
      handshake.resolve();
      return;
    }
    if (message.type === "error") {
      if (message.requestId) {
        this.#settle(
          message.requestId,
          failedOutcome(
            "failed",
            message.code,
            message.message,
            message.retryable
          )
        );
      } else {
        this.#protocolFailure(
          child,
          message.code,
          message.message,
          message.retryable
        );
      }
      return;
    }
    if (message.type === "result") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      if (pending.fencingToken !== message.fencingToken) {
        this.#protocolFailure(
          child,
          "STALE_FENCING_TOKEN",
          "Team Worker result fencing token does not match",
          false
        );
        return;
      }
      this.#settle(message.requestId, message.outcome);
      return;
    }
    this.#protocolFailure(
      child,
      "TEAM_WORKER_MESSAGE_UNKNOWN",
      "Unknown Team Worker message type",
      false
    );
  }

  #sendCancel(invocationId: string, fencingToken: number): void {
    try {
      this.#send({ type: "cancel", requestId: invocationId, fencingToken });
    } catch {
      // The pending invocation is settled locally even if the worker died.
    }
  }

  #send(message: TeamClientMessage): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed) {
      throw new TeamClientError(
        "TEAM_WORKER_UNAVAILABLE",
        "Team Worker is not running",
        true
      );
    }
    child.stdin.write(encodeTeamFrame(message));
  }

  #settle(invocationId: string, outcome: RuntimeOutcome): void {
    const pending = this.#pending.get(invocationId);
    if (!pending) return;
    this.#pending.delete(invocationId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(outcome);
  }

  #rejectHandshake(error: Error): void {
    const handshake = this.#handshake;
    this.#handshake = undefined;
    if (!handshake) return;
    clearTimeout(handshake.timer);
    handshake.reject(error);
  }

  #protocolFailure(
    child: ChildProcessWithoutNullStreams,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#ready = false;
    this.#rejectHandshake(new TeamClientError(code, message, retryable));
    for (const invocationId of [...this.#pending.keys()]) {
      this.#settle(
        invocationId,
        failedOutcome("failed", code, message, retryable)
      );
    }
    child.kill("SIGKILL");
  }

  #workerExited(
    child: ChildProcessWithoutNullStreams,
    message: string
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#ready = false;
    const code = this.#stopping
      ? "TEAM_WORKER_STOPPED"
      : "TEAM_WORKER_CRASHED";
    this.#rejectHandshake(new TeamClientError(code, message, true));
    for (const invocationId of [...this.#pending.keys()]) {
      this.#settle(
        invocationId,
        failedOutcome("failed", code, message, true)
      );
    }
  }
}

export class TeamClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "TeamClientError";
  }
}
