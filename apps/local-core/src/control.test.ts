import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CONTROL_HELLO_PROTOCOL_VERSION,
  CONTROL_MAX_MESSAGE_BYTES,
  decodeControlEnvelope,
  encodeControlEnvelope,
  parseControlHelloResponse,
  type ControlRequestEnvelope
} from "@bpa/control-protocol";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import {
  LocalControlServer,
  LocalCoreService,
  sendControlRequest
} from "./control.js";

const cleanups: Array<() => Promise<void>> = [];
const controlEndpoint = (root: string) =>
  process.platform === "win32"
    ? resolveLocalIpcEndpoint(root, "core", "win32")
    : join(root, "core.sock");

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
  it("blocks a legacy Workflow Trigger before creating an orphan Run", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    for (const path of [
      "../../../nodes/core/control.start.node.yaml",
      "../../../nodes/core/data.select.node.yaml",
      "../../../nodes/core/data.merge.node.yaml",
      "../../../nodes/core/control.succeed.node.yaml"
    ]) {
      const node = parse(
        readFileSync(new URL(path, import.meta.url), "utf8")
      ) as unknown;
      expect(service.handle({
        id: `publish-node:${path}`,
        method: "asset.publish",
        params: { assetType: "node", content: node, actor: "test" }
      })).toMatchObject({ ok: true });
    }
    const workflow = parse(
      readFileSync(
        new URL("../../../workflows/examples/core.data-flow-smoke.workflow.yaml", import.meta.url),
        "utf8"
      )
    ) as unknown;
    expect(service.handle({
      id: "publish-legacy-workflow",
      method: "asset.publish",
      params: { assetType: "workflow", content: workflow, actor: "test" }
    })).toMatchObject({ ok: true });
    expect(service.handle({
      id: "put-legacy-trigger",
      method: "trigger.put",
      params: {
        actor: "test",
        spec: {
          apiVersion: "bpa.trigger/v1alpha2",
          id: "legacy-trigger",
          version: "1.0.0",
          appId: "inventory-monitor",
          kind: "manual",
          workflow: { id: "core.data-flow-smoke", version: "1.0.0" },
          enabled: true,
          inputSchemaVersion: "legacy-trigger/1",
          input: { payload: {} },
          concurrencyKey: "legacy-trigger",
          idempotencyPolicy: "request_key",
          retryPolicy: "none"
        }
      }
    })).toMatchObject({ ok: true });

    const fired = service.handle({
      id: "fire-legacy-trigger",
      method: "trigger.fire",
      params: { id: "legacy-trigger", requestKey: "request-1" }
    });

    expect(fired).toMatchObject({
      ok: true,
      result: {
        occurrence: { status: "terminal", terminalOutcome: "blocked" },
        attempt: { status: "terminal", terminalOutcome: "blocked" }
      }
    });
    expect(persistence.listRuns({ limit: 20 })).toEqual([]);
    expect(persistence.queryAttention({
      sourceKinds: ["trigger-occurrence"],
      appIds: ["inventory-monitor"],
      limit: 20
    })).toMatchObject({ total: 1, truncated: false });
    expect(persistence.listTriggerLeases(new Date().toISOString())).toEqual([]);
    persistence.close();
  });

  it("lists durable terminal attention with sanitized login guidance", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    const createdAt = "2026-08-09T06:00:00.000Z";
    const run = persistence.createRun({
      run: {
        id: "run-login-alert",
        workflowId: "doudian.inventory.refresh",
        workflowVersion: "1.0.0",
        workflowDigest: "sha256:test",
        status: "running",
        revision: 0,
        input: {},
        createdAt,
        updatedAt: createdAt
      },
      event: {
        id: randomUUID(),
        runId: "run-login-alert",
        sequence: 1,
        type: "RUN_CREATED",
        payload: {},
        occurredAt: createdAt
      }
    });
    const terminalEvent = {
      id: randomUUID(),
      runId: run.id,
      sequence: 2,
      type: "RUNTIME_RESULT_APPLIED",
      payload: {
        errorCode: "SESSION_EXPIRED",
        message: "private browser diagnostic"
      },
      occurredAt: "2026-08-09T06:01:00.000Z"
    };
    const attentionItem = projectTerminalRunAttention({
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      status: "rejected",
      currentNodeKey: "collect",
      updatedAt: terminalEvent.occurredAt,
      events: [terminalEvent]
    });
    persistence.commitRunTransition({
      runId: run.id,
      expectedRevision: run.revision,
      nextStatus: "rejected",
      currentNodeKey: "collect",
      attention: {
        sourceRef: { kind: "workflow-run", runId: run.id },
        deliveryPolicy: "operator-notification",
        item: attentionItem,
        state: "open",
        revision: 0
      },
      attentionDelivery: createTerminalAttentionDelivery({
        attention: attentionItem,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion
      }),
      event: terminalEvent
    });

    const response = service.handle({
      id: "attention-list",
      method: "attention.list",
      params: { limit: 20 }
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [
          {
            id: "run-terminal:run-login-alert",
            runId: "run-login-alert",
            sourceRef: { kind: "workflow-run", runId: "run-login-alert" },
            deliveryPolicy: "operator-notification",
            groupKey: "authentication",
            kind: "blocking",
            attemptedActions: [],
            state: "open",
            revision: 0,
            runStatus: "rejected",
            deliveryState: "pending",
            deliveryAttempt: 0
          }
        ],
        total: 1,
        truncated: false
      }
    });
    expect(JSON.stringify(response)).not.toContain("private browser diagnostic");
    expect(service.handle({
      id: "attention-empty-app-filter",
      method: "attention.list",
      params: { appIds: [], limit: 20 }
    })).toMatchObject({
      ok: false,
      error: { message: "Attention app filter is invalid." }
    });
    expect(
      service.handle({
        id: "attention-acknowledge",
        method: "attention.acknowledge",
        params: {
          id: "run-terminal:run-login-alert",
          expectedRevision: 0,
          actor: "operator:test"
        }
      })
    ).toMatchObject({
      ok: true,
      result: { state: "acknowledged", revision: 1 }
    });
    expect(
      service.handle({
        id: "attention-list-after-acknowledge",
        method: "attention.list",
        params: { limit: 20 }
      })
    ).toMatchObject({
      ok: true,
      result: { items: [], total: 0, truncated: false }
    });
    persistence.close();
  });

  it("rejects new Runs while a Runtime upgrade holds maintenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-maintenance-"));
    const maintenancePath = join(directory, "runtime-maintenance.lock");
    await writeFile(maintenancePath, "installer\n");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(
      persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      maintenancePath
    );
    cleanups.push(async () => {
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });

    expect(
      service.handle({
        id: "maintenance-run",
        method: "run.create",
        params: {
          workflowId: "would-otherwise-be-looked-up",
          workflowVersion: "1.0.0",
          input: {}
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "BPA_RUNTIME_MAINTENANCE" }
    });
  });

  it("serves doctor requests over a 0600 unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-"));
    const socketPath = controlEndpoint(directory);
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
      persistence: { adapter: "sqlite", schemaVersion: 25 }
    });
  });

  it("reserves Trigger Attempt lease owner identities for the Runtime", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    expect(
      service.handle({
        id: "reserved-owner",
        method: "browser.control-lease.acquire",
        params: {
          resourceId: "browser-instance:test",
          ownerId: "trigger-attempt:external",
          ttlSeconds: 120
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "LEASE_OWNER_RESERVED" }
    });
    persistence.close();
  });

  it("serves versioned control envelopes without breaking legacy framing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-v1-"));
    const socketPath = controlEndpoint(directory);
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
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "lease-acquire-1",
        method: "browser.control-lease.acquire",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: {
          resourceId: "browser-instance:test",
          ownerId: "owner-1",
          ttlSeconds: 120
        }
      })
    ).resolves.toMatchObject({
      kind: "result",
      requestId: "lease-acquire-1",
      result: { fencingToken: 1 }
    });
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "lease-acquire-busy",
        method: "browser.control-lease.acquire",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: {
          resourceId: "browser-instance:test",
          ownerId: "owner-2",
          ttlSeconds: 120
        }
      })
    ).resolves.toEqual({
      version: "bpa.control/1",
      kind: "result",
      requestId: "lease-acquire-busy",
      result: null
    });
    await expect(
      sendV1(socketPath, {
        version: "bpa.control/1",
        kind: "request",
        requestId: "page-observation-limit",
        method: "browser.page-observation.list",
        deadline: new Date(Date.now() + 10_000).toISOString(),
        params: { limit: 500 }
      })
    ).resolves.toEqual({
      version: "bpa.control/1",
      kind: "result",
      requestId: "page-observation-limit",
      result: []
    });
  });

  it("negotiates hello before application requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-hello-"));
    const socketPath = controlEndpoint(directory);
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
    const socketPath = controlEndpoint(directory);
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
    const socketPath = controlEndpoint(directory);
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
