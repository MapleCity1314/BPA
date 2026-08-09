import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalDomainLeaseProviderError,
  InventoryDomainLeaseClient,
  inventoryWriteTimeoutMs
} from "./inventory-domain-lease-client.js";
import { InventoryServiceWriterError } from "./inventory-data-runtime-provider.js";

interface RequestFrame {
  readonly id: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
}

const cleanups: Array<() => Promise<void>> = [];

async function inventoryServer(
  respond: (request: RequestFrame, socket: Socket) => unknown
): Promise<string> {
  const directory = process.platform === "win32"
    ? undefined
    : mkdtempSync(join(tmpdir(), "bpa-domain-lease-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\bpa-domain-lease-${randomUUID()}`
    : join(directory!, "inventory.sock");
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
      const boundary = body.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(body.slice(0, boundary)) as RequestFrame;
      const response = respond(request, socket);
      if (response !== undefined) socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return socketPath;
}

function missingSocketPath(prefix: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${prefix}-${randomUUID()}`;
  }
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cleanups.push(async () =>
    rmSync(directory, { recursive: true, force: true })
  );
  return join(directory, "missing.sock");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leaseKey: "inventory-production-cycle",
    holderId: "trigger-attempt:test",
    fencingToken: 7,
    serverNow: "2026-08-05T00:00:00.000Z",
    expiresAt: "2026-08-05T00:05:00.000Z",
    active: true,
    ...overrides
  };
}

describe("InventoryDomainLeaseClient", () => {
  it("allows the sales sync Node deadline while bounding ordinary writes", () => {
    expect(inventoryWriteTimeoutMs("sales-demand.sync")).toBe(600_000);
    expect(inventoryWriteTimeoutMs("inventory.snapshot.persist")).toBe(30_000);
    expect(inventoryWriteTimeoutMs("inventory.shop.forecast-risk.refresh"))
      .toBe(1_800_000);
  });

  it("returns a strictly validated acquisition grant", async () => {
    const socketPath = await inventoryServer((request) => ({
      ok: true,
      id: request.id,
      result: grant()
    }));
    const client = new InventoryDomainLeaseClient(socketPath);
    await expect(
      client.acquire({
        requestId: "request:test",
        domainKey: "inventory-production-cycle",
        ownerId: "trigger-attempt:test",
        ttlSeconds: 300
      })
    ).resolves.toEqual({
      domainKey: "inventory-production-cycle",
      ownerId: "trigger-attempt:test",
      fencingToken: 7,
      serverNow: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T00:05:00.000Z",
      active: true
    });
  });

  it("rejects a mismatched response id", async () => {
    const socketPath = await inventoryServer(() => ({
      ok: true,
      id: "wrong-request",
      result: grant()
    }));
    const client = new InventoryDomainLeaseClient(socketPath);
    await expect(
      client.read("inventory-production-cycle")
    ).rejects.toMatchObject({
      code: "INVENTORY_SERVICE_PROTOCOL_ERROR",
      transportUncertain: true
    });
  });

  it.each([
    ["holder identity", { holderId: "another-owner" }],
    ["fencing token", { fencingToken: 8 }]
  ])("rejects a mismatched %s", async (_label, overrides) => {
    const socketPath = await inventoryServer((request) => ({
      ok: true,
      id: request.id,
      result: grant(overrides)
    }));
    const client = new InventoryDomainLeaseClient(socketPath);
    await expect(
      client.renew({
        domainKey: "inventory-production-cycle",
        ownerId: "trigger-attempt:test",
        fencingToken: 7,
        ttlSeconds: 300
      })
    ).rejects.toMatchObject({ code: "INVENTORY_SERVICE_PROTOCOL_ERROR" });
  });

  it("preserves a definitive busy code without marking transport uncertainty", async () => {
    const socketPath = await inventoryServer(() => ({
      ok: false,
      error: { code: "DOMAIN_LEASE_BUSY", message: "busy" }
    }));
    const client = new InventoryDomainLeaseClient(socketPath);
    const error = await client
      .acquire({
        requestId: "request:busy",
        domainKey: "inventory-production-cycle",
        ownerId: "trigger-attempt:test",
        ttlSeconds: 300
      })
      .catch((caught) => caught as ExternalDomainLeaseProviderError);
    expect(error).toMatchObject({
      code: "DOMAIN_LEASE_BUSY",
      transportUncertain: false
    });
  });

  it("marks connection and timeout failures as transport-uncertain", async () => {
    const missingPath = missingSocketPath("bpa-domain-lease-missing");
    const missing = new InventoryDomainLeaseClient(missingPath, 50);
    await expect(missing.read("inventory-production-cycle")).rejects.toMatchObject({
      code: "INVENTORY_SERVICE_UNAVAILABLE",
      message: "Inventory service connection failed",
      transportUncertain: true
    });

    const socketPath = await inventoryServer(() => undefined);
    const timedOut = new InventoryDomainLeaseClient(socketPath, 10);
    await expect(timedOut.read("inventory-production-cycle")).rejects.toMatchObject({
      code: "INVENTORY_SERVICE_UNAVAILABLE",
      transportUncertain: true
    });
  });

  it("persists a snapshot with only the trusted fence and maps uncertain transport failures", async () => {
    let received: RequestFrame | undefined;
    const socketPath = await inventoryServer((request) => {
      received = request;
      return {
        ok: true,
        id: request.id,
        result: {
          snapshotId: "snapshot:80001",
          envelope: { persisted: true }
        }
      };
    });
    const client = new InventoryDomainLeaseClient(socketPath);
    await expect(
      client.write(
        {
          operation: "inventory.snapshot.persist",
          input: {
            snapshot: {
              shop: { id: "10001", name: "测试店铺" },
              product: { id: "80001" }
            }
          },
          lease: {
            leaseKey: "inventory-production-cycle",
            holderId: "trigger-attempt:test",
            fencingToken: 7
          }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ snapshotId: "snapshot:80001" });
    expect(received).toMatchObject({
      operation: "inventory.snapshot.persist",
      input: {
        snapshot: {
          shop: { id: "10001", name: "测试店铺" },
          product: { id: "80001" }
        },
        lease: {
          leaseKey: "inventory-production-cycle",
          holderId: "trigger-attempt:test",
          fencingToken: 7
        }
      }
    });

    const missingPath = missingSocketPath("bpa-snapshot-writer-missing");
    const unavailable = new InventoryDomainLeaseClient(missingPath, 50);
    const error = await unavailable
      .write(
        {
          operation: "inventory.snapshot.persist",
          input: { snapshot: { shop: { id: "10001" } } },
          lease: {
            leaseKey: "inventory-production-cycle",
            holderId: "trigger-attempt:test",
            fencingToken: 7
          }
        },
        new AbortController().signal
      )
      .catch((caught) => caught as InventoryServiceWriterError);
    expect(error).toMatchObject({
      code: "INVENTORY_SERVICE_UNAVAILABLE",
      transportUncertain: true
    });
  });

  it("preserves a service-declared partial-commit uncertainty", async () => {
    const socketPath = await inventoryServer(() => ({
      ok:false,
      error:{
        code:"SALES_DEMAND_PARTIAL_COMMIT",
        message:"controlled",
        outcomeUncertain:true
      }
    }));
    const client = new InventoryDomainLeaseClient(socketPath);
    const error = await client.write({
      operation:"sales-demand.sync",
      input:{ shopId:"shop-1",shopName:"一号店" },
      lease:{
        leaseKey:"inventory-production-cycle",
        holderId:"trigger-attempt:test",
        fencingToken:7
      }
    },new AbortController().signal).catch(
      (caught) => caught as InventoryServiceWriterError
    );
    expect(error).toMatchObject({
      code:"SALES_DEMAND_PARTIAL_COMMIT",
      transportUncertain:true
    });
  });

  it("reads only the controlled orders-freshness projection without a fence",async () => {
    let received:RequestFrame | undefined;
    const socketPath = await inventoryServer((request) => {
      received = request;
      return {
        ok:true,id:request.id,result:{
          status:"fresh_reused",shop:{ id:"10001",name:"测试店铺" },
          checkedAt:"2026-08-09T08:00:00.000Z",maxAgeSeconds:7200,
          latestObservedAt:"2026-08-09T07:30:00.000Z",ageSeconds:1800,
          datasetId:"sales-demand-staged:10001",dataVersion:"v1",
          source:"wdt"
        }
      };
    });
    const client = new InventoryDomainLeaseClient(socketPath);
    await expect(client.readOrdersFreshness({
      shop:{ id:"10001",name:"测试店铺" }
    },new AbortController().signal)).resolves.toMatchObject({
      status:"fresh_reused",ageSeconds:1800
    });
    expect(received).toMatchObject({
      operation:"inventory.orders.freshness.read",
      input:{ shop:{ id:"10001",name:"测试店铺" } }
    });
    expect(received?.input).not.toHaveProperty("lease");
  });
});
