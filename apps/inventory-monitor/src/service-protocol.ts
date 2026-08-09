import { randomBytes } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { DemandForecast, InventoryRiskEvaluation } from "@bpa/inventory-domain";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import type { MysqlSalesDemandSync } from "./mysql-source.js";
import type {
  InventoryRepository,
  LeaseFence,
  PersistableDoudianSnapshot,
  PersistableRecentOrders
} from "./repository.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DOMAIN_LEASE_KEY = "inventory-production-cycle";
const MIN_DOMAIN_LEASE_TTL_SECONDS = 5;
const MAX_DOMAIN_LEASE_TTL_SECONDS = 3_600;
const OPERATIONS = [
  "health.read",
  "domain-lease.acquire",
  "domain-lease.renew",
  "domain-lease.release",
  "domain-lease.read",
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

function domainLeaseKey(value: unknown): string {
  const valueText = text(value,"leaseKey",500);
  if (valueText !== DOMAIN_LEASE_KEY) throw new Error("DOMAIN_LEASE_KEY_NOT_ALLOWED");
  return valueText;
}

function domainLeaseTtl(value: unknown): number {
  const ttlSeconds = Number(value);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_DOMAIN_LEASE_TTL_SECONDS ||
    ttlSeconds > MAX_DOMAIN_LEASE_TTL_SECONDS
  ) {
    throw new Error("DOMAIN_LEASE_TTL_INVALID");
  }
  return ttlSeconds;
}

function response(socket: Socket, value: unknown): void {
  if (!socket.destroyed && socket.writable) {
    socket.end(`${JSON.stringify(value)}\n`);
  }
}

export class InventoryServiceProtocol {
  #server: Server | undefined;
  readonly configuredShops: readonly { readonly id: string; readonly name: string }[];

  constructor(
    readonly socketPath: string,
    readonly repository: InventoryRepository,
    readonly salesSync?: MysqlSalesDemandSync,
    configuredShops?:
      | { readonly id: string; readonly name: string }
      | readonly { readonly id: string; readonly name: string }[]
  ) {
    this.configuredShops = configuredShops
      ? (Array.isArray(configuredShops) ? configuredShops : [configuredShops])
      : [];
  }

  private configuredShop(id: string, name: string): { readonly id: string; readonly name: string } {
    const exact = this.configuredShops.find((shop) => shop.id === id && shop.name === name);
    if (exact) return exact;
    const byName = this.configuredShops.filter((shop) => shop.name === name);
    if (byName.length === 1 && id.startsWith("name:")) return byName[0]!;
    throw new Error("SHOP_IDENTITY_MISMATCH");
  }

  async start(): Promise<void> {
    if (this.#server) return;
    if (!isWindowsNamedPipe(this.socketPath)) {
      await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (!isWindowsNamedPipe(this.socketPath)) {
      await chmod(this.socketPath, 0o600);
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    if (!isWindowsNamedPipe(this.socketPath)) {
      await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private accept(socket: Socket): void {
    let body = Buffer.alloc(0);
    let settled = false;
    socket.on("error", () => {
      settled = true;
    });
    const dispatch = (frame: Uint8Array): void => {
      if (settled) return;
      settled = true;
      void this.handle(frame)
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
    };
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      body = Buffer.concat([body, chunk]);
      if (body.byteLength > MAX_REQUEST_BYTES) {
        settled = true;
        response(socket, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeded 1 MiB" } });
        return;
      }
      const boundary = body.indexOf(0x0a);
      if (boundary >= 0) {
        const trailing = body.subarray(boundary + 1).toString("utf8").trim();
        if (trailing) {
          settled = true;
          response(socket, {
            ok: false,
            error: {
              code: "MULTIPLE_REQUESTS_NOT_ALLOWED",
              message: "Only one request frame is allowed per connection"
            }
          });
          return;
        }
        dispatch(body.subarray(0, boundary));
      }
    });
    socket.once("end", () => {
      dispatch(body);
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
    const writeFence = operation === "sales-demand.sync" ||
      operation === "sales-demand.recent.persist" ||
      operation === "inventory.snapshot.persist" ||
      operation === "inventory.forecast.persist" ||
      operation === "inventory.risk.persist"
      ? lease(input.lease)
      : undefined;
    let result: unknown;
    if (operation === "health.read") {
      result = await this.repository.health();
    } else if (operation === "domain-lease.acquire") {
      result = await this.repository.acquireDomainLease({
        leaseKey:domainLeaseKey(input.leaseKey),
        requestId:text(input.requestId,"requestId",200),
        holderId:text(input.holderId,"holderId",500),
        ttlSeconds:domainLeaseTtl(input.ttlSeconds)
      });
    } else if (operation === "domain-lease.renew") {
      result = await this.repository.renewDomainLease({
        leaseKey:domainLeaseKey(input.leaseKey),
        holderId:text(input.holderId,"holderId",500),
        fencingToken:lease({
          leaseKey:input.leaseKey,
          holderId:input.holderId,
          fencingToken:input.fencingToken
        }).fencingToken,
        ttlSeconds:domainLeaseTtl(input.ttlSeconds)
      });
    } else if (operation === "domain-lease.release") {
      result = await this.repository.releaseDomainLease({
        ...lease({
          leaseKey:input.leaseKey,
          holderId:input.holderId,
          fencingToken:input.fencingToken
        }),
        leaseKey:domainLeaseKey(input.leaseKey)
      });
    } else if (operation === "domain-lease.read") {
      result = await this.repository.readDomainLease(domainLeaseKey(input.leaseKey)) ?? null;
    } else if (operation === "sales-demand.sync") {
      if (!this.salesSync) throw new Error("MYSQL_SOURCE_NOT_CONFIGURED");
      const requestedShop = {
        name:text(input.shopName,"shopName",200),id:text(input.shopId,"shopId",200)
      };
      this.configuredShop(requestedShop.id, requestedShop.name);
      result = await this.salesSync.sync({
        shopName: requestedShop.name,
        expectedShopId: requestedShop.id,
        lease:writeFence!
      });
    } else if (operation === "inventory.snapshot.persist") {
      if (this.configuredShops.length === 0) throw new Error("SHOP_IDENTITY_NOT_CONFIGURED");
      const snapshot = record(input.snapshot,"snapshot") as unknown as PersistableDoudianSnapshot;
      const configuredShop = this.configuredShop(snapshot.shop.id, snapshot.shop.name);
      result = await this.repository.persistSnapshot({ ...snapshot,shop:configuredShop },writeFence!);
    } else if (operation === "sales-demand.recent.persist") {
      if (this.configuredShops.length === 0) throw new Error("SHOP_IDENTITY_NOT_CONFIGURED");
      const snapshot = record(input.snapshot,"snapshot") as unknown as PersistableRecentOrders;
      const configuredShop = this.configuredShop(snapshot.shop.id, snapshot.shop.name);
      result = await this.repository.persistRecentOrders({ ...snapshot,shop:configuredShop },writeFence!);
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
        },writeFence!)
      };
    } else {
      result = await this.repository.persistRisk({
        snapshotId: text(input.snapshotId, "snapshotId", 500),
        shopId: text(input.shopId, "shopId", 200),
        productId: text(input.productId, "productId", 200),
        evaluation: record(input.evaluation, "evaluation") as unknown as InventoryRiskEvaluation
      },writeFence!);
    }
    return { ok: true, id, result };
  }
}

export function serviceRequestId(): string {
  return randomBytes(16).toString("hex");
}
