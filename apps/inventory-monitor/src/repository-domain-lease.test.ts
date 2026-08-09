import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe,expect,it,vi } from "vitest";
import { INVENTORY_MIGRATIONS } from "./migrations.js";
import { InventoryRepository,type LeaseFence } from "./repository.js";

function result<T>(rows: readonly T[] = []) {
  return { rows:[...rows],rowCount:rows.length };
}

function domainLeasePool() {
  let now = new Date("2026-08-09T00:00:00.000Z");
  let lease: {
    holderId:string;fencingToken:number;acquiredAt:Date;expiresAt:Date;
  } | undefined;
  const requests = new Map<string,{
    holderId:string;fencingToken:number;acquiredAt:Date;expiresAt:Date;
  }>();
  const query = vi.fn(async (sqlValue: unknown,parameters: readonly unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
    if (sql.includes("pg_advisory_xact_lock")) return result([{}]);
    if (sql.includes("FROM ops.lease_acquisition_request r")) {
      const request = requests.get(String(parameters[1]));
      return result(request ? [{
        holder_id:request.holderId,fencing_token:String(request.fencingToken),
        expires_at:request.expiresAt
      }] : []);
    }
    if (sql.includes("FROM ops.lease WHERE lease_key=$1 FOR UPDATE")) {
      return result(lease ? [{
        holder_id:lease.holderId,fencing_token:String(lease.fencingToken),
        acquired_at:lease.acquiredAt,expires_at:lease.expiresAt,server_now:now
      }] : []);
    }
    if (sql.includes("INSERT INTO ops.lease(")) {
      if (lease && lease.expiresAt.getTime() > now.getTime()) return result();
      const ttlSeconds = Number(parameters[2]);
      lease = {
        holderId:String(parameters[1]),
        fencingToken:(lease?.fencingToken ?? 0) + 1,
        acquiredAt:new Date(now),
        expiresAt:new Date(now.getTime() + ttlSeconds * 1_000)
      };
      return result([{
        holder_id:lease.holderId,fencing_token:String(lease.fencingToken),
        server_now:lease.acquiredAt,expires_at:lease.expiresAt
      }]);
    }
    if (sql.includes("INSERT INTO ops.lease_acquisition_request")) {
      requests.set(String(parameters[1]),{
        holderId:String(parameters[2]),fencingToken:Number(parameters[3]),
        acquiredAt:new Date(parameters[4] as Date),expiresAt:new Date(parameters[5] as Date)
      });
      return result();
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const client = { query,release:vi.fn() };
  const pool = { connect:vi.fn(async () => client) } as unknown as Pool;
  return {
    pool,query,
    advance(milliseconds:number) { now = new Date(now.getTime() + milliseconds); },
    expire() { if (lease) lease.expiresAt = new Date(now.getTime() - 1); }
  };
}

const fence: LeaseFence = {
  leaseKey:"inventory-production-cycle",holderId:"run:1",fencingToken:7
};
const effect = {
  effectId:`inventory-effect:sha256:${"a".repeat(64)}`,
  inputDigest:`sha256:${"b".repeat(64)}`,
  identityDigest:`sha256:${"e".repeat(64)}`,
  runId:"run:test",invocationId:"invocation:test",
  idempotencyKey:"idempotency:test",leaseRequestId:"lease-request:test"
} as const;
const secondEffect = {
  effectId:`inventory-effect:sha256:${"c".repeat(64)}`,
  inputDigest:`sha256:${"d".repeat(64)}`,
  identityDigest:`sha256:${"f".repeat(64)}`,
  runId:"run:test",invocationId:"invocation:test:2",
  idempotencyKey:"idempotency:test:2",leaseRequestId:"lease-request:test"
} as const;

function runningEffectRow(operation:string) {
  return {
    effect_id:effect.effectId,operation,input_digest:effect.inputDigest,
    identity_digest:effect.identityDigest,run_id:effect.runId,
    invocation_id:effect.invocationId,idempotency_key:effect.idempotencyKey,
    lease_request_id:effect.leaseRequestId,
    lease_key:fence.leaseKey,holder_id:fence.holderId,
    fencing_token:String(fence.fencingToken),status:"running",
    progress:{},result:null,error_code:null,
    updated_at:new Date("2026-08-10T00:00:00.000Z"),completed_at:null
  };
}

describe("inventory domain lease",() => {
  it("keeps a stable acquisition request idempotent and never resurrects it",async () => {
    const fake = domainLeasePool();
    const repository = new InventoryRepository(fake.pool);
    const input = {
      leaseKey:"inventory-production-cycle",requestId:"request:1",holderId:"run:1",ttlSeconds:300
    };
    const first = await repository.acquireDomainLease(input);
    const replay = await repository.acquireDomainLease(input);
    expect(replay).toEqual(first);

    fake.advance(301_000);
    fake.expire();
    const expiredReplay = await repository.acquireDomainLease(input);
    expect(expiredReplay).toMatchObject({ fencingToken:first.fencingToken,active:false });
    const replacement = await repository.acquireDomainLease({
      ...input,requestId:"request:2",holderId:"run:2"
    });
    expect(replacement).toMatchObject({ fencingToken:first.fencingToken + 1,active:true });
  });

  it("rejects an active competitor without minting another token",async () => {
    const fake = domainLeasePool();
    const repository = new InventoryRepository(fake.pool);
    await repository.acquireDomainLease({
      leaseKey:"inventory-production-cycle",requestId:"request:1",holderId:"run:1",ttlSeconds:300
    });
    await expect(repository.acquireDomainLease({
      leaseKey:"inventory-production-cycle",requestId:"request:2",holderId:"run:2",ttlSeconds:300
    })).rejects.toThrow("DOMAIN_LEASE_BUSY");
    expect(fake.query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
  });

  it("rejects release from the superseded owner and token",async () => {
    const fake = domainLeasePool();
    const repository = new InventoryRepository(fake.pool);
    const old = await repository.acquireDomainLease({
      leaseKey:"inventory-production-cycle",requestId:"request:1",holderId:"run:1",ttlSeconds:300
    });
    fake.advance(301_000);
    fake.expire();
    await repository.acquireDomainLease({
      leaseKey:"inventory-production-cycle",requestId:"request:2",holderId:"run:2",ttlSeconds:300
    });
    await expect(repository.releaseDomainLease({
      leaseKey:old.leaseKey,holderId:old.holderId,fencingToken:old.fencingToken
    })).rejects.toThrow("DOMAIN_LEASE_LOST");
  });
});

describe("fenced inventory writes",() => {
  it("locks and validates the fence before a deterministic snapshot replay",async () => {
    const transactionSql: string[][] = [];
    let current: string[] = [];
    const query = vi.fn(async (sqlValue: unknown,parameters: readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN") {
        current = [];
        transactionSql.push(current);
        return result();
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") return result();
      current.push(sql);
      if (sql.includes("SELECT 1 FROM ops.lease")) return { rows:[{}],rowCount:1 };
      if (sql.includes("INSERT INTO ops.inventory_effect")) return { rows:[],rowCount:1 };
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      if (sql.includes("SELECT 1 FROM source.sync_run")) return { rows:[{}],rowCount:1 };
      if (sql.includes("INSERT INTO inventory.snapshot(")) {
        return result([{ snapshot_id:String(parameters[0]),source_digest:String(parameters[9]) }]);
      }
      return result();
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    const snapshot = {
      snapshotVersion:"1.0.0",observedAt:"2026-08-09T00:00:00.000Z",
      shop:{ id:"shop:1",name:"一号店" },
      product:{ id:"product:1",title:"商品",totalStock:0 },skus:[]
    };
    const first = await repository.persistSnapshot(snapshot,effect,fence);
    const replay = await repository.persistSnapshot(snapshot,secondEffect,fence);
    expect(replay).toEqual(first);
    expect(transactionSql).toHaveLength(2);
    for (const statements of transactionSql) {
      expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease/u);
      expect(statements[0]).toMatch(/FOR UPDATE/u);
      expect(statements.some((sql) => /ops\.lease_acquisition_request/u.test(sql))).toBe(true);
      expect(statements.some((sql) => /INSERT INTO dataset\.version/u.test(sql))).toBe(true);
      expect(statements.at(-1)).toMatch(/UPDATE ops\.inventory_effect/u);
    }
    const effectUpdates = query.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE ops.inventory_effect")
    );
    for (const [,parameters] of effectUpdates) {
      const compactResult = JSON.parse(String((parameters as readonly unknown[])[5]));
      expect(compactResult).toMatchObject({
        snapshotId:first.snapshotId,shopId:"shop:1",productId:"product:1"
      });
      expect(compactResult).not.toHaveProperty("envelope");
    }
    const acquisition = query.mock.calls.find(([sql]) =>
      String(sql).includes("ops.lease_acquisition_request")
    );
    expect(acquisition?.[1]).toEqual([
      fence.leaseKey,effect.leaseRequestId,fence.holderId,fence.fencingToken
    ]);
  });

  it("rejects an old token and rolls back before business SQL",async () => {
    const query = vi.fn(async (sqlValue: unknown,parameters: readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes("SELECT 1 FROM ops.lease")) {
        expect(parameters).toEqual([
          "inventory-production-cycle","run:1",7
        ]);
        return { rows:[],rowCount:0 };
      }
      return result();
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.persistForecastRiskProduct({
      forecasts:[{
        shopId:"shop:1",productId:"product:1",platformSkuId:"sku:1",merchantCode:"M1",
        sourceDataset:{ id:"dataset:1",version:"v1" },
        forecast:{
        asOf:"2026-08-09T00:00:00.000Z",
        algorithmVersion:"inventory-demand-ensemble-conformal/1.0.0",
        selectedModel:"hierarchical_fallback",confidence:"low",dailyP50:0,dailyP90:0,
        horizons:[],recentAcceleration:1,trainingHours:0,diagnostics:[]
        }
      }],
      risk:{
        snapshotId:"snapshot:1",shopId:"shop:1",productId:"product:1",
        evaluation:{
          policyVersion:"inventory-balanced-shadow/1.0.0",
          evaluatedAt:"2026-08-09T00:00:00.000Z",severity:"normal",
          findings:[],diagnostics:[]
        }
      },effect
    },fence)).rejects.toThrow("SCHEDULER_LEASE_LOST");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO inventory.demand_forecast")))
      .toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
  });

  it("rejects effect-id reuse under a different trusted identity before business SQL",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("SET TRANSACTION")) return result();
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("INSERT INTO ops.inventory_effect")) return { rows:[],rowCount:0 };
      if (sql.includes("FROM ops.inventory_effect WHERE")) return result([{
        ...runningEffectRow("inventory.snapshot.persist"),
        identity_digest:`sha256:${"0".repeat(64)}`
      }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.persistSnapshot({
      snapshotVersion:"1.0.0",observedAt:"2026-08-10T00:00:00.000Z",
      shop:{ id:"shop:1",name:"一号店" },
      product:{ id:"product:1",title:"商品",totalStock:0 },skus:[]
    },effect,fence)).rejects.toThrow("INVENTORY_EFFECT_ID_CONFLICT");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO dataset.version")))
      .toBe(false);
  });

  it("validates the fence in the same transaction as each MySQL order chunk",async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("SELECT 1 FROM ops.lease")) return { rows:[{}],rowCount:1 };
      if (sql.includes("SELECT 1 FROM source.sync_run")) return { rows:[{}],rowCount:1 };
      if (sql.includes("FROM ops.inventory_effect")) return result([runningEffectRow("sales-demand.sync")]);
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      if (sql.includes("jsonb_to_recordset")) return result([{ inserted:"1",updated:"0" }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.upsertOrderChunk({
      syncRunId:"sync:1",sourceSystem:"ecom-profit-mysql:wdt-stockout",shopId:"shop:1",rows:[{
      sourceSystem:"ecom-profit-mysql:wdt-stockout",
      shopId:"shop:1",shopName:"一号店",childOrderId:"order:1",productId:"product:1",
      merchantCode:"M1",specification:"默认",submittedAt:"2026-08-09T00:00:00.000Z",
      orderStatus:"已支付",aftersalesStatus:"",sourceQuantity:1,demandQuantity:1,
      sourceBatchId:1,sourceRowHash:"sha256:row",sourceLoadedAt:"2026-08-09T00:00:01.000Z"
      }]
      ,effect,progress:{ stagedChunks:1,stagedRows:1 }
    },fence)).resolves.toEqual({ inserted:1,updated:0 });
    expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements.some((sql) => /source\.sync_run/u.test(sql))).toBe(true);
    expect(statements.some((sql) => /source\.order_line_staging/u.test(sql))).toBe(true);
    expect(statements.at(-1)).toMatch(/UPDATE ops\.inventory_effect/u);
  });

  it("promotes staging and publishes its lineage in one fenced transaction",async () => {
    const statements:{ sql:string;parameters:readonly unknown[] }[] = [];
    const query = vi.fn(async (sqlValue:unknown,parameters:readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push({ sql,parameters });
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("SELECT 1 FROM source.sync_run")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect")) return result([runningEffectRow("sales-demand.sync")]);
      if (sql.includes("WITH changed AS") && sql.includes("source.order_line_fact")) {
        return result([{ inserted:"2",updated:"1" }]);
      }
      if (sql.includes("count(*)::text AS count") && sql.includes("source.order_line_fact")) {
        return result([{ count:"37" }]);
      }
      if (sql.includes("INSERT INTO dataset.version")) return result();
      if (sql.includes("INSERT INTO source.watermark")) return result();
      if (sql.includes("UPDATE source.sync_run")) return { rows:[],rowCount:1 };
      if (sql.includes("DELETE FROM source.order_line_staging")) return result();
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.completeOrderSync({
      syncRunId:"sync:1",sourceSystem:"ecom-profit-mysql:wdt-stockout",
      shopId:"10461048",watermark:"42",sourceDigest:"sha256:abcdefghijklmnop",
      recordCount:3,historicalCompleteThrough:"2026-08-10T00:00:00.000Z",
      observedAt:"2026-08-10T01:00:00.000Z",effect
    },fence)).resolves.toMatchObject({ inserted:2,updated:1 });
    expect(statements[0]!.sql).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements.some(({ sql }) => /source\.sync_run[\s\S]*status='running'[\s\S]*FOR UPDATE/u.test(sql))).toBe(true);
    const promotion = statements.find(({ sql }) => sql.includes("FROM source.order_line_staging"));
    expect(promotion?.sql).toContain("updated_at=now()");
    const publication = statements.find(({ sql }) => sql.includes("INSERT INTO dataset.version"));
    expect(publication?.parameters[0]).toBe("sales-demand-staged:10461048");
    expect(publication?.parameters[4]).toBe("2026-08-10T01:00:00.000Z");
    expect(publication?.parameters[6]).toBe(37);
    expect(JSON.parse(String(publication?.parameters[7]))).toEqual({
      watermark:"42",syncRunId:"sync:1",publicationProtocol:"staged-v1",
      sourceDigestKind:"incremental-sync-v1",syncRecordCount:3
    });
    expect(statements.some(({ sql }) => sql.includes("DELETE FROM source.order_line_staging"))).toBe(true);
    expect(statements.at(-1)?.sql).toContain("UPDATE ops.inventory_effect");
  });

  it("cleans deterministic sales staging and records the failed effect in one fenced transaction",async () => {
    const statements:{ sql:string;parameters:readonly unknown[] }[] = [];
    const query = vi.fn(async (sqlValue:unknown,parameters:readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push({ sql,parameters });
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect WHERE")) {
        return result([runningEffectRow("sales-demand.sync")]);
      }
      if (sql.includes("UPDATE source.sync_run")) return { rows:[],rowCount:1 };
      if (sql.includes("DELETE FROM source.order_line_staging")) return result();
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.failOrderSync(
      "sync:1","WDT_DATA_QUALITY_INVALID",effect,
      { stagedChunks:1,stagedRows:5000 },fence
    )).resolves.toBeUndefined();
    expect(statements[0]!.sql).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements.some(({ sql }) => sql.includes("DELETE FROM source.order_line_staging")))
      .toBe(true);
    const terminal = statements.at(-1)!;
    expect(terminal.sql).toContain("UPDATE ops.inventory_effect");
    expect(terminal.parameters[3]).toBe("failed");
    expect(terminal.parameters[6]).toBe("WDT_DATA_QUALITY_INVALID");
  });

  it("writes a forecast-risk item receipt in the same fenced product transaction",async () => {
    const statements:string[] = [];
    const query = vi.fn(async (sqlValue:unknown,parameters:readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect WHERE")) {
        return result([runningEffectRow("inventory.shop.forecast-risk.refresh")]);
      }
      if (sql.includes("INSERT INTO inventory.risk_evaluation")) {
        return result([{ evaluation_id:String(parameters[0]) }]);
      }
      if (sql.includes("INSERT INTO ops.inventory_effect_item")) {
        return { rows:[],rowCount:1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.persistForecastRiskProduct({
      forecasts:[],effect,
      risk:{
        snapshotId:"snapshot:1",shopId:"shop:1",productId:"product:1",
        evaluation:{
          policyVersion:"inventory-balanced-shadow/1.0.0",
          evaluatedAt:"2026-08-10T00:00:00.000Z",severity:"normal",
          findings:[],diagnostics:[]
        }
      }
    },fence)).resolves.toMatchObject({ incidentsUpdated:0,forecastIds:[] });
    expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements.findIndex((sql) => sql.includes("inventory.risk_evaluation")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("ops.inventory_effect_item")));
    expect(statements.at(-1)).toContain("ops.inventory_effect_item");
  });

  it("rejects a deterministic item receipt after the parent effect is terminal",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "ROLLBACK") return result();
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect WHERE")) return result([{
        ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
        status:"succeeded",result:{ status:"complete" },
        completed_at:new Date("2026-08-10T00:01:00.000Z")
      }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.recordInventoryEffectItem(effect,{
      productId:"product:1",snapshotId:"snapshot:1",status:"failed",
      code:"FORECAST_INPUT_INVALID",forecastAttempted:0,riskAttempted:0
    },fence)).rejects.toThrow("INVENTORY_EFFECT_STATE_CONFLICT");
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO ops.inventory_effect_item")
    )).toBe(false);
  });

  it("rejects forecast-risk business writes after the parent effect is terminal",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "ROLLBACK") return result();
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect WHERE")) return result([{
        ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
        status:"failed",error_code:"FORECAST_INPUT_INVALID",
        completed_at:new Date("2026-08-10T00:01:00.000Z")
      }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.persistForecastRiskProduct({
      forecasts:[],effect,
      risk:{
        snapshotId:"snapshot:1",shopId:"shop:1",productId:"product:1",
        evaluation:{
          policyVersion:"inventory-balanced-shadow/1.0.0",
          evaluatedAt:"2026-08-10T00:00:00.000Z",severity:"normal",
          findings:[],diagnostics:[]
        }
      }
    },fence)).rejects.toThrow("INVENTORY_EFFECT_STATE_CONFLICT");
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("inventory.risk_evaluation") ||
      String(sql).includes("inventory.demand_forecast") ||
      String(sql).includes("ops.inventory_effect_item")
    )).toBe(false);
  });

  it("refuses to finalize forecast-risk while any expected item receipt is missing",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("FROM ops.inventory_effect WHERE")) {
        return result([{
          ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
          progress:{ attemptedProducts:2 }
        }]);
      }
      if (sql.includes("FROM ops.inventory_effect_item")) return result([{
        status:"succeeded",counts:{
          completedProducts:1,failedProducts:0,forecastAttempted:0,forecastPersisted:0,
          riskAttempted:1,riskPersisted:1,severity:"normal"
        }
      }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.completeForecastRiskEffect(effect,{
      status:"partial",attemptedProducts:2,completedProducts:1,partialProducts:0,failedProducts:1,
      forecastWrites:{ attempted:0,persisted:0 },riskWrites:{ attempted:1,persisted:1 },
      severities:{ normal:1,warning:0,critical:0,unknown:0 }
    },fence)).rejects.toThrow("INVENTORY_EFFECT_SUMMARY_CONFLICT");
    expect(query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE ops.inventory_effect")))
      .toBe(false);
  });
});

