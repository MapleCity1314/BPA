import { randomBytes } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import type { MysqlSalesDemandSync } from "./mysql-source.js";
import type {
  InventoryRepository,
  InventoryEffectIdentity,
  LeaseFence,
  PersistableDoudianSnapshot
} from "./repository.js";
import { refreshShopForecastRisk } from "./shop-forecast-risk-refresh.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DOMAIN_LEASE_KEY = "inventory-production-cycle";
const MIN_DOMAIN_LEASE_TTL_SECONDS = 5;
const MAX_DOMAIN_LEASE_TTL_SECONDS = 3_600;
const OPERATIONS = [
  "health.read",
  "domain-lease.acquire",
  "domain-lease.renew",
  "domain-lease.release",
  "domain-lease.read",
  "inventory.effect.list",
  "inventory.effect.reconcile",
  "sales-demand.sync",
  "inventory.snapshot.persist",
  "inventory.orders.freshness.read",
  "inventory.forecast-input.read",
  "inventory.shop.forecast-risk.refresh"
] as const;
type Operation = (typeof OPERATIONS)[number];

const WRITE_OPERATIONS = new Set<Operation>([
  "sales-demand.sync",
  "inventory.snapshot.persist",
  "inventory.shop.forecast-risk.refresh"
]);

class InventoryServiceOperationError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUncertain: boolean
  ) {
    super(code);
  }
}

function rawErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    (/^[A-Z][A-Z0-9_]{1,99}$/u.test(error.code) ||
      /^[A-Z0-9]{5}$/u.test(error.code))
  ) {
    return error.code;
  }
  const first = error instanceof Error
    ? error.message.split(/[:\s]/u)[0]
    : "INVENTORY_SERVICE_FAILED";
  return first && (
    /^[A-Z][A-Z0-9_]{1,99}$/u.test(first) ||
    /^[A-Z0-9]{5}$/u.test(first)
  )
    ? first
    : "INVENTORY_SERVICE_FAILED";
}

function transportFailure(error: unknown, code: string): boolean {
  const transportCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
    "57P01",
    "57P02",
    "57P03"
  ]);
  if (transportCodes.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return /timed?\s*out|timeout|connection\s+(?:lost|reset|terminated)|socket\s+hang\s+up/iu.test(
    message
  );
}

function operationError(
  operation: Operation,
  error: unknown
): InventoryServiceOperationError {
  if (error instanceof InventoryServiceOperationError) return error;
  const code = rawErrorCode(error);
  return new InventoryServiceOperationError(
    code,
    code === "SCHEDULER_LEASE_LOST" ||
      code === "INVENTORY_EFFECT_IN_PROGRESS" ||
      code === "SALES_DEMAND_PARTIAL_COMMIT" ||
      code === "INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT" ||
      ((WRITE_OPERATIONS.has(operation) || operation === "inventory.effect.reconcile") &&
        transportFailure(error, code))
  );
}

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

