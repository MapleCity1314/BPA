import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type {
  BinanceMarketStore,
  OperationalExecutionContext,
  PersistBinanceMarketCaptureInput
} from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const NODE_ID = "binance.futures.market-reference.collect";
const NODE_VERSION = "1.0.0";
const PERMISSIONS = [
  "binance.futures.market.read",
  "binance.futures.market.write"
] as const;
const BASE_URL = "https://fapi.binance.com";
const MAX_REQUESTS = 20_000;
const TIME_FIELDS = ["时间", "成交时间", "资金费时间", "Time"] as const;
const SYMBOL_FIELDS = ["合约", "交易对", "Symbol"] as const;

type JsonObject = Record<string, JsonValue>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

class BinanceMarketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

function object(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function integer(value: JsonValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`
  ).join(",")}}`;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function stableId(prefix: string, value: JsonValue): string {
  return `${prefix}:${digest(value).slice("sha256:".length)}`;
}

function instant(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Binance timestamp is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function wallClockInstant(value: string, timeZone: string): string | undefined {
  try {
    return Temporal.Instant.from(value).toString();
  } catch {
    // The authenticated zh-CN page uses local wall-clock strings.
  }
  const match = value.match(
    /^(\d{4})[-\/]([01]\d)[-\/]([0-3]\d)[ T]([0-2]\d):([0-5]\d):([0-5]\d)$/u
  );
  if (!match) return undefined;
  try {
    return Temporal.PlainDateTime.from({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6])
    }).toZonedDateTime(timeZone).toInstant().toString();
  } catch {
    return undefined;
  }
}

function firstString(fields: JsonObject, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeSymbol(value: string): string | undefined {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/gu, " ");
  const candidates = compact.split(/\s+/u).filter(Boolean);
  return candidates.find((candidate) =>
    /^[A-Z0-9]{5,30}$/u.test(candidate) &&
    /(USDT|USDC|BUSD)$/u.test(candidate)
  );
}

function successfulOutputs(value: JsonValue): JsonObject[] {
  const outcome = object(value, "projects");
  const total = integer(outcome.total, "projects.total");
  const succeeded = object(outcome.succeeded ?? null, "projects.succeeded");
  const failed = object(outcome.failed ?? null, "projects.failed");
  const unresolved = object(outcome.unresolved ?? null, "projects.unresolved");
  const outputs = array(succeeded.items, "projects.succeeded.items");
  if (
    integer(succeeded.count, "projects.succeeded.count") !== outputs.length ||
    integer(failed.count, "projects.failed.count") !== 0 ||
    integer(unresolved.count, "projects.unresolved.count") !== 0 ||
    outputs.length !== total
  ) {
    throw new Error("Market collection requires complete project coverage");
  }
  return outputs.map((item) =>
    object(object(item, "project item").output ?? null, "project output")
  );
}

function projectReferences(
  projects: JsonValue,
  pageTimeZone: string,
  fallbackEnd: number
): { symbols: string[]; startTime: number; endTime: number } {
  const symbols = new Set<string>();
  const eventTimes: number[] = [];
  for (const output of successfulOutputs(projects)) {
    for (const tabValue of array(output.tabs, "detail tabs")) {
      const tab = object(tabValue, "detail tab");
      for (const recordValue of array(tab.records, "detail records")) {
        const fields = object(object(recordValue, "detail record").fields ?? null, "fields");
        const rawSymbol = firstString(fields, SYMBOL_FIELDS);
        const symbol = rawSymbol ? normalizeSymbol(rawSymbol) : undefined;
        if (symbol) symbols.add(symbol);
        const rawTime = firstString(fields, TIME_FIELDS);
        const normalized = rawTime ? wallClockInstant(rawTime, pageTimeZone) : undefined;
        if (normalized) eventTimes.push(Date.parse(normalized));
      }
    }
  }
  const buffer = 60 * 60 * 1000;
  return {
    symbols: [...symbols].sort(),
    startTime: Math.max(0, (eventTimes.length ? Math.min(...eventTimes) : fallbackEnd - 2 * buffer) - buffer),
    endTime: (eventTimes.length ? Math.max(...eventTimes) : fallbackEnd) + buffer
  };
}

function executionContext(invocation: RuntimeInvocation): OperationalExecutionContext {
  return {
    invocationId: invocation.invocationId,
    identity: invocation.identity,
    node: invocation.node,
    idempotencyKey: invocation.idempotencyKey,
    fencingToken: invocation.fencingToken
  };
}

function succeeded(output: JsonValue): RuntimeOutcome {
  return { status: "succeeded", output, evidence: [], riskSignals: [] };
}

function failure(error: unknown): RuntimeOutcome {
  const known = error instanceof BinanceMarketError ? error : undefined;
  return {
    status: "failed",
    error: {
      code: known?.code ?? "BINANCE_MARKET_COLLECTION_FAILED",
      message: known?.message ??
        (error instanceof Error
          ? `Binance market collection stopped: ${error.message}`
          : "Binance market collection stopped."),
      retryable: known?.retryable ?? false
    },
    evidence: [],
    riskSignals: []
  };
}

export function isBinanceMarketNode(id: string, version: string): boolean {
  return id === NODE_ID && version === NODE_VERSION;
}

export class BinanceMarketRuntimeProvider implements RuntimeProvider {
  readonly id = "binance-market";

  constructor(
    readonly store: BinanceMarketStore,
    readonly fetcher: Fetcher = fetch,
    readonly now: () => Date = () => new Date()
  ) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return isBinanceMarketNode(node.id, node.version);
  }

  async #json(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    requestBudget: { count: number }
  ): Promise<JsonValue> {
    if (requestBudget.count >= MAX_REQUESTS) {
      throw new BinanceMarketError(
        "BINANCE_MARKET_REQUEST_LIMIT_EXCEEDED",
        "Binance market request safety limit was reached.",
        false
      );
    }
    const url = new URL(path, BASE_URL);
    if (url.origin !== BASE_URL || !url.pathname.startsWith("/fapi/v1/")) {
      throw new Error("Binance market URL is outside the allowlist");
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    requestBudget.count += 1;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      });
    } catch (error) {
      if (signal.aborted) throw new BinanceMarketError("CANCELLED", "Binance market collection was cancelled.", false);
      throw new BinanceMarketError(
        "BINANCE_MARKET_NETWORK_FAILURE",
        `Binance public market request failed: ${error instanceof Error ? error.name : "network error"}`,
        true
      );
    }
    if (response.status === 418 || response.status === 429) {
      throw new BinanceMarketError(
        "BINANCE_MARKET_RATE_LIMITED",
        `Binance public market API returned HTTP ${response.status}; backoff is required.`,
        true
      );
    }
    if (!response.ok) {
      throw new BinanceMarketError(
        "BINANCE_MARKET_HTTP_FAILURE",
        `Binance public market API returned HTTP ${response.status}.`,
        response.status >= 500
      );
    }
    try {
      return await response.json() as JsonValue;
    } catch {
      throw new BinanceMarketError(
        "BINANCE_MARKET_STRUCTURE_CHANGED",
        "Binance public market API did not return valid JSON.",
        false
      );
    }
  }

  async invoke(invocation: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeOutcome> {
    if (!this.supports(invocation.node)) {
      return failure(new BinanceMarketError("BINANCE_MARKET_NODE_UNSUPPORTED", "Binance market Node id and version are not exact.", false));
    }
    if (
      invocation.permissionSnapshot.riskLevel !== "R1" ||
      invocation.permissionSnapshot.domains.length !== 1 ||
      invocation.permissionSnapshot.domains[0] !== BASE_URL ||
      invocation.permissionSnapshot.permissions.length !== PERMISSIONS.length ||
      PERMISSIONS.some((permission, index) =>
        invocation.permissionSnapshot.permissions[index] !== permission
      )
    ) {
      return failure(new BinanceMarketError("BINANCE_MARKET_PERMISSION_MISMATCH", "Binance market permission snapshot is not exact.", false));
    }
    const requestBudget = { count: 0 };
    try {
      const input = object(invocation.input, "market input");
      const pageTimeZone = text(input.pageTimeZone, "pageTimeZone");
      Temporal.Now.zonedDateTimeISO(pageTimeZone);
      const captureAt = this.now().toISOString();
      const range = projectReferences(input.projects ?? null, pageTimeZone, Date.parse(captureAt));
      const exchangeInfo = object(await this.#json("/fapi/v1/exchangeInfo", {}, signal, requestBudget), "exchangeInfo");
      const exchangeSymbols = array(exchangeInfo.symbols, "exchangeInfo.symbols");
      const knownSymbols = new Map<string, JsonObject>();
      for (const symbolValue of exchangeSymbols) {
        const symbol = object(symbolValue, "exchange symbol");
        knownSymbols.set(text(symbol.symbol, "exchange symbol.symbol"), symbol);
      }
      const missing = range.symbols.filter((symbol) => !knownSymbols.has(symbol));
      if (missing.length > 0) {
        throw new BinanceMarketError(
          "BINANCE_MARKET_SYMBOL_MISSING",
          `Binance exchangeInfo does not contain referenced symbols: ${missing.join(",")}`,
          false
        );
      }
      const rawCandles: JsonValue[] = [];
      const rawFunding: JsonValue[] = [];
      const rawReferences: JsonValue[] = [];
      const candles: PersistBinanceMarketCaptureInput["candles"][number][] = [];
      const funding: PersistBinanceMarketCaptureInput["funding"][number][] = [];
      const references: PersistBinanceMarketCaptureInput["references"][number][] = [];
      for (const symbol of range.symbols) {
        let cursor = range.startTime;
        while (cursor <= range.endTime) {
          const payload = array(await this.#json("/fapi/v1/klines", {
            symbol,
            interval: "1m",
            startTime: String(cursor),
            endTime: String(range.endTime),
            limit: "1500"
          }, signal, requestBudget), "klines");
          rawCandles.push({ symbol, rows: payload });
          if (payload.length === 0) break;
          for (const rowValue of payload) {
            const row = array(rowValue, "kline row");
            if (row.length < 11) throw new Error("Kline row structure changed");
            candles.push({
              symbol,
              openTimeUtc: instant(integer(row[0], "kline open time")),
              closeTimeUtc: instant(integer(row[6], "kline close time")),
              open: text(row[1], "kline open"),
              high: text(row[2], "kline high"),
              low: text(row[3], "kline low"),
              close: text(row[4], "kline close"),
              volume: text(row[5], "kline volume"),
              quoteVolume: text(row[7], "kline quote volume"),
              tradeCount: integer(row[8], "kline trade count")
            });
          }
          const last = array(payload.at(-1), "last kline");
          const next = integer(last[0], "last kline open time") + 60_000;
          if (next <= cursor) throw new Error("Kline pagination did not advance");
          cursor = next;
          if (payload.length < 1500) break;
        }
        cursor = range.startTime;
        while (cursor <= range.endTime) {
          const payload = array(await this.#json("/fapi/v1/fundingRate", {
            symbol,
            startTime: String(cursor),
            endTime: String(range.endTime),
            limit: "1000"
          }, signal, requestBudget), "funding rates");
          rawFunding.push({ symbol, rows: payload });
          if (payload.length === 0) break;
          for (const itemValue of payload) {
            const item = object(itemValue, "funding rate");
            funding.push({
              symbol: text(item.symbol, "funding symbol"),
              fundingTimeUtc: instant(integer(item.fundingTime, "funding time")),
              fundingRate: text(item.fundingRate, "funding rate"),
              ...(typeof item.markPrice === "string" ? { markPrice: item.markPrice } : {})
            });
          }
          const last = object(payload.at(-1)!, "last funding rate");
          const next = integer(last.fundingTime, "last funding time") + 1;
          if (next <= cursor) throw new Error("Funding pagination did not advance");
          cursor = next;
          if (payload.length < 1000) break;
        }
        const premium = object(await this.#json("/fapi/v1/premiumIndex", { symbol }, signal, requestBudget), "premium index");
        const openInterest = object(await this.#json("/fapi/v1/openInterest", { symbol }, signal, requestBudget), "open interest");
        rawReferences.push({ symbol, premium, openInterest });
        references.push({
          symbol,
          markPrice: text(premium.markPrice, "markPrice"),
          indexPrice: text(premium.indexPrice, "indexPrice"),
          lastFundingRate: text(premium.lastFundingRate, "lastFundingRate"),
          ...(typeof premium.nextFundingTime === "number" && premium.nextFundingTime > 0
            ? { nextFundingTimeUtc: instant(premium.nextFundingTime) }
            : {}),
          ...(typeof openInterest.openInterest === "string"
            ? { openInterest: openInterest.openInterest }
            : {}),
          observedAt: captureAt
        });
      }
      const symbolSnapshots = exchangeSymbols.map((symbolValue) => {
        const symbol = object(symbolValue, "exchange symbol");
        return {
          symbol: text(symbol.symbol, "symbol"),
          pair: text(symbol.pair, "pair"),
          contractType: text(symbol.contractType, "contractType"),
          status: text(symbol.status, "status"),
          ...(typeof symbol.onboardDate === "number"
            ? { onboardDateUtc: instant(symbol.onboardDate) }
            : {}),
          ...(typeof symbol.deliveryDate === "number"
            ? { deliveryDateUtc: instant(symbol.deliveryDate) }
            : {}),
          baseAsset: text(symbol.baseAsset, "baseAsset"),
          quoteAsset: text(symbol.quoteAsset, "quoteAsset"),
          marginAsset: text(symbol.marginAsset, "marginAsset")
        };
      });
      const candlesPayload: JsonValue = { klines: rawCandles, funding: rawFunding };
      const referencesPayload: JsonValue = rawReferences;
      const marketCaptureId = stableId("binance-market", {
        workflowRunId: invocation.identity.runId,
        idempotencyKey: invocation.idempotencyKey
      });
      const persisted = this.store.persistBinanceMarketCapture({
        marketCaptureId,
        workflowRunId: invocation.identity.runId,
        captureAt,
        sourceUrl: BASE_URL,
        symbolsPayload: exchangeInfo,
        symbolsDigest: digest(exchangeInfo),
        candlesPayload,
        candlesDigest: digest(candlesPayload),
        referencesPayload,
        referencesDigest: digest(referencesPayload),
        symbols: symbolSnapshots,
        candles,
        funding,
        references,
        executionContext: executionContext(invocation)
      });
      return succeeded({
        status: "success",
        marketCaptureId,
        captureAt,
        referencedSymbolCount: range.symbols.length,
        symbolMetadataCount: persisted.capture.symbolCount,
        candleCount: persisted.capture.candleCount,
        insertedCandleCount: persisted.insertedCandleCount,
        fundingCount: persisted.capture.fundingCount,
        insertedFundingCount: persisted.insertedFundingCount,
        referenceCount: persisted.capture.referenceCount,
        requestCount: requestBudget.count,
        windowStartUtc: instant(range.startTime),
        windowEndUtc: instant(range.endTime),
        duplicate: persisted.status === "duplicate"
      });
    } catch (error) {
      return failure(error);
    }
  }
}
