import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { InventoryRepository } from "./repository.js";
import {
  buildInventoryCollectionSummary,
  type FailedInventoryProduct
} from "./collection-summary.js";

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
const NODE_RUN_TIMEOUT_MS = 135_000;
const CONTROL_REQUEST_TIMEOUT_MS = 120_000;
const SNAPSHOT_RETRY_DELAYS_MS = [0, 2_000, 4_000, 8_000, 12_000, 20_000] as const;

function isPreRunBindingStale(error: unknown): boolean {
  return error instanceof Error && error.message === "BROWSER_OBSERVATION_STALE:browser";
}

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

const databaseUrl = required("BPA_APP_DATABASE_URL");
const socketPath = required("BPA_INVENTORY_SOCKET");
const shopId = required("BPA_INVENTORY_SHOP_ID");
const shopName = required("BPA_INVENTORY_SHOP_NAME");
const browserInstanceId = required("BPA_INVENTORY_BROWSER_INSTANCE_ID");
const refreshSince = required("BPA_INVENTORY_REFRESH_SINCE");
const scopeMode = process.env.BPA_INVENTORY_SCOPE_MODE?.trim() || "auto";
if (!new Set(["auto", "browser", "persisted"]).has(scopeMode)) {
  throw new Error("BPA_INVENTORY_SCOPE_MODE_INVALID");
}
const productIdFilter = new Set(
  (process.env.BPA_INVENTORY_PRODUCT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const pool = createAppPostgresPool({
  connectionString: databaseUrl,
  applicationName: "bpa-inventory-refresh-missing",
  maximumConnections: 2
});
const repository = new InventoryRepository(pool);
const client = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-inventory-refresh-missing", version: "1.0.0" },
    features: ["resource_bindings"]
  }),
  { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS }
);
const leaseKey = `inventory-shadow:${shopId}`;
const holderId = `inventory-refresh-missing:${process.pid}:${randomUUID()}`;
const fencingToken = await repository.acquireLease({
  leaseKey,
  holderId,
  ttlSeconds: 120
});
if (fencingToken === undefined) {
  process.stdout.write(
    `${JSON.stringify({ status: "skipped", shopId, reason: "lease_busy" })}\n`
  );
  await pool.end();
  process.exit(0);
}

let lastRenewedAt = Date.now();
const renew = async (): Promise<void> => {
  if (Date.now() - lastRenewedAt < 20_000) return;
  const renewed = await repository.renewLease({
    leaseKey,
    holderId,
    fencingToken,
    ttlSeconds: 120
  });
  if (!renewed) throw new Error("SCHEDULER_LEASE_LOST");
  lastRenewedAt = Date.now();
};

const waitWithLease = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) return;
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(5_000, deadline - Date.now()))
    );
    await renew();
  }
};

const browserBinding = async (): Promise<Record<string, unknown>> => {
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
      revision: number;
    }>>("browser.page-observation.list", {
      limit: 200,
      browserInstanceId
    });
    const page = pages.find((candidate) =>
      candidate.pathname === "/ffa/g/list" &&
      candidate.contentScriptReady &&
      candidate.observationState === "ready" &&
      candidate.authentication === "authenticated"
    );
    if (page) {
      return {
        browser: {
          sessionId: page.sessionId,
          browserInstanceId: page.browserInstanceId,
          tabId: page.tabId,
          observationRevision: page.revision
        }
      };
    }
    const probeCandidates = pages.filter((candidate) =>
      candidate.pathname === "/ffa/g/list" && candidate.contentScriptReady
    );
    await Promise.allSettled(
      probeCandidates.map((candidate) =>
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
    // A recycled worker tab needs one extension probe before it can become a
    // frozen BPA resource binding. Wait under the same fencing lease instead
    // of failing immediately and starting another refresh process.
    await waitWithLease(2_000);
  } while (Date.now() < deadline);
  throw new Error("BROWSER_PRODUCT_PAGE_NOT_READY");
};

