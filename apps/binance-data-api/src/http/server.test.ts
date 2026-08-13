import { request } from "node:http";
import type {
  BinanceReadStore,
  BinanceReadinessRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BinanceQueries } from "../application/binance-queries.js";
import { encodeCursor } from "../application/cursor.js";
import { createBinanceDataHttpServer } from "./server.js";

const timestamp = "2026-08-13T02:00:00.000Z";

function store(readiness: BinanceReadinessRecord): BinanceReadStore {
  return {
    getBinanceReadiness: () => readiness,
    getBinanceOverview: () => ({
      projectCount: 0,
      ongoingProjectCount: 0,
      endedProjectCount: 0,
      currentRecordCount: 0,
      positionSnapshotCount: 0
    }),
    getLatestBinanceAccountSummary: () => undefined,
    listBinanceCollectionRuns: () => ({ items: [], hasMore: false }),
    listBinanceProjects: () => ({ items: [], hasMore: false }),
    getBinanceProjectByAlias: () => undefined,
    listBinanceRecords: () => ({ items: [], hasMore: false }),
    listBinancePositions: () => ({ items: [], hasMore: false }),
    listBinanceValidations: () => ({ items: [], hasMore: false }),
    listBinanceCandles: () => ({ items: [], hasMore: false }),
    listBinanceFunding: () => ({ items: [], hasMore: false }),
    getBinanceMarketWatermark: () => undefined
  };
}

async function fetchJson(
  port: number,
  path: string,
  method = "GET",
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: raw ? JSON.parse(raw) : undefined,
          raw
        });
      });
    });
    call.once("error", reject);
    call.end();
  });
}

