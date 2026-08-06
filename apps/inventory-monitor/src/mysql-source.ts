import { createHash, randomUUID } from "node:crypto";
import mysql, { type Pool as MysqlPool, type RowDataPacket } from "mysql2/promise";
import type { InventoryRepository, LeaseFence, NormalizedOrderLine } from "./repository.js";

const SOURCE_SYSTEM = "ecom-profit-mysql:doudian-manual-order";
const WDT_SOURCE_SYSTEM = "ecom-profit-mysql:wdt-stockout";
const PAGE_SIZE = 5_000;
const MAX_ROWS_PER_SYNC = 1_000_000;

export interface MysqlSalesSourceOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly manualSkipShopIds?: readonly string[];
}

interface SourceRow extends RowDataPacket {
  id: number;
  batch_id: number;
  shop_name: string;
  shop_id: string;
  row_hash: string;
  loaded_at: string;
  period_end: string;
  child_order_id: string | null;
  product_id: string | null;
  merchant_code: string | null;
  specification: string | null;
  source_quantity: string | number | null;
  submitted_at: string | null;
  paid_at: string | null;
  shipped_at: string | null;
  order_status: string | null;
  aftersales_status: string | null;
}

interface WdtSourceRow extends RowDataPacket {
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

interface WdtCoverageRow extends RowDataPacket {
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

function shanghaiPeriodEnd(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return undefined;
  const parsed = Date.parse(`${value.slice(0,10)}T23:59:59.999+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
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

function normalizeRow(row: SourceRow): NormalizedOrderLine {
  const submittedAt = optionalShanghaiTimestamp(row.submitted_at);
  if (!submittedAt) throw new Error("ORDER_SUBMITTED_AT_INVALID");
  const paidAt = optionalShanghaiTimestamp(row.paid_at);
  const shippedAt = optionalShanghaiTimestamp(row.shipped_at);
  const quantity = Number(row.source_quantity ?? 0);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error("ORDER_QUANTITY_INVALID");
  }
  const orderStatus = String(row.order_status ?? "").trim();
  const cancelledBeforeShipment = /关闭|取消/u.test(orderStatus) && !shippedAt;
  const sourcePeriodEnd = shanghaiPeriodEnd(row.period_end);
  return {
    shopId: required(String(row.shop_id), "shopId", 200),
    shopName: required(row.shop_name, "shopName", 200),
    childOrderId: required(row.child_order_id, "childOrderId", 100),
    productId: required(row.product_id, "productId", 100),
    merchantCode: required(row.merchant_code, "merchantCode", 200),
    specification: String(row.specification ?? "").trim().slice(0, 1_000),
    submittedAt,
    ...(paidAt ? { paidAt } : {}),
    ...(shippedAt ? { shippedAt } : {}),
    orderStatus,
    aftersalesStatus: String(row.aftersales_status ?? "").trim().slice(0, 200),
    sourceQuantity: quantity,
    demandQuantity: paidAt && !cancelledBeforeShipment ? quantity : 0,
    sourceBatchId: Number(row.batch_id),
    sourceRowHash: required(row.row_hash, "rowHash", 100),
    sourceLoadedAt: optionalShanghaiTimestamp(row.loaded_at) ?? new Date(0).toISOString(),
    ...(sourcePeriodEnd ? { sourcePeriodEnd } : {})
  };
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
    const manual = input.expectedShopId && this.options.manualSkipShopIds?.includes(input.expectedShopId)
      ? {
          status:"skipped",
          processed:0,
          diagnostic:"Historical manual-order backfill is isolated for this high-volume shop; recent WDT demand remains enabled."
        }
      : await this.syncManual(input);
    const wdt = await this.syncWdt(input);
    const primary = wdt.status === "succeeded" ? wdt : manual;
    return {
      status: wdt.status === "succeeded" || manual.status === "succeeded"
        ? "succeeded"
        : "no_changes",
      syncRunId:String(primary.syncRunId),
      processed:Number(manual.processed ?? 0) + Number(wdt.processed ?? 0),
      inserted:Number(manual.inserted ?? 0) + Number(wdt.inserted ?? 0),
      updated:Number(manual.updated ?? 0) + Number(wdt.updated ?? 0),
      watermark:primary.watermark ?? null,
      manual,
      wdt,
      dataset: wdt.dataset ?? manual.dataset ?? null
    };
  }

  private async syncManual(input: {
    readonly shopName: string;
    readonly expectedShopId?: string;
    readonly lease: LeaseFence;
  }): Promise<Record<string, unknown>> {
    const syncRunId = `sync:${randomUUID()}`;
    const current = await this.repository.currentWatermark(SOURCE_SYSTEM, input.expectedShopId ?? input.shopName);
    await this.repository.beginOrderSync({
      syncRunId,
      sourceSystem: SOURCE_SYSTEM,
      shopId: input.expectedShopId ?? input.shopName,
      ...(current ? { sourceWatermark: current } : {})
    });
    const digest = createHash("sha256");
    let cursor = 0;
    let watermark = current ? Number(current) : 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let actualShopId = input.expectedShopId;
    let historicalCompleteThrough = new Date(0).toISOString();
    try {
      while (true) {
        await this.repository.assertLease(input.lease);
        const rows = await this.readPage({
          shopName: input.shopName,
          cursor,
          ...(current ? { minimumBatchId: Number(current) + 1 } : {})
        });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]!.id;
        const normalized: NormalizedOrderLine[] = [];
        for (const source of rows) {
          if (input.expectedShopId && String(source.shop_id) !== input.expectedShopId) {
            throw new Error("MYSQL_SHOP_IDENTITY_MISMATCH");
          }
          actualShopId ??= String(source.shop_id);
          const item = normalizeRow(source);
          normalized.push(item);
          watermark = Math.max(watermark, item.sourceBatchId);
          if (item.sourcePeriodEnd && item.sourcePeriodEnd > historicalCompleteThrough) {
            historicalCompleteThrough = item.sourcePeriodEnd;
          }
          digest.update(`${source.id}:${source.batch_id}:${source.row_hash}\n`);
        }
        const changes = await this.repository.upsertOrderChunk(normalized);
        inserted += changes.inserted;
        updated += changes.updated;
        processed += normalized.length;
        if (processed > MAX_ROWS_PER_SYNC) throw new Error("MYSQL_SYNC_ROW_LIMIT_EXCEEDED");
        if (rows.length < PAGE_SIZE) break;
      }
      if (processed === 0) {
        await this.repository.completeNoChangeOrderSync(syncRunId);
        return { status: "no_changes", syncRunId, watermark: current ?? null, processed: 0 };
      }
      const shopId = required(actualShopId, "actualShopId", 200);
      const sourceDigest = `sha256:${digest.digest("hex")}`;
      const dataset = await this.repository.completeOrderSync({
        syncRunId,
        sourceSystem: SOURCE_SYSTEM,
        shopId,
        watermark: String(watermark),
        sourceDigest,
        inserted,
        updated,
        recordCount: processed,
        historicalCompleteThrough
      });
      return {
        status: "succeeded",
        syncRunId,
        shopId,
        watermark: String(watermark),
        sourceDigest,
        processed,
        inserted,
        updated,
        dataset
      };
    } catch (error) {
      await this.repository.failOrderSync(
        syncRunId,
        error instanceof Error ? error.message : String(error)
      ).catch(() => undefined);
      throw error;
    }
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
    });
    const digest = createHash("sha256");
    let cursor = current ? Number(current) : 0;
    let watermark = cursor;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let historicalCompleteThrough = new Date(0).toISOString();
    try {
      const coverage = await this.readWdtCoverage();
      const recentObservedAt = optionalShanghaiTimestamp(coverage.query_end_time);
      const coverageCompleteThrough = completeDayBefore(coverage.query_end_time);
      if (coverageCompleteThrough) historicalCompleteThrough = coverageCompleteThrough;
      digest.update(JSON.stringify({
        queryEnd:coverage.query_end_time,sourceLoadedAt:coverage.source_loaded_at
      }));
      while (true) {
        await this.repository.assertLease(input.lease);
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
        const changes = await this.repository.upsertOrderChunk(normalized);
        inserted += changes.inserted;
        updated += changes.updated;
        processed += normalized.length;
        if (processed > MAX_ROWS_PER_SYNC) throw new Error("WDT_SYNC_ROW_LIMIT_EXCEEDED");
        if (rows.length < PAGE_SIZE) break;
      }
      if (processed === 0 && (!recentObservedAt || !coverageCompleteThrough)) {
        await this.repository.completeNoChangeOrderSync(syncRunId);
        return { status:"no_changes",syncRunId,watermark:current ?? null,processed:0 };
      }
      const sourceDigest = `sha256:${digest.digest("hex")}`;
      const dataset = await this.repository.completeOrderSync({
        syncRunId,sourceSystem:WDT_SOURCE_SYSTEM,shopId,
        watermark:String(watermark),sourceDigest,inserted,updated,
        recordCount:processed,historicalCompleteThrough
      });
      if (recentObservedAt) {
        await this.repository.persistRecentOrders({
          observedAt:recentObservedAt,shop:{ id:shopId,name:input.shopName },records:[],
          quality:{ completeness:1,diagnostics:[
            "Recent demand window coverage was verified from the WDT stockout API mirror."
          ] }
        });
      }
      return {
        status:"succeeded",syncRunId,shopId,watermark:String(watermark),
        sourceDigest,processed,inserted,updated,historicalCompleteThrough,dataset
      };
    } catch (error) {
      await this.repository.failOrderSync(
        syncRunId,error instanceof Error ? error.message : String(error)
      ).catch(() => undefined);
      throw error;
    }
  }

  private async readPage(input: {
    shopName: string;
    cursor: number;
    minimumBatchId?: number;
  }): Promise<SourceRow[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT
         id,batch_id,shop_name,shop_id,row_hash,loaded_at,period_end,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."子订单编号"')) AS child_order_id,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."商品ID"')) AS product_id,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."商家编码"')) AS merchant_code,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."商品规格"')) AS specification,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."商品数量"')) AS source_quantity,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."订单提交时间"')) AS submitted_at,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."支付完成时间"')) AS paid_at,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."发货时间"')) AS shipped_at,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."订单状态"')) AS order_status,
         JSON_UNQUOTE(JSON_EXTRACT(row_json,'$."售后状态"')) AS aftersales_status
       FROM stg_doudian_manual_order_raw
       WHERE id > ? AND shop_name = ?
         AND dataset_type IN ('order','orders')
         AND platform IN ('抖音','douyin')
         AND (? IS NOT NULL AND batch_id >= ? OR ? IS NULL AND period_end >= DATE_SUB(CURRENT_DATE, INTERVAL 90 DAY))
       ORDER BY id
       LIMIT ${PAGE_SIZE}`,
      [
        input.cursor,
        input.shopName,
        input.minimumBatchId ?? null,
        input.minimumBatchId ?? null,
        input.minimumBatchId ?? null
      ]
    );
    return rows;
  }

  private async readWdtPage(input: {
    shopName: string;
    cursor: number;
  }): Promise<WdtSourceRow[]> {
    const sourceNames = [input.shopName,`抖音-${input.shopName}`,`抖音-享乐东${input.shopName}`];
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

  private async readWdtCoverage(): Promise<WdtCoverageRow> {
    const [rows] = await this.pool.query<WdtCoverageRow[]>(
      `SELECT MAX(query_end_time) AS query_end_time,MAX(synced_at) AS source_loaded_at
       FROM ods_wdt_stock_out_api_line
       WHERE platform_id='69' AND query_end_time >= DATE_SUB(NOW(),INTERVAL 3 DAY)`
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
  const manualSkipShopIds = (environment.BPA_MYSQL_MANUAL_SKIP_SHOP_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (manualSkipShopIds.some((value) => !/^[0-9A-Za-z:_-]{1,200}$/u.test(value))) {
    throw new Error("BPA_MYSQL_MANUAL_SKIP_SHOP_IDS is invalid");
  }
  return {
    host,port,user,password,database,
    ...(manualSkipShopIds.length > 0 ? { manualSkipShopIds } : {})
  };
}
