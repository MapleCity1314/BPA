import { randomUUID } from "node:crypto";
import { inTransaction, row } from "@bpa/app-postgres";
import {
  factDigest,
  INVENTORY_DATA_VALIDITY_MINUTES,
  INVENTORY_FACT_SCHEMA_VERSION,
  transitionIncident,
  type DemandForecast,
  type FactEnvelope,
  type IncidentProjection,
  type InventoryProductFact,
  type InventoryRiskEvaluation,
  type MappingConfidence,
  type RiskFinding
} from "@bpa/inventory-domain";
import type { Pool, PoolClient } from "pg";
import {
  buildOperationalReminders,
  buildStoreDemandBacktest,
  type CollectionControlHealth
} from "./dashboard-analytics.js";

const COLLECTION_STALE_MINUTES = 120;

export interface PersistableDoudianSnapshot {
  readonly snapshotVersion: string;
  readonly observedAt: string;
  readonly shop: { readonly id: string; readonly name: string };
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly totalStock: number;
  };
  readonly skus: readonly {
    readonly platformSkuId: string;
    readonly merchantCode: string;
    readonly currentStock: number;
    readonly occupiedStock: number;
    readonly unoccupiedStock: number;
    readonly channels: readonly {
      readonly channelGoodsId: string;
      readonly stock: number;
    }[];
  }[];
  readonly diagnostics?: readonly string[];
}

export interface PersistableRecentOrders {
  readonly observedAt: string;
  readonly shop: { readonly id: string; readonly name: string };
  readonly records: readonly {
    readonly childOrderId: string;
    readonly productId: string;
    readonly merchantCode: string;
    readonly specification: string;
    readonly quantity: number;
    readonly submittedAt: string;
    readonly paidAt?: string;
    readonly shippedAt?: string;
    readonly orderStatus: string;
    readonly aftersalesStatus: string;
  }[];
  readonly quality: { readonly completeness: number; readonly diagnostics?: readonly string[] };
}

export interface LeaseFence {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly fencingToken: number;
}

export interface NormalizedOrderLine {
  readonly shopId: string;
  readonly shopName: string;
  readonly childOrderId: string;
  readonly productId: string;
  readonly merchantCode: string;
  readonly specification: string;
  readonly submittedAt: string;
  readonly paidAt?: string;
  readonly shippedAt?: string;
  readonly orderStatus: string;
  readonly aftersalesStatus: string;
  readonly sourceQuantity: number;
  readonly demandQuantity: number;
  readonly sourceBatchId: number;
  readonly sourceRowHash: string;
  readonly sourceLoadedAt: string;
  readonly sourcePeriodEnd?: string;
}

export interface ForecastInputRecord {
  readonly platformSkuId: string;
  readonly merchantCode: string;
  readonly observations: readonly { at: string; quantity: number }[];
  readonly channelPoints: readonly {
    at: string;
    channelGoodsId: string;
    stock: number;
  }[];
  readonly sourceDataset: { id: string; version: string; digest: string };
  readonly demandQuality: {
    readonly recentObservedAt?: string;
    readonly historicalCompleteThrough?: string;
  };
  readonly fallbackHourlyRate?: number;
  readonly fallbackReason?: string;
}

