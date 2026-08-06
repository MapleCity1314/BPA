import { randomUUID } from "node:crypto";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { InventoryRepository } from "./repository.js";

interface WorkflowRun {
  readonly id: string;
  readonly status: string;
  readonly output?: unknown;
}

const TERMINAL = new Set([
  "succeeded",
  "rejected",
  "failed",
  "timed_out",
  "cancelled",
  "uncertain"
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completedSnapshotCount(output: unknown): number {
  const snapshots = record(record(output)?.snapshots);
  const succeeded = record(snapshots?.succeeded);
  return Array.isArray(succeeded?.items) ? succeeded.items.length : 0;
}

const databaseUrl = required("BPA_APP_DATABASE_URL");
const shopId = required("BPA_INVENTORY_SHOP_ID");
const shopName = required("BPA_INVENTORY_SHOP_NAME");
const browserInstanceId = required("BPA_INVENTORY_BROWSER_INSTANCE_ID");
const pool = createAppPostgresPool({
  connectionString: databaseUrl,
  applicationName: "bpa-inventory-refresh-once",
  maximumConnections: 2
});
const repository = new InventoryRepository(pool);
const client = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-inventory-refresh-once", version: "1.0.0" },
    features: ["resource_bindings"]
  }),
  { timeoutMs: 30_000 }
);
const leaseKey = `inventory-shadow:${shopId}`;
const holderId = `inventory-refresh-once:${process.pid}:${randomUUID()}`;
const fencingToken = await repository.acquireLease({
  leaseKey,
  holderId,
  ttlSeconds: 120
});
if (fencingToken === undefined) {
  await pool.end();
  throw new Error("INVENTORY_REFRESH_LEASE_BUSY");
}

let runId: string | undefined;
try {
  const resolution = await client.request<{
    resourceBindings: Record<string, unknown>;
  }>("browser.resource-binding.resolve", {
    workflowId: "doudian.inventory.snapshot.refresh",
    workflowVersion: "1.0.0",
    browserInstanceId
  });
  let run = await client.request<WorkflowRun>("run.create", {
    workflowId: "doudian.inventory.snapshot.refresh",
    workflowVersion: "1.0.0",
    input: {
      shopId,
      shopName,
      lease: { leaseKey, holderId, fencingToken }
    },
    resourceBindings: resolution.resourceBindings,
    actor: "bpa-inventory-refresh-once"
  });
  runId = run.id;
  process.stdout.write(
    `${JSON.stringify({ status: "started", runId, browserInstanceId })}\n`
  );
  let lastRenewedAt = Date.now();
  while (!TERMINAL.has(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (Date.now() - lastRenewedAt >= 20_000) {
      const renewed = await repository.renewLease({
        leaseKey,
        holderId,
        fencingToken,
        ttlSeconds: 120
      });
      if (!renewed) throw new Error("SCHEDULER_LEASE_LOST");
      lastRenewedAt = Date.now();
    }
    run = await client.request<WorkflowRun>("run.inspect", { runId });
  }
  process.stdout.write(
    `${JSON.stringify({
      status: run.status,
      runId,
      completedSnapshots: completedSnapshotCount(run.output)
    })}\n`
  );
  if (run.status !== "succeeded") process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      ...(runId ? { runId } : {}),
      error: error instanceof Error ? error.message : String(error)
    })}\n`
  );
  process.exitCode = 1;
} finally {
  await repository.releaseLease({ leaseKey, holderId, fencingToken });
  await pool.end();
}
