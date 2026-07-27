import { BridgeSimulator } from "./bridge-simulator.js";
import { ExperimentalGateway } from "./gateway.js";

const pairingToken = "local-experiment-token";
const gateway = new ExperimentalGateway({ pairingToken });
const port = await gateway.start();
const bridge = new BridgeSimulator({
  url: `ws://127.0.0.1:${port}`,
  pairingToken,
  browserInstanceId: "demo-browser",
  capabilities: [
    {
      nodeId: "experiment.echo",
      versions: ["1.0.0"],
      risk: "read"
    }
  ],
  handlers: {
    "experiment.echo@1.0.0": async (input) => ({
      status: "succeeded",
      output: { echoed: input }
    })
  }
});

await bridge.connect();
gateway.dispatch("demo-browser", {
  nodeExecutionId: "demo-execution",
  idempotencyKey: "demo-idempotency",
  node: {
    id: "experiment.echo",
    version: "1.0.0"
  },
  input: { hello: "BPA" },
  leaseMs: 5_000
});
const result = await gateway.waitForResult("demo-execution");
console.log(JSON.stringify(result, null, 2));
await bridge.disconnect();
await gateway.stop();