function exactKeys(value:Record<string,unknown>,expected:readonly string[],label:string):void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length ||
    actual.some((key,index) => key !== required[index])) {
    throw new Error(`${label.toUpperCase().replaceAll(" ","_")}_INVALID`);
  }
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function nullableText(
  value: unknown,
  label: string,
  maximum = 500
): string | null {
  return value === null ? null : text(value,label,maximum);
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

function effectIdentity(input:Record<string,unknown>):InventoryEffectIdentity {
  const effectId = text(input.effectId,"effectId",200);
  const inputDigest = text(input.inputDigest,"inputDigest",100);
  const identityDigest = text(input.identityDigest,"identityDigest",100);
  if (!/^inventory-effect:sha256:[0-9a-f]{64}$/u.test(effectId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(inputDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(identityDigest)) {
    throw new Error("INVENTORY_EFFECT_IDENTITY_INVALID");
  }
  return {
    effectId,inputDigest,identityDigest,
    runId:text(input.runId,"runId",200),
    invocationId:text(input.invocationId,"invocationId",200),
    idempotencyKey:text(input.idempotencyKey,"idempotencyKey",500),
    leaseRequestId:text(input.leaseRequestId,"leaseRequestId",200)
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
    const encoded = `${JSON.stringify(value)}\n`;
    socket.end(Buffer.byteLength(encoded,"utf8") <= MAX_RESPONSE_BYTES
      ? encoded
      : `${JSON.stringify({
          ok:false,error:{
            code:"RESPONSE_TOO_LARGE",message:"Response exceeded 1 MiB"
          }
        })}\n`);
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
        .catch((error) => {
          const classified = error instanceof InventoryServiceOperationError
            ? error
            : new InventoryServiceOperationError(rawErrorCode(error), false);
          response(socket, {
            ok: false,
            error: {
              code: classified.code,
              message: `Inventory service operation failed: ${classified.code}`,
              ...(classified.outcomeUncertain
                ? { outcomeUncertain: true }
                : {})
            }
          });
        });
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
      operation === "inventory.snapshot.persist" ||
      operation === "inventory.shop.forecast-risk.refresh"
      ? lease(input.lease)
      : undefined;
    const writeEffect = WRITE_OPERATIONS.has(operation)
      ? effectIdentity(input)
      : undefined;
    try {
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
    } else if (operation === "inventory.effect.list") {
      exactKeys(
        input,
        input.cursor === undefined
          ? ["leaseRequestId","runId","lease","limit"]
          : ["leaseRequestId","runId","lease","limit","cursor"],
        "inventory effect list input"
      );
      const leaseInput = record(input.lease,"lease");
      exactKeys(leaseInput,["leaseKey","holderId","fencingToken"],"inventory effect list lease");
      const oldLease = lease(leaseInput);
      if (input.limit !== 100) throw new Error("INVENTORY_EFFECT_PAGE_LIMIT_INVALID");
      const cursor = input.cursor === undefined
        ? undefined
        : record(input.cursor,"cursor");
      if (cursor) exactKeys(cursor,["operation","effectId"],"inventory effect list cursor");
      const cursorOperation = cursor?.operation;
      if (cursorOperation !== undefined && !WRITE_OPERATIONS.has(cursorOperation as Operation)) {
        throw new Error("INVENTORY_EFFECT_CURSOR_INVALID");
      }
      const cursorEffectId = cursor === undefined
        ? undefined
        : text(cursor.effectId,"cursor.effectId",200);
      if (cursorEffectId !== undefined &&
        !/^inventory-effect:sha256:[0-9a-f]{64}$/u.test(cursorEffectId)) {
        throw new Error("INVENTORY_EFFECT_CURSOR_INVALID");
      }
      result = await this.repository.listInventoryEffectsForReconciliation({
        leaseRequestId:text(input.leaseRequestId,"leaseRequestId",200),
        lease:{ ...oldLease,leaseKey:domainLeaseKey(oldLease.leaseKey) },
        runId:text(input.runId,"runId",200),limit:100,
        ...(cursor ? { cursor:{
          operation:cursorOperation as
            | "sales-demand.sync"
            | "inventory.snapshot.persist"
            | "inventory.shop.forecast-risk.refresh",
          effectId:cursorEffectId!
        } } : {})
      });
    } else if (operation === "inventory.effect.reconcile") {
      exactKeys(
        input,
        ["leaseRequestId","runId","lease","effect"],
        "inventory effect reconcile input"
      );
      const leaseInput = record(input.lease,"lease");
      exactKeys(
        leaseInput,
        ["leaseKey","holderId","fencingToken"],
        "inventory effect reconcile lease"
      );
      const oldLease = lease(leaseInput);
      const effectInput = record(input.effect,"effect");
      exactKeys(effectInput,[
        "effectId","inputDigest","identityDigest","runId","invocationId",
        "idempotencyKey","leaseRequestId"
      ],"inventory effect reconcile effect");
      result = await this.repository.reconcileInventoryEffect({
        leaseRequestId:text(input.leaseRequestId,"leaseRequestId",200),
        runId:text(input.runId,"runId",200),
        lease:{ ...oldLease,leaseKey:domainLeaseKey(oldLease.leaseKey) },
        effect:effectIdentity(effectInput)
      });
    } else if (operation === "sales-demand.sync") {
      if (!this.salesSync) throw new Error("MYSQL_SOURCE_NOT_CONFIGURED");
      const requestedShop = {
        name:text(input.shopName,"shopName",200),id:text(input.shopId,"shopId",200)
      };
      this.configuredShop(requestedShop.id, requestedShop.name);
      result = await this.salesSync.sync({
        shopName: requestedShop.name,
        expectedShopId: requestedShop.id,
        lease:writeFence!,effect:writeEffect!
      });
    } else if (operation === "inventory.snapshot.persist") {
      if (this.configuredShops.length === 0) throw new Error("SHOP_IDENTITY_NOT_CONFIGURED");
      const snapshot = record(input.snapshot,"snapshot") as unknown as PersistableDoudianSnapshot;
      const configuredShop = this.configuredShop(snapshot.shop.id, snapshot.shop.name);
      result = await this.repository.persistSnapshot(
        { ...snapshot,shop:configuredShop },writeEffect!,writeFence!
      );
    } else if (operation === "inventory.orders.freshness.read") {
      const requestedShop = record(input.shop,"shop");
      const shop = this.configuredShop(
        text(requestedShop.id,"shop.id",200),
        text(requestedShop.name,"shop.name",200)
      );
      const baseline = input.baseline === undefined
        ? undefined
        : record(input.baseline,"baseline");
      const baselineStatus = baseline?.status;
      if (baseline &&
        !["fresh_reused","refresh_required","refreshed","degraded"]
          .includes(String(baselineStatus))) {
        throw new Error("ORDERS_FRESHNESS_BASELINE_INVALID");
      }
      result = await this.repository.ordersFreshness({
        shop,
        ...(baseline ? { baseline:{
          status:baselineStatus as
            | "fresh_reused" | "refresh_required" | "refreshed" | "degraded",
          checkedAt:text(baseline.checkedAt,"baseline.checkedAt",100),
          datasetId:nullableText(baseline.datasetId,"baseline.datasetId"),
          dataVersion:nullableText(baseline.dataVersion,"baseline.dataVersion")
        } } : {})
      });
    } else if (operation === "inventory.forecast-input.read") {
      result = await this.repository.forecastInputs({
        shopId: text(input.shopId, "shopId", 200),
        productId: text(input.productId, "productId", 200),
        asOf: text(input.asOf, "asOf", 100)
      });
    } else {
      const requestedShop = record(input.shop,"shop");
      const shop = this.configuredShop(
        text(requestedShop.id,"shop.id",200),
        text(requestedShop.name,"shop.name",200)
      );
      result = await refreshShopForecastRisk({
        shop,
        attemptedSnapshots:Number(input.attemptedSnapshots),
        persistedSnapshots:Number(input.persistedSnapshots),
        failedSnapshots:Number(input.failedSnapshots),
        unresolvedSnapshots:Number(input.unresolvedSnapshots),
        snapshotReceipts:Array.isArray(input.snapshotReceipts)
          ? input.snapshotReceipts
          : (() => { throw new Error("INVENTORY_FORECAST_RISK_INPUT_INVALID"); })(),
        lease:writeFence!,
        effect:writeEffect!,
        repository:this.repository
      });
      }
      return { ok: true, id, result };
    } catch (error) {
      throw operationError(operation, error);
    }
  }
}

export function serviceRequestId(): string {
  return randomBytes(16).toString("hex");
}
