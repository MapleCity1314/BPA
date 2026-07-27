import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { loadOrCreateCoreSigningKey } from "@bpa/gateway-core";
import { LocalWorkflowEngine } from "@bpa/engine";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { LocalControlServer, LocalCoreService } from "./control.js";
import { resolveBpaPaths } from "./paths.js";

const paths = resolveBpaPaths();
mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
mkdirSync(paths.logs, { recursive: true, mode: 0o700 });

const persistence = new SqlitePersistence({ path: paths.database });
const signingKey = loadOrCreateCoreSigningKey(paths.signingKey);
const browserGateway = new LocalBrowserGateway(
  persistence,
  new LocalWorkflowEngine(persistence),
  signingKey
);
const service = new LocalCoreService(persistence, browserGateway);
const server = new LocalControlServer(
  paths.socket,
  service
);

const shutdown = async (): Promise<void> => {
  await server.stop().catch(() => undefined);
  persistence.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.start();
process.stderr.write(`BPA Local Core listening on ${paths.socket}\n`);
