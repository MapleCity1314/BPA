import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createAppPostgresPool } from "@bpa/app-postgres";
import { InventoryRepository } from "./repository.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function requestService(
  socketPath: string,
  value: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(JSON.stringify(value)));
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

const shopId = required("BPA_INVENTORY_SHOP_ID");
const shopName = required("BPA_INVENTORY_SHOP_NAME");
const socketPath = required("BPA_INVENTORY_SOCKET");
const pool = createAppPostgresPool({
  connectionString: required("BPA_APP_DATABASE_URL"),
  applicationName: "bpa-sales-demand-refresh",
  maximumConnections: 2
});
const repository = new InventoryRepository(pool);
const leaseKey = `inventory-shadow:${shopId}`;
const holderId = `sales-demand-refresh:${process.pid}:${randomUUID()}`;
const fencingToken = await repository.acquireLease({
  leaseKey,
  holderId,
  ttlSeconds: 180
});
if (fencingToken === undefined) {
  await pool.end();
  throw new Error("SALES_DEMAND_REFRESH_LEASE_BUSY");
}

let renewing = false;
let leaseLost = false;
const renewal = setInterval(() => {
  if (renewing || leaseLost) return;
  renewing = true;
  void repository.renewLease({
    leaseKey,
    holderId,
    fencingToken,
    ttlSeconds: 180
  }).then((renewed) => {
    leaseLost = !renewed;
  }).catch(() => {
    leaseLost = true;
  }).finally(() => {
    renewing = false;
  });
}, 30_000);
renewal.unref();

try {
  const response = await requestService(socketPath, {
    id: `sales-sync-${shopId}-${randomUUID()}`,
    operation: "sales-demand.sync",
    input: {
      shopId,
      shopName,
      lease: { leaseKey, holderId, fencingToken }
    }
  });
  if (leaseLost) throw new Error("SALES_DEMAND_REFRESH_LEASE_LOST");
  if (response.ok !== true) {
    const error = response.error as Record<string, unknown> | undefined;
    throw new Error(String(error?.code ?? "SALES_DEMAND_SYNC_FAILED"));
  }
  const result = response.result as Record<string, unknown> | undefined;
  process.stdout.write(`${JSON.stringify({
    status: result?.status ?? "succeeded",
    shopId,
    processed: result?.processed ?? 0,
    inserted: result?.inserted ?? 0,
    updated: result?.updated ?? 0,
    watermark: result?.watermark ?? null
  })}\n`);
} finally {
  clearInterval(renewal);
  await repository.releaseLease({ leaseKey, holderId, fencingToken }).catch(() => undefined);
  await pool.end();
}
