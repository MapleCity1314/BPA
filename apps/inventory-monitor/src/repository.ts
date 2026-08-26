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

export interface LeaseFence {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly fencingToken: number;
}

export type InventoryEffectOperation =
  | "sales-demand.sync"
  | "inventory.snapshot.persist"
  | "inventory.shop.forecast-risk.refresh";

export interface InventoryEffectIdentity {
  readonly effectId: string;
  readonly inputDigest: string;
  readonly identityDigest:string;
  readonly runId:string;
  readonly invocationId:string;
  readonly idempotencyKey:string;
  readonly leaseRequestId:string;
}

export interface InventoryEffectReceipt extends InventoryEffectIdentity {
  readonly operation: InventoryEffectOperation;
  readonly status: "running" | "succeeded" | "failed";
  readonly progress: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface InventoryEffectSummary {
  readonly effectId:string;
  readonly operation:InventoryEffectOperation;
  readonly inputDigest:string;
  readonly identityDigest:string;
  readonly runId:string;
  readonly leaseRequestId:string;
  readonly status:"running"|"succeeded"|"failed";
  readonly progressCounts:Readonly<Record<string,number>>;
  readonly itemCounts:{ readonly succeeded:number;readonly failed:number };
  readonly resultDigest:string|null;
  readonly errorCode:string|null;
  readonly updatedAt:string;
  readonly completedAt:string|null;
}

export interface InventoryEffectPage {
  readonly status:"empty"|"available";
  readonly items:readonly InventoryEffectSummary[];
  readonly nextCursor:{
    readonly operation:InventoryEffectOperation;
    readonly effectId:string;
  }|null;
  readonly totalCount:number;
  readonly reportDigest:string;
}

export interface InventoryEffectReconciliationResult {
  readonly effectId: string;
  readonly operation: InventoryEffectOperation;
  readonly status: "succeeded" | "failed";
  readonly classification:
    | "already_terminal"
    | "abandoned_staging"
    | "not_committed"
    | "confirmed_partial";
}

interface ForecastEffectItemRow {
  readonly status:"succeeded"|"failed";
  readonly counts:Record<string,unknown>;
}

function aggregateForecastEffectItems(rows:readonly ForecastEffectItemRow[]) {
  const number = (counts:Record<string,unknown>,key:string) => {
    const value = Number(counts[key]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("INVENTORY_EFFECT_ITEM_COUNTS_INVALID");
    }
    return value;
  };
  const aggregate = {
    completedProducts:0,failedProducts:0,
    forecastAttempted:0,forecastPersisted:0,
    riskAttempted:0,riskPersisted:0,
    severities:{ normal:0,warning:0,critical:0,unknown:0 }
  };
  for (const item of rows) {
    const completed = number(item.counts,"completedProducts");
    const failed = number(item.counts,"failedProducts");
    const forecastAttempted = number(item.counts,"forecastAttempted");
    const forecastPersisted = number(item.counts,"forecastPersisted");
    const riskAttempted = number(item.counts,"riskAttempted");
    const riskPersisted = number(item.counts,"riskPersisted");
    const severity = item.counts.severity;
    if ((item.status === "succeeded" &&
      (completed !== 1 || failed !== 0 || riskAttempted !== 1 ||
        riskPersisted !== 1 || typeof severity !== "string")) ||
      (item.status === "failed" &&
      (completed !== 0 || failed !== 1 || forecastPersisted !== 0 ||
        riskAttempted > 1 || riskPersisted !== 0 || severity !== null)) ||
      forecastPersisted > forecastAttempted) {
      throw new Error("INVENTORY_EFFECT_ITEM_COUNTS_INVALID");
    }
    aggregate.completedProducts += completed;
    aggregate.failedProducts += failed;
    aggregate.forecastAttempted += forecastAttempted;
    aggregate.forecastPersisted += forecastPersisted;
    aggregate.riskAttempted += riskAttempted;
    aggregate.riskPersisted += riskPersisted;
    if (typeof severity === "string" && severity in aggregate.severities) {
      aggregate.severities[severity as keyof typeof aggregate.severities] += 1;
    } else if (severity !== null) {
      throw new Error("INVENTORY_EFFECT_ITEM_COUNTS_INVALID");
    }
  }
  return aggregate;
}

export interface DomainLeaseGrant extends LeaseFence {
  readonly serverNow: string;
  readonly expiresAt: string;
  readonly active: boolean;
}

export interface DomainLeaseStatus extends DomainLeaseGrant {
  readonly acquiredAt: string;
}

export interface NormalizedOrderLine {
  readonly sourceSystem: string;
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
      `SELECT completed_at AS observed_at,
              extract(epoch FROM (now()-completed_at))/60 AS age_minutes
       FROM source.sync_run
       WHERE source_system='ecom-profit-mysql:wdt-stockout'
         AND shop_id=$1 AND status='succeeded' AND completed_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM dataset.version
           WHERE dataset_id='sales-demand-staged:' || $1
             AND source_kind='ecom-profit-mysql:wdt-stockout'
             AND lineage->>'publicationProtocol'='staged-v1'
         )
       ORDER BY completed_at DESC,sync_run_id DESC LIMIT 1`,
      [shopId]
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

