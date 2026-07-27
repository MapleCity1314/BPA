import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeSimulator } from "../src/bridge-simulator.js";
import { ExperimentalGateway } from "../src/gateway.js";
import { JsonFileGatewayStateStore } from "../src/state-store.js";

const runningGateways: ExperimentalGateway[] = [];
const runningBridges: BridgeSimulator[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningBridges.splice(0).map((bridge) => bridge.disconnect()));
  await Promise.all(runningGateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(
  handler?: (input: unknown) => Promise<unknown>,
  gatewayOptions: { resultAckDelayMs?: number } = {}
) {
  const pairingToken = "test-pairing-token";
  const gateway = new ExperimentalGateway({
    pairingToken,
    heartbeatMs: 1_000,
    ...gatewayOptions
  });
  runningGateways.push(gateway);
  const port = await gateway.start();
  const bridge = new BridgeSimulator({
    url: `ws://127.0.0.1:${port}`,
    pairingToken,
    browserInstanceId: "browser-test",
    capabilities: [
      {
        nodeId: "experiment.read",
        versions: ["1.0.0"],
        risk: "read"
      }
    ],
    handlers: {
      "experiment.read@1.0.0": async (input) => ({
        status: "succeeded",
        output: handler ? await handler(input) : input
      })
    }
  });
  runningBridges.push(bridge);
  await bridge.connect();
  return { gateway, bridge };
}

describe("experimental bridge and gateway", () => {
  it("pairs a bridge, negotiates capability and returns a node result", async () => {
    const { gateway } = await setup(async (input) => ({
      observed: input
    }));
    expect(gateway.connectedBrowsers).toEqual(["browser-test"]);
    gateway.dispatch("browser-test", {
      nodeExecutionId: "node-exec-1",
      idempotencyKey: "idem-1",
      node: { id: "experiment.read", version: "1.0.0" },
      input: { shop: "A" },
      leaseMs: 5_000
    });
    await expect(gateway.waitForResult("node-exec-1")).resolves.toEqual({
      status: "succeeded",
      output: { observed: { shop: "A" } }
    });
  });

  it("rejects dispatch when the bridge does not advertise the node version", async () => {
    const { gateway } = await setup();
    expect(() =>
      gateway.dispatch("browser-test", {
        nodeExecutionId: "node-exec-missing",
        idempotencyKey: "idem-missing",
        node: { id: "experiment.read", version: "2.0.0" },
        input: {},
        leaseMs: 5_000
      })
    ).toThrow(/does not support/);
  });

  it("deduplicates an unacknowledged result that is resent after reconnect", async () => {
    let executions = 0;
    const { gateway, bridge } = await setup(
      async () => {
        executions += 1;
        return { executions };
      },
      { resultAckDelayMs: 150 }
    );
    gateway.dispatch("browser-test", {
      nodeExecutionId: "node-exec-reconnect",
      idempotencyKey: "idem-reconnect",
      node: { id: "experiment.read", version: "1.0.0" },
      input: {},
      leaseMs: 5_000
    });
    const result = await gateway.waitForResult("node-exec-reconnect");
    expect(result).toEqual({
      status: "succeeded",
      output: { executions: 1 }
    });
    expect(bridge.pendingResults.has("node-exec-reconnect")).toBe(true);
    bridge.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(executions).toBe(1);
    expect(bridge.pendingResults.size).toBe(0);
    expect(
      gateway.resultsByIdempotencyKey.get("idem-reconnect")
    ).toEqual(result);
  });

  it("preserves an uncertain terminal result without retrying the action", async () => {
    const { gateway } = await setup();
    const command = gateway.dispatch("browser-test", {
      nodeExecutionId: "node-exec-uncertain",
      idempotencyKey: "idem-uncertain",
      node: { id: "experiment.read", version: "1.0.0" },
      input: {},
      leaseMs: 5_000
    });
    const bridge = runningBridges.at(-1)!;
    bridge.terminate();
    command.state = "terminal";
    command.result = {
      status: "uncertain",
      error: "Connection lost after dispatch"
    };
    gateway.resultsByIdempotencyKey.set(
      command.idempotencyKey,
      command.result
    );
    expect(() =>
      gateway.dispatch("browser-test", {
        nodeExecutionId: "node-exec-uncertain-retry",
        idempotencyKey: "idem-uncertain",
        node: { id: "experiment.read", version: "1.0.0" },
        input: {},
        leaseMs: 5_000
      })
    ).toThrow(/terminal result/);
  });

  it("restores an accepted command after a Gateway process restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "bpa-gateway-experiment-")
    );
    temporaryDirectories.push(directory);
    const statePath = join(directory, "gateway-state.json");
    const pairingToken = "restart-pairing-token";
    const firstGateway = new ExperimentalGateway({
      pairingToken,
      stateStore: new JsonFileGatewayStateStore(statePath)
    });
    runningGateways.push(firstGateway);
    const port = await firstGateway.start();
    let executions = 0;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const bridge = new BridgeSimulator({
      url: `ws://127.0.0.1:${port}`,
      pairingToken,
      browserInstanceId: "browser-restart",
      capabilities: [
        {
          nodeId: "experiment.read",
          versions: ["1.0.0"],
          risk: "read"
        }
      ],
      handlers: {
        "experiment.read@1.0.0": async () => {
          executions += 1;
          await handlerGate;
          return {
            status: "succeeded",
            output: { executions }
          };
        }
      }
    });
    runningBridges.push(bridge);
    await bridge.connect();
    firstGateway.dispatch("browser-restart", {
      nodeExecutionId: "node-exec-process-restart",
      idempotencyKey: "idem-process-restart",
      node: { id: "experiment.read", version: "1.0.0" },
      input: {},
      leaseMs: 5_000
    });
    await expect.poll(() => executions).toBe(1);
    await firstGateway.flush();
    await firstGateway.stop();
    runningGateways.splice(runningGateways.indexOf(firstGateway), 1);

    releaseHandler?.();
    const secondGateway = new ExperimentalGateway({
      pairingToken,
      port,
      stateStore: new JsonFileGatewayStateStore(statePath)
    });
    runningGateways.push(secondGateway);
    await secondGateway.start();
    await bridge.connect();
    await expect
      .poll(() => secondGateway.connectedBrowsers, { timeout: 5_000 })
      .toContain("browser-restart");
    await expect(
      secondGateway.waitForResult("node-exec-process-restart", 5_000)
    ).resolves.toEqual({
      status: "succeeded",
      output: { executions: 1 }
    });
    expect(executions).toBe(1);
  }, 15_000);
});