describe("inventory effect reconciliation",() => {
  it("seals a running sales effect only after abandoning its fenced staging",async () => {
    const statements:string[] = [];
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.startsWith("SELECT operation FROM ops.inventory_effect")) {
        return result([{ operation:"sales-demand.sync" }]);
      }
      if (sql.includes("FROM ops.inventory_effect WHERE")) {
        return result([{
          ...runningEffectRow("sales-demand.sync"),
          progress:{ syncRunId:"sync:reconcile",stagedChunks:2,stagedRows:8_000 }
        }]);
      }
      if (sql.includes("UPDATE source.sync_run")) return { rows:[],rowCount:1 };
      if (sql.includes("DELETE FROM source.order_line_staging")) return result();
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);

    await expect(repository.reconcileInventoryEffect({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,effect
    })).resolves.toEqual({
      effectId:effect.effectId,operation:"sales-demand.sync",status:"failed",
      classification:"abandoned_staging"
    });
    expect(statements.findIndex((sql) => sql.includes("UPDATE source.sync_run")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("order_line_staging")));
    expect(statements.findIndex((sql) => sql.includes("order_line_staging")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("UPDATE ops.inventory_effect")));
  });

  it("seals a running forecast effect without replaying product writes",async () => {
    const statements:string[] = [];
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.startsWith("SELECT operation FROM ops.inventory_effect")) {
        return result([{ operation:"inventory.shop.forecast-risk.refresh" }]);
      }
      if (sql.includes("FROM ops.inventory_effect WHERE")) {
        return result([{
          ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
          progress:{ attemptedProducts:2,completedProducts:1,failedProducts:0 }
        }]);
      }
      if (sql.includes("FROM ops.inventory_effect_item")) return result([{
        status:"succeeded",counts:{
          completedProducts:1,failedProducts:0,
          forecastAttempted:1,forecastPersisted:1,
          riskAttempted:1,riskPersisted:1,severity:"normal"
        }
      }]);
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);

    await expect(repository.reconcileInventoryEffect({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,effect
    })).resolves.toEqual({
      effectId:effect.effectId,operation:"inventory.shop.forecast-risk.refresh",
      status:"failed",classification:"confirmed_partial"
    });
    expect(statements.some((sql) =>
      sql.includes("inventory.demand_forecast") || sql.includes("inventory.risk_evaluation")
    )).toBe(false);
  });

  it("reconstructs a complete forecast receipt when every item transaction is sealed",async () => {
    const mutableUpdates:unknown[][] = [];
    const query = vi.fn(async (sqlValue:unknown,parameters:readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.startsWith("SELECT operation FROM ops.inventory_effect")) {
        return result([{ operation:"inventory.shop.forecast-risk.refresh" }]);
      }
      if (sql.includes("FROM ops.inventory_effect WHERE")) return result([{
        ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
        progress:{ attemptedProducts:1 }
      }]);
      if (sql.includes("FROM ops.inventory_effect_item")) return result([{
        status:"succeeded",counts:{
          completedProducts:1,failedProducts:0,
          forecastAttempted:2,forecastPersisted:2,
          riskAttempted:1,riskPersisted:1,severity:"warning"
        }
      }]);
      if (sql.includes("UPDATE ops.inventory_effect")) {
        mutableUpdates.push([...parameters]);
        return { rows:[],rowCount:1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.reconcileInventoryEffect({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,effect
    })).resolves.toMatchObject({ status:"succeeded",classification:"already_terminal" });
    expect(mutableUpdates[0]).toEqual(expect.arrayContaining([
      effect.effectId,"inventory.shop.forecast-risk.refresh","succeeded"
    ]));
  });

  it("seals a zero-item running forecast as definitely not committed",async () => {
    const statements:string[] = [];
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.startsWith("SELECT operation FROM ops.inventory_effect")) {
        return result([{ operation:"inventory.shop.forecast-risk.refresh" }]);
      }
      if (sql.includes("FROM ops.inventory_effect WHERE")) return result([{
        ...runningEffectRow("inventory.shop.forecast-risk.refresh"),
        progress:{ attemptedProducts:1 }
      }]);
      if (sql.includes("FROM ops.inventory_effect_item")) return result();
      if (sql.includes("UPDATE ops.inventory_effect")) return { rows:[],rowCount:1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.reconcileInventoryEffect({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,effect
    })).resolves.toMatchObject({ status:"failed",classification:"not_committed" });
    expect(statements.some((sql) =>
      sql.includes("inventory.demand_forecast") || sql.includes("inventory.risk_evaluation")
    )).toBe(false);
  });

  it("blocks reports while any canonical domain owner is active",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("SET TRANSACTION")) return result();
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-10T00:05:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.listInventoryEffectsForReconciliation({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,limit:100
    })).rejects.toThrow("INVENTORY_EFFECT_ACTIVE_OWNER");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM ops.inventory_effect\n")))
      .toBe(false);
  });

  it("returns an authoritative empty report only after the old lease is inactive",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET TRANSACTION")) return result();
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.includes("FROM ops.inventory_effect\n")) return result();
      if (sql.includes("FROM ops.inventory_effect_item")) return result();
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    const page = await repository.listInventoryEffectsForReconciliation({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,limit:100
    });
    expect(page).toMatchObject({
      status:"empty",items:[],nextCursor:null,totalCount:0
    });
    expect(page.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("paginates more than 3250 effects without changing the canonical report",async () => {
    const rows = Array.from({ length:3_251 },(_,index) => ({
      effect_id:`inventory-effect:sha256:${index.toString(16).padStart(64,"0")}`,
      operation:"inventory.snapshot.persist" as const,
      input_digest:`sha256:${"a".repeat(64)}`,
      identity_digest:`sha256:${"b".repeat(64)}`,
      run_id:effect.runId,lease_request_id:effect.leaseRequestId,
      lease_key:fence.leaseKey,holder_id:fence.holderId,
      fencing_token:String(fence.fencingToken),status:"succeeded" as const,
      progress:{ persistedSnapshots:1 },result:{ snapshotId:`snapshot:${index}` },
      error_code:null,updated_at:new Date("2026-08-10T00:01:00.000Z"),
      completed_at:new Date("2026-08-10T00:01:00.000Z")
    }));
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET TRANSACTION")) return result();
      if (sql.includes("lease_acquisition_request")) return result([{}]);
      if (sql.includes("FROM ops.lease WHERE")) return result([{
        expires_at:new Date("2026-08-09T23:59:00.000Z"),
        server_now:new Date("2026-08-10T00:00:00.000Z")
      }]);
      if (sql.includes("FROM ops.inventory_effect\n")) return result(rows);
      if (sql.includes("FROM ops.inventory_effect_item")) return result();
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    const first = await repository.listInventoryEffectsForReconciliation({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,limit:100
    });
    const second = await repository.listInventoryEffectsForReconciliation({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,limit:100,
      cursor:first.nextCursor!
    });
    expect(first).toMatchObject({ status:"available",totalCount:3_251 });
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(100);
    expect(second.items[0]!.effectId).not.toBe(first.items.at(-1)!.effectId);
    expect(second.reportDigest).toBe(first.reportDigest);
    expect(Buffer.byteLength(JSON.stringify(first),"utf8")).toBeLessThan(1024 * 1024);
    await expect(repository.listInventoryEffectsForReconciliation({
      leaseRequestId:effect.leaseRequestId,lease:fence,runId:effect.runId,limit:100,
      cursor:{
        operation:"inventory.snapshot.persist",
        effectId:`inventory-effect:sha256:${"f".repeat(64)}`
      }
    })).rejects.toThrow("INVENTORY_EFFECT_CURSOR_INVALID");
  });
});

