import { createHash, randomUUID } from "node:crypto";
import mysql, { type Pool as MysqlPool, type RowDataPacket } from "mysql2/promise";
import type { InventoryRepository, LeaseFence, NormalizedOrderLine } from "./repository.js";

const WDT_SOURCE_SYSTEM = "ecom-profit-mysql:wdt-stockout";
const PAGE_SIZE = 5_000;
const MAX_ROWS_PER_SYNC = 1_000_000;

export interface SalesDemandCommitProgress {
  readonly committedChunks: number;
  readonly committedRows: number;
}

export class SalesDemandPartialCommitError extends Error {
  readonly code = "SALES_DEMAND_PARTIAL_COMMIT";

  constructor(
    readonly progress: SalesDemandCommitProgress,
    readonly causeCode: string
  ) {
    super("SALES_DEMAND_PARTIAL_COMMIT");
  }
}

function controlledCauseCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    (/^[A-Z][A-Z0-9_]{1,99}$/u.test(error.code) ||
      /^[A-Z0-9]{5}$/u.test(error.code))
  ) {
    return error.code;
  }
  const first = error instanceof Error
    ? error.message.split(/[:\s]/u)[0]
    : "SALES_DEMAND_SYNC_FAILED";
  return first && (
    /^[A-Z][A-Z0-9_]{1,99}$/u.test(first) ||
    /^[A-Z0-9]{5}$/u.test(first)
  )
    ? first
    : "SALES_DEMAND_SYNC_FAILED";
}

export function salesDemandSyncFailure(
  error: unknown,
  progress: SalesDemandCommitProgress
): Error {
  if (error instanceof SalesDemandPartialCommitError) return error;
  return progress.committedChunks > 0
    ? new SalesDemandPartialCommitError(progress, controlledCauseCode(error))
    : error instanceof Error
      ? error
      : new Error("SALES_DEMAND_SYNC_FAILED");
}

export interface MysqlSalesSourceOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface WdtSourceRow extends RowDataPacket {
  id: number;
  source_shop_name: string;
  child_order_id: string;
  product_id: string;
  merchant_code: string;
  specification: string | null;
  source_quantity: string | number;
  submitted_at: string | null;
  paid_at: string;
  shipped_at: string | null;
  refund_status: string | null;
  source_loaded_at: string;
  query_end_time: string;
}

export interface WdtCoverageRow extends RowDataPacket {
  query_end_time: string | null;
  source_loaded_at: string | null;
}

function required(value: unknown, label: string, maximum = 1_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value.trim();
}

function optionalShanghaiTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(" ", "T");
  const parsed = Date.parse(`${normalized}+08:00`);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function completeDayBefore(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return undefined;
  const instant = Date.parse(`${value.replace(" ", "T")}+08:00`);
  if (!Number.isFinite(instant)) return undefined;
  const shanghai = new Date(instant + 8 * 60 * 60_000);
  const year = shanghai.getUTCFullYear();
  const month = String(shanghai.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getUTCDate()).padStart(2, "0");
  const startOfDay = Date.parse(`${year}-${month}-${day}T00:00:00+08:00`);
  return new Date(startOfDay - 1).toISOString();
}

function wdtShopNames(shopName: string): readonly [string, string, string] {
  return [shopName, `抖音-${shopName}`, `抖音-享乐东${shopName}`];
}

export class MysqlSalesDemandSync {
  readonly pool: MysqlPool;

