import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  decodeControlEnvelope,
  encodeControlEnvelope,
  negotiateControlHello,
  parseControlHelloRequest,
  parseControlRequest
} from "@bpa/control-protocol";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import {
  ControlClient,
  ControlClientError,
  resolveControlEndpoint,
  resolveControlSocketPath,
  UnixSocketControlTransport,
  type ControlTransport
} from "./index.js";

const cleanup: Array<() => Promise<void>> = [];
const controlEndpoint = (root: string) =>
  process.platform === "win32"
    ? resolveLocalIpcEndpoint(root, "core", "win32")
    : join(root, "control.sock");
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe("injectable ControlClient", () => {
  it("returns a correlated result", async () => {
    const transport: ControlTransport = {
      send: async (request) => ({
        version: CONTROL_PROTOCOL_VERSION,
        kind: "result",
        requestId: request.requestId,
        result: { ok: true }
      })
    };
    const client = new ControlClient(transport, {
      now: () => 1000,
      requestId: () => "request-1"
    });
    await expect(client.request("task.list")).resolves.toEqual({ ok: true });
  });

  it("generates a default request id and wraps transport failures", async () => {
    const observed: string[] = [];
    const successful = new ControlClient({
      send: async (request) => {
        observed.push(request.requestId);
        return {
          version: CONTROL_PROTOCOL_VERSION,
          kind: "result",
          requestId: request.requestId,
          result: true
        };
      }
    });
    await expect(successful.request("doctor")).resolves.toBe(true);
    expect(observed[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const failed = new ControlClient(
      {
        send: async () => {
          throw new Error("socket unavailable");
        }
      },
      { requestId: () => "transport-failure" }
    );
    await expect(failed.request("doctor")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message: "socket unavailable"
    });
  });

  it("rejects malformed, mismatched and remote error responses", async () => {
    for (const [response, code] of [
      [{ bad: true }, "MALFORMED_RESPONSE"],
      [
        {
          version: CONTROL_PROTOCOL_VERSION,
          kind: "result",
          requestId: "other",
          result: null
        },
        "REQUEST_ID_MISMATCH"
      ],
      [
        {
          version: CONTROL_PROTOCOL_VERSION,
          kind: "error",
          requestId: "request-1",
          error: { code: "CONFLICT", message: "conflict" }
        },
        "REMOTE_ERROR"
      ]
    ] as const) {
      const client = new ControlClient(
        { send: async () => response },
        { requestId: () => "request-1" }
      );
      await expect(client.request("task.list")).rejects.toMatchObject({ code });
    }
  });

  it("times out and rejects a duplicate request id", async () => {
    const client = new ControlClient(
      {
        send: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          })
      },
      { requestId: () => "request-1", timeoutMs: 5 }
    );
    await expect(client.request("task.list")).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED"
    });
    await expect(
      client.request("task.list", {}, { requestId: "request-1" })
    ).rejects.toBeInstanceOf(ControlClientError);
  });

  it("rejects a late result even when a transport ignores cancellation", async () => {
    let clock = 1000;
    const client = new ControlClient(
      {
        send: async (request) => {
          clock = 1006;
          return {
            version: CONTROL_PROTOCOL_VERSION,
            kind: "result",
            requestId: request.requestId,
            result: "late"
          };
        }
      },
      { now: () => clock, requestId: () => "late-request", timeoutMs: 5 }
    );
    await expect(client.request("doctor")).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED"
    });
  });

  it("bounds remembered request ids and exposes deterministic scheduling", async () => {
    const requests: string[] = [];
    const transport: ControlTransport = {
      send: async (request) => {
        requests.push(request.requestId);
        return {
          version: CONTROL_PROTOCOL_VERSION,
          kind: "result",
          requestId: request.requestId,
          result: true
        };
      }
    };
    const client = new ControlClient(transport, {
      maxRememberedRequestIds: 1
    });
    await client.request("doctor", {}, { requestId: "request-a" });
    await client.request("doctor", {}, { requestId: "request-b" });
    await client.request("doctor", {}, { requestId: "request-a" });
    expect(requests).toEqual(["request-a", "request-b", "request-a"]);

    let scheduled: (() => void) | undefined;
    let cancelled = false;
    const timed = new ControlClient(
      {
        send: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          })
      },
      {
        requestId: () => "scheduled-request",
        schedule: (callback) => {
          scheduled = callback;
          return "timer";
        },
        cancelScheduled: (handle) => {
          expect(handle).toBe("timer");
          cancelled = true;
        }
      }
    );
    const pending = timed.request("doctor");
    scheduled?.();
    await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(cancelled).toBe(true);
  });

  it("resolves the standard control socket independently of Local Core", () => {
    expect(resolveControlEndpoint("/tmp/bpa-test", "darwin")).toBe(
      "/tmp/bpa-test/run/core.sock"
    );
    expect(resolveControlSocketPath("/tmp/bpa-test")).toBe(
      resolveControlEndpoint("/tmp/bpa-test", process.platform)
    );
    expect(
      resolveControlEndpoint("C:\\BPA", "win32")
    ).toMatch(/^\\\\\.\\pipe\\bpa-[a-f0-9]{16}-core$/u);
    expect(
      () =>
        new ControlClient(
          { send: async () => undefined },
          { maxRememberedRequestIds: 0 }
        )
    ).toThrow(/positive integer/);
  });
});

