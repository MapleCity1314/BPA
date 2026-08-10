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
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import { RuntimeProviderRegistry } from "@bpa/node-runtime";
import type { Persistence, RuntimeActivityMetrics } from "@bpa/persistence";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import {
  attachFrameDecoder,
  encodeFrame,
  LocalControlServer,
  LocalCoreService,
  sendControlRequest
} from "./control.js";
import type { LocalBrowserGateway } from "./browser-gateway.js";

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

function sendLegacyFrame(
  socketPath: string,
  message: unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    attachFrameDecoder(socket, (response) => {
      socket.end();
      resolve(response);
    });
    socket.on("connect", () => socket.write(encodeFrame(message)));
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
    expect(service.handle({
      id: "maintenance-read-blocked",
      method: "catalog.list",
      params: {}
    })).toMatchObject({
      ok: false,
      error: {
        code: "BPA_RUNTIME_MAINTENANCE",
        message: "BPA_RUNTIME_MAINTENANCE"
      }
    });
    await expect(service.handleAsync({
      id: "maintenance-async-blocked",
      method: "assistance.task.list",
      params: {}
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "BPA_RUNTIME_MAINTENANCE" }
    });
    expect(service.handle({
      id: "maintenance-doctor",
      method: "doctor",
      params: {}
    })).toMatchObject({ ok: true, result: { status: "ok" } });

    const triggerTick = vi.spyOn(service.triggers, "tick");
    expect(service.runtimeMaintenanceActive()).toBe(true);
    expect(service.tickTriggers()).toBe(false);
    expect(triggerTick).not.toHaveBeenCalled();
    expect(
      service.handle({
        id: "maintenance-ready",
        method: "runtime.maintenance.status",
        params: {}
      })
    ).toMatchObject({
      ok: true,
      result: {
        schema: "bpa.runtime-maintenance-readiness/1",
        maintenanceActive: true,
        ready: true,
        blockers: [],
        browser: {
          pendingQueueCount: 0,
          activeExtensionCommandCount: 0
        },
        teamWorker: {
          state: "stopped",
          pendingInvocationCount: 0
        }
      }
    });
    expect(
      service.handle({
        id: "maintenance-extra-params",
        method: "runtime.maintenance.status",
        params: { force: true }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "RUNTIME_MAINTENANCE_PARAMS_NOT_ALLOWED" }
    });

    await rm(maintenancePath, { force: true });
    expect(service.runtimeMaintenanceActive()).toBe(false);
    expect(service.runtimeMaintenanceReadiness(
      "2026-08-10T01:00:00.000Z"
    )).toMatchObject({
      maintenanceActive: false,
      ready: false,
      blockers: ["MAINTENANCE_LOCK_NOT_HELD"]
    });
    expect(service.tickTriggers()).toBe(true);
    expect(triggerTick).toHaveBeenCalledOnce();
  });

  it("fails maintenance readiness closed for persisted and browser activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-maintenance-busy-"));
    const maintenancePath = join(directory, "runtime-maintenance.lock");
    await writeFile(maintenancePath, "installer\n");
    const base = new SqlitePersistence({ path: ":memory:" });
    const activity: RuntimeActivityMetrics = {
      activeRunCount: 1,
      activeTriggerOccurrenceCount: 2,
      activeTriggerAttemptCount: 1,
      pendingEngineOutboxCount: 1,
      activeControlLeaseCount: 1,
      activeExternalDomainLeaseCount: 1,
      activeStagingLeaseCount: 1,
      activeRecoverySessionCount: 1,
      activeAttentionDeliveryCount: 1,
      terminalRunCount: 0,
      latestTerminalRunAt: null
    };
    let deliveryInFlight = true;
    const persistence = new Proxy(base as Persistence, {
      get(target, property, receiver) {
        if (property === "readRuntimeActivityMetrics") {
          return () => activity;
        }
        if (property === "listAttentionDeliveries") {
          return () => deliveryInFlight ? [{}] : [];
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const browserGateway = {
      id: "browser",
      supports: () => false,
      invoke: async () => ({
        status: "rejected" as const,
        error: {
          code: "TEST_ONLY",
          message: "not dispatched",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      }),
      status: () => ({
        connected: true,
        ready: true,
        extensionId: "extension-test",
        capabilityCount: 1,
        resourceUsage: {
          connectionCount: 1,
          readySessionCount: 1,
          pendingCancelRequestCount: 1,
          nativeHostPids: [101],
          queue: {
            pendingBrowserOutbox: 1,
            queuedCommands: 0,
            inFlightCommands: 0,
            terminalResultsPendingApplication: 0,
            totalPending: 1
          },
          pageProbes: { active: 1, capacity: 32, ttlMs: 10_000 },
          extension: {
            activeCommands: 1,
            activeTabCommands: 1,
            activeAllianceStages: 1,
            cancellationRequests: 1,
            cancellationStopBarriers: 1,
            observedTabs: 1,
            observationCapacity: 64,
            profileTabs: 1,
            managedTabs: 1,
            managedTabReservations: 1,
            managedTabCapacity: 8,
            pacingReservations: {
              active: 1,
              capacity: 64,
              ttlMs: 120_000
            },
            probes: { active: 1, capacity: 32, ttlMs: 30_000 }
          }
        }
      })
    } as unknown as LocalBrowserGateway;
    const service = new LocalCoreService(
      persistence,
      browserGateway,
      undefined,
      undefined,
      undefined,
      maintenancePath
    );
    cleanups.push(async () => {
      base.close();
      await rm(directory, { recursive: true, force: true });
    });

    expect(service.runtimeMaintenanceReadiness(
      "2026-08-10T01:00:00.000Z"
    )).toMatchObject({
      maintenanceActive: true,
      ready: false,
      blockers: [
        "ACTIVE_RUNS",
        "ACTIVE_TRIGGER_ATTEMPTS",
        "PENDING_ENGINE_OUTBOX",
        "ACTIVE_CONTROL_LEASES",
        "ACTIVE_EXTERNAL_DOMAIN_LEASES",
        "ACTIVE_STAGING_LEASES",
        "ACTIVE_RECOVERY_SESSIONS",
        "BROWSER_COMMANDS_ACTIVE",
        "ACTIVE_ATTENTION_DELIVERIES"
      ],
      activity,
      browser: {
        pendingCancelRequestCount: 1,
        pendingQueueCount: 1,
        activePageProbeCount: 1,
        activeExtensionCommandCount: 1,
        activeExtensionStageCount: 1,
        activeExtensionCancellationCount: 2,
        activeManagedTabReservationCount: 1,
        activePacingReservationCount: 1,
        activeExtensionProbeCount: 1
      },
      delivery: { inFlight: true }
    });

    Object.assign(activity, {
      activeRunCount: 0,
      activeTriggerAttemptCount: 0,
      pendingEngineOutboxCount: 0,
      activeControlLeaseCount: 0,
      activeExternalDomainLeaseCount: 0,
      activeStagingLeaseCount: 0,
      activeRecoverySessionCount: 0
    });
    deliveryInFlight = false;
    const pendingDeliveryOnly = new LocalCoreService(
      persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      maintenancePath
    );
    expect(pendingDeliveryOnly.runtimeMaintenanceReadiness(
      "2026-08-10T01:00:01.000Z"
    )).toMatchObject({
      maintenanceActive: true,
      ready: true,
      blockers: [],
      activity: {
        activeTriggerOccurrenceCount: 2,
        activeAttentionDeliveryCount: 1
      },
      delivery: { inFlight: false }
    });
  });

  it("tracks an async Control mutation that crossed the maintenance boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-maintenance-async-"));
    const maintenancePath = join(directory, "runtime-maintenance.lock");
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
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    vi.spyOn(service.datasets, "import").mockImplementation(async () => {
      markStarted?.();
      await importGate;
      return {} as never;
    });

    const request = service.handleAsync({
      id: "dataset-import-crossing-maintenance",
      method: "dataset.import",
      params: {
        path: "/tmp/not-read-by-test.xlsx",
        id: "dataset-test",
        version: "1.0.0"
      }
    });
    await started;
    await writeFile(maintenancePath, "installer\n");

    expect(service.runtimeMaintenanceReadiness(
      "2026-08-10T01:00:00.000Z"
    )).toMatchObject({
      ready: false,
      blockers: ["CONTROL_MUTATIONS_ACTIVE"],
      control: { inFlightMutationCount: 1 }
    });

    releaseImport?.();
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(service.runtimeMaintenanceReadiness(
      "2026-08-10T01:00:01.000Z"
    )).toMatchObject({
      ready: true,
      blockers: [],
      control: { inFlightMutationCount: 0 }
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

  it("binds a strict Native Host PID during legacy attach", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-native-attach-"));
    const socketPath = controlEndpoint(directory);
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const attach = vi.fn(() => "native-connection");
    const detach = vi.fn();
    const browserGateway = {
      id: "browser",
      supports: () => false,
      invoke: async () => ({
        status: "rejected" as const,
        error: { code: "UNUSED", message: "unused", retryable: false },
        evidence: [],
        riskSignals: []
      }),
      attach,
      detach
    } as unknown as LocalBrowserGateway;
    const service = new LocalCoreService(persistence, browserGateway);
    const server = new LocalControlServer(socketPath, service);
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });

    await expect(
      sendLegacyFrame(socketPath, {
        id: "native-valid",
        method: "native.attach",
        params: {
          origin: "chrome-extension://hoobbnlkcdhbemedpfhhoicklplggmbc/",
          processId: 4242
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { attached: true } });
    expect(attach).toHaveBeenCalledWith(
      "chrome-extension://hoobbnlkcdhbemedpfhhoicklplggmbc/",
      4242,
      expect.any(Function)
    );

    await expect(
      sendLegacyFrame(socketPath, {
        id: "native-extra",
        method: "native.attach",
        params: {
          origin: "chrome-extension://hoobbnlkcdhbemedpfhhoicklplggmbc/",
          processId: 4243,
          extra: true
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "NATIVE_ATTACH_REJECTED" }
    });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("disposes registered Runtime Providers with the Core service", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const providers = new RuntimeProviderRegistry();
    let disposed = 0;
    providers.register({
      id: "test-resident-provider",
      supports: () => false,
      invoke: async () => ({
        status: "succeeded",
        output: null,
        evidence: [],
        riskSignals: []
      }),
      dispose: () => {
        disposed += 1;
      }
    });
    const service = new LocalCoreService(
      persistence,
      undefined,
      providers
    );

    await service.dispose();
    await service.dispose();

    expect(disposed).toBe(1);
    persistence.close();
  });

  it("reports the default Team Worker as stopped before its first invocation", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    expect(service.runtimeProcessUsage()).toEqual({
      teamWorker: {
        state: "stopped",
        pid: null,
        pendingInvocationCount: 0
      }
    });
    await service.dispose();
    persistence.close();
  });

  it("closes resident Control connections before stopping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-stop-"));
    const socketPath = controlEndpoint(directory);
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    const server = new LocalControlServer(socketPath, service);
    await server.start();
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    await server.stop();
    await closed;

    expect(socket.destroyed).toBe(true);
    await service.dispose();
    persistence.close();
    await rm(directory, { recursive: true, force: true });
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
