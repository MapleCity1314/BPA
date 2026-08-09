import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import {
  InventoryServiceWriterError,
  type InventoryServiceWriter,
  type InventoryWriteOperation,
  type LeaseFence
} from "./inventory-data-runtime-provider.js";
import type { JsonValue } from "@bpa/workflow-ir";

const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const STANDARD_WRITE_TIMEOUT_MS = 30_000;
const SALES_SYNC_TIMEOUT_MS = 10 * 60_000;
const FORECAST_RISK_TIMEOUT_MS = 30 * 60_000;

export function inventoryWriteTimeoutMs(
  operation: InventoryWriteOperation
): number {
  return operation === "inventory.shop.forecast-risk.refresh"
    ? FORECAST_RISK_TIMEOUT_MS
    : operation === "sales-demand.sync"
    ? SALES_SYNC_TIMEOUT_MS
    : STANDARD_WRITE_TIMEOUT_MS;
}

export interface ExternalDomainLeaseGrant {
  readonly domainKey: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly serverNow: string;
  readonly expiresAt: string;
  readonly active: boolean;
}

export interface ExternalDomainLeaseProvider {
  readonly id: string;
  acquire(input: {
    readonly requestId: string;
    readonly domainKey: string;
    readonly ownerId: string;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant>;
  renew(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant>;
  release(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
  }): Promise<ExternalDomainLeaseGrant>;
  read(domainKey: string): Promise<ExternalDomainLeaseGrant | undefined>;
}

export class ExternalDomainLeaseProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transportUncertain = false
  ) {
    super(message);
  }
}

interface ServiceResponse {
  readonly ok?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly outcomeUncertain?: unknown;
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalDomainLeaseProviderError(
      "INVENTORY_SERVICE_PROTOCOL_ERROR",
      `${label} must be an object`
    );
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ExternalDomainLeaseProviderError(
      "INVENTORY_SERVICE_PROTOCOL_ERROR",
      `${label} must be an ISO timestamp`
    );
  }
  return new Date(value).toISOString();
}

