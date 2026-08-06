import { randomUUID } from "node:crypto";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import {
  INVENTORY_DATA_VALIDITY_MINUTES,
  INVENTORY_FACT_SCHEMA_VERSION,
  type FactEnvelope,
  type InventoryProductFact,
  type MappingConfidence
} from "@bpa/inventory-domain";
import { InventoryRepository } from "./repository.js";

interface WorkflowRun {
  readonly id: string;
  readonly status: string;
}

interface SnapshotRow {
  snapshot_id: string;
  dataset_id: string;
  data_version: string;
  source_digest: string;
  product_id: string;
  product_title: string;
  total_stock: number;
  observed_at: Date;
  completeness: string;
  mapping_confidence: MappingConfidence;
  diagnostics: unknown;
}

interface SkuRow {
  snapshot_id: string;
  platform_sku_id: string;
  merchant_code: string;
  current_stock: number;
  occupied_stock: number;
  unoccupied_stock: number;
  channels: unknown;
}

const TERMINAL = new Set([
  "succeeded",
  "rejected",
  "failed",
  "timed_out",
  "cancelled",
  "uncertain"
]);
const RISK_RETRY_DELAYS_MS = [0, 5_000] as const;
const PRODUCT_PACING_MS = 750;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function records(value: unknown): readonly { channelGoodsId: string; stock: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    return typeof item.channelGoodsId === "string" && Number.isSafeInteger(Number(item.stock))
      ? [{ channelGoodsId: item.channelGoodsId, stock: Number(item.stock) }]
      : [];
  });
}

const shopId = required("BPA_INVENTORY_SHOP_ID");
const productIdFilter = new Set(
  (process.env.BPA_INVENTORY_PRODUCT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const pool = createAppPostgresPool({
  connectionString: required("BPA_APP_DATABASE_URL"),
  applicationName: "bpa-inventory-risk-refresh",
  maximumConnections: 3
});
const repository = new InventoryRepository(pool);
const client = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-inventory-risk-refresh", version: "1.0.0" },
    features: ["resource_bindings"]
  }),
  { timeoutMs: 30_000 }
);
const leaseKey = `inventory-shadow:${shopId}`;
const holderId = `inventory-risk-refresh:${process.pid}:${randomUUID()}`;
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
const leaseToken = fencingToken;

let lastRenewedAt = Date.now();
async function renew(): Promise<void> {
  if (Date.now() - lastRenewedAt < 20_000) return;
  const renewed = await repository.renewLease({
    leaseKey,
    holderId,
    fencingToken: leaseToken,
    ttlSeconds: 180
  });
  if (!renewed) throw new Error("INVENTORY_RISK_REFRESH_LEASE_LOST");
  lastRenewedAt = Date.now();
}

async function runRisk(
  snapshotId: string,
  envelope: FactEnvelope<InventoryProductFact>
): Promise<WorkflowRun> {
  let run = await client.request<WorkflowRun>("run.create", {
    workflowId: "inventory.risk.shadow.evaluate",
    workflowVersion: "1.0.1",
    input: {
      snapshotId,
      envelope,
      evaluatedAt: new Date().toISOString(),
      lease: { leaseKey, holderId, fencingToken: leaseToken }
    },
    resourceBindings: {},
    actor: "bpa-inventory-risk-refresh"
  });
  const startedAt = Date.now();
  while (!TERMINAL.has(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await renew();
    run = await client.request<WorkflowRun>("run.inspect", { runId: run.id });
    if (Date.now() - startedAt >= 120_000 && !TERMINAL.has(run.status)) {
      run = await client.request<WorkflowRun>("run.cancel", {
        runId: run.id,
        actor: "bpa-inventory-risk-refresh-timeout"
      });
      break;
    }
  }
  return run;
}

async function runRiskWithRetry(
  snapshotId: string,
  envelope: FactEnvelope<InventoryProductFact>
): Promise<WorkflowRun> {
  let lastRun: WorkflowRun | undefined;
  for (const delayMs of RISK_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await renew();
    }
    lastRun = await runRisk(snapshotId, envelope);
    if (lastRun.status === "succeeded") return lastRun;
  }
  return lastRun ?? { id: "not-started", status: "failed" };
}

