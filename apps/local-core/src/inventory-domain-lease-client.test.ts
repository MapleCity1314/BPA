import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalDomainLeaseProviderError,
  InventoryDomainLeaseClient
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
  const directory = mkdtempSync(join(tmpdir(), "bpa-domain-lease-"));
  const socketPath = join(directory, "inventory.sock");
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
    rmSync(directory, { recursive: true, force: true });
  });
  return socketPath;
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
    const missingPath = join(
      mkdtempSync(join(tmpdir(), "bpa-domain-lease-missing-")),
      "missing.sock"
    );
    cleanups.push(async () =>
      rmSync(dirname(missingPath), { recursive: true, force: true })
    );
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
      client.persistSnapshot(
        {
          snapshot: {
            shop: { id: "10001", name: "测试店铺" },
            product: { id: "80001" }
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

    const missingPath = join(
      mkdtempSync(join(tmpdir(), "bpa-snapshot-writer-missing-")),
      "missing.sock"
    );
    cleanups.push(async () =>
      rmSync(dirname(missingPath), { recursive: true, force: true })
    );
    const unavailable = new InventoryDomainLeaseClient(missingPath, 50);
    const error = await unavailable
      .persistSnapshot(
        {
          snapshot: { shop: { id: "10001" } },
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
});
