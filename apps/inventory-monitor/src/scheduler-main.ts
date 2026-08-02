import { createAppPostgresPool } from "@bpa/app-postgres";
import { InventoryRepository } from "./repository.js";
import { InventoryShadowScheduler } from "./scheduler.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = createAppPostgresPool({
  connectionString: required("BPA_APP_DATABASE_URL"),
  applicationName: "bpa-inventory-scheduler",
  maximumConnections: 3
});
const scheduler = new InventoryShadowScheduler(new InventoryRepository(pool), {
  id: required("BPA_INVENTORY_SHOP_ID"),
  name: required("BPA_INVENTORY_SHOP_NAME")
});
const intervalMs = 30 * 60 * 1000;
let stopped = false;
let timer: NodeJS.Timeout | undefined;

const run = (): void => {
  void scheduler.run().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => process.stderr.write(`inventory schedule failed: ${error instanceof Error ? error.message : String(error)}\n`)
  );
};
timer = setInterval(run,intervalMs);
run();

const close = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  scheduler.stop();
  await pool.end().catch(() => undefined);
};
for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => { void close().finally(() => process.exit(0)); });
}