const runNode = async (
  nodeId: string,
  nodeVersion: string,
  input: Record<string, unknown>,
  resourceBindings: Record<string, unknown>
): Promise<WorkflowRun> => {
  const preview = await client.request<{
    previewDigest: string;
    requiresConfirmation: boolean;
  }>("run.node.preview", { nodeId, nodeVersion, input });
  let run = await client.request<WorkflowRun>("run.node.create", {
    nodeId,
    nodeVersion,
    input,
    expectedPreviewDigest: preview.previewDigest,
    confirmed: preview.requiresConfirmation,
    resourceBindings,
    actor: "bpa-inventory-refresh-missing"
  });
  const startedAt = Date.now();
  while (!TERMINAL.has(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await renew();
    run = await client.request<WorkflowRun>("run.inspect", { runId: run.id });
    if (
      !TERMINAL.has(run.status) &&
      Date.now() - startedAt >= NODE_RUN_TIMEOUT_MS
    ) {
      try {
        run = await client.request<WorkflowRun>("run.cancel", {
          runId: run.id,
          actor: "bpa-inventory-refresh-missing-timeout"
        });
      } catch {
        return { id: run.id, status: "timed_out" };
      }
      return TERMINAL.has(run.status)
        ? run
        : { id: run.id, status: "timed_out" };
    }
  }
  return run;
};

const runSnapshotNode = async (
  input: Record<string, unknown>
): Promise<WorkflowRun> => {
  let lastRun: WorkflowRun | undefined;
  for (const delayMs of SNAPSHOT_RETRY_DELAYS_MS) {
    await waitWithLease(delayMs);
    try {
      lastRun = await runNode(
        "doudian.inventory.product.snapshot.read",
        "1.0.0",
        input,
        await browserBinding()
      );
    } catch (error) {
      if (!isPreRunBindingStale(error)) throw error;
      lastRun = { id: "binding-stale-before-run", status: "failed" };
    }
    if (lastRun.status === "succeeded") return lastRun;
  }
  return lastRun ?? { id: "not-started", status: "failed" };
};

const runShopContextNode = async (): Promise<WorkflowRun> => {
  let lastRun: WorkflowRun | undefined;
  for (const delayMs of [0,2_000,5_000] as const) {
    await waitWithLease(delayMs);
    try {
      lastRun = await runNode(
        "doudian.shop.context.read",
        "1.3.0",
        {},
        await browserBinding()
      );
    } catch (error) {
      if (!isPreRunBindingStale(error)) throw error;
      lastRun = { id: "binding-stale-before-run", status: "failed" };
    }
    if (lastRun.status === "succeeded") return lastRun;
  }
  return lastRun ?? { id:"not-started",status:"failed" };
};

function safeProductTitle(productId: string, value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const cleaned = normalized
    .replace(/\s*ID[：:]\s*\d{5,30}[\s\S]*$/iu, "")
    .replace(/\s*(?:现货模式|预览|复制链接)[\s\S]*$/u, "")
    .trim();
  if (
    !cleaned ||
    cleaned.length > 120 ||
    /(?:好评|设置优惠|提升购买转化|提升销量|发起提醒|库存监测服务)/u.test(cleaned)
  ) {
    return `商品 ${productId}`;
  }
  return cleaned;
}

async function persistedProducts(): Promise<Array<{ id: string; title: string }>> {
  const result = await pool.query<{ product_id: string; product_title: string }>(
    `SELECT DISTINCT ON (product_id) product_id,product_title
     FROM inventory.snapshot
     WHERE shop_id=$1
     ORDER BY product_id,observed_at DESC`,
    [shopId]
  );
  return result.rows.map((row) => ({
    id: row.product_id,
    title: safeProductTitle(row.product_id, row.product_title)
  }));
}

try {
  const contextRun = await runShopContextNode();
  let currentShop = record(record(contextRun.output)?.shop);
  const contextMismatch =
    contextRun.status !== "succeeded" ||
    currentShop?.identity_confirmed !== true ||
    typeof currentShop.id !== "string" ||
    typeof currentShop.name !== "string" ||
    currentShop.name.trim() !== shopName;
  if (contextMismatch) {
    const actualShopId = typeof currentShop?.id === "string"
      ? currentShop.id
      : "unknown";
    const actualShopName = typeof currentShop?.name === "string"
      ? currentShop.name.trim()
      : "unknown";
    const bootstrapProduct = scopeMode === "browser"
      ? undefined
      : (await persistedProducts())[0];
    const bootstrapRun = bootstrapProduct
      ? await runSnapshotNode({
          shop: { id: shopId, name: shopName },
          product: bootstrapProduct
        })
      : undefined;
    if (bootstrapRun?.status !== "succeeded") {
      throw new Error(
        `SHOP_CONTEXT_MISMATCH expected=${shopId}:${shopName} actual=${actualShopId}:${actualShopName}`
      );
    }
    // The read-only snapshot node navigated the frozen product tab and
    // independently verified the requested shop. Continue with the explicit
    // configured identity; every subsequent product read repeats this gate.
    currentShop = { id: shopId, name: shopName, identity_confirmed: true };
  }
  if (
    !currentShop ||
    typeof currentShop.id !== "string" ||
    typeof currentShop.name !== "string"
  ) {
    throw new Error("SHOP_CONTEXT_UNVERIFIED");
  }
  const verifiedShop = { id: currentShop.id, name: currentShop.name };

  let products: Array<{ id: string; title: string }> = [];
  let scopeSource = "persisted";
  if (scopeMode !== "persisted") {
    const scopeRun = await runNode(
      "doudian.product.scope.collect",
      "1.1.0",
      {},
      await browserBinding()
    );
    const scope = record(scopeRun.output);
    products = Array.isArray(scope?.inspectionQueue)
      ? scope.inspectionQueue.flatMap((value) => {
          const product = record(value);
          return typeof product?.id === "string" && typeof product.title === "string"
            ? [{ id: product.id, title: safeProductTitle(product.id, product.title) }]
            : [];
        })
      : [];
    if (scopeRun.status === "succeeded" && scope?.status === "complete" && products.length > 0) {
      scopeSource = "browser";
    } else if (scopeMode === "browser") {
      throw new Error("PRODUCT_SCOPE_NOT_COMPLETE");
    } else {
      products = [];
    }
  }
  if (products.length === 0) {
    products = await persistedProducts();
    scopeSource = "persisted";
  }
  if (products.length === 0) {
    throw new Error("PRODUCT_SCOPE_EMPTY");
  }
  if (productIdFilter.size > 0) {
    products = products.filter((product) => productIdFilter.has(product.id));
    if (products.length !== productIdFilter.size) {
      throw new Error("PRODUCT_FILTER_SCOPE_MISMATCH");
    }
  }
  const existing = await pool.query<{ product_id: string }>(
    "SELECT DISTINCT product_id FROM inventory.snapshot WHERE shop_id=$1 AND observed_at >= $2::timestamptz",
    [shopId,refreshSince]
  );
  const completed = new Set(existing.rows.map((row) => row.product_id));
  const missing = products.filter((product) => !completed.has(product.id));
  process.stdout.write(
    `${JSON.stringify({ status: "started", scopeSource, total: products.length, missing: missing.length })}\n`
  );
  const failures: FailedInventoryProduct[] = [];
  let persisted = 0;
  for (const product of missing) {
    const snapshotRun = await runSnapshotNode({
      shop: {
        id: verifiedShop.id,
        name: verifiedShop.name
      },
      product
    });
    if (snapshotRun.status !== "succeeded" || !record(snapshotRun.output)) {
      failures.push({
        productId:product.id,stage:"snapshot_read",errorCode:snapshotRun.status,
        evidenceId:snapshotRun.id
      });
      continue;
    }
    const response = await requestService(socketPath, {
      id: `persist-${product.id}`,
      operation: "inventory.snapshot.persist",
      input: {
        snapshot: snapshotRun.output,
        lease: { leaseKey, holderId, fencingToken }
      }
    });
    if (response.ok !== true) {
      failures.push({
        productId:product.id,stage:"snapshot_persist",
        errorCode:String(response.error ?? "persist_failed"),evidenceId:snapshotRun.id
      });
      continue;
    }
    persisted += 1;
    process.stdout.write(
      `${JSON.stringify({ status: "progress", persisted, missing: missing.length, productId: product.id })}\n`
    );
  }
  const summary = buildInventoryCollectionSummary({
    discovered:products.length,alreadyFresh:completed.size,attempted:missing.length,
    persisted,failedProducts:failures
  });
  process.stdout.write(`${JSON.stringify({
    status:summary.outcome === "complete" ? "succeeded" : summary.outcome,
    summary
  })}\n`);
  if (failures.length) process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exitCode = 1;
} finally {
  await repository.releaseLease({ leaseKey, holderId, fencingToken });
  await pool.end();
}