  constructor(
    readonly options: MysqlSalesSourceOptions,
    readonly repository: InventoryRepository
  ) {
    this.pool = mysql.createPool({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit: 2,
      waitForConnections: true,
      enableKeepAlive: true,
      dateStrings: true,
      charset: "utf8mb4"
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async sync(input: {
    readonly shopName: string;
    readonly expectedShopId?: string;
    readonly lease: LeaseFence;
  }): Promise<Record<string, unknown>> {
    return this.syncWdt(input);
  }

  protected maximumRowsPerSync(): number {
    return MAX_ROWS_PER_SYNC;
  }

  private async syncWdt(input: {
    readonly shopName: string;
    readonly expectedShopId?: string;
    readonly lease: LeaseFence;
  }): Promise<Record<string, unknown>> {
    const shopId = required(input.expectedShopId, "expectedShopId", 200);
    const syncRunId = `sync:${randomUUID()}`;
    const current = await this.repository.currentWatermark(WDT_SOURCE_SYSTEM, shopId);
    await this.repository.beginOrderSync({
      syncRunId,
      sourceSystem: WDT_SOURCE_SYSTEM,
      shopId,
      ...(current ? { sourceWatermark: current } : {})
    },input.lease);
    const digest = createHash("sha256");
    let cursor = current ? Number(current) : 0;
    let watermark = cursor;
    let processed = 0;
    let historicalCompleteThrough = new Date(0).toISOString();
    let committedChunks = 0;
    let committedRows = 0;
    try {
      const coverage = await this.readWdtCoverage(input.shopName);
      const recentObservedAt = optionalShanghaiTimestamp(coverage.query_end_time);
      const coverageCompleteThrough = completeDayBefore(coverage.query_end_time);
      if (coverageCompleteThrough) historicalCompleteThrough = coverageCompleteThrough;
      digest.update(JSON.stringify({
        queryEnd:coverage.query_end_time,sourceLoadedAt:coverage.source_loaded_at
      }));
      while (true) {
        const rows = await this.readWdtPage({ shopName: input.shopName,cursor });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]!.id;
        const normalized: NormalizedOrderLine[] = [];
        for (const source of rows) {
          const quantity = Number(source.source_quantity);
          const paidAt = optionalShanghaiTimestamp(source.paid_at);
          const submittedAt = optionalShanghaiTimestamp(source.submitted_at) ?? paidAt;
          const sourceLoadedAt = optionalShanghaiTimestamp(source.source_loaded_at);
          const sourcePeriodEnd = completeDayBefore(source.query_end_time);
          if (
            !Number.isSafeInteger(quantity) || quantity < 0 || !paidAt ||
            !submittedAt || !sourceLoadedAt || !sourcePeriodEnd
          ) {
            throw new Error("WDT_ORDER_ROW_INVALID");
          }
          const shippedAt = optionalShanghaiTimestamp(source.shipped_at);
          const rowHash = `sha256:${createHash("sha256").update(JSON.stringify([
            source.id,source.child_order_id,source.product_id,source.merchant_code,
            quantity,submittedAt,paidAt,shippedAt ?? null,source.refund_status ?? ""
          ])).digest("hex")}`;
          normalized.push({
            sourceSystem:WDT_SOURCE_SYSTEM,
            shopId,shopName:input.shopName,
            childOrderId:required(source.child_order_id,"childOrderId",100),
            productId:required(source.product_id,"productId",100),
            merchantCode:required(source.merchant_code,"merchantCode",200),
            specification:String(source.specification ?? "").trim().slice(0,1_000),
            submittedAt,paidAt,...(shippedAt ? { shippedAt } : {}),
            orderStatus:shippedAt ? "已发货" : "已支付",
            aftersalesStatus:String(source.refund_status ?? "").trim().slice(0,200),
            sourceQuantity:quantity,demandQuantity:quantity,sourceBatchId:source.id,
            sourceRowHash:rowHash,sourceLoadedAt,sourcePeriodEnd
          });
          watermark = Math.max(watermark,source.id);
          if (sourcePeriodEnd > historicalCompleteThrough) historicalCompleteThrough = sourcePeriodEnd;
          digest.update(`${source.id}:${rowHash}\n`);
        }
        await this.repository.upsertOrderChunk({
          syncRunId,sourceSystem:WDT_SOURCE_SYSTEM,shopId,rows:normalized
        },input.lease);
        committedChunks += 1;
        committedRows += normalized.length;
        processed += normalized.length;
        if (processed > this.maximumRowsPerSync()) {
          throw new Error("WDT_SYNC_ROW_LIMIT_EXCEEDED");
        }
        if (rows.length < PAGE_SIZE) break;
      }
      if (!recentObservedAt || !coverageCompleteThrough) {
        if (processed === 0) {
          await this.repository.completeNoChangeOrderSync(syncRunId,input.lease);
          return { status:"no_changes",syncRunId,watermark:current ?? null,processed:0 };
        }
        throw new Error("WDT_DATA_QUALITY_INVALID");
      }
      const sourceDigest = `sha256:${digest.digest("hex")}`;
      const dataset = await this.repository.completeOrderSync({
        syncRunId,sourceSystem:WDT_SOURCE_SYSTEM,shopId,
        watermark:String(watermark),sourceDigest,
        recordCount:processed,historicalCompleteThrough,
        observedAt:recentObservedAt
      },input.lease);
      return {
        status:"succeeded",syncRunId,shopId,watermark:String(watermark),
        sourceDigest,processed,inserted:dataset.inserted,updated:dataset.updated,
        historicalCompleteThrough,dataset
      };
    } catch (error) {
      try {
        await this.repository.failOrderSync(
          syncRunId,controlledCauseCode(error),input.lease
        );
      } catch (cleanupError) {
        if (controlledCauseCode(cleanupError) === "SCHEDULER_LEASE_LOST") {
          throw cleanupError instanceof Error
            ? cleanupError
            : new Error("SCHEDULER_LEASE_LOST");
        }
        throw new SalesDemandPartialCommitError(
          { committedChunks,committedRows },
          controlledCauseCode(error)
        );
      }
      const causeCode = controlledCauseCode(error);
      throw new Error(
        causeCode === "WDT_ORDER_ROW_INVALID" ||
        causeCode === "WDT_SYNC_ROW_LIMIT_EXCEEDED" ||
        causeCode === "WDT_DATA_QUALITY_INVALID"
          ? "WDT_DATA_QUALITY_INVALID"
          : "WDT_SOURCE_UNAVAILABLE"
      );
    }
  }

  protected async readWdtPage(input: {
    shopName: string;
    cursor: number;
  }): Promise<WdtSourceRow[]> {
    const sourceNames = wdtShopNames(input.shopName);
    const [rows] = await this.pool.query<WdtSourceRow[]>(
      `SELECT
         id,shop_name AS source_shop_name,origin_sub_order_no AS child_order_id,
         JSON_UNQUOTE(JSON_EXTRACT(raw_detail_json,'$.api_goods_id')) AS product_id,
         merchant_code,
         JSON_UNQUOTE(JSON_EXTRACT(raw_detail_json,'$.spec_name')) AS specification,
         qty AS source_quantity,trade_time AS submitted_at,pay_time AS paid_at,
         ship_time AS shipped_at,
         JSON_UNQUOTE(JSON_EXTRACT(raw_detail_json,'$.refund_status')) AS refund_status,
         synced_at AS source_loaded_at,query_end_time
       FROM ods_wdt_stock_out_api_line
       WHERE id > ? AND platform_id='69' AND shop_name IN (?,?,?)
         AND pay_time >= DATE_SUB(CURRENT_DATE, INTERVAL 7 DAY)
         AND origin_sub_order_no IS NOT NULL AND origin_sub_order_no <> ''
         AND merchant_code IS NOT NULL AND merchant_code <> ''
         AND JSON_UNQUOTE(JSON_EXTRACT(raw_detail_json,'$.api_goods_id')) REGEXP '^[0-9]{5,30}$'
       ORDER BY id
       LIMIT ${PAGE_SIZE}`,
      [input.cursor,...sourceNames]
    );
    return rows;
  }

  protected async readWdtCoverage(shopName: string): Promise<WdtCoverageRow> {
    const sourceNames = wdtShopNames(shopName);
    const [rows] = await this.pool.query<WdtCoverageRow[]>(
      `SELECT MAX(query_end_time) AS query_end_time,MAX(synced_at) AS source_loaded_at
       FROM ods_wdt_stock_out_api_line
       WHERE platform_id='69' AND shop_name IN (?,?,?)
         AND query_end_time >= DATE_SUB(NOW(),INTERVAL 3 DAY)`,
      [...sourceNames]
    );
    return rows[0] ?? ({ query_end_time:null,source_loaded_at:null } as WdtCoverageRow);
  }
}

export function mysqlOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): MysqlSalesSourceOptions | undefined {
  const host = environment.BPA_MYSQL_HOST?.trim();
  const user = environment.BPA_MYSQL_USER?.trim();
  const password = environment.BPA_MYSQL_PASSWORD;
  const database = environment.BPA_MYSQL_DATABASE?.trim();
  if (!host || !user || password === undefined || !database) return undefined;
  const port = Number(environment.BPA_MYSQL_PORT ?? 3306);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BPA_MYSQL_PORT is invalid");
  }
  return { host,port,user,password,database };
}
