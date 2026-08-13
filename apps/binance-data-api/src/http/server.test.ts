import { request } from "node:http";
import type {
  BinanceReadStore,
  BinanceReadinessRecord
} from "@bpa/persistence";
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
      currentRecordCount: 0
    }),
    listBinanceCollectionRuns: () => ({ items: [], hasMore: false }),
    listBinanceProjects: () => ({ items: [], hasMore: false }),
    getBinanceProjectByAlias: () => undefined,
    listBinanceRecords: () => ({ items: [], hasMore: false }),
    listBinanceValidations: () => ({ items: [], hasMore: false }),
    listBinanceCandles: () => ({ items: [], hasMore: false }),
    listBinanceFunding: () => ({ items: [], hasMore: false })
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
    const denied = await fetchJson(address.port, "/healthz", "OPTIONS", {
      origin: "http://localhost:4173",
      "access-control-request-method": "GET"
    });
    expect(denied).toMatchObject({
      status: 403,
      body: { error: { code: "CORS_ORIGIN_DENIED" } }
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("uses independent unknown freshness metadata for public market data", async () => {
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
    const market = await fetchJson(
      address.port,
      "/api/v1/binance/market/candles?symbol=BTCUSDT"
    );
    expect(market).toMatchObject({
      status: 200,
      body: {
        meta: {
          source: "binance_futures_public_market",
          last_success_at: null,
          stale_status: "unknown",
          partial_status: "unknown"
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
