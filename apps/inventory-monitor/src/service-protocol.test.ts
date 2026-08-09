import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import { describe, expect, it, vi } from "vitest";
import { InventoryDomainLeaseClient } from "../../local-core/src/inventory-domain-lease-client.js";
import { InventoryServiceProtocol } from "./service-protocol.js";
import { SalesDemandPartialCommitError } from "./mysql-source.js";

const effectFields = {
  effectId:`inventory-effect:sha256:${"a".repeat(64)}`,
  inputDigest:`sha256:${"b".repeat(64)}`,
  identityDigest:`sha256:${"c".repeat(64)}`,
  runId:"run:test",invocationId:"invocation:test",
  idempotencyKey:"idempotency:test",leaseRequestId:"lease-request:test"
} as const;

async function request(socketPath: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve,reject) => {
    let body = "";
    const socket = createConnection(socketPath);
    socket.once("connect",() => socket.write(`${JSON.stringify(value)}\n`));
    socket.setEncoding("utf8");
    socket.on("data",(chunk) => { body += chunk; });
    socket.once("error",reject);
    socket.once("end",() => resolve(JSON.parse(body) as Record<string, unknown>));
  });
}

describe("inventory service protocol", () => {
  it("serves only allowlisted operations on a protected local IPC endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-test-"));
    await mkdir(directory,{ recursive:true });
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory","win32")
      : join(directory,"inventory.sock");
    const repository = { health:vi.fn(async () => ({ databaseTime:"2026-08-02T00:00:00.000Z" })) };
    const server = new InventoryServiceProtocol(socketPath,repository as never);
    await server.start();
    try {
      if (process.platform !== "win32") {
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      }
      await expect(request(socketPath,{ id:"1",operation:"health.read",input:{} })).resolves.toMatchObject({
        ok:true,id:"1",result:{ databaseTime:"2026-08-02T00:00:00.000Z" }
      });
      await expect(request(socketPath,{ id:"2",operation:"sql.execute",input:{ sql:"SELECT 1" } })).resolves.toMatchObject({
        ok:false,error:{ code:"OPERATION_NOT_ALLOWED" }
      });
      await expect(request(socketPath,{ id:"3",operation:"inventory.snapshot.persist",input:{ snapshot:{} } })).resolves.toMatchObject({
        ok:false,error:{ code:"LEASE_FENCE_INVALID" }
      });
    } finally {
      await server.close();
    }
  });

  it("maps each browser-observed shop only to its configured identity", async () => {
    const repository = {
      persistSnapshot:vi.fn(async (snapshot: unknown) => ({ snapshot }))
    };
    const server = new InventoryServiceProtocol("unused",repository as never,undefined,[
      { id:"shop-1",name:"一号店" },
      { id:"shop-2",name:"二号店" }
    ]);
    const frame = (shop: { id: string; name: string }) => Buffer.from(JSON.stringify({
      id:"persist",
      operation:"inventory.snapshot.persist",
      input:{
        ...effectFields,
        lease:{ leaseKey:"inventory-shadow:shop-2",holderId:"holder",fencingToken:1 },
        snapshot:{
          status:"complete",snapshotVersion:"1.0.0",observedAt:"2026-08-03T00:00:00.000Z",
          shop,product:{ id:"12345",title:"商品",totalStock:0 },skus:[],diagnostics:[],formMutations:0
        }
      }
    }));
    await expect(server.handle(frame({ id:"name:observed",name:"二号店" }))).resolves.toMatchObject({
      ok:true,id:"persist"
    });
    expect(repository.persistSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ shop:{ id:"shop-2",name:"二号店" } }),
      effectFields,
      { leaseKey:"inventory-shadow:shop-2",holderId:"holder",fencingToken:1 }
    );
    await expect(server.handle(frame({ id:"name:unknown",name:"未配置店" })))
      .rejects.toThrow("SHOP_IDENTITY_MISMATCH");
  });

  it("exposes only the production-cycle domain lease with bounded TTL", async () => {
    const grant = {
      leaseKey:"inventory-production-cycle",holderId:"run:1",fencingToken:7,
      serverNow:"2026-08-09T00:00:00.000Z",expiresAt:"2026-08-09T00:05:00.000Z",active:true
    };
    const repository = {
      acquireDomainLease:vi.fn(async () => grant),
      renewDomainLease:vi.fn(async () => grant),
      releaseDomainLease:vi.fn(async () => ({ ...grant,active:false })),
      readDomainLease:vi.fn(async () => grant)
    };
    const server = new InventoryServiceProtocol("unused",repository as never);
    const frame = (id:string,operation:string,input:Record<string,unknown>) =>
      Buffer.from(JSON.stringify({ id,operation,input }));

    await expect(server.handle(frame("a","domain-lease.acquire",{
      leaseKey:"inventory-production-cycle",requestId:"request:1",holderId:"run:1",ttlSeconds:300
    }))).resolves.toMatchObject({ ok:true,result:grant });
    expect(repository.acquireDomainLease).toHaveBeenCalledWith({
      leaseKey:"inventory-production-cycle",requestId:"request:1",holderId:"run:1",ttlSeconds:300
    });
    await expect(server.handle(frame("b","domain-lease.acquire",{
      leaseKey:"inventory-shadow:shop-1",requestId:"request:2",holderId:"run:2",ttlSeconds:300
    }))).rejects.toThrow("DOMAIN_LEASE_KEY_NOT_ALLOWED");
    await expect(server.handle(frame("c","domain-lease.renew",{
      leaseKey:"inventory-production-cycle",holderId:"run:1",fencingToken:7,ttlSeconds:4
    }))).rejects.toThrow("DOMAIN_LEASE_TTL_INVALID");
  });

  it("marks a sales-demand transport failure after a persisted chunk as uncertain", async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-sync-test-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-sync","win32")
      : join(directory,"inventory.sock");
    const persistedChunks:string[] = [];
    const salesSync = {
      sync:vi.fn(async () => {
        persistedChunks.push("chunk-1");
        throw new SalesDemandPartialCommitError(
          { committedChunks:1,committedRows:5_000 },
          "ORDER_SUBMITTED_AT_INVALID"
        );
      })
    };
    const server = new InventoryServiceProtocol(
      socketPath,{} as never,salesSync as never,
      { id:"shop-1",name:"一号店" }
    );
    await server.start();
    try {
      await expect(request(socketPath,{
        id:"sync-1",operation:"sales-demand.sync",input:{
          ...effectFields,
          shopId:"shop-1",shopName:"一号店",
          lease:{
            leaseKey:"inventory-production-cycle",
            holderId:"trigger-attempt:test",
            fencingToken:7
          }
        }
      })).resolves.toMatchObject({
        ok:false,
        error:{ code:"SALES_DEMAND_PARTIAL_COMMIT",outcomeUncertain:true }
      });
      expect(persistedChunks).toEqual(["chunk-1"]);
    } finally {
      await server.close();
    }
  });

  it("preserves PostgreSQL SQLSTATE on an uncertain write response", async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-pg-test-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-pg","win32")
      : join(directory,"inventory.sock");
    const repository = {
      persistSnapshot:vi.fn(async () => {
        throw Object.assign(new Error("connection terminated"),{ code:"57P01" });
      })
    };
    const server = new InventoryServiceProtocol(
      socketPath,repository as never,undefined,
      { id:"shop-1",name:"一号店" }
    );
    await server.start();
    try {
      await expect(request(socketPath,{
        id:"pg-1",operation:"inventory.snapshot.persist",input:{
          ...effectFields,
          lease:{
            leaseKey:"inventory-production-cycle",
            holderId:"trigger-attempt:test",fencingToken:7
          },
          snapshot:{
            shop:{ id:"shop-1",name:"一号店" },
            product:{ id:"80001" }
          }
        }
      })).resolves.toMatchObject({
        ok:false,error:{ code:"57P01",outcomeUncertain:true }
      });
    } finally {
      await server.close();
    }
  });

  it("marks an uncertain shop forecast-risk product transaction in the service envelope",async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-risk-test-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-risk","win32")
      : join(directory,"inventory.sock");
    const repository = {
      beginInventoryEffect:vi.fn(async () => undefined),
      recordInventoryEffectItem:vi.fn(async () => undefined),
      completeForecastRiskEffect:vi.fn(async () => undefined),
      verifiedSnapshotFacts:vi.fn(async () => [{
        productId:"80001",snapshotId:"snapshot:1",
        envelope:{
          schemaVersion:"inventory-product-fact/1.0.0",
          observedAt:"2026-08-10T00:00:00.000Z",asOf:"2026-08-10T00:00:00.000Z",
          scope:{ shopId:"shop-1",productId:"80001" },
          facts:{ productId:"80001",title:"商品",totalStock:0,skus:[] },
          quality:{ freshness:"fresh",completeness:1,mappingConfidence:"high",diagnostics:[] },
          source:{
            kind:"doudian.inventory.product.snapshot.read",datasetId:"inventory-snapshot:shop-1",
            datasetVersion:"v1",digest:"sha256:snapshot"
          }
        }
      }]),
      forecastInputs:vi.fn(async () => []),
      persistForecastRiskProduct:vi.fn(async () => {
        throw Object.assign(new Error("connection timed out"),{ code:"ETIMEDOUT" });
      })
    };
    const server = new InventoryServiceProtocol(
      socketPath,repository as never,undefined,{ id:"shop-1",name:"一号店" }
    );
    await server.start();
    try {
      await expect(request(socketPath,{
        id:"risk-1",operation:"inventory.shop.forecast-risk.refresh",input:{
          ...effectFields,
          shop:{ id:"shop-1",name:"一号店" },
          attemptedSnapshots:1,persistedSnapshots:1,failedSnapshots:0,unresolvedSnapshots:0,
          snapshotReceipts:[{ itemKey:"80001",output:{ productId:"80001",snapshotId:"snapshot:1" } }],
          lease:{
            leaseKey:"inventory-production-cycle",holderId:"trigger-attempt:test",fencingToken:7
          }
        }
      })).resolves.toMatchObject({
        ok:false,error:{
          code:"INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT",outcomeUncertain:true
        }
      });
    } finally {
      await server.close();
    }
  });

  it("marks an already-running exact effect as uncertain",async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-effect-running-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-effect-running","win32")
      : join(directory,"inventory.sock");
    const repository = {
      persistSnapshot:vi.fn(async () => { throw new Error("INVENTORY_EFFECT_IN_PROGRESS"); })
    };
    const server = new InventoryServiceProtocol(
      socketPath,repository as never,undefined,{ id:"shop-1",name:"一号店" }
    );
    await server.start();
    try {
      await expect(request(socketPath,{
        id:"effect-running",operation:"inventory.snapshot.persist",input:{
          ...effectFields,
          lease:{
            leaseKey:"inventory-production-cycle",holderId:"trigger-attempt:test",fencingToken:7
          },
          snapshot:{ shop:{ id:"shop-1",name:"一号店" },product:{ id:"80001" } }
        }
      })).resolves.toMatchObject({
        ok:false,error:{ code:"INVENTORY_EFFECT_IN_PROGRESS",outcomeUncertain:true }
      });
    } finally {
      await server.close();
    }
  });

  it("lists only controlled effect summaries for an inactive exact lease request",async () => {
    const repository = {
      listInventoryEffectsForReconciliation:vi.fn(async () => ({
        status:"available",items:[{
          effectId:effectFields.effectId,inputDigest:effectFields.inputDigest,
          identityDigest:effectFields.identityDigest,runId:effectFields.runId,
          leaseRequestId:effectFields.leaseRequestId,
          operation:"inventory.snapshot.persist",status:"succeeded",
          progressCounts:{ persistedSnapshots:1 },itemCounts:{ succeeded:0,failed:0 },
          resultDigest:`sha256:${"d".repeat(64)}`,
          errorCode:null,updatedAt:"2026-08-10T00:01:00.000Z",
          completedAt:"2026-08-10T00:01:00.000Z"
        }],nextCursor:null,totalCount:1,reportDigest:`sha256:${"e".repeat(64)}`
      }))
    };
    const server = new InventoryServiceProtocol("unused",repository as never);
    const response = await server.handle(Buffer.from(JSON.stringify({
      id:"effect-list",operation:"inventory.effect.list",input:{
        leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,limit:100,
        lease:{
          leaseKey:"inventory-production-cycle",holderId:"trigger-attempt:test",fencingToken:7
        }
      }
    })));
    expect(response).toMatchObject({
      ok:true,result:{
        status:"available",
        items:[{
          effectId:effectFields.effectId,status:"succeeded",
          progressCounts:{ persistedSnapshots:1 },itemCounts:{ succeeded:0,failed:0 }
        }]
      }
    });
    expect(JSON.stringify(response)).not.toContain(effectFields.idempotencyKey);
    expect(JSON.stringify(response)).not.toContain(effectFields.invocationId);
  });

  it("reconciles only an exact trusted effect identity",async () => {
    const repository = {
      reconcileInventoryEffect:vi.fn(async () => ({
        effectId:effectFields.effectId,
        operation:"inventory.shop.forecast-risk.refresh",
        status:"failed",
        classification:"confirmed_partial"
      }))
    };
    const server = new InventoryServiceProtocol("unused",repository as never);
    const response = await server.handle(Buffer.from(JSON.stringify({
      id:"effect-reconcile",operation:"inventory.effect.reconcile",input:{
        leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,
        lease:{
          leaseKey:"inventory-production-cycle",
          holderId:"trigger-attempt:test",fencingToken:7
        },
        effect:effectFields
      }
    })));
    expect(response).toMatchObject({
      ok:true,result:{
        effectId:effectFields.effectId,status:"failed",classification:"confirmed_partial"
      }
    });
    expect(repository.reconcileInventoryEffect).toHaveBeenCalledWith({
      leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,
      lease:{
        leaseKey:"inventory-production-cycle",
        holderId:"trigger-attempt:test",fencingToken:7
      },
      effect:effectFields
    });
    await expect(server.handle(Buffer.from(JSON.stringify({
      id:"effect-reconcile-invalid",operation:"inventory.effect.reconcile",input:{
        leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,
        lease:{
          leaseKey:"inventory-production-cycle",
          holderId:"trigger-attempt:test",fencingToken:7
        },
        effect:{ ...effectFields,extra:"forbidden" }
      }
    })))).rejects.toThrow("INVENTORY_EFFECT_RECONCILE_EFFECT_INVALID");
  });

  it("accepts the exact Core client reconciliation frame without internal operation metadata",async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-effect-reconcile-e2e-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-effect-reconcile","win32")
      : join(directory,"inventory.sock");
    const repository = {
      reconcileInventoryEffect:vi.fn(async () => ({
        effectId:effectFields.effectId,
        operation:"inventory.shop.forecast-risk.refresh",
        status:"failed",classification:"confirmed_partial"
      }))
    };
    const server = new InventoryServiceProtocol(socketPath,repository as never);
    await server.start();
    try {
      const client = new InventoryDomainLeaseClient(socketPath);
      await expect(client.reconcileInventoryEffect({
        leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,
        lease:{
          leaseKey:"inventory-production-cycle",
          holderId:"trigger-attempt:test",fencingToken:7
        },effect:effectFields
      })).resolves.toMatchObject({
        effectId:effectFields.effectId,classification:"confirmed_partial"
      });
      expect(repository.reconcileInventoryEffect).toHaveBeenCalledWith(
        expect.objectContaining({ effect:effectFields })
      );
    } finally {
      await server.close();
    }
  });

  it("keeps a 3251-effect reconciliation report inside a paged response frame",async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-effect-page-"));
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory-effect-page","win32")
      : join(directory,"inventory.sock");
    const items = Array.from({ length:100 },(_,index) => ({
      effectId:`inventory-effect:sha256:${index.toString(16).padStart(64,"0")}`,
      operation:"inventory.snapshot.persist",inputDigest:effectFields.inputDigest,
      identityDigest:effectFields.identityDigest,runId:effectFields.runId,
      leaseRequestId:effectFields.leaseRequestId,status:"succeeded",
      progressCounts:{ persistedSnapshots:1 },itemCounts:{ succeeded:0,failed:0 },
      resultDigest:`sha256:${"d".repeat(64)}`,errorCode:null,
      updatedAt:"2026-08-10T00:01:00.000Z",completedAt:"2026-08-10T00:01:00.000Z"
    }));
    const repository = {
      listInventoryEffectsForReconciliation:vi.fn(async () => ({
        status:"available",items,
        nextCursor:{
          operation:"inventory.snapshot.persist",effectId:items.at(-1)!.effectId
        },
        totalCount:3_251,reportDigest:`sha256:${"e".repeat(64)}`
      }))
    };
    const server = new InventoryServiceProtocol(socketPath,repository as never);
    await server.start();
    try {
      const frame = await request(socketPath,{
        id:"effect-page",operation:"inventory.effect.list",input:{
          leaseRequestId:effectFields.leaseRequestId,runId:effectFields.runId,limit:100,
          lease:{
            leaseKey:"inventory-production-cycle",holderId:"trigger-attempt:test",fencingToken:7
          }
        }
      });
      expect(frame).toMatchObject({
        ok:true,result:{ status:"available",totalCount:3_251,items }
      });
      expect((frame.result as { items:unknown[] }).items).toHaveLength(100);
      expect(Buffer.byteLength(JSON.stringify(frame),"utf8")).toBeLessThan(1024 * 1024);
    } finally {
      await server.close();
    }
  });
});
