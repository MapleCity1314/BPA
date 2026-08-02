import { randomBytes } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { DemandForecast, InventoryRiskEvaluation } from "@bpa/inventory-domain";
import type { MysqlSalesDemandSync } from "./mysql-source.js";
import type {
  InventoryRepository,
  LeaseFence,
  PersistableDoudianSnapshot,
  PersistableRecentOrders
} from "./repository.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const OPERATIONS = [
  "health.read",
  "sales-demand.sync",
  "sales-demand.recent.persist",
  "inventory.snapshot.persist",
  "inventory.forecast-input.read",
  "inventory.forecast.persist",
  "inventory.risk.persist"
] as const;
type Operation = (typeof OPERATIONS)[number];

interface ServiceRequest {
  readonly id: string;
  readonly operation: Operation;
  readonly input: Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function lease(value: unknown): LeaseFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LEASE_FENCE_INVALID");
  const candidate = value as Record<string, unknown>;
  const fencingToken = Number(candidate.fencingToken);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new Error("LEASE_FENCE_INVALID");
  return {
    leaseKey:text(candidate.leaseKey,"lease.leaseKey",500),
    holderId:text(candidate.holderId,"lease.holderId",500),
    fencingToken
  };
}

function response(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

export class InventoryServiceProtocol {
  #server: Server | undefined;

  constructor(
    readonly socketPath: string,
    readonly repository: InventoryRepository,
    readonly salesSync?: MysqlSalesDemandSync,
    readonly configuredShop?: { readonly id: string; readonly name: string }
  ) {}

  async start(): Promise<void> {
    if (this.#server) return;
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private accept(socket: Socket): void {
    let body = Buffer.alloc(0);
    let settled = false;
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      body = Buffer.concat([body, chunk]);
      if (body.byteLength > MAX_REQUEST_BYTES) {
        settled = true;
        response(socket, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeded 1 MiB" } });
      }
    });
    socket.once("end", () => {
      if (settled) return;
      settled = true;
      void this.handle(body)
        .then((result) => response(socket, result))
        .catch((error) =>
          response(socket, {
            ok: false,
            error: {
              code: error instanceof Error ? error.message.split(/[:\s]/u)[0] : "INVENTORY_SERVICE_FAILED",
              message: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
            }
          })
        );
    });
  }

  async handle(bytes: Uint8Array): Promise<Record<string, unknown>> {
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_REQUEST_BYTES) {
      throw new Error("REQUEST_SIZE_INVALID");
    }
    const parsed = record(JSON.parse(Buffer.from(bytes).toString("utf8")), "request");
    const id = text(parsed.id, "request.id", 200);
    const operation = text(parsed.operation, "request.operation", 100) as Operation;
    if (!OPERATIONS.includes(operation)) throw new Error("OPERATION_NOT_ALLOWED");
    const input = record(parsed.input, "request.input");
    const writeFence = operation === "health.read" || operation === "inventory.forecast-input.read"
      ? undefined
      : lease(input.lease);
    if (writeFence) await this.repository.assertLease(writeFence);
    let result: unknown;
    if (operation === "health.read") {
      result = await this.repository.health();
    } else if (operation === "sales-demand.sync") {
      if (!this.salesSync) throw new Error("MYSQL_SOURCE_NOT_CONFIGURED");
      const requestedShop = {
        name:text(input.shopName,"shopName",200),id:text(input.shopId,"shopId",200)
      };
      if (this.configuredShop && (
        requestedShop.id !== this.configuredShop.id || requestedShop.name !== this.configuredShop.name
      )) throw new Error("SHOP_IDENTITY_MISMATCH");
      result = await this.salesSync.sync({
        shopName: requestedShop.name,
        expectedShopId: requestedShop.id,
        lease:writeFence!
      });
    } else if (operation === "inventory.snapshot.persist") {
      if (!this.configuredShop) throw new Error("SHOP_IDENTITY_NOT_CONFIGURED");
      const snapshot = record(input.snapshot,"snapshot") as unknown as PersistableDoudianSnapshot;
      if (snapshot.shop.name !== this.configuredShop.name) throw new Error("SHOP_IDENTITY_MISMATCH");
      result = await this.repository.persistSnapshot({ ...snapshot,shop:this.configuredShop });
    } else if (operation === "sales-demand.recent.persist") {
      if (!this.configuredShop) throw new Error("SHOP_IDENTITY_NOT_CONFIGURED");
      const snapshot = record(input.snapshot,"snapshot") as unknown as PersistableRecentOrders;
      if (snapshot.shop.name !== this.configuredShop.name) throw new Error("SHOP_IDENTITY_MISMATCH");
      result = await this.repository.persistRecentOrders({ ...snapshot,shop:this.configuredShop });
    } else if (operation === "inventory.forecast-input.read") {
      result = await this.repository.forecastInputs({
        shopId: text(input.shopId, "shopId", 200),
        productId: text(input.productId, "productId", 200),
        asOf: text(input.asOf, "asOf", 100)
      });
    } else if (operation === "inventory.forecast.persist") {
      result = {
        forecastId: await this.repository.persistForecast({
          shopId: text(input.shopId, "shopId", 200),
          productId: text(input.productId, "productId", 200),
          platformSkuId: text(input.platformSkuId, "platformSkuId", 200),
          merchantCode: text(input.merchantCode, "merchantCode", 200),
          sourceDataset: record(input.sourceDataset, "sourceDataset") as { id: string; version: string },
          forecast: record(input.forecast, "forecast") as unknown as DemandForecast
        })
      };
    } else {
      result = await this.repository.persistRisk({
        snapshotId: text(input.snapshotId, "snapshotId", 500),
        shopId: text(input.shopId, "shopId", 200),
        productId: text(input.productId, "productId", 200),
        evaluation: record(input.evaluation, "evaluation") as unknown as InventoryRiskEvaluation
      });
    }
    return { ok: true, id, result };
  }
}

export function serviceRequestId(): string {
  return randomBytes(16).toString("hex");
}
