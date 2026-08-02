import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { loadOrCreateCoreSigningKey } from "@bpa/gateway-core";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { BrowserEvidenceReceiver } from "./browser-evidence.js";
import { LocalControlServer, LocalCoreService } from "./control.js";
import { resolveBpaPaths } from "./paths.js";
import { CoreInstanceLock } from "./instance-lock.js";
import {
  LocalStagingTransferServer,
  StagingTransferService
} from "./staging-transfer.js";

const paths = resolveBpaPaths();
mkdirSync(paths.run, { recursive: true, mode: 0o700 });
mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
const instanceLock = new CoreInstanceLock(paths.lock);
instanceLock.acquire();

const persistence = new SqlitePersistence({ path: paths.database });
if (process.argv.includes("--migrate-only")) {
  persistence.close();
  instanceLock.release();
  process.stderr.write("BPA migrations completed successfully.\n");
  process.exit(0);
}
const signingKey = loadOrCreateCoreSigningKey(paths.signingKey);
const browserEvidence = new BrowserEvidenceReceiver(
  persistence,
  paths.data
);
const browserGateway = new LocalBrowserGateway(
  persistence,
  new LocalWorkflowEngine(persistence),
  signingKey,
  undefined,
  browserEvidence
);
const stagingTransfers = new StagingTransferService(
  persistence,
  paths.data
);
const stagingServer = new LocalStagingTransferServer(
  paths.transferSocket,
  stagingTransfers
);
const service = new LocalCoreService(
  persistence,
  browserGateway,
  undefined,
  stagingTransfers,
  paths.data,
  join(paths.run, "runtime-maintenance.lock")
);
browserGateway.recoverTerminalResults();
browserGateway.recoverCancellations();
const server = new LocalControlServer(
  paths.socket,
  service
);
let drainingIr2 = false;
const gatewayTimer = setInterval(() => {
  try {
    browserGateway.tick();
    if (!drainingIr2) {
      drainingIr2 = true;
      void service.ir2Runtime
        .drainOnce()
        .catch((error: unknown) => {
          process.stderr.write(
            `[ir2-runtime] ${
              error instanceof Error
                ? error.stack ?? error.message
                : String(error)
            }\n`
          );
        })
        .finally(() => {
          drainingIr2 = false;
        });
    }
  } catch (error) {
    process.stderr.write(
      `[browser-gateway] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`
    );
  }
}, 500);
gatewayTimer.unref();

const shutdown = async (): Promise<void> => {
  clearInterval(gatewayTimer);
  await server.stop().catch(() => undefined);
  await stagingServer.stop().catch(() => undefined);
  persistence.close();
  instanceLock.release();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await stagingServer.start();
await server.start().catch(async (error) => {
  await stagingServer.stop().catch(() => undefined);
  throw error;
});
process.stderr.write(`BPA Local Core listening on ${paths.socket}\n`);
