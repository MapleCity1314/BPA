import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { loadOrCreateCoreSigningKey } from "@bpa/gateway-core";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { LocalControlServer, LocalCoreService } from "./control.js";
import { resolveBpaPaths } from "./paths.js";
import { CoreInstanceLock } from "./instance-lock.js";

const paths = resolveBpaPaths();
mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
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
const browserGateway = new LocalBrowserGateway(
  persistence,
  new LocalWorkflowEngine(persistence),
  signingKey
);
const service = new LocalCoreService(persistence, browserGateway);
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
  persistence.close();
  instanceLock.release();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.start();
process.stderr.write(`BPA Local Core listening on ${paths.socket}\n`);
