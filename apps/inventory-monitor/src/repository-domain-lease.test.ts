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
      if (sql.includes("SELECT 1 FROM source.sync_run")) return { rows:[{}],rowCount:1 };
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
    },fence)).resolves.toEqual({ inserted:1,updated:0 });
    expect(statements[0]).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements[1]).toMatch(/source\.sync_run/u);
    expect(statements[2]).toMatch(/source\.order_line_staging/u);
  });

  it("promotes staging and publishes its lineage in one fenced transaction",async () => {
    const statements:{ sql:string;parameters:readonly unknown[] }[] = [];
    const query = vi.fn(async (sqlValue:unknown,parameters:readonly unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result();
      statements.push({ sql,parameters });
      if (sql.includes("SELECT 1 FROM ops.lease")) return result([{}]);
      if (sql.includes("SELECT 1 FROM source.sync_run")) return result([{}]);
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
      observedAt:"2026-08-10T01:00:00.000Z"
    },fence)).resolves.toMatchObject({ inserted:2,updated:1 });
    expect(statements[0]!.sql).toMatch(/SELECT 1 FROM ops\.lease[\s\S]*FOR UPDATE/u);
    expect(statements[1]!.sql).toMatch(/source\.sync_run[\s\S]*status='running'[\s\S]*FOR UPDATE/u);
    expect(statements[2]!.sql).toContain("FROM source.order_line_staging");
    expect(statements[2]!.sql).toContain("updated_at=now()");
    const publication = statements.find(({ sql }) => sql.includes("INSERT INTO dataset.version"));
    expect(publication?.parameters[0]).toBe("sales-demand-staged:10461048");
    expect(publication?.parameters[4]).toBe("2026-08-10T01:00:00.000Z");
    expect(publication?.parameters[6]).toBe(37);
    expect(JSON.parse(String(publication?.parameters[7]))).toEqual({
      watermark:"42",syncRunId:"sync:1",publicationProtocol:"staged-v1",
      sourceDigestKind:"incremental-sync-v1",syncRecordCount:3
    });
    expect(statements.at(-1)?.sql).toContain("DELETE FROM source.order_line_staging");
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

it("keeps v1-v5 immutable and archives ambiguous v5 order facts before staged publication",() => {
  expect(INVENTORY_MIGRATIONS.map((migration) => migration.version)).toEqual([1,2,3,4,5,6]);
  expect(INVENTORY_MIGRATIONS[4]).toMatchObject({
    name:"domain-lease-acquisition-requests"
  });
  expect(INVENTORY_MIGRATIONS[4]!.sql).toContain("CREATE TABLE ops.lease_acquisition_request");
  expect(INVENTORY_MIGRATIONS[5]).toMatchObject({
    name:"published-order-staging"
  });
  expect(INVENTORY_MIGRATIONS.slice(0,5).map(({ sql }) =>
    createHash("sha256").update(sql).digest("hex")
  )).toEqual([
    "865225807b46ee2b5198c8e450b37102dbfbe35c4d0168ba396eb43fe05a2d6e",
    "70184f949d8f62a8e49ae63c650c7dd8b91d8710572b3c6e48c9133f975503ae",
    "5a0924125ce6602d81719c4485f5d0ad249cfe5c6a8fd0b41c890c3b194d2bea",
    "57b6ea5e9f1ab36bd326ba3bb2d73d8d0b5346e98df4c476814905e6e06db5c3",
    "217b699be9d249be894c1754d53c268535b299628ba022072ca317edea88cd01"
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
});
