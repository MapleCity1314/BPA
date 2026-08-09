import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import { describe, expect, it, vi } from "vitest";
import { InventoryServiceProtocol } from "./service-protocol.js";

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
});