  async acquireDomainLease(input: {
    leaseKey: string;
    requestId: string;
    holderId: string;
    ttlSeconds: number;
  }): Promise<DomainLeaseGrant> {
    return inTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [input.leaseKey]
      );
      const priorRequest = await client.query<{
        holder_id: string;
        fencing_token: string;
        expires_at: Date;
      }>(
        `SELECT r.holder_id,r.fencing_token::text,r.expires_at
         FROM ops.lease_acquisition_request r
         WHERE r.lease_key=$1 AND r.request_id=$2
         FOR UPDATE`,
        [input.leaseKey,input.requestId]
      );
      const prior = priorRequest.rows[0];
      const currentResult = await client.query<{
        holder_id: string;
        fencing_token: string;
        expires_at: Date;
        server_now: Date;
      }>(
        `SELECT holder_id,fencing_token::text,expires_at,clock_timestamp() AS server_now
         FROM ops.lease WHERE lease_key=$1 FOR UPDATE`,
        [input.leaseKey]
      );
      const current = currentResult.rows[0];
      if (prior) {
        if (prior.holder_id !== input.holderId) {
          throw new Error("DOMAIN_LEASE_REQUEST_CONFLICT");
        }
        if (!current) throw new Error("DOMAIN_LEASE_STATE_INVALID");
        return {
          leaseKey:input.leaseKey,
          holderId:prior.holder_id,
          fencingToken:Number(prior.fencing_token),
          serverNow:current.server_now.toISOString(),
          expiresAt:prior.expires_at.toISOString(),
          active:
            current?.holder_id === prior.holder_id &&
            Number(current?.fencing_token) === Number(prior.fencing_token) &&
            current.expires_at.getTime() > current.server_now.getTime()
        };
      }
      if (current && current.expires_at.getTime() > current.server_now.getTime()) {
        throw new Error("DOMAIN_LEASE_BUSY");
      }
      const lease = await client.query<{
        holder_id: string;
        fencing_token: string;
        server_now: Date;
        expires_at: Date;
      }>(
        `INSERT INTO ops.lease(lease_key,holder_id,fencing_token,acquired_at,expires_at)
         VALUES (
           $1,$2,1,clock_timestamp(),
           clock_timestamp()+make_interval(secs => $3)
         )
         ON CONFLICT(lease_key) DO UPDATE SET
           holder_id=EXCLUDED.holder_id,
           fencing_token=ops.lease.fencing_token+1,
           acquired_at=clock_timestamp(),
           expires_at=clock_timestamp()+make_interval(secs => $3)
         WHERE ops.lease.expires_at <= clock_timestamp()
         RETURNING holder_id,fencing_token::text,acquired_at AS server_now,expires_at`,
        [input.leaseKey,input.holderId,input.ttlSeconds]
      );
      const granted = lease.rows[0];
      if (!granted) throw new Error("DOMAIN_LEASE_BUSY");
      const fencingToken = Number(granted.fencing_token);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
        throw new Error("DOMAIN_LEASE_TOKEN_INVALID");
      }
      await client.query(
        `INSERT INTO ops.lease_acquisition_request(
           lease_key,request_id,holder_id,fencing_token,acquired_at,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.leaseKey,input.requestId,input.holderId,fencingToken,granted.server_now,granted.expires_at]
      );
      return {
        leaseKey:input.leaseKey,
        holderId:granted.holder_id,
        fencingToken:Number(granted.fencing_token),
        serverNow:granted.server_now.toISOString(),
        expiresAt:granted.expires_at.toISOString(),
        active:true
      };
    });
  }

  async renewDomainLease(input: LeaseFence & { ttlSeconds: number }): Promise<DomainLeaseGrant> {
    return inTransaction(this.pool, async (client) => {
      const locked = await client.query<{
        holder_id: string;
        fencing_token: string;
        expires_at: Date;
        server_now: Date;
      }>(
        `SELECT holder_id,fencing_token::text,expires_at,clock_timestamp() AS server_now
         FROM ops.lease WHERE lease_key=$1 FOR UPDATE`,
        [input.leaseKey]
      );
      const current = locked.rows[0];
      if (
        !current || current.holder_id !== input.holderId ||
        Number(current.fencing_token) !== input.fencingToken ||
        current.expires_at.getTime() <= current.server_now.getTime()
      ) {
        throw new Error("DOMAIN_LEASE_LOST");
      }
      const renewed = await client.query<{ expires_at: Date }>(
        `UPDATE ops.lease
         SET expires_at=$4::timestamptz+make_interval(secs => $5)
         WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3
         RETURNING expires_at`,
        [input.leaseKey,input.holderId,input.fencingToken,current.server_now,input.ttlSeconds]
      );
      return {
        leaseKey:input.leaseKey,
        holderId:input.holderId,
        fencingToken:input.fencingToken,
        serverNow:current.server_now.toISOString(),
        expiresAt:row(renewed.rows,"renewed domain lease").expires_at.toISOString(),
        active:true
      };
    });
  }

  async releaseDomainLease(input: LeaseFence): Promise<DomainLeaseGrant> {
    return inTransaction(this.pool, async (client) => {
      const locked = await client.query<{
        holder_id: string;
        fencing_token: string;
        acquired_at: Date;
        expires_at: Date;
        server_now: Date;
      }>(
        `SELECT holder_id,fencing_token::text,acquired_at,expires_at,
                clock_timestamp() AS server_now
         FROM ops.lease WHERE lease_key=$1 FOR UPDATE`,
        [input.leaseKey]
      );
      const current = locked.rows[0];
      if (
        !current || current.holder_id !== input.holderId ||
        Number(current.fencing_token) !== input.fencingToken
      ) {
        throw new Error("DOMAIN_LEASE_LOST");
      }
      const released = await client.query<{ expires_at: Date }>(
        `UPDATE ops.lease
         SET expires_at=GREATEST($4::timestamptz,acquired_at+interval '1 microsecond')
         WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3
         RETURNING expires_at`,
        [input.leaseKey,input.holderId,input.fencingToken,current.server_now]
      );
      return {
        leaseKey:input.leaseKey,
        holderId:input.holderId,
        fencingToken:input.fencingToken,
        serverNow:current.server_now.toISOString(),
        expiresAt:row(released.rows,"released domain lease").expires_at.toISOString(),
        active:false
      };
    });
  }

  async readDomainLease(leaseKey: string): Promise<DomainLeaseStatus | undefined> {
    const result = await this.pool.query<{
      holder_id: string;
      fencing_token: string;
      acquired_at: Date;
      expires_at: Date;
      server_now: Date;
      active: boolean;
    }>(
      `WITH clock AS (SELECT clock_timestamp() AS server_now)
       SELECT holder_id,fencing_token::text,acquired_at,expires_at,
              clock.server_now,expires_at > clock.server_now AS active
       FROM ops.lease CROSS JOIN clock WHERE lease_key=$1`,
      [leaseKey]
    );
    const current = result.rows[0];
    return current ? {
      leaseKey,
      holderId:current.holder_id,
      fencingToken:Number(current.fencing_token),
      acquiredAt:current.acquired_at.toISOString(),
      serverNow:current.server_now.toISOString(),
      expiresAt:current.expires_at.toISOString(),
      active:current.active
    } : undefined;
  }

  async assertLease(fence: LeaseFence): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM ops.lease
       WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3 AND expires_at > now()`,
      [fence.leaseKey,fence.holderId,fence.fencingToken]
    );
    if (result.rowCount !== 1) throw new Error("SCHEDULER_LEASE_LOST");
  }

  private async assertLeaseForUpdate(client: PoolClient, fence: LeaseFence): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM ops.lease
       WHERE lease_key=$1 AND holder_id=$2 AND fencing_token=$3
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [fence.leaseKey,fence.holderId,fence.fencingToken]
    );
    if (result.rowCount !== 1) throw new Error("SCHEDULER_LEASE_LOST");
  }

  private async lockInventoryEffect(
    client: PoolClient,
    effect: InventoryEffectIdentity,
    operation: InventoryEffectOperation,
    fence:LeaseFence,
    requireRunning = true
  ): Promise<InventoryEffectReceipt> {
    const result = await client.query<{
      effect_id:string;operation:InventoryEffectOperation;input_digest:string;
      identity_digest:string;run_id:string;invocation_id:string;
      idempotency_key:string;lease_request_id:string;
      lease_key:string;holder_id:string;fencing_token:string;
      status:"running"|"succeeded"|"failed";progress:Record<string,unknown>;
      result:Record<string,unknown>|null;error_code:string|null;
      updated_at:Date;completed_at:Date|null;
    }>(
      `SELECT effect_id,operation,input_digest,identity_digest,run_id,invocation_id,
              idempotency_key,lease_request_id,lease_key,holder_id,fencing_token::text,
              status,progress,result,error_code,
              updated_at,completed_at
       FROM ops.inventory_effect WHERE effect_id=$1 FOR UPDATE`,
      [effect.effectId]
    );
    const current = row(result.rows,"inventory effect");
    if (current.operation !== operation || current.input_digest !== effect.inputDigest ||
      current.identity_digest !== effect.identityDigest || current.run_id !== effect.runId ||
      current.invocation_id !== effect.invocationId ||
      current.idempotency_key !== effect.idempotencyKey ||
      current.lease_request_id !== effect.leaseRequestId ||
      current.lease_key !== fence.leaseKey || current.holder_id !== fence.holderId ||
      Number(current.fencing_token) !== fence.fencingToken) {
      throw new Error("INVENTORY_EFFECT_ID_CONFLICT");
    }
    if (requireRunning && current.status !== "running") {
      throw new Error("INVENTORY_EFFECT_STATE_CONFLICT");
    }
    return {
      effectId:current.effect_id,operation:current.operation,
      inputDigest:current.input_digest,identityDigest:current.identity_digest,
      runId:current.run_id,invocationId:current.invocation_id,
      idempotencyKey:current.idempotency_key,leaseRequestId:current.lease_request_id,
      status:current.status,
      progress:current.progress,result:current.result,errorCode:current.error_code,
      updatedAt:current.updated_at.toISOString(),
      completedAt:current.completed_at?.toISOString() ?? null
    };
  }

  private async claimInventoryEffect(
    client: PoolClient,
    effect: InventoryEffectIdentity,
    operation: InventoryEffectOperation,
    progress: Record<string,unknown>,
    fence:LeaseFence
  ): Promise<InventoryEffectReceipt | undefined> {
    const acquisition = await client.query(
      `SELECT 1 FROM ops.lease_acquisition_request
       WHERE lease_key=$1 AND request_id=$2 AND holder_id=$3 AND fencing_token=$4`,
      [fence.leaseKey,effect.leaseRequestId,fence.holderId,fence.fencingToken]
    );
    if (acquisition.rowCount !== 1) throw new Error("INVENTORY_EFFECT_LEASE_IDENTITY_INVALID");
    const inserted = await client.query(
      `INSERT INTO ops.inventory_effect(
         effect_id,operation,input_digest,identity_digest,run_id,invocation_id,
         idempotency_key,lease_request_id,lease_key,holder_id,fencing_token,status,progress
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',$12)
       ON CONFLICT(effect_id) DO NOTHING`,
      [effect.effectId,operation,effect.inputDigest,effect.identityDigest,effect.runId,
       effect.invocationId,effect.idempotencyKey,effect.leaseRequestId,
       fence.leaseKey,fence.holderId,fence.fencingToken,JSON.stringify(progress)]
    );
    if (inserted.rowCount === 1) return undefined;
    const current = await this.lockInventoryEffect(client,effect,operation,fence,false);
    if (current.status === "running") throw new Error("INVENTORY_EFFECT_IN_PROGRESS");
    if (current.status === "failed") throw new Error(current.errorCode ?? "INVENTORY_EFFECT_PREVIOUSLY_FAILED");
    return current;
  }

  private async updateInventoryEffect(
    client:PoolClient,
    effect:InventoryEffectIdentity,
    operation:InventoryEffectOperation,
    input:{
      readonly status?:"succeeded"|"failed";
      readonly progress:Record<string,unknown>;
      readonly result?:Record<string,unknown>;
      readonly errorCode?:string;
    }
  ):Promise<void> {
    const status = input.status ?? "running";
    const updated = await client.query(
      `UPDATE ops.inventory_effect SET status=$4,progress=$5,result=$6,error_code=$7,
         updated_at=clock_timestamp(),completed_at=CASE WHEN $4='running' THEN NULL ELSE clock_timestamp() END
       WHERE effect_id=$1 AND operation=$2 AND input_digest=$3 AND status='running'`,
      [effect.effectId,operation,effect.inputDigest,status,JSON.stringify(input.progress),
       input.result === undefined ? null : JSON.stringify(input.result),input.errorCode ?? null]
    );
    if (updated.rowCount !== 1) throw new Error("INVENTORY_EFFECT_STATE_CONFLICT");
  }

  private async insertInventoryEffectItem(
    client:PoolClient,
    input:{
      effectId:string;itemKey:string;inputDigest:string;
      status:"succeeded"|"failed";resultDigest:string;
      counts:Record<string,unknown>;
    }
  ):Promise<void> {
    const inserted = await client.query(
      `INSERT INTO ops.inventory_effect_item(
         effect_id,item_key,input_digest,status,result_digest,counts
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(effect_id,item_key) DO NOTHING`,
      [input.effectId,input.itemKey,input.inputDigest,input.status,
       input.resultDigest,JSON.stringify(input.counts)]
    );
    if (inserted.rowCount === 1) return;
    const existing = await client.query<{
      input_digest:string;status:string;result_digest:string;counts:Record<string,unknown>;
    }>(
      `SELECT input_digest,status,result_digest,counts
       FROM ops.inventory_effect_item WHERE effect_id=$1 AND item_key=$2`,
      [input.effectId,input.itemKey]
    );
    const current = row(existing.rows,"inventory effect item");
    if (current.input_digest !== input.inputDigest || current.status !== input.status ||
      current.result_digest !== input.resultDigest ||
      factDigest(current.counts) !== factDigest(input.counts)) {
      throw new Error("INVENTORY_EFFECT_ITEM_CONFLICT");
    }
  }

  async beginInventoryEffect(
    effect:InventoryEffectIdentity,
    operation:InventoryEffectOperation,
    progress:Record<string,unknown>,
    fence:LeaseFence
  ):Promise<Record<string,unknown> | undefined> {
    return inTransaction(this.pool,async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      return (await this.claimInventoryEffect(client,effect,operation,progress,fence))?.result ?? undefined;
    });
  }

  async recordInventoryEffectItem(
    effect:InventoryEffectIdentity,
    input:{
      readonly productId:string;readonly snapshotId:string;
      readonly status:"failed";
      readonly code:string;
      readonly forecastAttempted:number;
      readonly riskAttempted:number;
    },
    fence:LeaseFence
  ):Promise<void> {
    await inTransaction(this.pool,async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(
        client,effect,"inventory.shop.forecast-risk.refresh",fence
      );
      const inputDigest = factDigest([
        effect.inputDigest,input.productId,input.snapshotId
      ]);
      await this.insertInventoryEffectItem(client,{
        effectId:effect.effectId,itemKey:input.productId,inputDigest,
        status:"failed",resultDigest:factDigest({ code:input.code }),
        counts:{
          completedProducts:0,failedProducts:1,
          forecastAttempted:input.forecastAttempted,forecastPersisted:0,
          riskAttempted:input.riskAttempted,riskPersisted:0,
          severity:null
        }
      });
    });
  }

  async completeForecastRiskEffect(
    effect:InventoryEffectIdentity,
    result:Record<string,unknown>,
    fence:LeaseFence
  ):Promise<void> {
    await inTransaction(this.pool,async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      const currentEffect = await this.lockInventoryEffect(
        client,effect,"inventory.shop.forecast-risk.refresh",fence
      );
      const items = await client.query<ForecastEffectItemRow>(
        `SELECT status,counts FROM ops.inventory_effect_item
         WHERE effect_id=$1 ORDER BY item_key`,
        [effect.effectId]
      );
      const aggregate = aggregateForecastEffectItems(items.rows);
      const expectedProducts = Number(currentEffect.progress.attemptedProducts);
      const forecastWrites = result.forecastWrites as Record<string,unknown> | undefined;
      const riskWrites = result.riskWrites as Record<string,unknown> | undefined;
      const resultSeverities = result.severities as Record<string,unknown> | undefined;
      const severityTotal = Object.values(aggregate.severities).reduce((sum,value) => sum + value,0);
      if (!Number.isSafeInteger(expectedProducts) || expectedProducts < 0 ||
        items.rows.length !== expectedProducts ||
        Number(result.attemptedProducts) !== expectedProducts ||
        Number(result.completedProducts) !== aggregate.completedProducts ||
        Number(result.partialProducts) !== 0 ||
        Number(result.failedProducts) !== aggregate.failedProducts ||
        aggregate.completedProducts + aggregate.failedProducts !== expectedProducts ||
        aggregate.riskPersisted !== aggregate.completedProducts ||
        severityTotal !== aggregate.completedProducts ||
        !forecastWrites || !riskWrites || !resultSeverities ||
        Number(forecastWrites.attempted) !== aggregate.forecastAttempted ||
        Number(forecastWrites.persisted) !== aggregate.forecastPersisted ||
        Number(riskWrites.attempted) !== aggregate.riskAttempted ||
        Number(riskWrites.persisted) !== aggregate.riskPersisted ||
        Object.entries(aggregate.severities).some(
          ([key,value]) => Number(resultSeverities[key]) !== value
        ) ||
        result.status !== (aggregate.failedProducts === 0 ? "complete" : "partial")) {
        throw new Error("INVENTORY_EFFECT_SUMMARY_CONFLICT");
      }
      await this.updateInventoryEffect(
        client,effect,"inventory.shop.forecast-risk.refresh",{
          status:"succeeded",
          progress:{
            attemptedProducts:expectedProducts,
            completedProducts:aggregate.completedProducts,
            partialProducts:0,failedProducts:aggregate.failedProducts,
            forecastWrites:{
              attempted:aggregate.forecastAttempted,persisted:aggregate.forecastPersisted
            },
            riskWrites:{ attempted:aggregate.riskAttempted,persisted:aggregate.riskPersisted },
            severities:aggregate.severities
          },
          result
        }
      );
    });
  }

  async listInventoryEffectsForReconciliation(input:{
    readonly leaseRequestId:string;
    readonly lease:LeaseFence;
    readonly runId:string;
    readonly limit:100;
    readonly cursor?:{
      readonly operation:InventoryEffectOperation;
      readonly effectId:string;
    };
  }):Promise<InventoryEffectPage> {
    return inTransaction(this.pool,async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const acquisition = await client.query(
        `SELECT 1 FROM ops.lease_acquisition_request
         WHERE lease_key=$1 AND request_id=$2 AND holder_id=$3 AND fencing_token=$4`,
        [input.lease.leaseKey,input.leaseRequestId,input.lease.holderId,
         input.lease.fencingToken]
      );
      if (acquisition.rowCount !== 1) {
        throw new Error("INVENTORY_EFFECT_LEASE_IDENTITY_INVALID");
      }
      const lease = await client.query<{
        expires_at:Date;server_now:Date;
      }>(
        `SELECT expires_at,clock_timestamp() AS server_now
         FROM ops.lease WHERE lease_key=$1 FOR UPDATE`,
        [input.lease.leaseKey]
      );
      const currentLease = lease.rows[0];
      if (currentLease &&
        currentLease.expires_at.getTime() > currentLease.server_now.getTime()) {
        throw new Error("INVENTORY_EFFECT_ACTIVE_OWNER");
      }
      const effects = await client.query<{
        effect_id:string;operation:InventoryEffectOperation;input_digest:string;
        identity_digest:string;run_id:string;lease_request_id:string;
        lease_key:string;holder_id:string;fencing_token:string;
        status:"running"|"succeeded"|"failed";progress:Record<string,unknown>;
        result:Record<string,unknown>|null;error_code:string|null;
        updated_at:Date;completed_at:Date|null;
      }>(
        `SELECT effect_id,operation,input_digest,identity_digest,run_id,
                lease_request_id,lease_key,holder_id,fencing_token::text,
                status,progress,result,error_code,
                updated_at,completed_at
         FROM ops.inventory_effect
         WHERE lease_request_id=$1 AND run_id=$2 AND lease_key=$3
           AND holder_id=$4 AND fencing_token=$5
         ORDER BY operation,effect_id`,
        [input.leaseRequestId,input.runId,input.lease.leaseKey,
         input.lease.holderId,input.lease.fencingToken]
      );
      const itemCounts = await client.query<{
        effect_id:string;succeeded:number;failed:number;
      }>(
        `SELECT effect_id,
           count(*) FILTER(WHERE status='succeeded')::int AS succeeded,
           count(*) FILTER(WHERE status='failed')::int AS failed
         FROM ops.inventory_effect_item
         WHERE effect_id=ANY($1::text[])
         GROUP BY effect_id ORDER BY effect_id`,
        [effects.rows.map(({ effect_id }) => effect_id)]
      );
      const byEffect = new Map(itemCounts.rows.map((item) => [item.effect_id,item]));
      const countKeys = new Set([
        "stagedChunks","stagedRows","publishedRows","persistedSnapshots",
        "attemptedProducts","completedProducts","partialProducts","failedProducts"
      ]);
      const summaries:InventoryEffectSummary[] = effects.rows.map((current) => {
        const counts = byEffect.get(current.effect_id);
        return {
          effectId:current.effect_id,operation:current.operation,inputDigest:current.input_digest,
          identityDigest:current.identity_digest,runId:current.run_id,
          leaseRequestId:current.lease_request_id,
          status:current.status,
          progressCounts:Object.fromEntries(Object.entries(current.progress).flatMap(
            ([key,value]) => countKeys.has(key) && Number.isSafeInteger(value) && Number(value) >= 0
              ? [[key,Number(value)]]
              : []
          )),
          itemCounts:{ succeeded:counts?.succeeded ?? 0,failed:counts?.failed ?? 0 },
          resultDigest:current.result === null ? null : factDigest(current.result),
          errorCode:current.error_code,updatedAt:current.updated_at.toISOString(),
          completedAt:current.completed_at?.toISOString() ?? null
        };
      });
      let offset = 0;
      if (input.cursor) {
        const index = summaries.findIndex((summary) =>
          summary.operation === input.cursor!.operation &&
          summary.effectId === input.cursor!.effectId
        );
        if (index < 0) throw new Error("INVENTORY_EFFECT_CURSOR_INVALID");
        offset = index + 1;
      }
      const items = summaries.slice(offset,offset + input.limit);
      const hasMore = offset + items.length < summaries.length;
      const last = items.at(-1);
      return {
        status:summaries.length === 0 ? "empty" : "available",
        items,
        nextCursor:hasMore && last
          ? { operation:last.operation,effectId:last.effectId }
          : null,
        totalCount:summaries.length,
        reportDigest:factDigest(summaries)
      };
    });
  }

  async reconcileInventoryEffect(input: {
    readonly leaseRequestId: string;
    readonly lease: LeaseFence;
    readonly runId: string;
    readonly effect: InventoryEffectIdentity;
  }): Promise<InventoryEffectReconciliationResult> {
    return inTransaction(this.pool, async (client) => {
      const acquisition = await client.query(
        `SELECT 1 FROM ops.lease_acquisition_request
         WHERE lease_key=$1 AND request_id=$2 AND holder_id=$3 AND fencing_token=$4`,
        [input.lease.leaseKey,input.leaseRequestId,input.lease.holderId,
         input.lease.fencingToken]
      );
      if (acquisition.rowCount !== 1 ||
        input.effect.leaseRequestId !== input.leaseRequestId ||
        input.effect.runId !== input.runId) {
        throw new Error("INVENTORY_EFFECT_LEASE_IDENTITY_INVALID");
      }
      const lease = await client.query<{ expires_at:Date;server_now:Date }>(
        `SELECT expires_at,clock_timestamp() AS server_now
         FROM ops.lease WHERE lease_key=$1 FOR UPDATE`,
        [input.lease.leaseKey]
      );
      const currentLease = lease.rows[0];
      if (currentLease &&
        currentLease.expires_at.getTime() > currentLease.server_now.getTime()) {
        throw new Error("INVENTORY_EFFECT_ACTIVE_OWNER");
      }
      const current = await this.lockInventoryEffect(
        client,input.effect,
        (await client.query<{ operation:InventoryEffectOperation }>(
          `SELECT operation FROM ops.inventory_effect WHERE effect_id=$1`,
          [input.effect.effectId]
        )).rows[0]?.operation ?? "inventory.snapshot.persist",
        input.lease,false
      );
      if (current.runId !== input.runId) {
        throw new Error("INVENTORY_EFFECT_ID_CONFLICT");
      }
      if (current.status !== "running") {
        return {
          effectId:current.effectId,
          operation:current.operation,
          status:current.status,
          classification:"already_terminal"
        };
      }
      if (current.operation === "inventory.snapshot.persist") {
        throw new Error("INVENTORY_EFFECT_SNAPSHOT_RUNNING_INVALID");
      }
      if (current.operation === "sales-demand.sync") {
        const syncRunId = current.progress.syncRunId;
        if (typeof syncRunId !== "string" || !syncRunId) {
          throw new Error("INVENTORY_EFFECT_PROGRESS_INVALID");
        }
        const sync = await client.query(
          `UPDATE source.sync_run
           SET status='failed',completed_at=clock_timestamp(),
               diagnostics='["RECONCILED_ABANDONED_STAGING"]'::jsonb
           WHERE sync_run_id=$1 AND status='running'`,
          [syncRunId]
        );
        if (sync.rowCount !== 1) {
          throw new Error("INVENTORY_EFFECT_SYNC_STATE_CONFLICT");
        }
        await client.query(
          "DELETE FROM source.order_line_staging WHERE sync_run_id=$1",
          [syncRunId]
        );
        await this.updateInventoryEffect(
          client,input.effect,current.operation,{
            status:"failed",
            progress:current.progress,
            errorCode:"RECONCILED_ABANDONED_STAGING"
          }
        );
        return {
          effectId:current.effectId,
          operation:current.operation,
          status:"failed",
          classification:"abandoned_staging"
        };
      }
      const items = await client.query<ForecastEffectItemRow>(
        `SELECT status,counts FROM ops.inventory_effect_item
         WHERE effect_id=$1 ORDER BY item_key`,
        [input.effect.effectId]
      );
      const expectedProducts = Number(current.progress.attemptedProducts);
      if (!Number.isSafeInteger(expectedProducts) || expectedProducts < 0 ||
        items.rows.length > expectedProducts) {
        throw new Error("INVENTORY_EFFECT_PROGRESS_INVALID");
      }
      const aggregate = aggregateForecastEffectItems(items.rows);
      const severityTotal = Object.values(aggregate.severities)
        .reduce((sum,value) => sum + value,0);
      if (aggregate.completedProducts + aggregate.failedProducts !== items.rows.length ||
        aggregate.riskPersisted !== aggregate.completedProducts ||
        severityTotal !== aggregate.completedProducts) {
        throw new Error("INVENTORY_EFFECT_ITEM_COUNTS_INVALID");
      }
      if (items.rows.length === expectedProducts) {
        const result = {
          status:aggregate.failedProducts === 0 ? "complete" : "partial",
          attemptedProducts:expectedProducts,
          completedProducts:aggregate.completedProducts,
          partialProducts:0,
          failedProducts:aggregate.failedProducts,
          forecastWrites:{
            attempted:aggregate.forecastAttempted,
            persisted:aggregate.forecastPersisted
          },
          riskWrites:{
            attempted:aggregate.riskAttempted,
            persisted:aggregate.riskPersisted
          },
          severities:aggregate.severities
        };
        await this.updateInventoryEffect(
          client,input.effect,current.operation,{
            status:"succeeded",progress:result,result
          }
        );
        return {
          effectId:current.effectId,
          operation:current.operation,
          status:"succeeded",
          classification:"already_terminal"
        };
      }
      if (items.rows.length === 0) {
        await this.updateInventoryEffect(
          client,input.effect,current.operation,{
            status:"failed",progress:current.progress,
            errorCode:"RECONCILED_NOT_COMMITTED"
          }
        );
        return {
          effectId:current.effectId,
          operation:current.operation,
          status:"failed",
          classification:"not_committed"
        };
      }
      await this.updateInventoryEffect(
        client,input.effect,current.operation,{
          status:"failed",
          progress:{
            ...current.progress,
            completedProducts:aggregate.completedProducts,
            failedProducts:aggregate.failedProducts,
            forecastWrites:{
              attempted:aggregate.forecastAttempted,
              persisted:aggregate.forecastPersisted
            },
            riskWrites:{
              attempted:aggregate.riskAttempted,
              persisted:aggregate.riskPersisted
            },
            severities:aggregate.severities
          },
          errorCode:"RECONCILED_CONFIRMED_PARTIAL"
        }
      );
      return {
        effectId:current.effectId,
        operation:current.operation,
        status:"failed",
        classification:"confirmed_partial"
      };
    });
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

  async persistSnapshot(
    snapshot: PersistableDoudianSnapshot,
    effect: InventoryEffectIdentity,
    fence: LeaseFence
  ): Promise<{
    readonly snapshotId: string;
    readonly envelope: FactEnvelope<InventoryProductFact>;
  }> {
    const factEnvelope = envelope(snapshot);
    let snapshotId = `snapshot:${snapshot.shop.id}:${snapshot.product.id}:${factEnvelope.source.digest.slice(7, 23)}`;
    return inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      const replay = await this.claimInventoryEffect(
        client,effect,"inventory.snapshot.persist",{
          shopId:snapshot.shop.id,productId:snapshot.product.id
        },fence
      );
      if (replay?.result) {
        const replaySnapshotId = replay.result.snapshotId;
        if (typeof replaySnapshotId !== "string") {
          throw new Error("INVENTORY_EFFECT_RESULT_INVALID");
        }
        const persisted = await client.query<{ snapshot_id:string;source_digest:string }>(
          `SELECT snapshot_id,source_digest FROM inventory.snapshot
           WHERE snapshot_id=$1 AND shop_id=$2 AND product_id=$3`,
          [replaySnapshotId,snapshot.shop.id,snapshot.product.id]
        );
        const exact = row(persisted.rows,"replayed inventory snapshot");
        if (exact.source_digest !== factEnvelope.source.digest) {
          throw new Error("INVENTORY_EFFECT_RESULT_CONFLICT");
        }
        return { snapshotId:exact.snapshot_id,envelope:factEnvelope };
      }
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
      const result = { snapshotId,envelope:factEnvelope };
      const effectResult = {
        snapshotId,shopId:snapshot.shop.id,productId:snapshot.product.id,
        resultDigest:factDigest({ snapshotId,sourceDigest:factEnvelope.source.digest })
      };
      await this.updateInventoryEffect(
        client,effect,"inventory.snapshot.persist",{
          status:"succeeded",
          progress:{ shopId:snapshot.shop.id,productId:snapshot.product.id,persistedSnapshots:1 },
          result:effectResult
        }
      );
      return result;
    });
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

  async verifiedSnapshotFacts(input: {
    readonly shopId: string;
    readonly receipts: readonly {
      readonly productId: string;
      readonly snapshotId: string;
    }[];
  }): Promise<readonly {
    readonly productId: string;
    readonly snapshotId: string;
    readonly envelope: FactEnvelope<InventoryProductFact>;
  }[]> {
    if (input.receipts.length === 0) return [];
    const snapshotIds = input.receipts.map(({ snapshotId }) => snapshotId);
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
      `SELECT snapshot_id,dataset_id,data_version,source_digest,product_id,product_title,
              total_stock,observed_at,completeness,mapping_confidence,diagnostics
       FROM inventory.snapshot
       WHERE shop_id=$1 AND snapshot_id=ANY($2::text[])`,
      [input.shopId,snapshotIds]
    );
    const allowed = new Set(input.receipts.map(({ productId,snapshotId }) => `${productId}\u0000${snapshotId}`));
    const exactSnapshots = snapshots.rows.filter((snapshot) =>
      allowed.has(`${snapshot.product_id}\u0000${snapshot.snapshot_id}`)
    );
    if (exactSnapshots.length === 0) return [];
    const exactSnapshotIds = exactSnapshots.map(({ snapshot_id }) => snapshot_id);
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
      [exactSnapshotIds]
    );
    const bySnapshot = new Map<string, typeof skus.rows>();
    for (const sku of skus.rows) {
      const values = bySnapshot.get(sku.snapshot_id) ?? [];
      values.push(sku);
      bySnapshot.set(sku.snapshot_id,values);
    }
    return exactSnapshots.map((snapshot) => {
      const observedAt = snapshot.observed_at.toISOString();
      return {
        productId:snapshot.product_id,
        snapshotId:snapshot.snapshot_id,
        envelope:{
          schemaVersion:INVENTORY_FACT_SCHEMA_VERSION,
          observedAt,
          asOf:observedAt,
          scope:{ shopId:input.shopId,productId:snapshot.product_id },
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
            diagnostics:Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics.map(String) : []
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

  async beginOrderSync(input: {
    syncRunId: string;
    sourceSystem: string;
    shopId: string;
    sourceWatermark?: string;
    effect:InventoryEffectIdentity;
  }, fence: LeaseFence): Promise<Record<string,unknown> | undefined> {
    return inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      const replay = await this.claimInventoryEffect(
        client,input.effect,"sales-demand.sync",{
          syncRunId:input.syncRunId,stagedChunks:0,stagedRows:0
        },fence
      );
      if (replay?.result) return replay.result;
      await client.query(
        `INSERT INTO source.sync_run(
          sync_run_id,source_system,shop_id,status,started_at,source_watermark
        ) VALUES ($1,$2,$3,'running',clock_timestamp(),$4)
        ON CONFLICT(sync_run_id) DO NOTHING`,
        [input.syncRunId,input.sourceSystem,input.shopId,input.sourceWatermark ?? null]
      );
      return undefined;
    });
  }

  async upsertOrderChunk(input: {
    readonly syncRunId: string;
    readonly sourceSystem: string;
    readonly shopId: string;
    readonly rows: readonly NormalizedOrderLine[];
    readonly effect:InventoryEffectIdentity;
    readonly progress:{ readonly stagedChunks:number;readonly stagedRows:number };
  }, fence: LeaseFence): Promise<{
    inserted: number;
    updated: number;
  }> {
    if (input.rows.some((row) =>
      row.sourceSystem !== input.sourceSystem || row.shopId !== input.shopId
    )) {
      throw new Error("ORDER_SYNC_SOURCE_MISMATCH");
    }
    const payload = this.orderChunkPayload(input.rows);
    if (payload.length === 0) return { inserted:0,updated:0 };
    return inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(client,input.effect,"sales-demand.sync",fence);
      const sync = await client.query(
        `SELECT 1 FROM source.sync_run
         WHERE sync_run_id=$1 AND source_system=$2 AND shop_id=$3 AND status='running'
         FOR UPDATE`,
        [input.syncRunId,input.sourceSystem,input.shopId]
      );
      if (sync.rowCount !== 1) throw new Error("ORDER_SYNC_RUN_INVALID");
      const counts = await this.stageOrderChunkWithClient(client,input.syncRunId,payload);
      await this.updateInventoryEffect(client,input.effect,"sales-demand.sync",{
        progress:{ syncRunId:input.syncRunId,...input.progress }
      });
      return counts;
    });
  }

  private orderChunkPayload(rows: readonly NormalizedOrderLine[]): readonly Record<string, unknown>[] {
    const deduplicated = new Map<string, NormalizedOrderLine>();
    for (const item of rows) {
      const sourceItemKey = factDigest([
        item.sourceSystem,item.shopId,item.childOrderId,item.productId,item.merchantCode
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
    return [...deduplicated].map(([sourceItemKey,item]) => ({
      source_item_key:sourceItemKey,
      source_system:item.sourceSystem,
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
  }

  private async stageOrderChunkWithClient(
    client: PoolClient,
    syncRunId: string,
    payload: readonly Record<string, unknown>[]
  ): Promise<{ inserted: number; updated: number }> {
    if (payload.length === 0) return { inserted:0,updated:0 };
    const result = await client.query<{ inserted: string; updated: string }>(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
             source_item_key text,source_system text,shop_id text,shop_name text,child_order_id text,
             product_id text,merchant_code text,specification text,
             submitted_at timestamptz,paid_at timestamptz,shipped_at timestamptz,
             order_status text,aftersales_status text,source_quantity integer,
             demand_quantity integer,source_batch_id bigint,source_row_hash text,
             source_loaded_at timestamptz,source_period_end timestamptz
           )
         ), changed AS (
           INSERT INTO source.order_line_staging(
            sync_run_id,source_item_key,source_system,shop_id,shop_name,child_order_id,product_id,
            merchant_code,specification,submitted_at,paid_at,shipped_at,
            order_status,aftersales_status,source_quantity,demand_quantity,
            source_batch_id,source_row_hash,source_loaded_at,source_period_end
           ) SELECT
             $2,source_item_key,source_system,shop_id,shop_name,child_order_id,product_id,
             merchant_code,specification,submitted_at,paid_at,shipped_at,
             order_status,aftersales_status,source_quantity,demand_quantity,
             source_batch_id,source_row_hash,source_loaded_at,source_period_end
           FROM incoming
          ON CONFLICT(sync_run_id,source_item_key) DO UPDATE SET
            specification=EXCLUDED.specification,paid_at=EXCLUDED.paid_at,
            shipped_at=EXCLUDED.shipped_at,order_status=EXCLUDED.order_status,
            aftersales_status=EXCLUDED.aftersales_status,
            source_quantity=EXCLUDED.source_quantity,demand_quantity=EXCLUDED.demand_quantity,
            source_batch_id=EXCLUDED.source_batch_id,source_row_hash=EXCLUDED.source_row_hash,
            source_loaded_at=EXCLUDED.source_loaded_at,source_period_end=EXCLUDED.source_period_end,
            staged_at=clock_timestamp()
          WHERE source.order_line_staging.source_loaded_at <= EXCLUDED.source_loaded_at
          RETURNING (xmax = 0) AS was_inserted
         ) SELECT
           count(*) FILTER (WHERE was_inserted)::text AS inserted,
           count(*) FILTER (WHERE NOT was_inserted)::text AS updated
         FROM changed`,
        [JSON.stringify(payload),syncRunId]
      );
    const counts = row(result.rows,"order chunk upsert counts");
    return { inserted:Number(counts.inserted),updated:Number(counts.updated) };
  }

  async completeOrderSync(input: {
    syncRunId: string;
    sourceSystem: string;
    shopId: string;
    watermark: string;
    sourceDigest: string;
    recordCount: number;
    historicalCompleteThrough: string;
    observedAt: string;
    effect:InventoryEffectIdentity;
  }, fence: LeaseFence): Promise<{
    datasetId: string;
    dataVersion: string;
    inserted: number;
    updated: number;
  }> {
    return inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(client,input.effect,"sales-demand.sync",fence);
      const sync = await client.query(
        `SELECT 1 FROM source.sync_run
         WHERE sync_run_id=$1 AND source_system=$2 AND shop_id=$3 AND status='running'
         FOR UPDATE`,
        [input.syncRunId,input.sourceSystem,input.shopId]
      );
      if (sync.rowCount !== 1) throw new Error("ORDER_SYNC_RUN_INVALID");
      const promoted = await client.query<{ inserted: string; updated: string }>(
        `WITH changed AS (
           INSERT INTO source.order_line_fact(
             source_item_key,source_system,shop_id,shop_name,child_order_id,product_id,
             merchant_code,specification,submitted_at,paid_at,shipped_at,
             order_status,aftersales_status,source_quantity,demand_quantity,
             source_batch_id,source_row_hash,source_loaded_at,source_period_end
           ) SELECT
             source_item_key,source_system,shop_id,shop_name,child_order_id,product_id,
             merchant_code,specification,submitted_at,paid_at,shipped_at,
             order_status,aftersales_status,source_quantity,demand_quantity,
             source_batch_id,source_row_hash,source_loaded_at,source_period_end
           FROM source.order_line_staging
           WHERE sync_run_id=$1 AND source_system=$2 AND shop_id=$3
           ON CONFLICT(source_item_key) DO UPDATE SET
             source_system=EXCLUDED.source_system,
             specification=EXCLUDED.specification,paid_at=EXCLUDED.paid_at,
             shipped_at=EXCLUDED.shipped_at,order_status=EXCLUDED.order_status,
             aftersales_status=EXCLUDED.aftersales_status,
             source_quantity=EXCLUDED.source_quantity,demand_quantity=EXCLUDED.demand_quantity,
             source_batch_id=EXCLUDED.source_batch_id,source_row_hash=EXCLUDED.source_row_hash,
             source_loaded_at=EXCLUDED.source_loaded_at,source_period_end=EXCLUDED.source_period_end,
             updated_at=now()
           WHERE source.order_line_fact.source_loaded_at <= EXCLUDED.source_loaded_at
           RETURNING (xmax = 0) AS was_inserted
         ) SELECT
           count(*) FILTER (WHERE was_inserted)::text AS inserted,
           count(*) FILTER (WHERE NOT was_inserted)::text AS updated
         FROM changed`,
        [input.syncRunId,input.sourceSystem,input.shopId]
      );
      const promotedCounts = row(promoted.rows,"published order promotion counts");
      const inserted = Number(promotedCounts.inserted);
      const updated = Number(promotedCounts.updated);
      const datasetId = `sales-demand-staged:${input.shopId}`;
      const dataVersion = `${input.watermark}:${input.sourceDigest.slice(7, 19)}`;
      const publishedFacts = row((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM source.order_line_fact
         WHERE source_system=$1 AND shop_id=$2
           AND source_batch_id <= $3::bigint AND updated_at <= now()`,
        [input.sourceSystem,input.shopId,input.watermark]
      )).rows,"published order fact count");
      const publishedRecordCount = Number(publishedFacts.count);
      if (!Number.isSafeInteger(publishedRecordCount) || publishedRecordCount < 0) {
        throw new Error("ORDER_SYNC_PUBLISHED_COUNT_INVALID");
      }
      await client.query(
        `INSERT INTO dataset.version(
          dataset_id,data_version,source_kind,source_digest,observed_at,as_of,
          record_count,lineage
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(dataset_id,source_digest) DO NOTHING`,
        [datasetId,dataVersion,input.sourceSystem,input.sourceDigest,input.observedAt,
         input.historicalCompleteThrough,publishedRecordCount,
         JSON.stringify({
           watermark:input.watermark,
           syncRunId:input.syncRunId,
           publicationProtocol:"staged-v1",
           sourceDigestKind:"incremental-sync-v1",
           syncRecordCount:input.recordCount
         })]
      );
      await client.query(
        `INSERT INTO source.watermark(source_system,shop_id,dataset_type,watermark,source_digest,updated_at)
         VALUES ($1,$2,'orders',$3,$4,now())
         ON CONFLICT(source_system,shop_id,dataset_type) DO UPDATE SET
           watermark=EXCLUDED.watermark,source_digest=EXCLUDED.source_digest,updated_at=EXCLUDED.updated_at`,
        [input.sourceSystem,input.shopId,input.watermark,input.sourceDigest]
      );
      const completed = await client.query(
        `UPDATE source.sync_run SET status='succeeded',completed_at=now(),
           inserted_count=$2,updated_count=$3,source_watermark=$4
         WHERE sync_run_id=$1 AND status='running'`,
        [input.syncRunId,inserted,updated,input.watermark]
      );
      if (completed.rowCount !== 1) throw new Error("ORDER_SYNC_RUN_INVALID");
      await client.query(
        "DELETE FROM source.order_line_staging WHERE sync_run_id=$1",
        [input.syncRunId]
      );
      const result = {
        status:"succeeded",syncRunId:input.syncRunId,shopId:input.shopId,
        watermark:input.watermark,sourceDigest:input.sourceDigest,
        processed:input.recordCount,inserted,updated,
        historicalCompleteThrough:input.historicalCompleteThrough,
        dataset:{ datasetId,dataVersion,inserted,updated }
      };
      await this.updateInventoryEffect(client,input.effect,"sales-demand.sync",{
        status:"succeeded",
        progress:{ syncRunId:input.syncRunId,publishedRows:publishedRecordCount },
        result
      });
      return { datasetId,dataVersion,inserted,updated };
    });
  }

  async completeNoChangeOrderSync(
    syncRunId:string,
    effect:InventoryEffectIdentity,
    result:Record<string,unknown>,
    fence: LeaseFence
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(client,effect,"sales-demand.sync",fence);
      const completed = await client.query(
        `UPDATE source.sync_run SET status='succeeded',completed_at=clock_timestamp(),
           inserted_count=0,updated_count=0,diagnostics='["No newer source batch was available."]'::jsonb
         WHERE sync_run_id=$1 AND status='running'`,
        [syncRunId]
      );
      if (completed.rowCount !== 1) throw new Error("ORDER_SYNC_RUN_INVALID");
      await client.query("DELETE FROM source.order_line_staging WHERE sync_run_id=$1",[syncRunId]);
      await this.updateInventoryEffect(client,effect,"sales-demand.sync",{
        status:"succeeded",progress:{ syncRunId,stagedChunks:0,stagedRows:0 },result
      });
    });
  }

  async failOrderSync(
    syncRunId:string,
    diagnosticCode:string,
    effect:InventoryEffectIdentity,
    progress:Record<string,unknown>,
    fence: LeaseFence
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(client,effect,"sales-demand.sync",fence);
      const code = /^[A-Z][A-Z0-9_]{1,99}$/u.test(diagnosticCode)
        ? diagnosticCode
        : "ORDER_SYNC_FAILED";
      const failed = await client.query(
        `UPDATE source.sync_run SET status='failed',completed_at=clock_timestamp(),diagnostics=$2
         WHERE sync_run_id=$1 AND status='running'`,
        [syncRunId,JSON.stringify([code])]
      );
      if (failed.rowCount !== 1) throw new Error("ORDER_SYNC_RUN_INVALID");
      await client.query("DELETE FROM source.order_line_staging WHERE sync_run_id=$1",[syncRunId]);
      await this.updateInventoryEffect(client,effect,"sales-demand.sync",{
        status:"failed",progress:{ syncRunId,...progress },errorCode:code
      });
    });
  }

  async currentWatermark(sourceSystem: string, shopId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ watermark: string }>(
      "SELECT watermark FROM source.watermark WHERE source_system=$1 AND shop_id=$2 AND dataset_type='orders'",
      [sourceSystem, shopId]
    );
    return result.rows[0]?.watermark;
  }

  async ordersFreshness(input: {
    shop: { id: string; name: string };
    baseline?: {
      status: "fresh_reused" | "refresh_required" | "refreshed" | "degraded";
      checkedAt: string;
      datasetId: string | null;
      dataVersion: string | null;
    };
  }): Promise<{
    status: "fresh_reused" | "refresh_required" | "refreshed" | "degraded";
    shop: { id: string; name: string };
    checkedAt: string;
    maxAgeSeconds: 7200;
    latestObservedAt: string | null;
    ageSeconds: number | null;
    datasetId: string | null;
    dataVersion: string | null;
    source: "wdt" | null;
  }> {
    const result = await this.pool.query<{
      server_now: Date;
      dataset_id: string | null;
      data_version: string | null;
      source_kind: string | null;
      observed_at: Date | null;
    }>(
      `WITH clock AS (SELECT clock_timestamp() AS server_now), latest AS (
         SELECT dataset_id,data_version,source_kind,observed_at
         FROM dataset.version
         WHERE dataset_id='sales-demand-staged:' || $1
           AND source_kind='ecom-profit-mysql:wdt-stockout'
           AND lineage->>'publicationProtocol'='staged-v1'
         ORDER BY created_at DESC,observed_at DESC,dataset_id,data_version
         LIMIT 1
       ), latest_sync AS (
         SELECT completed_at
         FROM source.sync_run
         WHERE source_system='ecom-profit-mysql:wdt-stockout'
           AND shop_id=$1 AND status='succeeded' AND completed_at IS NOT NULL
         ORDER BY completed_at DESC,sync_run_id DESC
         LIMIT 1
       )
       SELECT clock.server_now,latest.dataset_id,latest.data_version,
              latest.source_kind,latest_sync.completed_at AS observed_at
       FROM clock LEFT JOIN latest ON true LEFT JOIN latest_sync ON true`,
      [input.shop.id]
    );
    const freshness = row(result.rows,"orders freshness");
    const checkedAt = freshness.server_now.toISOString();
    const latestObservedAt = freshness.observed_at?.toISOString() ?? null;
    const ageSeconds = latestObservedAt === null
      ? null
      : Math.max(
          0,
          Math.floor(
            (freshness.server_now.getTime() - freshness.observed_at!.getTime()) /
              1_000
          )
        );
    const datasetId = freshness.dataset_id ?? null;
    const dataVersion = freshness.data_version ?? null;
    const currentFresh = Boolean(
      datasetId && dataVersion && ageSeconds !== null && ageSeconds <= 7_200
    );
    const versionChanged = Boolean(
      input.baseline &&
      datasetId &&
      dataVersion &&
      (datasetId !== input.baseline.datasetId ||
        dataVersion !== input.baseline.dataVersion)
    );
    const freshBaselineStillExact = Boolean(
      input.baseline?.status === "fresh_reused" &&
      currentFresh &&
      datasetId === input.baseline.datasetId &&
      dataVersion === input.baseline.dataVersion
    );
    const refreshCompletedAfterBaseline = Boolean(
      input.baseline &&
      latestObservedAt &&
      Date.parse(latestObservedAt) >= Date.parse(input.baseline.checkedAt)
    );
    const status = input.baseline
      ? input.baseline.status === "fresh_reused"
        ? freshBaselineStillExact
          ? "fresh_reused"
          : "degraded"
        : input.baseline.status === "refresh_required" &&
            currentFresh &&
            (versionChanged || refreshCompletedAfterBaseline)
          ? "refreshed"
          : "degraded"
      : currentFresh
        ? "fresh_reused"
        : "refresh_required";
    return {
      status,
      shop:input.shop,
      checkedAt,
      maxAgeSeconds:7_200,
      latestObservedAt,
      ageSeconds,
      datasetId,
      dataVersion,
      source:freshness.source_kind === "ecom-profit-mysql:wdt-stockout"
          ? "wdt"
          : null
    };
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
    const datasetResult = await this.pool.query<{
      dataset_id: string;
      data_version: string;
      source_kind: string;
      source_digest: string;
      observed_at: Date;
      created_at: Date;
      as_of: Date;
      watermark: string;
      last_sync_at: Date | null;
    }>(
      `SELECT dataset_id,data_version,source_kind,source_digest,observed_at,created_at,as_of,
              lineage->>'watermark' AS watermark,
              (SELECT max(completed_at) FROM source.sync_run
               WHERE source_system='ecom-profit-mysql:wdt-stockout'
                 AND shop_id=$3 AND status='succeeded') AS last_sync_at
       FROM dataset.version
       WHERE dataset_id=$1 AND source_kind='ecom-profit-mysql:wdt-stockout'
         AND lineage->>'publicationProtocol'='staged-v1'
         AND as_of <= $2 AND lineage->>'watermark' ~ '^[0-9]+$'
       ORDER BY created_at DESC,observed_at DESC,data_version DESC LIMIT 1`,
      [`sales-demand-staged:${input.shopId}`,input.asOf,input.shopId]
    );
    const dataset = datasetResult.rows[0] ?? {
      dataset_id:`sales-demand-staged:${input.shopId}`,data_version:"unavailable",
      source_kind:"unavailable",
      source_digest:factDigest({ shopId:input.shopId,kind:"sales-demand-unavailable" }),
      observed_at:new Date(0),
      created_at:new Date(0),
      as_of:new Date(0),
      watermark:"-1",
      last_sync_at:null
    };
    const productFallback = await this.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(demand_quantity),0)::text AS quantity
       FROM source.order_line_fact WHERE shop_id=$1 AND product_id=$2
         AND paid_at > $3::timestamptz-interval '28 days' AND paid_at <= $3 AND demand_quantity > 0
         AND source_system=$4 AND source_batch_id <= $5::bigint
         AND updated_at <= $6::timestamptz`,
      [input.shopId,input.productId,input.asOf,dataset.source_kind,dataset.watermark,dataset.created_at]
    );
    const storeFallback = await this.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(demand_quantity),0)::text AS quantity
       FROM source.order_line_fact WHERE shop_id=$1
         AND paid_at > $2::timestamptz-interval '28 days' AND paid_at <= $2 AND demand_quantity > 0
         AND source_system=$3 AND source_batch_id <= $4::bigint
         AND updated_at <= $5::timestamptz`,
      [input.shopId,input.asOf,dataset.source_kind,dataset.watermark,dataset.created_at]
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
           AND source_system=$5 AND source_batch_id <= $6::bigint
           AND updated_at <= $7::timestamptz
         GROUP BY 1 ORDER BY 1`,
        [input.shopId,input.productId,binding.merchant_code,input.asOf,
         dataset.source_kind,dataset.watermark,dataset.created_at]
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
          ...(datasetResult.rows[0]?.last_sync_at
            ? { recentObservedAt:datasetResult.rows[0].last_sync_at.toISOString() }
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

  private async persistForecastRows(client: PoolClient, inputs: readonly {
    readonly shopId: string;
    readonly productId: string;
    readonly platformSkuId: string;
    readonly merchantCode: string;
    readonly sourceDataset: { id: string; version: string };
    readonly forecast: DemandForecast;
  }[]): Promise<readonly string[]> {
    const forecastIds: string[] = [];
    for (const input of inputs) {
      const forecastId = `forecast:${factDigest(input).slice(7, 39)}`;
      const persisted = await client.query<{ forecast_id: string }>(
        `INSERT INTO inventory.demand_forecast(
          forecast_id,shop_id,product_id,platform_sku_id,merchant_code,as_of,
          algorithm_version,source_dataset_id,source_data_version,selected_model,
          confidence,daily_p50,daily_p90,horizons,diagnostics
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(shop_id,product_id,platform_sku_id,as_of,algorithm_version)
        DO UPDATE SET forecast_id=inventory.demand_forecast.forecast_id
        RETURNING forecast_id`,
        [forecastId,input.shopId,input.productId,input.platformSkuId,input.merchantCode,input.forecast.asOf,
         input.forecast.algorithmVersion,input.sourceDataset.id,input.sourceDataset.version,input.forecast.selectedModel,
         input.forecast.confidence,input.forecast.dailyP50,input.forecast.dailyP90,
         JSON.stringify(input.forecast.horizons),JSON.stringify(input.forecast.diagnostics)]
      );
      if (row(persisted.rows, "persisted inventory forecast").forecast_id !== forecastId) {
        throw new Error("INVENTORY_FORECAST_CONFLICT");
      }
      forecastIds.push(forecastId);
    }
    return forecastIds;
  }

  async persistForecastRiskProduct(input: {
    readonly forecasts: readonly {
      readonly shopId: string;
      readonly productId: string;
      readonly platformSkuId: string;
      readonly merchantCode: string;
      readonly sourceDataset: { id: string; version: string };
      readonly forecast: DemandForecast;
    }[];
    readonly risk: {
      readonly snapshotId: string;
      readonly shopId: string;
      readonly productId: string;
      readonly evaluation: InventoryRiskEvaluation;
    };
    readonly effect:InventoryEffectIdentity;
  }, fence: LeaseFence): Promise<{
    readonly forecastIds: readonly string[];
    readonly evaluationId: string;
    readonly incidentsUpdated: number;
  }> {
    return inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
      await this.lockInventoryEffect(
        client,input.effect,"inventory.shop.forecast-risk.refresh",fence
      );
      const forecastIds = await this.persistForecastRows(client,input.forecasts);
      const sourceDigest = factDigest(input.risk);
      const evaluationId = `evaluation:${sourceDigest.slice(7, 39)}`;
      const insertedEvaluation = await client.query<{ evaluation_id: string }>(
        `INSERT INTO inventory.risk_evaluation(
          evaluation_id,shop_id,product_id,snapshot_id,policy_version,evaluated_at,
          severity,findings,diagnostics,source_digest
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(shop_id,product_id,snapshot_id,policy_version) DO NOTHING
        RETURNING evaluation_id`,
        [evaluationId,input.risk.shopId,input.risk.productId,input.risk.snapshotId,
         input.risk.evaluation.policyVersion,input.risk.evaluation.evaluatedAt,
         input.risk.evaluation.severity,JSON.stringify(input.risk.evaluation.findings),
         JSON.stringify(input.risk.evaluation.diagnostics),sourceDigest]
      );
      let incidentsUpdated = 0;
      if (insertedEvaluation.rowCount === 1) {
        for (const finding of input.risk.evaluation.findings) {
          if (await this.persistIncident(
            client,evaluationId,input.risk.evaluation.policyVersion,
            input.risk.evaluation.evaluatedAt,finding
          )) {
            incidentsUpdated += 1;
          }
        }
      } else {
        const existing = await client.query<{ evaluation_id: string }>(
          `SELECT evaluation_id FROM inventory.risk_evaluation
           WHERE shop_id=$1 AND product_id=$2 AND snapshot_id=$3 AND policy_version=$4`,
          [input.risk.shopId,input.risk.productId,input.risk.snapshotId,input.risk.evaluation.policyVersion]
        );
        if (row(existing.rows,"persisted inventory risk").evaluation_id !== evaluationId) {
          throw new Error("INVENTORY_RISK_CONFLICT");
        }
      }
      await this.insertInventoryEffectItem(client,{
        effectId:input.effect.effectId,itemKey:input.risk.productId,
        inputDigest:factDigest([
          input.effect.inputDigest,input.risk.productId,input.risk.snapshotId
        ]),
        status:"succeeded",
        resultDigest:factDigest({ forecastIds,evaluationId,incidentsUpdated }),
        counts:{
          completedProducts:1,failedProducts:0,
          forecastAttempted:input.forecasts.length,
          forecastPersisted:forecastIds.length,
          riskAttempted:1,riskPersisted:1,
          severity:input.risk.evaluation.severity
        }
      });
      return { forecastIds,evaluationId,incidentsUpdated };
    });
  }

  async persistRisk(input: {
    readonly snapshotId: string;
    readonly shopId: string;
    readonly productId: string;
    readonly evaluation: InventoryRiskEvaluation;
  }, fence: LeaseFence): Promise<{ evaluationId: string; incidentsUpdated: number }> {
    const sourceDigest = factDigest(input);
    const evaluationId = `evaluation:${sourceDigest.slice(7, 39)}`;
    let incidentsUpdated = 0;
    await inTransaction(this.pool, async (client) => {
      await this.assertLeaseForUpdate(client,fence);
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
        (SELECT max(completed_at) FROM source.sync_run
          WHERE shop_id=$1 AND source_system='ecom-profit-mysql:wdt-stockout'
            AND status='succeeded' AND EXISTS (
              SELECT 1 FROM dataset.version
              WHERE dataset_id='sales-demand-staged:' || $1
                AND source_kind='ecom-profit-mysql:wdt-stockout'
                AND lineage->>'publicationProtocol'='staged-v1'
            )) AS latest_order_at,
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