try {
  const snapshots = await pool.query<SnapshotRow>(
    `SELECT DISTINCT ON (product_id)
       snapshot_id,dataset_id,data_version,source_digest,product_id,product_title,
       total_stock,observed_at,completeness,mapping_confidence,diagnostics
     FROM inventory.snapshot WHERE shop_id=$1
     ORDER BY product_id,observed_at DESC`,
    [shopId]
  );
  const selectedSnapshots = productIdFilter.size === 0
    ? snapshots.rows
    : snapshots.rows.filter((row) => productIdFilter.has(row.product_id));
  if (productIdFilter.size > 0 && selectedSnapshots.length !== productIdFilter.size) {
    throw new Error("PRODUCT_FILTER_SCOPE_MISMATCH");
  }
  const snapshotIds = selectedSnapshots.map((row) => row.snapshot_id);
  const skus = snapshotIds.length === 0
    ? { rows: [] as SkuRow[] }
    : await pool.query<SkuRow>(
        `SELECT ss.snapshot_id,ss.platform_sku_id,ss.merchant_code,
                ss.current_stock,ss.occupied_stock,ss.unoccupied_stock,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'channelGoodsId',sc.channel_goods_id,'stock',sc.stock
                ) ORDER BY sc.channel_goods_id) FILTER (WHERE sc.channel_goods_id IS NOT NULL),'[]'::jsonb) AS channels
         FROM inventory.snapshot_sku ss
         LEFT JOIN inventory.snapshot_channel sc
           ON sc.snapshot_id=ss.snapshot_id AND sc.platform_sku_id=ss.platform_sku_id
         WHERE ss.snapshot_id=ANY($1::text[])
         GROUP BY ss.snapshot_id,ss.platform_sku_id,ss.merchant_code,
                  ss.current_stock,ss.occupied_stock,ss.unoccupied_stock
         ORDER BY ss.snapshot_id,ss.platform_sku_id`,
        [snapshotIds]
      );
  const bySnapshot = new Map<string, SkuRow[]>();
  for (const sku of skus.rows) {
    const values = bySnapshot.get(sku.snapshot_id) ?? [];
    values.push(sku);
    bySnapshot.set(sku.snapshot_id, values);
  }
  process.stdout.write(`${JSON.stringify({ status: "started", shopId, products: selectedSnapshots.length })}\n`);
  const failures: Array<{ productId: string; status: string }> = [];
  let completed = 0;
  for (const snapshot of selectedSnapshots) {
    const observedAt = snapshot.observed_at.toISOString();
    const envelope: FactEnvelope<InventoryProductFact> = {
      schemaVersion: INVENTORY_FACT_SCHEMA_VERSION,
      observedAt,
      asOf: observedAt,
      scope: { shopId, productId: snapshot.product_id },
      facts: {
        productId: snapshot.product_id,
        title: snapshot.product_title,
        totalStock: snapshot.total_stock,
        skus: (bySnapshot.get(snapshot.snapshot_id) ?? []).map((sku) => ({
          platformSkuId: sku.platform_sku_id,
          merchantCode: sku.merchant_code,
          currentStock: sku.current_stock,
          occupiedStock: sku.occupied_stock,
          unoccupiedStock: sku.unoccupied_stock,
          channels: records(sku.channels)
        }))
      },
      quality: {
        freshness:
          Date.now() - snapshot.observed_at.getTime() <=
          INVENTORY_DATA_VALIDITY_MINUTES * 60_000
          ? "fresh"
          : "stale",
        completeness: Number(snapshot.completeness),
        mappingConfidence: snapshot.mapping_confidence,
        diagnostics: Array.isArray(snapshot.diagnostics)
          ? snapshot.diagnostics.map(String)
          : []
      },
      source: {
        kind: "doudian.inventory.product.snapshot.read",
        datasetId: snapshot.dataset_id,
        datasetVersion: snapshot.data_version,
        digest: snapshot.source_digest
      }
    };
    const run = await runRiskWithRetry(snapshot.snapshot_id, envelope);
    if (run.status === "succeeded") {
      completed += 1;
    } else {
      failures.push({ productId: snapshot.product_id, status: run.status });
    }
    process.stdout.write(`${JSON.stringify({
      status: "progress",
      shopId,
      completed,
      total: selectedSnapshots.length,
      productId: snapshot.product_id,
      runStatus: run.status
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, PRODUCT_PACING_MS));
    await renew();
  }
  process.stdout.write(`${JSON.stringify({
    status: failures.length ? "partial" : "succeeded",
    shopId,
    completed,
    total: selectedSnapshots.length,
    failures
  })}\n`);
  if (failures.length) process.exitCode = 2;
} finally {
  await repository.releaseLease({
    leaseKey,
    holderId,
    fencingToken: leaseToken
  }).catch(() => undefined);
  await pool.end();
}
