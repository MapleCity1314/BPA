import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAppPostgresPool } from "@bpa/app-postgres";
import { MysqlSalesDemandSync, mysqlOptionsFromEnvironment } from "./mysql-source.js";
import { InventoryRepository } from "./repository.js";
import { InventoryServiceProtocol } from "./service-protocol.js";
import { startInventoryWebServer } from "./web-server.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = required("BPA_APP_DATABASE_URL");
const socketPath = required("BPA_INVENTORY_SOCKET");
const shopId = required("BPA_INVENTORY_SHOP_ID");
const shopName = required("BPA_INVENTORY_SHOP_NAME");
const pool = createAppPostgresPool({
  connectionString: databaseUrl,
  applicationName: "bpa-inventory-monitor",
  maximumConnections: 10
});
const repository = new InventoryRepository(pool);
await repository.recordConfiguration({
  shopId,shopName,scheduleMinutes:30,shadowDays:14,
  notifications:"disabled",inventoryWrites:"disabled",
  policyVersion:"inventory-balanced-shadow/1.0.0"
});
const mysqlOptions = mysqlOptionsFromEnvironment();
const salesSync = mysqlOptions ? new MysqlSalesDemandSync(mysqlOptions, repository) : undefined;
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
const protocol = new InventoryServiceProtocol(socketPath,repository,salesSync,{ id:shopId,name:shopName });
await protocol.start();
const port = Number(process.env.BPA_INVENTORY_PORT ?? 17650);
const web = await startInventoryWebServer({ repository,shopId,port });
const launchUrlFile = process.env.BPA_INVENTORY_LAUNCH_URL_FILE?.trim() || `${socketPath}.review-url`;
await mkdir(dirname(launchUrlFile),{ recursive:true,mode:0o700 });
await writeFile(launchUrlFile,`${web.launchUrl}\n`,{ encoding:"utf8",mode:0o600 });
await chmod(launchUrlFile,0o600);

process.stdout.write(`${JSON.stringify({ status: "ready",shopId,shopName,socketPath,port:web.port,launchUrlFile })}\n`);

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