const servers: Array<ReturnType<typeof createBinanceDataHttpServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Binance Data API transport", () => {
  it("keeps service ready while business data is not ready", async () => {
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(store({ schemaVersion: 26 }), () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    const service = await fetchJson(address.port, "/readyz");
    const data = await fetchJson(address.port, "/api/v1/binance/readiness");
    expect(service).toMatchObject({ status: 200, body: { ready: true } });
    expect(data).toMatchObject({
      status: 200,
      body: {
        data: {
          ready: false,
          reason_codes: ["NO_SUCCESSFUL_COLLECTION"]
        }
      }
    });
  });

  it("serves a project detail over GET and HEAD", async () => {
    const readStore = store({ schemaVersion: 26 });
    readStore.getBinanceProjectByAlias = () => ({
      projectAlias: "leader-01",
      projectStatus: "ongoing",
      capturedAt: timestamp,
      summary: { status: "available" }
    });
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(readStore, () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(
      address.port,
      "/api/v1/binance/projects/leader-01"
    )).resolves.toMatchObject({
      status: 200,
      body: { data: { projectAlias: "leader-01", projectStatus: "ongoing" } }
    });
    await expect(fetchJson(
      address.port,
      "/api/v1/binance/projects/leader-01",
      "HEAD"
    )).resolves.toMatchObject({ status: 200, raw: "" });
  });

  it("serves the latest structured positions through a dedicated read-only route", async () => {
    const readStore = store({ schemaVersion: 26 });
    readStore.listBinancePositions = () => ({
      items: [{
        projectAlias: "leader-01",
        symbol: "BTCUSDT",
        positionSide: "做多",
        ordinal: 1,
        capturedAt: timestamp,
        fields: { Symbol: "BTCUSDT 永续", 数量: "0.01000000" }
      }],
      hasMore: false
    });
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(readStore, () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(address.port, "/api/v1/binance/positions?limit=100"))
      .resolves.toMatchObject({
        status: 200,
        body: {
          data: [{ projectAlias: "leader-01", symbol: "BTCUSDT", ordinal: 1 }],
          page: { has_more: false, limit: 100 }
        }
      });
  });

  it("serves canonical account balances as exact decimal strings", async () => {
    const readStore = store({ schemaVersion: 26 });
    readStore.getLatestBinanceAccountSummary = () => ({
      capturedAt: timestamp,
      fields: {
        全部保证金余额: "1,234.56789000 USDT",
        钱包余额: "1,200.00000000 USDT",
        已实现总盈亏: "+34.56789000 USDT"
      }
    });
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(readStore, () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(address.port, "/api/v1/binance/account-summary"))
      .resolves.toMatchObject({
        status: 200,
        body: {
          data: {
            available: true,
            capturedAt: timestamp,
            balances: {
              asset: "USDT",
              totalMarginBalance: "1234.56789000",
              walletBalance: "1200.00000000",
              realizedPnl: "34.56789000",
              netProfit: null
            }
          }
        }
      });
  });

  it("does not turn a missing project into 500 with the real SQLite query", async () => {
    const readStore = new SqlitePersistence({ path: ":memory:" });
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(readStore, () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(
      address.port,
      "/api/v1/binance/projects/leader-01"
    )).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "NOT_FOUND" } }
    });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    readStore.close();
  });

  it("reports an unmigrated database without confusing health and readiness", async () => {
    const server = createBinanceDataHttpServer({
      serviceReadiness: {
        ready: false,
        database_readable: true,
        schema_ready: false,
        schema_version: 25
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(address.port, "/healthz")).resolves.toMatchObject({
      status: 200,
      body: { status: "ok" }
    });
    await expect(fetchJson(address.port, "/readyz")).resolves.toMatchObject({
      status: 200,
      body: { ready: false, schema_version: 25 }
    });
    await expect(fetchJson(address.port, "/api/v1/binance/overview")).resolves.toMatchObject({
      status: 503,
      body: { error: { code: "SERVICE_NOT_READY" } }
    });
  });

  it("enforces GET/HEAD, security headers and no wildcard CORS", async () => {
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(store({ schemaVersion: 26 })),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    const post = await fetchJson(address.port, "/healthz", "POST");
    expect(post).toMatchObject({
      status: 405,
      headers: {
        allow: "GET, HEAD, OPTIONS",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
    expect(post.headers["access-control-allow-origin"]).toBeUndefined();
    const head = await fetchJson(address.port, "/healthz", "HEAD");
    expect(head).toMatchObject({ status: 200, raw: "" });
  });

  it("allows only the configured exact CORS origin and its preflight", async () => {
    const allowedOrigin = "http://127.0.0.1:4173";
    const server = createBinanceDataHttpServer({
      serviceReadiness: {
        ready: false,
        database_readable: false,
        schema_ready: false,
        schema_version: null
      },
      allowedOrigin,
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    const allowed = await fetchJson(address.port, "/healthz", "GET", {
      origin: allowedOrigin
    });
    expect(allowed.headers).toMatchObject({
      "access-control-allow-origin": allowedOrigin,
      vary: "Origin"
    });
    const preflight = await fetchJson(address.port, "/healthz", "OPTIONS", {
      origin: allowedOrigin,
      "access-control-request-method": "GET"
    });
    expect(preflight).toMatchObject({
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET, HEAD",
        vary: "Origin"
      }
    });
    const headPreflight = await fetchJson(address.port, "/healthz", "OPTIONS", {
      origin: allowedOrigin,
      "access-control-request-method": "HEAD",
      "access-control-request-headers": "Authorization"
    });
    expect(headPreflight).toMatchObject({
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET, HEAD",
        "access-control-allow-headers": "Authorization"
      }
    });
    const denied = await fetchJson(address.port, "/healthz", "OPTIONS", {
      origin: "http://localhost:4173",
      "access-control-request-method": "GET"
    });
    expect(denied).toMatchObject({
      status: 403,
      body: { error: { code: "CORS_ORIGIN_DENIED" } }
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    const invalidMethod = await fetchJson(address.port, "/healthz", "OPTIONS", {
      origin: allowedOrigin,
      "access-control-request-method": "POST"
    });
    expect(invalidMethod).toMatchObject({
      status: 403,
      body: { error: { code: "CORS_ORIGIN_DENIED" } }
    });
  });

  it("uses an independent market watermark rather than follower readiness", async () => {
    const readStore = store({
      schemaVersion: 26,
      latestSuccessfulRun: {
        collectionRunId: "follower-run",
        workflowRunId: "workflow-run",
        sourceUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
        attemptAt: "2026-08-12T00:00:00.000Z",
        captureAt: "2026-08-12T00:00:00.000Z",
        status: "success",
        contentDigest: `sha256:${"a".repeat(64)}`,
        projectCount: 1,
        pageCount: 1,
        recordCount: 1,
        lastSuccessAt: "2026-08-12T00:00:00.000Z",
        createdAt: "2026-08-12T00:00:00.000Z"
      }
    });
    readStore.getBinanceMarketWatermark = () => ({
      lastSuccessAt: "2026-08-13T01:50:00.000Z",
      lastSeenAt: "2026-08-13T01:50:00.000Z"
    });
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(readStore, () => new Date(timestamp)),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    const market = await fetchJson(
      address.port,
      "/api/v1/binance/market/candles?symbol=BTCUSDT"
    );
    expect(market).toMatchObject({
      status: 200,
      body: {
        meta: {
          source: "binance_futures_public_market",
          last_success_at: "2026-08-13T01:50:00.000Z",
          last_seen_at: "2026-08-13T01:50:00.000Z",
          stale_status: "fresh",
          partial_status: "complete"
        }
      }
    });
  });

  it("rejects malformed and cross-filter cursors", async () => {
    const server = createBinanceDataHttpServer({
      queries: new BinanceQueries(store({ schemaVersion: 26 })),
      serviceReadiness: {
        ready: true,
        database_readable: true,
        schema_ready: true,
        schema_version: 26
      },
      port: 0
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetchJson(address.port, "/api/v1/binance/runs?cursor=invalid")).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_CURSOR" } }
    });
    const cursor = encodeCursor(
      "candles",
      { symbol: "BTCUSDT", fromUtc: undefined, toUtc: undefined },
      { event_time_utc: "2026-08-13T00:00:00.000Z" }
    );
    await expect(fetchJson(
      address.port,
      `/api/v1/binance/market/candles?symbol=ETHUSDT&cursor=${cursor}`
    )).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_CURSOR" } }
    });
  });

  it("requires authentication before binding outside loopback", () => {
    expect(() => createBinanceDataHttpServer({
      serviceReadiness: {
        ready: false,
        database_readable: false,
        schema_ready: false,
        schema_version: null
      },
      host: "0.0.0.0"
    })).toThrow("BINANCE_DATA_API_NON_LOOPBACK_REQUIRES_AUTH");
  });
});
