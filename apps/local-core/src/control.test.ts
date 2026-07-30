import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_HELLO_PROTOCOL_VERSION,
  CONTROL_MAX_MESSAGE_BYTES,
  decodeControlEnvelope,
  encodeControlEnvelope,
  parseControlHelloResponse,
  type ControlRequestEnvelope
} from "@bpa/control-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  LocalControlServer,
  LocalCoreService,
  sendControlRequest
} from "./control.js";

const cleanups: Array<() => Promise<void>> = [];

function sendV1(
  socketPath: string,
  request: ControlRequestEnvelope
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () =>
      socket.write(Buffer.from(encodeControlEnvelope(request)))
    );
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (!chunk.includes(0x0a)) return;
      socket.end();
      try {
        resolve(decodeControlEnvelope(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function sendNegotiatedV1(
  socketPath: string,
  request: ControlRequestEnvelope
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    let welcomed = false;
    socket.on("connect", () =>
      socket.write(
        Buffer.from(
          encodeControlEnvelope({
            version: CONTROL_HELLO_PROTOCOL_VERSION,
            kind: "hello",
            requestId: "hello-local-core",
            supportedApplicationProtocols: ["bpa.control/1"],
            runtime: { name: "test-client", version: "0.4.0" },
            maxFrameBytes: CONTROL_MAX_MESSAGE_BYTES,
            features: ["evidence_refs", "resource_bindings"]
          })
        )
      )
    );
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const message = decodeControlEnvelope(
          buffered.subarray(0, newline + 1)
        );
        buffered = buffered.subarray(newline + 1);
        if (!welcomed) {
          const welcome = parseControlHelloResponse(message);
          if (welcome.kind !== "welcome") {
            reject(new Error(welcome.error.message));
            socket.destroy();
            return;
          }
          welcomed = true;
          socket.write(Buffer.from(encodeControlEnvelope(request)));
        } else {
          socket.end();
          resolve(message);
          return;
        }
        newline = buffered.indexOf(0x0a);
      }
    });
    socket.on("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("local control socket", () => {
  it("serves doctor requests over a 0600 unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await expect(
      sendControlRequest(socketPath, "doctor")
    ).resolves.toMatchObject({
      status: "ok",
      persistence: { adapter: "sqlite", schemaVersion: 7 }
    });
  });

  it("serves versioned control envelopes without breaking legacy framing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-v1-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "request-1",
        method: "doctor",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: {}
      })
    ).resolves.toMatchObject({
      version: "bpa.control/1",
      kind: "result",
      requestId: "request-1",
      result: { status: "ok" }
    });
    await expect(sendControlRequest(socketPath, "doctor")).resolves.toMatchObject({
      status: "ok"
    });
  });

  it("negotiates hello before application requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-hello-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await expect(
      sendNegotiatedV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "negotiated-doctor",
        method: "doctor",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: {}
      })
    ).resolves.toMatchObject({
      kind: "result",
      requestId: "negotiated-doctor",
      result: { status: "ok" }
    });
  });

  it("isolates an oversized connection without terminating Core", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-oversize-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => {
      const socket = createConnection(socketPath);
      socket.on("connect", () =>
        socket.write(
          Buffer.concat([
            Buffer.from("{"),
            Buffer.alloc(CONTROL_MAX_MESSAGE_BYTES, 0x20)
          ])
        )
      );
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
    });
    await expect(sendControlRequest(socketPath, "doctor")).resolves.toMatchObject({
      status: "ok"
    });
  });

  it("rejects expired and unknown v1 requests with stable error codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-v1-errors-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "expired",
        method: "doctor",
        deadline: new Date(0).toISOString(),
        params: {}
      })
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "DEADLINE_EXCEEDED" }
    });
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "unknown",
        method: "missing.method",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: {}
      })
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "UNKNOWN_METHOD" }
    });
  });
});