describe("staged WDT publication visibility",() => {
  it("does not treat a pre-v6 dataset as formally fresh",async () => {
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      expect(sql).toContain("source_kind='ecom-profit-mysql:wdt-stockout'");
      expect(sql).toContain("lineage->>'publicationProtocol'='staged-v1'");
      expect(sql).toContain("ORDER BY observed_at DESC,created_at DESC");
      return result([{
        server_now:new Date("2026-08-10T00:00:00.000Z"),
        dataset_id:null,data_version:null,source_kind:null,observed_at:null
      }]);
    });
    const repository = new InventoryRepository({ query } as unknown as Pool);
    await expect(repository.ordersFreshness({
      shop:{ id:"10461048",name:"一号店" }
    })).resolves.toMatchObject({
      status:"refresh_required",datasetId:null,dataVersion:null,source:null
    });
  });

  it.each([
    {
      label:"missing",
      datasetId:null,
      dataVersion:null,
      observedAt:null
    },
    {
      label:"stale",
      datasetId:"sales-demand-staged:10461048",
      dataVersion:"42:abcdefghijkl",
      observedAt:new Date("2026-08-09T20:59:59.000Z")
    },
    {
      label:"changed",
      datasetId:"sales-demand-staged:10461048",
      dataVersion:"43:changedvalue1",
      observedAt:new Date("2026-08-09T23:59:00.000Z")
    }
  ])("degrades a fresh baseline when the current staged publication is $label",async ({
    datasetId,dataVersion,observedAt
  }) => {
    const query = vi.fn(async () => result([{
      server_now:new Date("2026-08-10T00:00:00.000Z"),
      dataset_id:datasetId,
      data_version:dataVersion,
      source_kind:datasetId ? "ecom-profit-mysql:wdt-stockout" : null,
      observed_at:observedAt
    }]));
    const repository = new InventoryRepository({ query } as unknown as Pool);
    await expect(repository.ordersFreshness({
      shop:{ id:"10461048",name:"一号店" },
      baseline:{
        status:"fresh_reused",
        datasetId:"sales-demand-staged:10461048",
        dataVersion:"42:abcdefghijkl"
      }
    })).resolves.toMatchObject({ status:"degraded" });
  });

  it("keeps a fresh baseline only while the exact staged publication remains fresh",async () => {
    const query = vi.fn(async () => result([{
      server_now:new Date("2026-08-10T00:00:00.000Z"),
      dataset_id:"sales-demand-staged:10461048",
      data_version:"42:abcdefghijkl",
      source_kind:"ecom-profit-mysql:wdt-stockout",
      observed_at:new Date("2026-08-09T23:59:00.000Z")
    }]));
    const repository = new InventoryRepository({ query } as unknown as Pool);
    await expect(repository.ordersFreshness({
      shop:{ id:"10461048",name:"一号店" },
      baseline:{
        status:"fresh_reused",
        datasetId:"sales-demand-staged:10461048",
        dataVersion:"42:abcdefghijkl"
      }
    })).resolves.toMatchObject({ status:"fresh_reused" });
  });

  it("limits forecast order facts to an exact staged-v1 WDT publication",async () => {
    const queries:string[] = [];
    const query = vi.fn(async (sqlValue:unknown) => {
      const sql = String(sqlValue);
      queries.push(sql);
      if (sql.includes("FROM inventory.sku_binding") && sql.includes("platform_sku_id")) {
        return result();
      }
      if (sql.includes("FROM dataset.version")) return result();
      if (sql.includes("COALESCE(sum(demand_quantity)")) return result([{ quantity:"0" }]);
      if (sql.includes("count(*)::int")) return result([{ count:0 }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new InventoryRepository({ query } as unknown as Pool);
    await expect(repository.forecastInputs({
      shopId:"10461048",productId:"80001",asOf:"2026-08-10T00:00:00.000Z"
    })).resolves.toEqual([]);
    const publishedDatasetQuery = queries.find((sql) =>
      sql.includes("FROM dataset.version")
    );
    expect(publishedDatasetQuery).toContain(
      "lineage->>'publicationProtocol'='staged-v1'"
    );
    expect(publishedDatasetQuery).toContain("created_at");
    expect(publishedDatasetQuery).toContain(
      "ORDER BY observed_at DESC,created_at DESC"
    );
    for (const sql of queries.filter((value) => value.includes("source.order_line_fact"))) {
      expect(sql).toContain("source_system=");
      expect(sql).toContain("source_batch_id <=");
      expect(sql).toContain("updated_at <=");
    }
  });
});

it("keeps v1-v6 immutable and appends the authoritative effect ledger",() => {
  expect(INVENTORY_MIGRATIONS.map((migration) => migration.version)).toEqual([1,2,3,4,5,6,7]);
  expect(INVENTORY_MIGRATIONS[4]).toMatchObject({
    name:"domain-lease-acquisition-requests"
  });
  expect(INVENTORY_MIGRATIONS[4]!.sql).toContain("CREATE TABLE ops.lease_acquisition_request");
  expect(INVENTORY_MIGRATIONS[5]).toMatchObject({
    name:"published-order-staging"
  });
  expect(INVENTORY_MIGRATIONS.slice(0,6).map(({ sql }) =>
    createHash("sha256").update(sql).digest("hex")
  )).toEqual([
    "865225807b46ee2b5198c8e450b37102dbfbe35c4d0168ba396eb43fe05a2d6e",
    "70184f949d8f62a8e49ae63c650c7dd8b91d8710572b3c6e48c9133f975503ae",
    "5a0924125ce6602d81719c4485f5d0ad249cfe5c6a8fd0b41c890c3b194d2bea",
    "57b6ea5e9f1ab36bd326ba3bb2d73d8d0b5346e98df4c476814905e6e06db5c3",
    "217b699be9d249be894c1754d53c268535b299628ba022072ca317edea88cd01",
    "e59a90b7cfb6b2ddbf7208e826c2a3bb5c728e7e63287b648d125bd82818bf20"
  ]);
  const stagingMigration = INVENTORY_MIGRATIONS[5]!.sql;
  expect(stagingMigration).toContain("ALTER TABLE source.order_line_fact SET SCHEMA legacy");
  expect(stagingMigration).toContain("ALTER TABLE legacy.order_line_fact RENAME TO order_line_fact_v5");
  expect(stagingMigration).toContain("ALTER TABLE source.watermark SET SCHEMA legacy");
  expect(stagingMigration).toContain("ALTER TABLE legacy.watermark RENAME TO watermark_v5");
  expect(stagingMigration).toContain("CREATE TABLE source.order_line_fact");
  expect(stagingMigration).toContain("source_system text NOT NULL");
  expect(stagingMigration.indexOf("SET SCHEMA legacy")).toBeLessThan(
    stagingMigration.indexOf("CREATE TABLE source.order_line_fact")
  );
  expect(stagingMigration).not.toContain("DROP TABLE");
  expect(stagingMigration).not.toContain("TRUNCATE");
  expect(INVENTORY_MIGRATIONS[6]).toMatchObject({ name:"inventory-effect-ledger" });
  expect(INVENTORY_MIGRATIONS[6]!.sql).toContain("CREATE TABLE ops.inventory_effect_item");
  expect(INVENTORY_MIGRATIONS[6]!.sql).toContain("inventory_effect_reconciliation_page_idx");
});
