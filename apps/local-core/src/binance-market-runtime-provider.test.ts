import type {
  BinanceMarketCaptureRecord,
  BinanceMarketStore,
  PersistBinanceMarketCaptureInput
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import { describe, expect, it } from "vitest";
import { BinanceMarketRuntimeProvider } from "./binance-market-runtime-provider.js";

class MemoryMarketStore implements BinanceMarketStore {
  calls: PersistBinanceMarketCaptureInput[] = [];

  persistBinanceMarketCapture(input: PersistBinanceMarketCaptureInput) {
    this.calls.push(structuredClone(input));
    const capture: BinanceMarketCaptureRecord = {
      marketCaptureId: input.marketCaptureId,
      workflowRunId: input.workflowRunId,
      captureAt: input.captureAt,
      sourceUrl: input.sourceUrl,
      symbolCount: input.symbols.length,
      candleCount: input.candles.length,
      fundingCount: input.funding.length,
      referenceCount: input.references.length,
      createdAt: input.captureAt
    };
    return {
      status: "accepted" as const,
      capture,
      insertedCandleCount: input.candles.length,
      insertedFundingCount: input.funding.length
    };
  }

  getBinanceMarketCapture() { return undefined; }
}

function projects() {
  return {
    total: 1,
    succeeded: {
      count: 1,
      items: [
        {
          itemKey: "project_1001",
          output: {
            projectId: "project_1001",
            tabs: [
              {
                sourceTab: "交易历史",
                pageCount: 1,
                records: [
                  {
                    page: 1,
                    rowOrdinal: 1,
                    fields: {
                      时间: "2026-08-12 12:00:00",
                      合约: "BTCUSDT 永续"
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    failed: { count: 0, items: [] },
    unresolved: { count: 0, items: [] }
  };
}

function invocation(): RuntimeInvocation {
  return {
    invocationId: "invocation:market",
    identity: {
      runId: "run:market",
      scopePath: [],
      iterationKey: "root",
      stepKey: "market",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "binance.futures.market-reference.collect",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`
    },
    providerId: "binance-market",
    input: { projects: projects(), pageTimeZone: "Asia/Shanghai" },
    permissionSnapshot: {
      riskLevel: "R1",
      permissions: [
        "binance.futures.market.read",
        "binance.futures.market.write"
      ],
      domains: ["https://fapi.binance.com"]
    },
    deadlineAt: Date.parse("2026-08-12T06:00:00.000Z"),
    idempotencyKey: "run:market:root:market:1",
    fencingToken: 1,
    traceId: "trace:market"
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("BinanceMarketRuntimeProvider", () => {
  it("uses only fixed public GET endpoints and persists normalized UTC data", async () => {
    const store = new MemoryMarketStore();
    const requests: URL[] = [];
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(url.origin).toBe("https://fapi.binance.com");
      if (url.pathname.endsWith("/exchangeInfo")) {
        return response({
          symbols: [
            {
              symbol: "BTCUSDT",
              pair: "BTCUSDT",
              contractType: "PERPETUAL",
              status: "TRADING",
              onboardDate: 1569398400000,
              deliveryDate: 4133404800000,
              baseAsset: "BTC",
              quoteAsset: "USDT",
              marginAsset: "USDT"
            }
          ]
        });
      }
      if (url.pathname.endsWith("/klines")) {
        return response([[1786503600000, "1", "2", "0.5", "1.5", "10", 1786503659999, "15", 7, "4", "6", "0"]]);
      }
      if (url.pathname.endsWith("/fundingRate")) {
        return response([{ symbol: "BTCUSDT", fundingTime: 1786503600000, fundingRate: "0.0001", markPrice: "60000" }]);
      }
      if (url.pathname.endsWith("/premiumIndex")) {
        return response({ symbol: "BTCUSDT", markPrice: "60001", indexPrice: "60000", lastFundingRate: "0.0001", nextFundingTime: 1786532400000 });
      }
      if (url.pathname.endsWith("/openInterest")) {
        return response({ symbol: "BTCUSDT", openInterest: "12345" });
      }
      throw new Error(`Unexpected URL ${url.href}`);
    };
    const result = await new BinanceMarketRuntimeProvider(
      store,
      fetcher,
      () => new Date("2026-08-12T05:00:00.000Z")
    ).invoke(invocation(), new AbortController().signal);

    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded" });
    expect(requests.map((url) => url.pathname)).toEqual([
      "/fapi/v1/exchangeInfo",
      "/fapi/v1/klines",
      "/fapi/v1/fundingRate",
      "/fapi/v1/premiumIndex",
      "/fapi/v1/openInterest"
    ]);
    expect(store.calls[0]).toMatchObject({
      sourceUrl: "https://fapi.binance.com",
      candles: [{ symbol: "BTCUSDT", tradeCount: 7 }],
      funding: [{ symbol: "BTCUSDT", fundingRate: "0.0001" }],
      references: [{ symbol: "BTCUSDT", openInterest: "12345" }]
    });
  });

  it.each([418, 429])("stops and requests backoff on HTTP %s", async (status) => {
    const store = new MemoryMarketStore();
    const result = await new BinanceMarketRuntimeProvider(
      store,
      async () => response({ code: -1003 }, status)
    ).invoke(invocation(), new AbortController().signal);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "BINANCE_MARKET_RATE_LIMITED", retryable: true }
    });
    expect(store.calls).toHaveLength(0);
  });
});