export class InventoryDomainLeaseClient
  implements ExternalDomainLeaseProvider, InventoryServiceWriter
{
  readonly id = "inventory-postgres";

  constructor(
    readonly socketPath: string,
    readonly timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    if (
      (!isAbsolute(socketPath) && !isWindowsNamedPipe(socketPath)) ||
      socketPath.length > 500
    ) {
      throw new Error("BPA_INVENTORY_SOCKET must be an absolute socket path");
    }
  }

  acquire(input: {
    readonly requestId: string;
    readonly domainKey: string;
    readonly ownerId: string;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant> {
    return this.request("domain-lease.acquire", {
      leaseKey: input.domainKey,
      requestId: input.requestId,
      holderId: input.ownerId,
      ttlSeconds: input.ttlSeconds
    }).then((result) => this.grant(result, input.domainKey, input.ownerId));
  }

  renew(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant> {
    return this.request("domain-lease.renew", {
      leaseKey: input.domainKey,
      holderId: input.ownerId,
      fencingToken: input.fencingToken,
      ttlSeconds: input.ttlSeconds
    }).then((result) =>
      this.grant(result, input.domainKey, input.ownerId, input.fencingToken)
    );
  }

  release(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
  }): Promise<ExternalDomainLeaseGrant> {
    return this.request("domain-lease.release", {
      leaseKey: input.domainKey,
      holderId: input.ownerId,
      fencingToken: input.fencingToken
    }).then((result) =>
      this.grant(result, input.domainKey, input.ownerId, input.fencingToken)
    );
  }

  async read(domainKey: string): Promise<ExternalDomainLeaseGrant | undefined> {
    const result = await this.request("domain-lease.read", {
      leaseKey: domainKey
    });
    return result === null ? undefined : this.grant(result, domainKey);
  }

  async write(
    request: {
      readonly operation: InventoryWriteOperation;
      readonly input: JsonValue;
      readonly lease: LeaseFence;
    },
    signal: AbortSignal
  ): Promise<JsonValue> {
    if (signal.aborted) {
      throw new InventoryServiceWriterError(
        "INVENTORY_SERVICE_UNAVAILABLE",
        "Inventory write was cancelled before dispatch."
      );
    }
    try {
      return (await this.request(
        request.operation,
        {
          ...(request.input as Record<string, JsonValue>),
          lease: request.lease
        },
        signal,
        this.timeoutMs === REQUEST_TIMEOUT_MS
          ? inventoryWriteTimeoutMs(request.operation)
          : this.timeoutMs
      )) as JsonValue;
    } catch (error) {
      if (error instanceof ExternalDomainLeaseProviderError) {
        throw new InventoryServiceWriterError(
          error.code,
          error.message,
          error.transportUncertain
        );
      }
      throw error;
    }
  }

  async readOrdersFreshness(
    input: {
      readonly shop: JsonValue;
      readonly baseline?: JsonValue;
    },
    signal: AbortSignal
  ): Promise<JsonValue> {
    try {
      return (await this.request(
        "inventory.orders.freshness.read",
        {
          shop:input.shop,
          ...(input.baseline === undefined ? {} : { baseline:input.baseline })
        },
        signal,
        STANDARD_WRITE_TIMEOUT_MS
      )) as JsonValue;
    } catch (error) {
      if (error instanceof ExternalDomainLeaseProviderError) {
        throw new InventoryServiceWriterError(
          error.code,
          error.message,
          error.transportUncertain
        );
      }
      throw error;
    }
  }

  private grant(
    value: unknown,
    domainKey: string,
    ownerId?: string,
    fencingToken?: number
  ): ExternalDomainLeaseGrant {
    const result = object(value, "inventory domain lease response");
    const actualDomainKey = result.leaseKey;
    const actualOwnerId = result.holderId;
    const actualFencingToken = result.fencingToken;
    if (
      actualDomainKey !== domainKey ||
      typeof actualOwnerId !== "string" ||
      !actualOwnerId ||
      (ownerId !== undefined && actualOwnerId !== ownerId) ||
      !Number.isSafeInteger(actualFencingToken) ||
      Number(actualFencingToken) < 1 ||
      (fencingToken !== undefined && actualFencingToken !== fencingToken) ||
      typeof result.active !== "boolean"
    ) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory domain lease identity is invalid"
      );
    }
    const serverNow = timestamp(result.serverNow, "serverNow");
    const expiresAt = timestamp(result.expiresAt, "expiresAt");
    return {
      domainKey,
      ownerId: actualOwnerId,
      fencingToken: Number(actualFencingToken),
      serverNow,
      expiresAt,
      active: result.active
    };
  }

  private request(
    operation: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    requestTimeoutMs = this.timeoutMs
  ): Promise<unknown> {
    const id = `core-domain-lease:${randomUUID()}`;
    const payload = Buffer.from(
      `${JSON.stringify({ id, operation, input })}\n`,
      "utf8"
    );
    if (payload.byteLength > MAX_FRAME_BYTES) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory service request exceeds 1 MiB"
      );
    }
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let body = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket?.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new ExternalDomainLeaseProviderError(
              "INVENTORY_SERVICE_UNAVAILABLE",
              "Inventory service request timed out",
              true
            )
          ),
        requestTimeoutMs
      );
      const onAbort = (): void =>
        finish(
          new ExternalDomainLeaseProviderError(
            "INVENTORY_SERVICE_UNAVAILABLE",
            "Inventory service request was cancelled after dispatch.",
            true
          )
        );
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket = createConnection(this.socketPath);
      socket.once("connect", () => socket?.write(payload));
      socket.on("data", (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (body.byteLength > MAX_FRAME_BYTES) {
          finish(
            new ExternalDomainLeaseProviderError(
              "INVENTORY_SERVICE_PROTOCOL_ERROR",
              "Inventory service response exceeds 1 MiB",
              true
            )
          );
        }
      });
      socket.once("error", (error) =>
        finish(
          new ExternalDomainLeaseProviderError(
            "INVENTORY_SERVICE_UNAVAILABLE",
            "Inventory service connection failed",
            true
          )
        )
      );
      socket.once("end", () => {
        if (settled) return;
        try {
          const response = object(
            JSON.parse(body.toString("utf8")) as ServiceResponse,
            "inventory service response"
          ) as ServiceResponse;
          if (response.ok !== true) {
            const code =
              typeof response.error?.code === "string"
                ? response.error.code
                : "INVENTORY_SERVICE_FAILED";
            const message =
              typeof response.error?.message === "string"
                ? response.error.message
                : "Inventory service request failed";
            finish(
              new ExternalDomainLeaseProviderError(
                code,
                message,
                response.error?.outcomeUncertain === true
              )
            );
            return;
          }
          if (response.id !== id) {
            finish(
              new ExternalDomainLeaseProviderError(
                "INVENTORY_SERVICE_PROTOCOL_ERROR",
                "Inventory service response id does not match the request",
                true
              )
            );
            return;
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(
            error instanceof ExternalDomainLeaseProviderError
              ? error
              : new ExternalDomainLeaseProviderError(
                  "INVENTORY_SERVICE_PROTOCOL_ERROR",
                  error instanceof Error ? error.message : String(error),
                  true
                )
          );
        }
      });
    });
  }
}
