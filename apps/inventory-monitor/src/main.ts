import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { isWindowsNamedPipe, resolveDefaultBpaHome } from "@bpa/platform-runtime";
import { MysqlSalesDemandSync, mysqlOptionsFromEnvironment } from "./mysql-source.js";
import { InventoryRepository } from "./repository.js";
import { InventoryServiceProtocol } from "./service-protocol.js";
import { inventoryShopsFromEnvironment } from "./shop-config.js";
import { startInventoryWebServer } from "./web-server.js";
import { createRuntimeAttentionReminderProvider } from "./runtime-attention-reminders.js";
import { createRuntimeProductionCycleSummaryProvider } from "./runtime-production-cycle-summary.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = required("BPA_APP_DATABASE_URL");
const socketPath = required("BPA_INVENTORY_SOCKET");
const shops = inventoryShopsFromEnvironment();
const pool = createAppPostgresPool({
  connectionString: databaseUrl,
  applicationName: "bpa-inventory-monitor",
  maximumConnections: 10
});
const repository = new InventoryRepository(pool);
for (const shop of shops) {
  await repository.recordConfiguration({
    shopId:shop.id,shopName:shop.name,scheduleMinutes:30,shadowDays:14,
    notifications:"disabled",inventoryWrites:"disabled",
    policyVersion:"inventory-balanced-shadow/1.0.0"
  });
}
const mysqlOptions = mysqlOptionsFromEnvironment();
const salesSync = mysqlOptions ? new MysqlSalesDemandSync(mysqlOptions, repository) : undefined;
if (!isWindowsNamedPipe(socketPath)) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
}
const protocol = new InventoryServiceProtocol(socketPath,repository,salesSync,shops);
await protocol.start();
const port = Number(process.env.BPA_INVENTORY_PORT ?? 17650);
const listenHost = process.env.BPA_INVENTORY_WEB_HOST?.trim() || "127.0.0.1";
const publicHost = process.env.BPA_INVENTORY_PUBLIC_HOST?.trim() || listenHost;
const sessionSecretFile = process.env.BPA_INVENTORY_WEB_SESSION_SECRET_FILE?.trim() || (
  isWindowsNamedPipe(socketPath)
    ? join(resolveDefaultBpaHome(), "run", "inventory-web-session.key")
    : `${socketPath}.web-session.key`
);
await mkdir(dirname(sessionSecretFile),{ recursive:true,mode:0o700 });
let sessionSecret: string;
try {
  sessionSecret = (await readFile(sessionSecretFile,"utf8")).trim();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  sessionSecret = randomBytes(32).toString("base64url");
  await writeFile(sessionSecretFile,`${sessionSecret}\n`,{ encoding:"utf8",mode:0o600,flag:"wx" });
}
if (sessionSecret.length < 32) throw new Error("WEB_SESSION_SECRET_TOO_SHORT");
await chmod(sessionSecretFile,0o600);
const recoveryStatusPath = process.env.BPA_INVENTORY_RECOVERY_STATUS_FILE?.trim() ||
  join(resolveDefaultBpaHome(),"run","inventory-multishop-recovery.status.json");
const attentionControl = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(),{
    runtime:{ name:"bpa-inventory-monitor",version:"0.1.0" },
    features:["attention_dashboard"]
  }),
  { timeoutMs:2_000 }
);
const web = await startInventoryWebServer({
  repository,shops,port,sessionSecret,listenHost,publicHost,recoveryStatusPath,
  runtimeAttentionReminders:createRuntimeAttentionReminderProvider(attentionControl),
  runtimeProductionCycleSummary:createRuntimeProductionCycleSummaryProvider(
    attentionControl
  )
});
const launchUrlFile = process.env.BPA_INVENTORY_LAUNCH_URL_FILE?.trim() || (
  isWindowsNamedPipe(socketPath)
    ? join(resolveDefaultBpaHome(), "run", "inventory.review-url")
    : `${socketPath}.review-url`
);
await mkdir(dirname(launchUrlFile),{ recursive:true,mode:0o700 });
await writeFile(launchUrlFile,`${web.launchUrl}\n`,{ encoding:"utf8",mode:0o600 });
await chmod(launchUrlFile,0o600);

process.stdout.write(`${JSON.stringify({
  status: "ready",
  shops: shops.map(({ id,name }) => ({ id,name })),
  socketPath,
  port:web.port,
  listenHost,
  launchUrlFile
})}\n`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await web.close().catch(() => undefined);
  await protocol.close().catch(() => undefined);
  await unlink(launchUrlFile).catch(() => undefined);
  await salesSync?.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};
for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => { void close().finally(() => process.exit(0)); });
}
