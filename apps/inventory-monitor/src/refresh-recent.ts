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
}

const TERMINAL = new Set([
  "succeeded",
  "rejected",
  "failed",
  "timed_out",
  "cancelled",
  "uncertain"
]);
const RUN_TIMEOUT_MS = 13 * 60_000;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const shopId = required("BPA_INVENTORY_SHOP_ID");
const shopName = required("BPA_INVENTORY_SHOP_NAME");
const browserInstanceId = required("BPA_INVENTORY_BROWSER_INSTANCE_ID");
const pool = createAppPostgresPool({
  connectionString: required("BPA_APP_DATABASE_URL"),
  applicationName: "bpa-sales-demand-recent-refresh",
  maximumConnections: 2
});
const repository = new InventoryRepository(pool);
const client = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-sales-demand-recent-refresh", version: "1.0.0" },
    features: ["resource_bindings"]
  }),
  // Browser-backed order reads can briefly monopolize the local control loop
  // while a large page is being normalized. Keep one workflow run attached
  // through that window instead of letting the caller create a duplicate run.
  { timeoutMs: 120_000 }
);
const leaseKey = `inventory-shadow:${shopId}`;
const holderId = `sales-demand-recent-refresh:${process.pid}:${randomUUID()}`;
const fencingToken = await repository.acquireLease({
  leaseKey,
  holderId,
  ttlSeconds: 180
});
if (fencingToken === undefined) {
  process.stdout.write(
    `${JSON.stringify({ status: "skipped", shopId, reason: "lease_busy" })}\n`
  );
  await pool.end();
  process.exit(0);
}

let lastRenewedAt = Date.now();
async function renew(): Promise<void> {
  if (Date.now() - lastRenewedAt < 20_000) return;
  const renewed = await repository.renewLease({
    leaseKey,
    holderId,
    fencingToken: fencingToken!,
    ttlSeconds: 180
  });
  if (!renewed) throw new Error("SALES_DEMAND_RECENT_REFRESH_LEASE_LOST");
  lastRenewedAt = Date.now();
}

async function waitForOrderObservation(): Promise<void> {
  const deadline = Date.now() + 60_000;
  do {
    const pages = await client.request<Array<{
      sessionId: string;
      browserInstanceId: string;
      tabId: number;
      windowId?: number;
      origin: string;
      pathname: string;
      contentScriptReady: boolean;
      observationState: string;
      authentication: string;
    }>>("browser.page-observation.list", {
      limit: 200,
      browserInstanceId
    });
    const orders = pages.filter((candidate) =>
      candidate.pathname === "/ffa/morder/order/list" &&
      candidate.contentScriptReady
    );
    if (orders.some((candidate) =>
      candidate.observationState === "ready" &&
      candidate.authentication === "authenticated"
    )) return;
    if (orders.some((candidate) => candidate.authentication === "logged_out")) {
      throw new Error("BROWSER_AUTH_REQUIRED:doudian_orders_browser");
    }
    await Promise.allSettled(
      orders.map((candidate) =>
        client.request("browser.page-observation.probe", {
          sessionId: candidate.sessionId,
          browserInstanceId: candidate.browserInstanceId,
          tabId: candidate.tabId,
          ...(candidate.windowId === undefined
            ? {}
            : { windowId: candidate.windowId }),
          origin: candidate.origin,
          timeoutMs: 5_000
        })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await renew();
  } while (Date.now() < deadline);
  throw new Error("BROWSER_ORDER_PAGE_NOT_READY");
}

let runId: string | undefined;
try {
  await waitForOrderObservation();
  const resolution = await client.request<{
    resourceBindings: Record<string, unknown>;
  }>("browser.resource-binding.resolve", {
    workflowId: "ecom.sales-demand.refresh",
    workflowVersion: "1.0.3",
    browserInstanceId
  });
  let run = await client.request<WorkflowRun>("run.create", {
    workflowId: "ecom.sales-demand.refresh",
    workflowVersion: "1.0.3",
    input: {
      shopId,
      shopName,
      lease: { leaseKey, holderId, fencingToken }
    },
    resourceBindings: resolution.resourceBindings,
    actor: "bpa-sales-demand-recent-refresh"
  });
  runId = run.id;
  process.stdout.write(
    `${JSON.stringify({ status: "started", shopId, runId })}\n`
  );
  const startedAt = Date.now();
  while (!TERMINAL.has(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await renew();
    run = await client.request<WorkflowRun>("run.inspect", { runId });
    if (Date.now() - startedAt >= RUN_TIMEOUT_MS && !TERMINAL.has(run.status)) {
      run = await client.request<WorkflowRun>("run.cancel", {
        runId,
        actor: "bpa-sales-demand-recent-refresh-timeout"
      });
      break;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ status: run.status, shopId, runId })}\n`
  );
  if (run.status !== "succeeded") process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      shopId,
      ...(runId ? { runId } : {}),
      error: error instanceof Error ? error.message : String(error)
    })}\n`
  );
  process.exitCode = 1;
} finally {
  await repository.releaseLease({
    leaseKey,
    holderId,
    fencingToken
  }).catch(() => undefined);
  await pool.end();
}
