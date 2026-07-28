import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  TeamHandlerRegistry,
  TeamWorkerServer,
  decodeTeamJson,
  encodeTeamFrame,
  TEAM_MAX_FRAME_BYTES,
  TEAM_PROTOCOL_VERSION,
  TeamFrameDecoder,
  type TeamWorkerMessage
} from "./index.js";

const codeDigest = `sha256:${"a".repeat(64)}`;
const implementationDigest = `sha256:${"b".repeat(64)}`;

class Harness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly messages: TeamWorkerMessage[] = [];
  readonly waiters: Array<(message: TeamWorkerMessage) => void> = [];
  readonly server: TeamWorkerServer;

  constructor(handlers: TeamHandlerRegistry) {
    this.server = new TeamWorkerServer(
      this.input,
      this.output,
      codeDigest,
      handlers
    );
    const decoder = new TeamFrameDecoder();
    this.output.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const message = decodeTeamJson<TeamWorkerMessage>(frame);
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      }
    });
    this.server.start();
  }

  send(message: unknown): void {
    this.input.write(encodeTeamFrame(message));
  }

  next(): Promise<TeamWorkerMessage> {
    const existing = this.messages.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async hello(digest = codeDigest): Promise<TeamWorkerMessage> {
    this.send({
      type: "hello",
      protocolVersion: TEAM_PROTOCOL_VERSION,
      expectedCodeDigest: digest
    });
    return this.next();
  }

  close(): void {
    this.server.close();
    this.input.destroy();
    this.output.destroy();
  }
}

function registry(): TeamHandlerRegistry {
  return new TeamHandlerRegistry([
    {
      node: { id: "test.slow", version: "1.0.0" },
      implementationDigest,
      invoke(_input, signal) {
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ aborted: true }),
            { once: true }
          );
        });
      }
    }
  ]);
}

describe("Team Worker server", () => {
  it("rejects a hello code digest mismatch", async () => {
    const harness = new Harness(registry());
    await expect(
      harness.hello(`sha256:${"c".repeat(64)}`)
    ).resolves.toMatchObject({
      type: "error",
      code: "HELLO_DIGEST_MISMATCH"
    });
    harness.close();
  });

  it("rejects unknown node@version without executing anything", async () => {
    const harness = new Harness(registry());
    await expect(harness.hello()).resolves.toMatchObject({
      type: "hello.ack",
      handlers: ["test.slow@1.0.0"]
    });
    harness.send({
      type: "invoke",
      requestId: "unknown",
      node: {
        kind: "node",
        id: "test.unknown",
        version: "1.0.0",
        digest: implementationDigest
      },
      input: {},
      deadlineAt: Date.now() + 1_000,
      fencingToken: 1
    });
    await expect(harness.next()).resolves.toMatchObject({
      type: "result",
      outcome: {
        status: "rejected",
        error: { code: "UNKNOWN_TEAM_HANDLER" }
      }
    });
    harness.close();
  });

  it("times out a pending Handler", async () => {
    const harness = new Harness(registry());
    await harness.hello();
    harness.send({
      type: "invoke",
      requestId: "timeout",
      node: {
        kind: "node",
        id: "test.slow",
        version: "1.0.0",
        digest: implementationDigest
      },
      input: {},
      deadlineAt: Date.now() + 20,
      fencingToken: 1
    });
    await expect(harness.next()).resolves.toMatchObject({
      type: "result",
      outcome: {
        status: "timed_out",
        error: { code: "TEAM_HANDLER_TIMEOUT" }
      }
    });
    harness.close();
  });

  it("cancels a pending Handler with the exact fencing token", async () => {
    const harness = new Harness(registry());
    await harness.hello();
    harness.send({
      type: "invoke",
      requestId: "cancel",
      node: {
        kind: "node",
        id: "test.slow",
        version: "1.0.0",
        digest: implementationDigest
      },
      input: {},
      deadlineAt: Date.now() + 1_000,
      fencingToken: 2
    });
    harness.send({
      type: "cancel",
      requestId: "cancel",
      fencingToken: 2
    });
    await expect(harness.next()).resolves.toMatchObject({
      type: "result",
      fencingToken: 2,
      outcome: {
        status: "cancelled",
        error: { code: "TEAM_HANDLER_CANCELLED" }
      }
    });
    harness.close();
  });

  it("settles an oversized Handler result without emitting an invalid frame", async () => {
    const oversizedRegistry = new TeamHandlerRegistry([
      {
        node: { id: "test.oversized", version: "1.0.0" },
        implementationDigest,
        invoke() {
          return "x".repeat(TEAM_MAX_FRAME_BYTES);
        }
      }
    ]);
    const harness = new Harness(oversizedRegistry);
    await harness.hello();
    harness.send({
      type: "invoke",
      requestId: "oversized",
      node: {
        kind: "node",
        id: "test.oversized",
        version: "1.0.0",
        digest: implementationDigest
      },
      input: {},
      deadlineAt: Date.now() + 1_000,
      fencingToken: 1
    });
    await expect(harness.next()).resolves.toMatchObject({
      type: "result",
      outcome: {
        status: "failed",
        error: { code: "TEAM_RESULT_TOO_LARGE" }
      }
    });
    harness.close();
  });
});
