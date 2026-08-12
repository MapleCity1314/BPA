import { createHash,randomUUID } from "node:crypto";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  buildConsolidatedInventoryFeishuReport,buildInventoryFeishuAlert,sendFeishuWebhook,
  type InventoryReportOverview,type ShopInventoryReport
} from "./feishu-report.js";
import { InventoryRepository } from "./repository.js";
import { inventoryShopsFromEnvironment } from "./shop-config.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const mode = process.env.BPA_FEISHU_INVENTORY_MODE?.trim() || "preview";
if (!new Set(["preview","send"]).has(mode)) throw new Error("BPA_FEISHU_INVENTORY_MODE must be preview or send");
const reportKind = process.env.BPA_FEISHU_REPORT_KIND?.trim() || "daily";
if (!new Set(["daily","alert"]).has(reportKind)) throw new Error("BPA_FEISHU_REPORT_KIND must be daily or alert");
const webhookUrl = mode === "send" ? required("BPA_FEISHU_INVENTORY_WEBHOOK_URL") : "";
const inventoryDashboardUrl = reportKind === "daily"
  ? required("BPA_FEISHU_INVENTORY_DASHBOARD_URL")
  : "";
const pool = createAppPostgresPool({
  connectionString:required("BPA_APP_DATABASE_URL"),
  applicationName:`bpa-inventory-feishu-${reportKind}`,
  maximumConnections:2
});
const repository = new InventoryRepository(pool);
const shops = inventoryShopsFromEnvironment();

try {
  const reportShops: ShopInventoryReport[] = [];
  for (const shop of shops) {
    reportShops.push({ shop,overview:await repository.overview(shop.id) as unknown as InventoryReportOverview });
  }
  const report = reportKind === "daily"
    ? buildConsolidatedInventoryFeishuReport({
        shops:reportShops,dashboardUrl:inventoryDashboardUrl
      })
    : buildInventoryFeishuAlert({ shops:reportShops });
  if (!report) {
    process.stdout.write(`${JSON.stringify({ status:"skipped",kind:reportKind,reason:"NO_ACTIONABLE_ANOMALY" })}\n`);
  } else if (mode === "preview") {
    process.stdout.write(`${JSON.stringify({ status:"preview",kind:reportKind,reportKey:report.reportKey,digest:report.digest,counts:report.counts,payload:report.payload })}\n`);
  } else {
    const client = await pool.connect();
    const lockName = `inventory-feishu:${reportKind}:all`;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",[lockName]
      );
      if (lock.rows[0]?.acquired !== true) {
        process.stdout.write(`${JSON.stringify({ status:"skipped",kind:reportKind,reason:"REPORT_LOCK_BUSY" })}\n`);
      } else {
        const action = reportKind === "daily" ? "inventory.feishu.report.sent" : "inventory.feishu.alert.sent";
        const prior = await client.query(
          "SELECT 1 FROM audit.change_event WHERE action=$1 AND target_id=$2 LIMIT 1",[action,report.reportKey]
        );
        if (prior.rowCount) {
          process.stdout.write(`${JSON.stringify({ status:"skipped",kind:reportKind,reason:"REPORT_ALREADY_SENT",reportKey:report.reportKey })}\n`);
        } else {
          const result = await sendFeishuWebhook({ webhookUrl,payload:report.payload });
          await client.query(
            `INSERT INTO audit.change_event(event_id,actor_id,action,target_type,target_id,details)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              `audit:${randomUUID()}`,`bpa-inventory-feishu-${reportKind}`,action,`${reportKind}_report`,report.reportKey,
              JSON.stringify({
                shopIds:shops.map((shop) => shop.id),reportDigest:report.digest,counts:report.counts,
                providerCode:result.code,responseDigest:`sha256:${createHash("sha256").update(result.message).digest("hex")}`
              })
            ]
          );
          process.stdout.write(`${JSON.stringify({ status:"sent",kind:reportKind,reportKey:report.reportKey,digest:report.digest,counts:report.counts })}\n`);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))",[lockName]).catch(() => undefined);
      client.release();
    }
  }
} finally {
  await pool.end();
}
