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
    const first = await repository.persistSnapshot(snapshot,fence);
    const replay = await repository.persistSnapshot(snapshot,fence);
    expect(replay).toEqual(first);
    expect(transactionSql).toHaveLength(2);
    for (const statements of transactionSql) {
      expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease/u);
      expect(statements[0]).toMatch(/FOR UPDATE/u);
      expect(statements[1]).toMatch(/INSERT INTO dataset\.version/u);
    }
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
    await expect(repository.persistForecast({
      shopId:"shop:1",productId:"product:1",platformSkuId:"sku:1",merchantCode:"M1",
      sourceDataset:{ id:"dataset:1",version:"v1" },
      forecast:{
        asOf:"2026-08-09T00:00:00.000Z",
        algorithmVersion:"inventory-demand-ensemble-conformal/1.0.0",
        selectedModel:"hierarchical_fallback",confidence:"low",dailyP50:0,dailyP90:0,
        horizons:[],recentAcceleration:1,trainingHours:0,diagnostics:[]
      }
    },fence)).rejects.toThrow("SCHEDULER_LEASE_LOST");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO inventory.demand_forecast")))
      .toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
  });

  it("validates the fence in the same transaction as each MySQL order chunk",async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push(sql);
      if (sql.includes("SELECT 1 FROM ops.lease")) return { rows:[{}],rowCount:1 };
      if (sql.includes("jsonb_to_recordset")) return result([{ inserted:"1",updated:"0" }]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query,release:vi.fn() };
    const repository = new InventoryRepository({
      connect:vi.fn(async () => client)
    } as unknown as Pool);
    await expect(repository.upsertOrderChunk([{
      shopId:"shop:1",shopName:"一号店",childOrderId:"order:1",productId:"product:1",
      merchantCode:"M1",specification:"默认",submittedAt:"2026-08-09T00:00:00.000Z",
      orderStatus:"已支付",aftersalesStatus:"",sourceQuantity:1,demandQuantity:1,
      sourceBatchId:1,sourceRowHash:"sha256:row",sourceLoadedAt:"2026-08-09T00:00:01.000Z"
    }],fence)).resolves.toEqual({ inserted:1,updated:0 });
    expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements[1]).toMatch(/jsonb_to_recordset/u);
  });
});

it("adds the request ledger as an append-only migration",() => {
  expect(INVENTORY_MIGRATIONS.map((migration) => migration.version)).toEqual([1,2,3,4,5]);
  expect(INVENTORY_MIGRATIONS[4]).toMatchObject({
    name:"domain-lease-acquisition-requests"
  });
  expect(INVENTORY_MIGRATIONS[4]!.sql).toContain("CREATE TABLE ops.lease_acquisition_request");
});
