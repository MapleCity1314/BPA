import { createAppPostgresPool } from "@bpa/app-postgres";
import { InventoryRepository } from "./repository.js";
import { InventoryShadowScheduler } from "./scheduler.js";
import {
  inventoryShopsFromEnvironment,
  prioritizeBrowserBoundShops,
  schedulerShopIndexGroups
} from "./shop-config.js";

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
const repository = new InventoryRepository(pool);
const shops = prioritizeBrowserBoundShops(inventoryShopsFromEnvironment(process.env));
const schedulers = shops.map((shop) => new InventoryShadowScheduler(repository, shop));
const intervalMs = 30 * 60 * 1000;
const configuredConcurrency = Number(process.env.BPA_INVENTORY_SCHEDULER_CONCURRENCY ?? "2");
if (!Number.isSafeInteger(configuredConcurrency) || configuredConcurrency < 1 || configuredConcurrency > 4) {
  throw new Error("BPA_INVENTORY_SCHEDULER_CONCURRENCY_INVALID");
}
let stopped = false;
let timer: NodeJS.Timeout | undefined;
let running = false;

const run = (): void => {
  if (running) {
    process.stderr.write("inventory multi-shop schedule skipped: previous cycle is still running\n");
    return;
  }
  running = true;
  void (async () => {
    const runGroup = async (
      indexes: readonly number[],
      concurrency: number
    ): Promise<void> => {
      let cursor = 0;
      const workers = Array.from(
        { length:Math.min(concurrency,indexes.length) },
        async () => {
          while (!stopped) {
            const index = indexes[cursor++];
            if (index === undefined) return;
            const shop = shops[index]!;
            try {
              const result = await schedulers[index]!.run();
              process.stdout.write(`${JSON.stringify({ shopId:shop.id,...result })}\n`);
            } catch (error) {
              process.stderr.write(`inventory schedule failed for ${shop.id}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }
        }
      );
      await Promise.all(workers);
    };
    const groups = schedulerShopIndexGroups(shops);
    await runGroup(groups.bound,1);
    await runGroup(groups.unbound,configuredConcurrency);
  })().finally(() => { running = false; });
};
timer = setInterval(run,intervalMs);
run();

const close = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  schedulers.forEach((scheduler) => scheduler.stop());
  await pool.end().catch(() => undefined);
};
for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => { void close().finally(() => process.exit(0)); });
}