describe("local IPC control transport", () => {
  it("exchanges one newline-delimited versioned envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-client-"));
    const socketPath = controlEndpoint(directory);
    const server = createServer((socket) => {
      let buffered = Buffer.alloc(0);
      let negotiated = false;
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0) {
          const message = decodeControlEnvelope(
            buffered.subarray(0, newline + 1)
          );
          buffered = buffered.subarray(newline + 1);
          if (!negotiated) {
            const hello = parseControlHelloRequest(message);
            socket.write(
              encodeControlEnvelope(
                negotiateControlHello(hello, {
                  supportedApplicationProtocols: [CONTROL_PROTOCOL_VERSION],
                  runtime: { name: "test-core", version: "0.4.0" },
                  maxFrameBytes: CONTROL_MAX_MESSAGE_BYTES,
                  features: []
                })
              )
            );
            negotiated = true;
          } else {
            const request = parseControlRequest(message);
            socket.end(
              encodeControlEnvelope({
                version: CONTROL_PROTOCOL_VERSION,
                kind: "result",
                requestId: request.requestId,
                result: { method: request.method }
              })
            );
          }
          newline = buffered.indexOf(0x0a);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanup.push(
      () => rm(directory, { recursive: true, force: true }),
      async () => {
        server.close();
      }
    );
    const client = new ControlClient(
      new UnixSocketControlTransport(socketPath),
      { requestId: () => "socket-request" }
    );
    await expect(client.request("task.list")).resolves.toEqual({
      method: "task.list"
    });
  });

  it("rejects malformed socket data and a missing socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-malformed-"));
    const socketPath = controlEndpoint(directory);
    const server = createServer((socket) => {
      socket.end(Buffer.from("not-json\n"));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanup.push(
      () => rm(directory, { recursive: true, force: true }),
      async () => {
        server.close();
      }
    );
    const malformed = new ControlClient(
      new UnixSocketControlTransport(socketPath),
      { requestId: () => "malformed-socket" }
    );
    await expect(malformed.request("doctor")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR"
    });

    const missing = new ControlClient(
      new UnixSocketControlTransport(
        controlEndpoint(join(directory, "missing"))
      ),
      { requestId: () => "missing-socket" }
    );
    await expect(missing.request("doctor")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR"
    });
  });

  it("rejects oversized and empty socket responses", async () => {
    for (const [suffix, respond] of [
      [
        "oversized",
        (socket: import("node:net").Socket) =>
          socket.end(Buffer.alloc(CONTROL_MAX_MESSAGE_BYTES + 1))
      ],
      ["empty", (socket: import("node:net").Socket) => socket.end()]
    ] as const) {
      const directory = await mkdtemp(
        join(tmpdir(), `bpa-control-${suffix}-`)
      );
      const socketPath = controlEndpoint(directory);
      const server = createServer(respond);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const client = new ControlClient(
        new UnixSocketControlTransport(socketPath),
        { requestId: () => `${suffix}-response` }
      );
      await expect(client.request("doctor")).rejects.toMatchObject({
        code: "TRANSPORT_ERROR"
      });
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors an externally aborted Unix transport request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-abort-"));
    const socketPath = controlEndpoint(directory);
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const controller = new AbortController();
    const pending = new UnixSocketControlTransport(socketPath).send(
      {
        version: CONTROL_PROTOCOL_VERSION,
        kind: "request",
        requestId: "abort-request",
        method: "doctor",
        deadline: "2026-07-28T00:00:10.000Z",
        params: {}
      },
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
});
