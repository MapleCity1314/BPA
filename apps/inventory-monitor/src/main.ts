import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createAppPostgresPool } from "@bpa/app-postgres";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import { MysqlSalesDemandSync, mysqlOptionsFromEnvironment } from "./mysql-source.js";
import { InventoryRepository } from "./repository.js";
import { InventoryServiceProtocol } from "./service-protocol.js";
import { inventoryShopsFromEnvironment } from "./shop-config.js";

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

process.stdout.write(`${JSON.stringify({
  status: "ready",
  shops: shops.map(({ id,name }) => ({ id,name })),
  socketPath
})}\n`);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await protocol.close().catch(() => undefined);
  await salesSync?.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};
for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => { void close().finally(() => process.exit(0)); });
}
