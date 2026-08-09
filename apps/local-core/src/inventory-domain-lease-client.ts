import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import {
  InventoryServiceWriterError,
  type InventoryServiceWriter,
  type InventoryEffectIdentity,
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

export interface InventoryEffectSummary {
  readonly effectId: string;
  readonly operation: InventoryWriteOperation;
  readonly inputDigest: string;
  readonly identityDigest: string;
  readonly runId: string;
  readonly leaseRequestId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly progressCounts: Readonly<Record<string, number>>;
  readonly itemCounts: {
    readonly succeeded: number;
    readonly failed: number;
  };
  readonly resultDigest: string | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface InventoryEffectReconciliationReport {
  readonly status: "empty" | "available";
  readonly effects: readonly InventoryEffectSummary[];
  readonly reportDigest: string;
}

export interface InventoryEffectReconciliationResult {
  readonly effectId: string;
  readonly operation: InventoryWriteOperation;
  readonly status: "succeeded" | "failed";
  readonly classification:
    | "already_terminal"
    | "abandoned_staging"
    | "not_committed"
    | "confirmed_partial";
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

  async inspectInventoryEffects(input: {
    readonly leaseRequestId: string;
    readonly runId: string;
    readonly lease: LeaseFence;
  }): Promise<InventoryEffectReconciliationReport> {
    const effects: InventoryEffectSummary[] = [];
    let cursor: { operation: InventoryWriteOperation; effectId: string } | undefined;
    let totalCount: number | undefined;
    let reportDigest: string | undefined;
    let status: "empty" | "available" | undefined;
    do {
      const result = object(await this.request("inventory.effect.list", {
        ...input,
        limit: 100,
        ...(cursor ? { cursor } : {})
      }), "inventory effect reconciliation response");
      const allowedTopLevel = new Set([
        "status", "items", "nextCursor", "totalCount", "reportDigest"
      ]);
      const items = result.items;
      const pageTotal = result.totalCount;
      const pageDigest = result.reportDigest;
      const pageStatus = result.status;
      if (
        Object.keys(result).length !== allowedTopLevel.size ||
        Object.keys(result).some((key) => !allowedTopLevel.has(key)) ||
        (pageStatus !== "empty" && pageStatus !== "available") ||
        !Array.isArray(items) || items.length > 100 ||
        !Number.isSafeInteger(pageTotal) || Number(pageTotal) < 0 ||
        Number(pageTotal) > 10_000 ||
        typeof pageDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(pageDigest) ||
        (pageStatus === "empty") !== (Number(pageTotal) === 0) ||
        (totalCount !== undefined && totalCount !== pageTotal) ||
        (reportDigest !== undefined && reportDigest !== pageDigest) ||
        (status !== undefined && status !== pageStatus)
      ) {
        throw new ExternalDomainLeaseProviderError(
          "INVENTORY_SERVICE_PROTOCOL_ERROR",
          "Inventory effect reconciliation page is invalid"
        );
      }
      totalCount = Number(pageTotal);
      reportDigest = pageDigest;
      status = pageStatus;
      const page = items.map((value) => this.effectSummary(
        value,
        input.runId,
        input.leaseRequestId
      ));
      const previous = effects.at(-1);
      if (
        page.length === 0 && result.nextCursor !== null ||
        previous && page[0] && this.compareEffects(previous, page[0]) >= 0 ||
        page.some((value, index) =>
          index > 0 && this.compareEffects(page[index - 1]!, value) >= 0
        )
      ) {
        throw new ExternalDomainLeaseProviderError(
          "INVENTORY_SERVICE_PROTOCOL_ERROR",
          "Inventory effect reconciliation page is not ordered"
        );
      }
      effects.push(...page);
      if (result.nextCursor === null) {
        cursor = undefined;
      } else {
        const next = object(result.nextCursor, "inventory effect reconciliation cursor");
        const last = page.at(-1);
        if (
          Object.keys(next).length !== 2 ||
          typeof next.operation !== "string" ||
          typeof next.effectId !== "string" ||
          !last || next.operation !== last.operation || next.effectId !== last.effectId
        ) {
          throw new ExternalDomainLeaseProviderError(
            "INVENTORY_SERVICE_PROTOCOL_ERROR",
            "Inventory effect reconciliation cursor is invalid"
          );
        }
        cursor = { operation: last.operation, effectId: last.effectId };
      }
      if (!cursor && effects.length !== totalCount) {
        throw new ExternalDomainLeaseProviderError(
          "INVENTORY_SERVICE_PROTOCOL_ERROR",
          "Inventory effect reconciliation result is incomplete"
        );
      }
    } while (cursor);
    const canonicalReportDigest =
      `sha256:${createHash("sha256").update(JSON.stringify(effects)).digest("hex")}`;
    if (canonicalReportDigest !== reportDigest) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory effect reconciliation digest does not match its receipts"
      );
    }
    return { status: status!, effects, reportDigest };
  }

  async reconcileInventoryEffect(input: {
    readonly leaseRequestId: string;
    readonly runId: string;
    readonly lease: LeaseFence;
    readonly effect: InventoryEffectIdentity;
  }): Promise<InventoryEffectReconciliationResult> {
    const result = object(
      await this.request("inventory.effect.reconcile", input),
      "inventory effect reconciliation result"
    );
    const allowed = new Set(["effectId","operation","status","classification"]);
    if (
      Object.keys(result).length !== allowed.size ||
      Object.keys(result).some((key) => !allowed.has(key)) ||
      result.effectId !== input.effect.effectId ||
      ![
        "sales-demand.sync",
        "inventory.snapshot.persist",
        "inventory.shop.forecast-risk.refresh"
      ].includes(String(result.operation)) ||
      (result.status !== "succeeded" && result.status !== "failed") ||
      ![
        "already_terminal",
        "abandoned_staging",
        "not_committed",
        "confirmed_partial"
      ].includes(String(result.classification))
    ) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory effect reconciliation result is invalid"
      );
    }
    return result as unknown as InventoryEffectReconciliationResult;
  }

  private compareEffects(
    left: Pick<InventoryEffectSummary, "operation" | "effectId">,
    right: Pick<InventoryEffectSummary, "operation" | "effectId">
  ): number {
    return left.operation.localeCompare(right.operation) ||
      left.effectId.localeCompare(right.effectId);
  }

  async write(
    request: {
      readonly operation: InventoryWriteOperation;
      readonly input: JsonValue;
      readonly lease: LeaseFence;
      readonly effect: InventoryEffectIdentity;
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
          effectId: request.effect.effectId,
          inputDigest: request.effect.inputDigest,
          identityDigest: request.effect.identityDigest,
          runId: request.effect.runId,
          invocationId: request.effect.invocationId,
          idempotencyKey: request.effect.idempotencyKey,
          leaseRequestId: request.effect.leaseRequestId,
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

  private effectSummary(
    value: unknown,
    runId: string,
    leaseRequestId: string
  ): InventoryEffectSummary {
    const result = object(value, "inventory effect summary");
    const keys = new Set([
      "effectId", "operation", "inputDigest", "identityDigest", "runId",
      "leaseRequestId", "status", "progressCounts", "itemCounts",
      "resultDigest", "errorCode", "updatedAt", "completedAt"
    ]);
    if (Object.keys(result).length !== keys.size ||
      Object.keys(result).some((key) => !keys.has(key))) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory effect summary is not exact"
      );
    }
    const operation = result.operation;
    const effectStatus = result.status;
    const progress = object(result.progressCounts, "inventory effect progress counts");
    const allowedCounts = new Set([
      "stagedChunks", "stagedRows", "publishedRows", "persistedSnapshots",
      "attemptedProducts", "completedProducts", "partialProducts",
      "failedProducts"
    ]);
    const itemCounts = object(result.itemCounts, "inventory effect item counts");
    const nonnegativeInteger = (candidate: unknown): candidate is number =>
      Number.isSafeInteger(candidate) && Number(candidate) >= 0;
    const digestOrNull = (candidate: unknown): candidate is string | null =>
      candidate === null ||
      (typeof candidate === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate));
    const errorCode = result.errorCode;
    const completedAt = result.completedAt;
    if (
      typeof result.effectId !== "string" ||
      !/^inventory-effect:sha256:[0-9a-f]{64}$/u.test(result.effectId) ||
      !["sales-demand.sync", "inventory.snapshot.persist",
        "inventory.shop.forecast-risk.refresh"].includes(String(operation)) ||
      typeof result.inputDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(result.inputDigest) ||
      typeof result.identityDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(result.identityDigest) ||
      result.runId !== runId || result.leaseRequestId !== leaseRequestId ||
      !["running", "succeeded", "failed"].includes(String(effectStatus)) ||
      Object.keys(progress).some((key) => !allowedCounts.has(key)) ||
      Object.values(progress).some((count) => !nonnegativeInteger(count)) ||
      Object.keys(itemCounts).length !== 2 ||
      !nonnegativeInteger(itemCounts.succeeded) ||
      !nonnegativeInteger(itemCounts.failed) ||
      !digestOrNull(result.resultDigest) ||
      !(errorCode === null ||
        (typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(errorCode))) ||
      typeof result.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(result.updatedAt)) ||
      !(completedAt === null ||
        (typeof completedAt === "string" && Number.isFinite(Date.parse(completedAt)))) ||
      (effectStatus === "running" &&
        (result.resultDigest !== null || errorCode !== null || completedAt !== null)) ||
      (effectStatus === "succeeded" &&
        (result.resultDigest === null || errorCode !== null || completedAt === null)) ||
      (effectStatus === "failed" &&
        (result.resultDigest !== null || errorCode === null || completedAt === null))
    ) {
      throw new ExternalDomainLeaseProviderError(
        "INVENTORY_SERVICE_PROTOCOL_ERROR",
        "Inventory effect summary is invalid"
      );
    }
    return {
      effectId: result.effectId,
      operation: operation as InventoryWriteOperation,
      inputDigest: result.inputDigest,
      identityDigest: result.identityDigest,
      runId,
      leaseRequestId,
      status: effectStatus as InventoryEffectSummary["status"],
      progressCounts: progress as Record<string, number>,
      itemCounts: {
        succeeded: itemCounts.succeeded as number,
        failed: itemCounts.failed as number
      },
      resultDigest: result.resultDigest,
      errorCode,
      updatedAt: result.updatedAt,
      completedAt
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