function id(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

function snapshotDataset(snapshot: PersistableDoudianSnapshot) {
  const digest = factDigest(snapshot);
  return {
    id: `inventory-snapshot:${snapshot.shop.id}`,
    version: `${snapshot.observedAt}:${digest.slice(7, 19)}`,
    digest
  };
}

function envelope(snapshot: PersistableDoudianSnapshot): FactEnvelope<InventoryProductFact> {
  const dataset = snapshotDataset(snapshot);
  return {
    schemaVersion: INVENTORY_FACT_SCHEMA_VERSION,
    observedAt: snapshot.observedAt,
    asOf: snapshot.observedAt,
    scope: { shopId: snapshot.shop.id, productId: snapshot.product.id },
    facts: {
      productId: snapshot.product.id,
      title: snapshot.product.title,
      totalStock: snapshot.product.totalStock,
      skus: snapshot.skus.map((sku) => ({ ...sku, channels: [...sku.channels] }))
    },
    quality: {
      freshness: "fresh",
      completeness: 1,
      mappingConfidence: "high",
      diagnostics: snapshot.diagnostics ?? []
    },
    source: {
      kind: "doudian.inventory.product.snapshot.read",
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      digest: dataset.digest
    }
  };
}

export class InventoryRepository {
  constructor(readonly pool: Pool) {}

  async health(): Promise<{ databaseTime: string }> {
    const result = await this.pool.query<{ now: Date }>("SELECT now() AS now");
    return { databaseTime: row(result.rows, "database health").now.toISOString() };
  }

  async collectionControlHealth(): Promise<CollectionControlHealth> {
    const result = await this.pool.query<{
      active_collection_count: number;
      stale_collection_count: number;
      oldest_stale_started_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE status='running'
             AND started_at >= now()-($1::int * interval '1 minute')
         )::int AS active_collection_count,
         count(*) FILTER (
           WHERE status='running'
             AND started_at < now()-($1::int * interval '1 minute')
         )::int AS stale_collection_count,
         min(started_at) FILTER (
           WHERE status='running'
             AND started_at < now()-($1::int * interval '1 minute')
         ) AS oldest_stale_started_at
       FROM ops.collection_run`,
      [COLLECTION_STALE_MINUTES]
    );
    const health = row(result.rows,"collection control health");
    return {
      activeCollectionCount:health.active_collection_count,
      staleCollectionCount:health.stale_collection_count,
      oldestStaleStartedAt:health.oldest_stale_started_at?.toISOString() ?? null,
      staleAfterMinutes:COLLECTION_STALE_MINUTES
    };
  }

  async recordConfiguration(details: Record<string, unknown>): Promise<void> {
    const digest = factDigest(details);
    await this.pool.query(
      `INSERT INTO audit.change_event(event_id,actor_id,action,target_type,target_id,details)
       VALUES ($1,'inventory-monitor','inventory.configuration.observe','configuration',$2,$3)
       ON CONFLICT(event_id) DO NOTHING`,
      [`config:${digest.slice(7,39)}`,digest,JSON.stringify(details)]
    );
  }

  async recentOrderFreshness(shopId: string): Promise<{
    observedAt?: string;
    ageMinutes?: number;
    fresh: boolean;
  }> {
    const result = await this.pool.query<{ observed_at: Date; age_minutes: string }>(
      `SELECT observed_at,
              extract(epoch FROM (now()-observed_at))/60 AS age_minutes
       FROM dataset.version WHERE dataset_id=$1
       ORDER BY observed_at DESC LIMIT 1`,
      [`sales-demand-recent:${shopId}`]
    );
    const latest = result.rows[0];
    if (!latest) return { fresh:false };
    const ageMinutes = Math.max(0,Number(latest.age_minutes));
    return {
      observedAt:latest.observed_at.toISOString(),ageMinutes,
      fresh:ageMinutes <= 120
    };
  }

  async startCollectionRun(input: {
    collectionRunId:string;
    triggerKind:"manual"|"schedule"|"recovery";
    browserInstanceId:string;
    fencingToken:number;
    shopCount:number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops.collection_run(
        collection_run_id,trigger_kind,status,browser_instance_id,fencing_token,shop_count
      ) VALUES ($1,$2,'running',$3,$4,$5)`,
      [input.collectionRunId,input.triggerKind,input.browserInstanceId,input.fencingToken,input.shopCount]
    );
  }

  async recordCollectionStep(input: {
    collectionRunId:string;shopId:string;shopName:string;
    component:"canary"|"orders"|"inventory"|"risk";
    status:"running"|"succeeded"|"fresh_reused"|"partial"|"blocked"|"degraded"|"failed"|"skipped";
    attempted?:number;persisted?:number;failed?:number;coverage?:number;
    diagnostic?:string;details?:Record<string,unknown>;completed?:boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops.collection_step(
        collection_run_id,shop_id,shop_name,component,status,attempted,persisted,
        failed,coverage,diagnostic,details,completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12 THEN now() ELSE NULL END)
      ON CONFLICT(collection_run_id,shop_id,component) DO UPDATE SET
        status=EXCLUDED.status,attempted=EXCLUDED.attempted,persisted=EXCLUDED.persisted,
        failed=EXCLUDED.failed,coverage=EXCLUDED.coverage,diagnostic=EXCLUDED.diagnostic,
        details=EXCLUDED.details,completed_at=EXCLUDED.completed_at`,
      [input.collectionRunId,input.shopId,input.shopName,input.component,input.status,
       input.attempted ?? 0,input.persisted ?? 0,input.failed ?? 0,input.coverage ?? null,
       input.diagnostic ?? null,JSON.stringify(input.details ?? {}),input.completed ?? true]
    );
  }

  async updateCollectionProgress(input: {
    collectionRunId:string;
    completedShopCount:number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ops.collection_run
       SET completed_shop_count=$2
       WHERE collection_run_id=$1 AND status='running'`,
      [input.collectionRunId,input.completedShopCount]
    );
  }

  async completeCollectionRun(input: {
    collectionRunId:string;
    status:"succeeded"|"partial"|"blocked"|"degraded"|"failed"|"skipped";
    completedShopCount:number;
    summary:Record<string,unknown>;
    diagnostics:readonly string[];
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ops.collection_run SET status=$2,completed_shop_count=$3,summary=$4,
         diagnostics=$5,completed_at=now() WHERE collection_run_id=$1`,
      [input.collectionRunId,input.status,input.completedShopCount,
       JSON.stringify(input.summary),JSON.stringify(input.diagnostics)]
    );
  }

  async acquireLease(input: {
    leaseKey: string;
    holderId: string;
    ttlSeconds: number;
  }): Promise<number | undefined> {
    const result = await this.pool.query<{ fencing_token: string }>(
      `INSERT INTO ops.lease(lease_key,holder_id,fencing_token,acquired_at,expires_at)
       VALUES ($1,$2,1,now(),now()+make_interval(secs => $3))
       ON CONFLICT(lease_key) DO UPDATE SET
         holder_id=EXCLUDED.holder_id,
         fencing_token=ops.lease.fencing_token+1,
         acquired_at=EXCLUDED.acquired_at,
         expires_at=EXCLUDED.expires_at
       WHERE ops.lease.expires_at <= now()
       RETURNING fencing_token::text`,
      [input.leaseKey,input.holderId,input.ttlSeconds]
    );
    const token = result.rows[0]?.fencing_token;
    return token === undefined ? undefined : Number(token);
  }

  async assertLease(fence: LeaseFence): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM ops.lease
       WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at > now()`,
      [fence.leaseKey,fence.holderId,fence.fencingToken]
    );
    if (result.rowCount !== 1) throw new Error("SCHEDULER_LEASE_LOST");
  }

  async renewLease(input: {
    leaseKey: string;
    holderId: string;
    fencingToken: number;
    ttlSeconds: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ops.lease SET expires_at=now()+make_interval(secs => $4)
       WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at > now()`,
      [input.leaseKey,input.holderId,input.fencingToken,input.ttlSeconds]
    );
    return result.rowCount === 1;
  }

  async releaseLease(input: {
    leaseKey: string;
    holderId: string;
    fencingToken: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ops.lease SET expires_at=GREATEST(now(),acquired_at+interval '1 microsecond')
       WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3`,
      [input.leaseKey,input.holderId,input.fencingToken]
    );
  }

  async startScheduleRun(input: {
    scheduleRunId: string;
    leaseKey: string;
    holderId: string;
    fencingToken?: number;
    scheduledFor: string;
    status?: "running" | "skipped";
    diagnostic?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ops.schedule_run(
         schedule_run_id,lease_key,holder_id,fencing_token,scheduled_for,status,diagnostics,completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='skipped' THEN now() ELSE NULL END)
       ON CONFLICT(lease_key,scheduled_for) DO NOTHING
       RETURNING schedule_run_id`,
      [input.scheduleRunId,input.leaseKey,input.holderId,input.fencingToken ?? null,
       input.scheduledFor,input.status ?? "running",JSON.stringify(input.diagnostic ? [input.diagnostic] : [])]
    );
    return result.rowCount === 1;
  }

  async completeScheduleRun(input: {
    scheduleRunId: string;
    leaseKey: string;
    holderId: string;
    fencingToken: number;
    status: "succeeded" | "failed" | "degraded";
    workflowRunIds: readonly string[];
    diagnostics: readonly string[];
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ops.schedule_run SET status=$2,workflow_runs=$3,diagnostics=$4,completed_at=now()
       WHERE schedule_run_id=$1 AND lease_key=$5 AND holder_id=$6 AND fencing_token=$7
         AND EXISTS (
           SELECT 1 FROM ops.lease l
           WHERE l.lease_key=$5 AND l.holder_id=$6 AND l.fencing_token=$7
             AND l.expires_at > now()
         )`,
      [input.scheduleRunId,input.status,JSON.stringify(input.workflowRunIds),JSON.stringify(input.diagnostics),
       input.leaseKey,input.holderId,input.fencingToken]
    );
    return result.rowCount === 1;
  }

  async persistSnapshot(snapshot: PersistableDoudianSnapshot): Promise<{
    readonly snapshotId: string;
    readonly envelope: FactEnvelope<InventoryProductFact>;
  }> {
    const factEnvelope = envelope(snapshot);
    let snapshotId = `snapshot:${snapshot.shop.id}:${snapshot.product.id}:${factEnvelope.source.digest.slice(7, 23)}`;
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO dataset.version(
          dataset_id, data_version, source_kind, source_digest, observed_at,
          as_of, record_count, lineage
        ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7)
        ON CONFLICT(dataset_id, source_digest) DO NOTHING`,
        [
          factEnvelope.source.datasetId,
          factEnvelope.source.datasetVersion,
          factEnvelope.source.kind,
          factEnvelope.source.digest,
          snapshot.observedAt,
          snapshot.skus.length,
          JSON.stringify({ snapshotVersion: snapshot.snapshotVersion })
        ]
      );
      const persisted = await client.query<{ snapshot_id: string; source_digest: string }>(
        `INSERT INTO inventory.snapshot(
          snapshot_id,dataset_id,data_version,shop_id,shop_name,product_id,
          product_title,total_stock,observed_at,source_digest,completeness,
          mapping_confidence,diagnostics
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'high',$11)
        ON CONFLICT(shop_id,product_id,observed_at) DO UPDATE SET
          source_digest=inventory.snapshot.source_digest
        RETURNING snapshot_id,source_digest`,
        [
          snapshotId,
          factEnvelope.source.datasetId,
          factEnvelope.source.datasetVersion,
          snapshot.shop.id,
          snapshot.shop.name,
          snapshot.product.id,
          snapshot.product.title,
          snapshot.product.totalStock,
          snapshot.observedAt,
          factEnvelope.source.digest,
          JSON.stringify(snapshot.diagnostics ?? [])
        ]
      );
      const persistedSnapshot = row(persisted.rows,"persisted inventory snapshot");
      if (persistedSnapshot.source_digest !== factEnvelope.source.digest) {
        throw new Error("INVENTORY_SNAPSHOT_OBSERVED_AT_CONFLICT");
      }
      snapshotId = persistedSnapshot.snapshot_id;
      for (const sku of snapshot.skus) {
        await this.updateBinding(client, snapshot, sku, factEnvelope.source.digest);
        await client.query(
          `INSERT INTO inventory.snapshot_sku(
            snapshot_id,platform_sku_id,merchant_code,current_stock,
            occupied_stock,unoccupied_stock
          ) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT(snapshot_id,platform_sku_id) DO NOTHING`,
          [snapshotId, sku.platformSkuId, sku.merchantCode, sku.currentStock, sku.occupiedStock, sku.unoccupiedStock]
        );
        for (const channel of sku.channels) {
          await client.query(
            `INSERT INTO inventory.snapshot_channel(
              snapshot_id,platform_sku_id,channel_goods_id,stock
            ) VALUES ($1,$2,$3,$4)
            ON CONFLICT(snapshot_id,platform_sku_id,channel_goods_id) DO NOTHING`,
            [snapshotId, sku.platformSkuId, channel.channelGoodsId, channel.stock]
          );
        }
      }
    });
    return { snapshotId, envelope: factEnvelope };
  }

  async latestSnapshotFacts(
    shopId: string,
    observedAfter: string
  ): Promise<readonly {
    snapshotId: string;
    envelope: FactEnvelope<InventoryProductFact>;
  }[]> {
    const snapshots = await this.pool.query<{
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
    }>(
      `SELECT DISTINCT ON (product_id)
         snapshot_id,dataset_id,data_version,source_digest,product_id,product_title,
         total_stock,observed_at,completeness,mapping_confidence,diagnostics
       FROM inventory.snapshot
       WHERE shop_id=$1 AND observed_at >= $2::timestamptz
       ORDER BY product_id,observed_at DESC`,
      [shopId,observedAfter]
    );
    if (snapshots.rowCount === 0) return [];
    const snapshotIds = snapshots.rows.map((snapshot) => snapshot.snapshot_id);
    const skus = await this.pool.query<{
      snapshot_id: string;
      platform_sku_id: string;
      merchant_code: string;
      current_stock: number;
      occupied_stock: number;
      unoccupied_stock: number;
      channels: unknown;
    }>(
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
    const bySnapshot = new Map<string, typeof skus.rows>();
    for (const sku of skus.rows) {
      const values = bySnapshot.get(sku.snapshot_id) ?? [];
      values.push(sku);
      bySnapshot.set(sku.snapshot_id,values);
    }
    return snapshots.rows.map((snapshot) => {
      const observedAt = snapshot.observed_at.toISOString();
      return {
        snapshotId:snapshot.snapshot_id,
        envelope:{
          schemaVersion:INVENTORY_FACT_SCHEMA_VERSION,
          observedAt,
          asOf:observedAt,
          scope:{ shopId,productId:snapshot.product_id },
          facts:{
            productId:snapshot.product_id,
            title:snapshot.product_title,
            totalStock:snapshot.total_stock,
            skus:(bySnapshot.get(snapshot.snapshot_id) ?? []).map((sku) => ({
              platformSkuId:sku.platform_sku_id,
              merchantCode:sku.merchant_code,
              currentStock:sku.current_stock,
              occupiedStock:sku.occupied_stock,
              unoccupiedStock:sku.unoccupied_stock,
              channels:Array.isArray(sku.channels)
                ? sku.channels.flatMap((entry) => {
                    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
                    const channel = entry as Record<string,unknown>;
                    return typeof channel.channelGoodsId === "string" && Number.isSafeInteger(Number(channel.stock))
                      ? [{ channelGoodsId:channel.channelGoodsId,stock:Number(channel.stock) }]
                      : [];
                  })
                : []
            }))
          },
          quality:{
            freshness:"fresh",
            completeness:Number(snapshot.completeness),
            mappingConfidence:snapshot.mapping_confidence,
            diagnostics:Array.isArray(snapshot.diagnostics)
              ? snapshot.diagnostics.map(String)
              : []
          },
          source:{
            kind:"doudian.inventory.product.snapshot.read",
            datasetId:snapshot.dataset_id,
            datasetVersion:snapshot.data_version,
            digest:snapshot.source_digest
          }
        }
      };
    });
  }

  private async updateBinding(
    client: PoolClient,
    snapshot: PersistableDoudianSnapshot,
    sku: PersistableDoudianSnapshot["skus"][number],
    sourceDigest: string
  ): Promise<void> {
    const active = await client.query<{ binding_id: string; merchant_code: string }>(
      `SELECT binding_id,merchant_code FROM inventory.sku_binding
       WHERE shop_id=$1 AND product_id=$2 AND platform_sku_id=$3 AND valid_to IS NULL
       FOR UPDATE`,
      [snapshot.shop.id, snapshot.product.id, sku.platformSkuId]
    );
    const current = active.rows[0];
    if (current?.merchant_code === sku.merchantCode) {
      await client.query(
        "UPDATE inventory.sku_binding SET last_seen_at=$1,source_digest=$2 WHERE binding_id=$3",
        [snapshot.observedAt, sourceDigest, current.binding_id]
      );
      return;
    }
    if (current) {
      await client.query(
        "UPDATE inventory.sku_binding SET valid_to=$1,last_seen_at=$1 WHERE binding_id=$2",
        [snapshot.observedAt, current.binding_id]
      );
    }
    await client.query(
      `INSERT INTO inventory.sku_binding(
        binding_id,shop_id,product_id,platform_sku_id,merchant_code,valid_from,
        first_seen_at,last_seen_at,source_digest
      ) VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7)`,
      [id("binding"), snapshot.shop.id, snapshot.product.id, sku.platformSkuId, sku.merchantCode, snapshot.observedAt, sourceDigest]
    );
  }

  async persistOrders(input: {
    readonly syncRunId: string;
    readonly sourceSystem: string;
    readonly shopId: string;
    readonly watermark: string;
    readonly sourceDigest: string;
    readonly rows: readonly NormalizedOrderLine[];
  }): Promise<{ inserted: number; updated: number; datasetId: string; dataVersion: string }> {
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO source.sync_run(sync_run_id,source_system,shop_id,status,started_at,source_watermark)
         VALUES ($1,$2,$3,'running',now(),$4)`,
        [input.syncRunId, input.sourceSystem, input.shopId, input.watermark]
      );
      let inserted = 0;
      let updated = 0;
      for (const item of input.rows) {
        const sourceItemKey = factDigest([
          item.shopId,
          item.childOrderId,
          item.productId,
          item.merchantCode
        ]);
        const result = await client.query<{ inserted: boolean }>(
          `INSERT INTO source.order_line_fact(
            source_item_key,shop_id,shop_name,child_order_id,product_id,
            merchant_code,specification,submitted_at,paid_at,shipped_at,
            order_status,aftersales_status,source_quantity,demand_quantity,
            source_batch_id,source_row_hash,source_loaded_at,source_period_end
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT(source_item_key) DO UPDATE SET
            specification=EXCLUDED.specification,
            paid_at=EXCLUDED.paid_at,
            shipped_at=EXCLUDED.shipped_at,
            order_status=EXCLUDED.order_status,
            aftersales_status=EXCLUDED.aftersales_status,
            source_quantity=EXCLUDED.source_quantity,
            demand_quantity=EXCLUDED.demand_quantity,
            source_batch_id=EXCLUDED.source_batch_id,
            source_row_hash=EXCLUDED.source_row_hash,
            source_loaded_at=EXCLUDED.source_loaded_at,
            source_period_end=EXCLUDED.source_period_end,
            updated_at=now()
          WHERE source.order_line_fact.source_loaded_at <= EXCLUDED.source_loaded_at
          RETURNING (xmax = 0) AS inserted`,
          [
            sourceItemKey,item.shopId,item.shopName,item.childOrderId,item.productId,
            item.merchantCode,item.specification,item.submittedAt,item.paidAt ?? null,
            item.shippedAt ?? null,item.orderStatus,item.aftersalesStatus,
            item.sourceQuantity,item.demandQuantity,item.sourceBatchId,
            item.sourceRowHash,item.sourceLoadedAt,item.sourcePeriodEnd ?? null
          ]
        );
        if (result.rows[0]?.inserted) inserted += 1;
        else if (result.rowCount) updated += 1;
      }
      const datasetId = `sales-demand:${input.shopId}`;
      const dataVersion = `${input.watermark}:${input.sourceDigest.slice(7, 19)}`;
      await client.query(
        `INSERT INTO dataset.version(
          dataset_id,data_version,source_kind,source_digest,observed_at,as_of,
          record_count,lineage
        ) VALUES ($1,$2,$3,$4,now(),now(),$5,$6)
        ON CONFLICT(dataset_id,source_digest) DO NOTHING`,
        [datasetId,dataVersion,input.sourceSystem,input.sourceDigest,input.rows.length,JSON.stringify({ watermark: input.watermark })]
      );
      await client.query(
        `INSERT INTO source.watermark(source_system,shop_id,dataset_type,watermark,source_digest,updated_at)
         VALUES ($1,$2,'orders',$3,$4,now())
         ON CONFLICT(source_system,shop_id,dataset_type) DO UPDATE SET
           watermark=EXCLUDED.watermark,source_digest=EXCLUDED.source_digest,updated_at=EXCLUDED.updated_at`,
        [input.sourceSystem,input.shopId,input.watermark,input.sourceDigest]
      );
      await client.query(
        `UPDATE source.sync_run SET status='succeeded',completed_at=now(),inserted_count=$2,updated_count=$3
         WHERE sync_run_id=$1`,
        [input.syncRunId,inserted,updated]
      );
      return { inserted, updated, datasetId, dataVersion };
    });
  }

  async beginOrderSync(input: {
    syncRunId: string;
    sourceSystem: string;
    shopId: string;
    sourceWatermark?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO source.sync_run(
        sync_run_id,source_system,shop_id,status,started_at,source_watermark
      ) VALUES ($1,$2,$3,'running',now(),$4)
      ON CONFLICT(sync_run_id) DO NOTHING`,
      [input.syncRunId,input.sourceSystem,input.shopId,input.sourceWatermark ?? null]
    );
  }

  async upsertOrderChunk(rows: readonly NormalizedOrderLine[]): Promise<{
    inserted: number;
    updated: number;
  }> {
    const deduplicated = new Map<string, NormalizedOrderLine>();
    for (const item of rows) {
      const sourceItemKey = factDigest([
        item.shopId,item.childOrderId,item.productId,item.merchantCode
      ]);
      const current = deduplicated.get(sourceItemKey);
      if (
        !current ||
        item.sourceLoadedAt > current.sourceLoadedAt ||
        (
          item.sourceLoadedAt === current.sourceLoadedAt &&
          item.sourceBatchId > current.sourceBatchId
        )
      ) {
        deduplicated.set(sourceItemKey,item);
      }
    }
    if (deduplicated.size === 0) return { inserted:0,updated:0 };
    const payload = [...deduplicated].map(([sourceItemKey,item]) => ({
      source_item_key:sourceItemKey,
      shop_id:item.shopId,
      shop_name:item.shopName,
      child_order_id:item.childOrderId,
      product_id:item.productId,
      merchant_code:item.merchantCode,
      specification:item.specification,
      submitted_at:item.submittedAt,
      paid_at:item.paidAt ?? null,
      shipped_at:item.shippedAt ?? null,
      order_status:item.orderStatus,
      aftersales_status:item.aftersalesStatus,
      source_quantity:item.sourceQuantity,
      demand_quantity:item.demandQuantity,
      source_batch_id:item.sourceBatchId,
      source_row_hash:item.sourceRowHash,
      source_loaded_at:item.sourceLoadedAt,
      source_period_end:item.sourcePeriodEnd ?? null
    }));
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{ inserted: string; updated: string }>(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
             source_item_key text,shop_id text,shop_name text,child_order_id text,
             product_id text,merchant_code text,specification text,
             submitted_at timestamptz,paid_at timestamptz,shipped_at timestamptz,
             order_status text,aftersales_status text,source_quantity integer,
             demand_quantity integer,source_batch_id bigint,source_row_hash text,
             source_loaded_at timestamptz,source_period_end timestamptz
           )
         ), changed AS (
           INSERT INTO source.order_line_fact(
            source_item_key,shop_id,shop_name,child_order_id,product_id,
            merchant_code,specification,submitted_at,paid_at,shipped_at,
            order_status,aftersales_status,source_quantity,demand_quantity,
            source_batch_id,source_row_hash,source_loaded_at,source_period_end
           ) SELECT
             source_item_key,shop_id,shop_name,child_order_id,product_id,
             merchant_code,specification,submitted_at,paid_at,shipped_at,
             order_status,aftersales_status,source_quantity,demand_quantity,
             source_batch_id,source_row_hash,source_loaded_at,source_period_end
           FROM incoming
          ON CONFLICT(source_item_key) DO UPDATE SET
            specification=EXCLUDED.specification,paid_at=EXCLUDED.paid_at,
            shipped_at=EXCLUDED.shipped_at,order_status=EXCLUDED.order_status,
            aftersales_status=EXCLUDED.aftersales_status,
            source_quantity=EXCLUDED.source_quantity,demand_quantity=EXCLUDED.demand_quantity,
            source_batch_id=EXCLUDED.source_batch_id,source_row_hash=EXCLUDED.source_row_hash,
            source_loaded_at=EXCLUDED.source_loaded_at,source_period_end=EXCLUDED.source_period_end,updated_at=now()
          WHERE source.order_line_fact.source_loaded_at <= EXCLUDED.source_loaded_at
          RETURNING (xmax = 0) AS was_inserted
         ) SELECT
           count(*) FILTER (WHERE was_inserted)::text AS inserted,
           count(*) FILTER (WHERE NOT was_inserted)::text AS updated
         FROM changed`,
        [JSON.stringify(payload)]
      );
      const counts = row(result.rows,"order chunk upsert counts");
      return { inserted:Number(counts.inserted),updated:Number(counts.updated) };
    });
  }

  async completeOrderSync(input: {
    syncRunId: string;
    sourceSystem: string;
    shopId: string;
    watermark: string;
    sourceDigest: string;
    inserted: number;
    updated: number;
    recordCount: number;
    historicalCompleteThrough: string;
  }): Promise<{ datasetId: string; dataVersion: string }> {
    return inTransaction(this.pool, async (client) => {
      const datasetId = `sales-demand:${input.shopId}`;
      const dataVersion = `${input.watermark}:${input.sourceDigest.slice(7, 19)}`;
      await client.query(
        `INSERT INTO dataset.version(
          dataset_id,data_version,source_kind,source_digest,observed_at,as_of,
          record_count,lineage
        ) VALUES ($1,$2,$3,$4,now(),$5,$6,$7)
        ON CONFLICT(dataset_id,source_digest) DO NOTHING`,
        [datasetId,dataVersion,input.sourceSystem,input.sourceDigest,input.historicalCompleteThrough,input.recordCount,
         JSON.stringify({ watermark: input.watermark, syncRunId: input.syncRunId })]
      );
      await client.query(
        `INSERT INTO source.watermark(source_system,shop_id,dataset_type,watermark,source_digest,updated_at)
         VALUES ($1,$2,'orders',$3,$4,now())
         ON CONFLICT(source_system,shop_id,dataset_type) DO UPDATE SET
           watermark=EXCLUDED.watermark,source_digest=EXCLUDED.source_digest,updated_at=EXCLUDED.updated_at`,
        [input.sourceSystem,input.shopId,input.watermark,input.sourceDigest]
      );
      await client.query(
        `UPDATE source.sync_run SET status='succeeded',completed_at=now(),
           inserted_count=$2,updated_count=$3,source_watermark=$4
         WHERE sync_run_id=$1`,
        [input.syncRunId,input.inserted,input.updated,input.watermark]
      );
      return { datasetId,dataVersion };
    });
  }

  async completeNoChangeOrderSync(syncRunId: string): Promise<void> {
    await this.pool.query(
      `UPDATE source.sync_run SET status='succeeded',completed_at=now(),
         inserted_count=0,updated_count=0,diagnostics='["No newer source batch was available."]'::jsonb
       WHERE sync_run_id=$1`,
      [syncRunId]
    );
  }

  async persistRecentOrders(input: PersistableRecentOrders): Promise<{
    datasetId: string;
    dataVersion: string;
    inserted: number;
    updated: number;
  }> {
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime())) throw new Error("RECENT_ORDER_OBSERVED_AT_INVALID");
    const sourceBatchId = Math.floor(observedAt.getTime() / 1000);
    const merchantCodes = [...new Set(input.records.map((record) => record.merchantCode))];
    const bindings = merchantCodes.length ? await this.pool.query<{
      merchant_code: string;
      product_id: string;
    }>(
      `SELECT merchant_code,product_id FROM inventory.sku_binding
       WHERE shop_id=$1 AND merchant_code=ANY($2::text[]) AND valid_to IS NULL`,
      [input.shop.id,merchantCodes]
    ) : { rows: [] as { merchant_code: string; product_id: string }[] };
    const productsByMerchant = new Map<string,Set<string>>();
    for (const binding of bindings.rows) {
      const products = productsByMerchant.get(binding.merchant_code) ?? new Set<string>();
      products.add(binding.product_id);
      productsByMerchant.set(binding.merchant_code,products);
    }
    const rows: NormalizedOrderLine[] = input.records.flatMap((record) => {
      const mapped = productsByMerchant.get(record.merchantCode);
      const productId = mapped?.has(record.productId)
        ? record.productId
        : mapped?.size === 1 ? [...mapped][0] : undefined;
      if (!productId) return [];
      const cancelledBeforeShipment = /关闭|取消/u.test(record.orderStatus) && !record.shippedAt;
      return [{
        shopId:input.shop.id,shopName:input.shop.name,childOrderId:record.childOrderId,
        productId,merchantCode:record.merchantCode,
        specification:record.specification,submittedAt:record.submittedAt,
        ...(record.paidAt ? { paidAt:record.paidAt } : {}),
        ...(record.shippedAt ? { shippedAt:record.shippedAt } : {}),
        orderStatus:record.orderStatus,aftersalesStatus:record.aftersalesStatus,
        sourceQuantity:record.quantity,
        demandQuantity:record.paidAt && !cancelledBeforeShipment ? record.quantity : 0,
        sourceBatchId,sourceRowHash:factDigest(record),sourceLoadedAt:input.observedAt
      }];
    });
    const changes = await this.upsertOrderChunk(rows);
    const sourceDigest = factDigest({ shop:input.shop,observedAt:input.observedAt,records:input.records });
    const datasetId = `sales-demand-recent:${input.shop.id}`;
    const dataVersion = `${input.observedAt}:${sourceDigest.slice(7,19)}`;
    await this.pool.query(
      `INSERT INTO dataset.version(
        dataset_id,data_version,source_kind,source_digest,observed_at,as_of,
        record_count,lineage
       ) VALUES ($1,$2,'doudian.orders.recent.read',$3,$4,$4,$5,$6)
       ON CONFLICT(dataset_id,source_digest) DO NOTHING`,
      [datasetId,dataVersion,sourceDigest,input.observedAt,input.records.length,
       JSON.stringify({ completeness:input.quality.completeness,diagnostics:input.quality.diagnostics ?? [] })]
    );
    return { datasetId,dataVersion,...changes };
  }

  async failOrderSync(syncRunId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE source.sync_run SET status='failed',completed_at=now(),diagnostics=$2
       WHERE sync_run_id=$1`,
      [syncRunId,JSON.stringify([message.slice(0, 1000)])]
    );
  }

  async currentWatermark(sourceSystem: string, shopId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ watermark: string }>(
      "SELECT watermark FROM source.watermark WHERE source_system=$1 AND shop_id=$2 AND dataset_type='orders'",
      [sourceSystem, shopId]
    );
    return result.rows[0]?.watermark;
  }

  async forecastInputs(input: {
    readonly shopId: string;
    readonly productId: string;
    readonly asOf: string;
  }): Promise<readonly ForecastInputRecord[]> {
    const bindings = await this.pool.query<{ platform_sku_id: string; merchant_code: string }>(
      `SELECT platform_sku_id,merchant_code FROM inventory.sku_binding
       WHERE shop_id=$1 AND product_id=$2 AND valid_to IS NULL
       ORDER BY platform_sku_id`,
      [input.shopId,input.productId]
    );
    const datasetResult = await this.pool.query<{ dataset_id: string; data_version: string; source_digest: string; as_of: Date }>(
      `SELECT dataset_id,data_version,source_digest,as_of FROM dataset.version
       WHERE dataset_id=$1 AND as_of <= $2 ORDER BY as_of DESC LIMIT 1`,
      [`sales-demand:${input.shopId}`,input.asOf]
    );
    const recentResult = await this.pool.query<{ observed_at: Date }>(
      `SELECT observed_at FROM dataset.version
       WHERE dataset_id=$1 AND observed_at <= $2 ORDER BY observed_at DESC LIMIT 1`,
      [`sales-demand-recent:${input.shopId}`,input.asOf]
    );
    const dataset = datasetResult.rows[0] ?? {
      dataset_id:`sales-demand:${input.shopId}`,data_version:"unavailable",
      source_digest:factDigest({ shopId:input.shopId,kind:"sales-demand-unavailable" }),
      as_of:new Date(0)
    };
    const productFallback = await this.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(demand_quantity),0)::text AS quantity
       FROM source.order_line_fact WHERE shop_id=$1 AND product_id=$2
         AND paid_at > $3::timestamptz-interval '28 days' AND paid_at <= $3 AND demand_quantity > 0`,
      [input.shopId,input.productId,input.asOf]
    );
    const storeFallback = await this.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(demand_quantity),0)::text AS quantity
       FROM source.order_line_fact WHERE shop_id=$1
         AND paid_at > $2::timestamptz-interval '28 days' AND paid_at <= $2 AND demand_quantity > 0`,
      [input.shopId,input.asOf]
    );
    const activeSkuCount = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory.sku_binding WHERE shop_id=$1 AND valid_to IS NULL`,
      [input.shopId]
    );
    const productRate = Number(productFallback.rows[0]?.quantity ?? 0)/(28*24*Math.max(1,bindings.rows.length));
    const storeRate = Number(storeFallback.rows[0]?.quantity ?? 0)/(28*24*Math.max(1,activeSkuCount.rows[0]?.count ?? 1));
    const records: ForecastInputRecord[] = [];
    for (const binding of bindings.rows) {
      const demand = await this.pool.query<{ at: Date; quantity: string }>(
        `SELECT date_trunc('hour',paid_at) AS at,sum(demand_quantity)::text AS quantity
         FROM source.order_line_fact
         WHERE shop_id=$1 AND product_id=$2 AND merchant_code=$3
           AND paid_at > $4::timestamptz - interval '90 days' AND paid_at <= $4
           AND demand_quantity > 0
         GROUP BY 1 ORDER BY 1`,
        [input.shopId,input.productId,binding.merchant_code,input.asOf]
      );
      const channels = await this.pool.query<{ at: Date; channel_goods_id: string; stock: number }>(
        `SELECT s.observed_at AS at,c.channel_goods_id,c.stock
         FROM inventory.snapshot_channel c
         JOIN inventory.snapshot s ON s.snapshot_id=c.snapshot_id
         WHERE s.shop_id=$1 AND s.product_id=$2 AND c.platform_sku_id=$3
           AND s.observed_at > $4::timestamptz - interval '3 days' AND s.observed_at <= $4
         ORDER BY s.observed_at,c.channel_goods_id`,
        [input.shopId,input.productId,binding.platform_sku_id,input.asOf]
      );
      records.push({
        platformSkuId: binding.platform_sku_id,
        merchantCode: binding.merchant_code,
        observations: demand.rows.map((entry) => ({ at: entry.at.toISOString(), quantity: Number(entry.quantity) })),
        channelPoints: channels.rows.map((entry) => ({ at: entry.at.toISOString(), channelGoodsId: entry.channel_goods_id, stock: entry.stock })),
        sourceDataset: { id: dataset.dataset_id, version: dataset.data_version, digest: dataset.source_digest },
        demandQuality: {
          ...(recentResult.rows[0]?.observed_at
            ? { recentObservedAt:recentResult.rows[0].observed_at.toISOString() }
            : {}),
          ...(datasetResult.rows[0]?.as_of
            ? { historicalCompleteThrough:datasetResult.rows[0].as_of.toISOString() }
            : {})
        },
        ...((productRate > 0 || storeRate > 0) ? {
          fallbackHourlyRate:productRate > 0 ? productRate : storeRate,
          fallbackReason:productRate > 0
            ? "Sparse SKU demand fell back to the same-product hourly baseline."
            : "Sparse SKU demand fell back to the shop-wide per-SKU hourly baseline."
        } : {})
      });
    }
    return records;
  }

  async persistForecast(input: {
    readonly shopId: string;
    readonly productId: string;
    readonly platformSkuId: string;
    readonly merchantCode: string;
    readonly sourceDataset: { id: string; version: string };
    readonly forecast: DemandForecast;
  }): Promise<string> {
    const forecastId = `forecast:${factDigest(input).slice(7, 39)}`;
    await this.pool.query(
      `INSERT INTO inventory.demand_forecast(
        forecast_id,shop_id,product_id,platform_sku_id,merchant_code,as_of,
        algorithm_version,source_dataset_id,source_data_version,selected_model,
        confidence,daily_p50,daily_p90,horizons,diagnostics
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(shop_id,product_id,platform_sku_id,as_of,algorithm_version) DO NOTHING`,
      [forecastId,input.shopId,input.productId,input.platformSkuId,input.merchantCode,input.forecast.asOf,
       input.forecast.algorithmVersion,input.sourceDataset.id,input.sourceDataset.version,input.forecast.selectedModel,
       input.forecast.confidence,input.forecast.dailyP50,input.forecast.dailyP90,
       JSON.stringify(input.forecast.horizons),JSON.stringify(input.forecast.diagnostics)]
    );
    return forecastId;
  }

  async persistRisk(input: {
    readonly snapshotId: string;
    readonly shopId: string;
    readonly productId: string;
    readonly evaluation: InventoryRiskEvaluation;
  }): Promise<{ evaluationId: string; incidentsUpdated: number }> {
    const sourceDigest = factDigest(input);
    const evaluationId = `evaluation:${sourceDigest.slice(7, 39)}`;
    let incidentsUpdated = 0;
    await inTransaction(this.pool, async (client) => {
      const insertedEvaluation = await client.query(
        `INSERT INTO inventory.risk_evaluation(
          evaluation_id,shop_id,product_id,snapshot_id,policy_version,evaluated_at,
          severity,findings,diagnostics,source_digest
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(shop_id,product_id,snapshot_id,policy_version) DO NOTHING
        RETURNING evaluation_id`,
        [evaluationId,input.shopId,input.productId,input.snapshotId,input.evaluation.policyVersion,
         input.evaluation.evaluatedAt,input.evaluation.severity,JSON.stringify(input.evaluation.findings),
         JSON.stringify(input.evaluation.diagnostics),sourceDigest]
      );
      if (insertedEvaluation.rowCount !== 1) return;
      for (const finding of input.evaluation.findings) {
        if (await this.persistIncident(client,evaluationId,input.evaluation.policyVersion,input.evaluation.evaluatedAt,finding)) {
          incidentsUpdated += 1;
        }
      }
    });
    return { evaluationId, incidentsUpdated };
  }

  private async persistIncident(
    client: PoolClient,
    evaluationId: string,
    policyVersion: string,
    at: string,
    finding: RiskFinding
  ): Promise<boolean> {
    const scopeKey = factDigest({ scope: finding.scope, kind: finding.kind });
    const result = await client.query<{
      incident_id: string; state: IncidentProjection["state"];
      severity: IncidentProjection["severity"]; warning_streak: number;
      healthy_streak: number; revision: number;
    }>(
      `SELECT incident_id,state,severity,warning_streak,healthy_streak,revision
       FROM ops.incident WHERE scope_key=$1 AND policy_version=$2 FOR UPDATE`,
      [scopeKey,policyVersion]
    );
    const prior = result.rows[0];
    // Normal and unknown findings remain available on risk_evaluation. They do
    // not need a new ops incident unless one already exists and must be closed.
    if (!prior && (finding.severity === "normal" || finding.severity === "unknown")) return false;
    const next = transitionIncident(prior ? {
      state: prior.state,severity: prior.severity,warningStreak: prior.warning_streak,
      healthyStreak: prior.healthy_streak,revision: prior.revision
    } : undefined, finding.severity);
    const incidentId = prior?.incident_id ?? id("incident");
    await client.query(
      `INSERT INTO ops.incident(
        incident_id,scope_key,policy_version,state,severity,warning_streak,
        healthy_streak,revision,opened_at,resolved_at,first_seen_at,last_seen_at,
        latest_evaluation_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)
      ON CONFLICT(scope_key,policy_version) DO UPDATE SET
        state=EXCLUDED.state,severity=EXCLUDED.severity,
        warning_streak=EXCLUDED.warning_streak,healthy_streak=EXCLUDED.healthy_streak,
        revision=EXCLUDED.revision,
        opened_at=COALESCE(ops.incident.opened_at,EXCLUDED.opened_at),
        resolved_at=EXCLUDED.resolved_at,last_seen_at=EXCLUDED.last_seen_at,
        latest_evaluation_id=EXCLUDED.latest_evaluation_id`,
      [incidentId,scopeKey,policyVersion,next.state,next.severity,next.warningStreak,
       next.healthyStreak,next.revision,next.state === "open" ? at : null,
       next.state === "resolved" ? at : null,at,evaluationId]
    );
    await client.query(
      `INSERT INTO ops.incident_transition(
        transition_id,incident_id,from_state,to_state,from_severity,to_severity,
        evaluation_id,occurred_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(incident_id,evaluation_id) DO NOTHING`,
      [id("transition"),incidentId,prior?.state ?? null,next.state,prior?.severity ?? null,next.severity,evaluationId,at]
    );
    return true;
  }

  async overview(shopId: string): Promise<Record<string, unknown>> {
    const health = await this.health();
    const freshness = await this.pool.query<{
      latest_inventory_at: Date | null;
      latest_order_at: Date | null;
      historical_complete_through: Date | null;
      product_count: number;
      fresh_product_count: number;
      sku_count: number;
    }>(
      `SELECT
        (SELECT max(observed_at) FROM inventory.snapshot WHERE shop_id=$1) AS latest_inventory_at,
        (SELECT max(observed_at) FROM dataset.version
          WHERE dataset_id='sales-demand-recent:' || $1) AS latest_order_at,
        (SELECT max(source_period_end) FROM source.order_line_fact WHERE shop_id=$1) AS historical_complete_through,
        (SELECT count(DISTINCT product_id)::int FROM inventory.snapshot WHERE shop_id=$1) AS product_count,
        (SELECT count(DISTINCT product_id)::int FROM inventory.snapshot
          WHERE shop_id=$1
            AND observed_at >= now()-make_interval(mins => $2)) AS fresh_product_count,
        (SELECT count(*)::int FROM inventory.sku_binding WHERE shop_id=$1 AND valid_to IS NULL) AS sku_count`,
      [shopId,INVENTORY_DATA_VALIDITY_MINUTES]
    );
    const incidents = await this.pool.query(
      `WITH latest_product_evaluation AS (
         SELECT DISTINCT ON (product_id) evaluation_id,product_id
         FROM inventory.risk_evaluation
         WHERE shop_id=$1
         ORDER BY product_id,evaluated_at DESC,evaluation_id DESC
       ), ranked AS (
         SELECT i.incident_id,i.state,i.severity,i.first_seen_at,i.last_seen_at,
                r.product_id,r.findings,r.policy_version,r.evaluated_at,r.diagnostics,
                s.snapshot_id,s.product_title,s.observed_at AS snapshot_observed_at,
                s.dataset_id,s.data_version,s.source_digest,
                row_number() OVER (
                  PARTITION BY CASE
                    WHEN i.severity='unknown' THEN r.product_id
                    ELSE i.incident_id
                  END
                  ORDER BY i.last_seen_at DESC
                ) AS ui_rank
         FROM ops.incident i JOIN inventory.risk_evaluation r
           ON r.evaluation_id=i.latest_evaluation_id
         JOIN latest_product_evaluation latest
           ON latest.evaluation_id=r.evaluation_id
         JOIN inventory.snapshot s ON s.snapshot_id=r.snapshot_id
         WHERE r.shop_id=$1
           AND i.severity IN ('critical','warning')
       )
       SELECT incident_id,state,severity,first_seen_at,last_seen_at,product_id,
              findings,policy_version,evaluated_at,diagnostics,snapshot_id,
              product_title,snapshot_observed_at,dataset_id,data_version,source_digest
       FROM ranked WHERE ui_rank=1 ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END,
         last_seen_at DESC LIMIT 200`,
      [shopId]
    );
    const products = await this.pool.query(
      `SELECT DISTINCT ON (s.product_id)
        s.snapshot_id,s.dataset_id,s.data_version,s.source_digest,s.product_id,s.product_title,
        s.total_stock,s.observed_at,s.mapping_confidence,s.completeness,s.diagnostics,
        (SELECT count(*)::int FROM inventory.snapshot_sku ss WHERE ss.snapshot_id=s.snapshot_id) AS sku_count
       FROM inventory.snapshot s WHERE s.shop_id=$1
       ORDER BY s.product_id,s.observed_at DESC LIMIT 1000`,
      [shopId]
    );
    const snapshotIds = products.rows.map((product) => String(product.snapshot_id));
    const skus = snapshotIds.length ? await this.pool.query(
      `SELECT ss.snapshot_id,ss.platform_sku_id,ss.merchant_code,ss.current_stock,
              ss.occupied_stock,ss.unoccupied_stock,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'channelGoodsId',c.channel_goods_id,'stock',c.stock
              ) ORDER BY c.channel_goods_id) FROM inventory.snapshot_channel c
                WHERE c.snapshot_id=ss.snapshot_id AND c.platform_sku_id=ss.platform_sku_id),'[]'::jsonb) AS channels
       FROM inventory.snapshot_sku ss WHERE ss.snapshot_id=ANY($1::text[])
       ORDER BY ss.snapshot_id,ss.platform_sku_id`,
      [snapshotIds]
    ) : { rows: [] as Record<string, unknown>[] };
    const forecasts = await this.pool.query(
      `SELECT DISTINCT ON (product_id,platform_sku_id)
        product_id,platform_sku_id,merchant_code,as_of,algorithm_version,
        source_dataset_id,source_data_version,selected_model,confidence,
        daily_p50,daily_p90,horizons,diagnostics
       FROM inventory.demand_forecast WHERE shop_id=$1
       ORDER BY product_id,platform_sku_id,as_of DESC`,
      [shopId]
    );
    const skusBySnapshot = new Map<string, Record<string, unknown>[]>();
    for (const sku of skus.rows as Record<string, unknown>[]) {
      const key = String(sku.snapshot_id);
      const values = skusBySnapshot.get(key) ?? [];
      values.push(sku);
      skusBySnapshot.set(key,values);
    }
    const forecastByScope = new Map(
      (forecasts.rows as Record<string, unknown>[]).map((forecast) => [
        `${String(forecast.product_id)}:${String(forecast.platform_sku_id)}`,forecast
      ])
    );
    const detailedProducts = (products.rows as Record<string, unknown>[]).map((product) => ({
      ...product,
      skus: (skusBySnapshot.get(String(product.snapshot_id)) ?? []).map((sku) => ({
        ...sku,
        forecast: forecastByScope.get(`${String(product.product_id)}:${String(sku.platform_sku_id)}`) ?? null
      }))
    }));
    const schedules = await this.pool.query(
      `SELECT cr.collection_run_id AS schedule_run_id,
              cr.started_at AS scheduled_for,
              CASE
                WHEN bool_or(cs.status='blocked') THEN 'blocked'
                WHEN bool_or(cs.status='failed') THEN 'failed'
                WHEN bool_or(cs.status='partial') THEN 'partial'
                WHEN bool_or(cs.status='degraded') THEN 'degraded'
                WHEN bool_or(cs.status='running') THEN 'running'
                ELSE 'succeeded'
              END AS status,
              '[]'::jsonb AS workflow_runs,
              COALESCE(jsonb_agg(to_jsonb(cs.diagnostic) ORDER BY cs.component)
                FILTER (WHERE cs.diagnostic IS NOT NULL),'[]'::jsonb) AS diagnostics,
              cr.started_at,cr.completed_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'component',cs.component,'status',cs.status,'coverage',cs.coverage,
                'attempted',cs.attempted,'persisted',cs.persisted,'failed',cs.failed
              ) ORDER BY cs.component) FILTER (WHERE cs.component IS NOT NULL),'[]'::jsonb) AS components
       FROM ops.collection_run cr
       LEFT JOIN ops.collection_step cs
         ON cs.collection_run_id=cr.collection_run_id AND cs.shop_id=$1
       WHERE EXISTS (
         SELECT 1 FROM ops.collection_step selected
         WHERE selected.collection_run_id=cr.collection_run_id AND selected.shop_id=$1
       )
       GROUP BY cr.collection_run_id,cr.started_at,cr.completed_at
       ORDER BY cr.started_at DESC LIMIT 48`,
      [shopId]
    );
    const feishuReport = await this.pool.query<{ target_id: string; occurred_at: Date }>(
      `SELECT target_id,occurred_at FROM audit.change_event
       WHERE action='inventory.feishu.report.sent'
         AND (details->>'shopId'=$1 OR (details->'shopIds') ? $1)
       ORDER BY occurred_at DESC LIMIT 1`,
      [shopId]
    );
    const dailyDemand = await this.pool.query<{ date: string; actual: number }>(
      `WITH bounds AS (
         SELECT date_trunc('day',max(paid_at)) AS end_day
         FROM source.order_line_fact
         WHERE shop_id=$1 AND paid_at IS NOT NULL AND demand_quantity > 0
       ), days AS (
         SELECT generate_series(end_day-interval '89 days',end_day,interval '1 day') AS day
         FROM bounds WHERE end_day IS NOT NULL
       ), demand AS (
         SELECT date_trunc('day',paid_at) AS day,sum(demand_quantity)::int AS actual
         FROM source.order_line_fact,bounds
         WHERE shop_id=$1 AND paid_at >= bounds.end_day-interval '89 days'
           AND paid_at < bounds.end_day+interval '1 day' AND demand_quantity > 0
         GROUP BY date_trunc('day',paid_at)
       )
       SELECT to_char(days.day,'YYYY-MM-DD') AS date,COALESCE(demand.actual,0)::int AS actual
       FROM days LEFT JOIN demand USING(day) ORDER BY days.day`,
      [shopId]
    );
    const coldStart = await this.pool.query<{
      direct_model: number;
      hierarchical_fallback: number;
      store_baseline: number;
      total_order_skus: number;
    }>(
      `WITH history AS (
         SELECT product_id,merchant_code,count(DISTINCT paid_at::date)::int AS active_days
         FROM source.order_line_fact
         WHERE shop_id=$1 AND paid_at IS NOT NULL AND demand_quantity > 0
         GROUP BY product_id,merchant_code
       )
       SELECT
         count(*) FILTER (WHERE active_days >= 14)::int AS direct_model,
         count(*) FILTER (WHERE active_days BETWEEN 3 AND 13)::int AS hierarchical_fallback,
         count(*) FILTER (WHERE active_days < 3)::int AS store_baseline,
         count(*)::int AS total_order_skus
       FROM history`,
      [shopId]
    );
    const state = row(freshness.rows, "inventory overview");
    const generatedAt = new Date().toISOString();
    const backtest = buildStoreDemandBacktest(dailyDemand.rows);
    const coldStartState = row(coldStart.rows,"inventory cold-start overview");
    const activeCollectionCutoff = Date.parse(generatedAt) - COLLECTION_STALE_MINUTES * 60_000;
    const collectionActive = schedules.rows.some((schedule) => {
      if (schedule.status !== "running") return false;
      const startedAt = schedule.started_at instanceof Date
        ? schedule.started_at.getTime()
        : Date.parse(String(schedule.started_at));
      return Number.isFinite(startedAt) && startedAt >= activeCollectionCutoff;
    });
    const reminders = buildOperationalReminders({
      now:generatedAt,
      latestInventoryAt:state.latest_inventory_at?.toISOString() ?? null,
      latestOrderAt:state.latest_order_at?.toISOString() ?? null,
      productCount:state.product_count,
      freshProductCount:state.fresh_product_count,
      scheduleCount:schedules.rows.length,
      collectionActive,
      incidents:incidents.rows as Record<string, unknown>[],
      backtest
    });
    return {
      generatedAt,
      databaseTime: health.databaseTime,
      shopId,
      freshness: {
        latestInventoryAt: state.latest_inventory_at?.toISOString() ?? null,
        latestOrderAt: state.latest_order_at?.toISOString() ?? null,
        historicalCompleteThrough: state.historical_complete_through?.toISOString() ?? null
      },
      counts: {
        products: state.product_count,
        freshProducts: state.fresh_product_count,
        skus: state.sku_count,
        incidents: incidents.rows.length
      },
      products: detailedProducts,
      incidents: incidents.rows,
      schedules: schedules.rows,
      notifications: {
        feishu: {
          lastSentAt:feishuReport.rows[0]?.occurred_at.toISOString() ?? null,
          reportKey:feishuReport.rows[0]?.target_id ?? null
        }
      },
      reminders,
      backtest,
      coldStart: {
        directModel: coldStartState.direct_model,
        hierarchicalFallback: coldStartState.hierarchical_fallback,
        storeBaseline: coldStartState.store_baseline,
        totalOrderSkus: coldStartState.total_order_skus,
        inventoryMappedSkus: state.sku_count
      },
      rules: {
        policyVersion: "库存均衡策略 v1.0",
        skuChannelCritical: "P90 需求在 2 小时内耗尽",
        skuChannelWarning: "P90 需求在 6 小时内耗尽，且连续两个快照",
        reserveCritical: "未占用库存不能补足全部渠道未来 6 小时缺口",
        reserveWarning: "未占用库存不能补足全部渠道未来 24 小时缺口，且连续两个快照",
        legacyComparison: "库存 < 200（仅对照，不触发正式风险）"
      }
    };
  }

  async reviewIncident(input: {
    incidentId: string;
    decision: "valid" | "false_positive" | "needs_context";
    note: string;
    actorId: string;
  }): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const exists = await client.query("SELECT 1 FROM ops.incident WHERE incident_id=$1", [input.incidentId]);
      if (exists.rowCount !== 1) throw new Error("INCIDENT_NOT_FOUND");
      const reviewId = id("review");
      await client.query(
        "INSERT INTO ops.review(review_id,incident_id,decision,note,actor_id) VALUES ($1,$2,$3,$4,$5)",
        [reviewId,input.incidentId,input.decision,input.note,input.actorId]
      );
      await client.query(
        `INSERT INTO audit.change_event(event_id,actor_id,action,target_type,target_id,details)
         VALUES ($1,$2,'inventory.incident.review','incident',$3,$4)`,
        [id("audit"),input.actorId,input.incidentId,JSON.stringify({ reviewId, decision: input.decision })]
      );
    });
  }
}
