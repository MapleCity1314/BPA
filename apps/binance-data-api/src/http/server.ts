import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BinanceQueries } from "../application/binance-queries.js";
import { InvalidCursorError } from "../application/cursor.js";
import { QueryInputError } from "../application/binance-queries.js";
import type { ErrorEnvelope, ServiceReadiness } from "../core/contracts.js";
import { openApiDocument } from "../openapi.js";
import type { DirectBinanceAccount } from "../infrastructure/binance-signed-account-client.js";
import { unavailableDirectAccount } from "../infrastructure/binance-signed-account-client.js";

export interface BinanceDataHttpServerOptions {
  queries?: BinanceQueries;
  serviceReadiness: ServiceReadiness;
  host?: string;
  port?: number;
  bearerToken?: string;
  allowedOrigin?: string;
  requestTimeoutMs?: number;
  directAccount?: { load(signal?: AbortSignal): Promise<DirectBinanceAccount> };
}

function validAllowedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "zero://app") return value;
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password) {
    throw new Error("BINANCE_DATA_API_ALLOWED_ORIGIN_INVALID");
  }
  return origin.origin;
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string | undefined
): boolean {
  const origin = request.headers.origin;
  if (!allowedOrigin || origin !== allowedOrigin) return false;
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("vary", "Origin");
  return true;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  head: boolean
): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(head ? undefined : payload);
}

function error(
  response: ServerResponse,
  status: number,
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
  head: boolean
): void {
  const body: ErrorEnvelope = {
    error: { code, message, request_id: requestId, retryable }
  };
  json(response, status, body, head);
}

function loopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

export function createBinanceDataHttpServer(options: BinanceDataHttpServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const allowedOrigin = validAllowedOrigin(options.allowedOrigin);
  if (!loopback(host) && !options.bearerToken) {
    throw new Error("BINANCE_DATA_API_NON_LOOPBACK_REQUIRES_AUTH");
  }
  const server = createServer(
    { requestTimeout: options.requestTimeoutMs ?? 10_000, headersTimeout: 5_000, maxHeaderSize: 16_384 },
    async (request, response) => {
      const requestId = randomUUID();
      const head = request.method === "HEAD";
      const corsAllowed = applyCors(request, response, allowedOrigin);
      if (request.method === "OPTIONS") {
        const requestedMethod = request.headers["access-control-request-method"];
        if (
          !corsAllowed ||
          (requestedMethod !== "GET" && requestedMethod !== "HEAD")
        ) {
          error(response, 403, requestId, "CORS_ORIGIN_DENIED", "Origin is not allowed", false, false);
          return;
        }
        response.statusCode = 204;
        response.setHeader("access-control-allow-methods", "GET, HEAD");
        response.setHeader("access-control-allow-headers", "Authorization");
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.end();
        return;
      }
      if (request.method !== "GET" && !head) {
        response.setHeader("allow", "GET, HEAD, OPTIONS");
        error(response, 405, requestId, "METHOD_NOT_ALLOWED", "Only GET and HEAD are allowed", false, false);
        return;
      }
      if (!authorized(request, options.bearerToken)) {
        error(response, 401, requestId, "UNAUTHORIZED", "Authentication is required", false, head);
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      try {
        if (url.pathname === "/healthz") {
          json(response, 200, { status: "ok" }, head);
          return;
        }
        if (url.pathname === "/readyz") {
          json(response, 200, options.serviceReadiness, head);
          return;
        }
        if (url.pathname === "/openapi.json") {
          json(response, 200, openApiDocument, head);
          return;
        }
        if (!options.queries || !options.serviceReadiness.ready) {
          error(response, 503, requestId, "SERVICE_NOT_READY", "Binance read schema is unavailable", true, head);
          return;
        }
        const queries = options.queries;
        if (url.pathname === "/api/v1/binance/readiness") {
          json(response, 200, queries.readiness(requestId), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/overview") {
          json(response, 200, queries.overview(requestId), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/account-summary") {
          json(response, 200, queries.accountSummary(requestId), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/direct-account") {
          const direct = options.directAccount
            ? await options.directAccount.load()
            : unavailableDirectAccount(new Date().toISOString());
          json(response, 200, { meta: queries.meta(requestId), data: direct }, head);
          return;
        }
        if (url.pathname === "/api/v1/binance/account-snapshots") {
          json(response, 200, queries.accountSnapshots(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/runs") {
          json(response, 200, queries.runs(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/projects") {
          json(response, 200, queries.projects(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/positions") {
          json(response, 200, queries.positions(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/position-snapshots") {
          json(response, 200, queries.positionSnapshots(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/validations") {
          json(response, 200, queries.validations(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/market/candles") {
          json(response, 200, queries.candles(requestId, url.searchParams), head);
          return;
        }
        if (url.pathname === "/api/v1/binance/market/funding") {
          json(response, 200, queries.funding(requestId, url.searchParams), head);
          return;
        }
        const recordMatch = url.pathname.match(/^\/api\/v1\/binance\/projects\/(leader-[0-9]+)\/records$/u);
        if (recordMatch?.[1]) {
          json(response, 200, queries.records(requestId, recordMatch[1], url.searchParams), head);
          return;
        }
        const projectMatch = url.pathname.match(/^\/api\/v1\/binance\/projects\/(leader-[0-9]+)$/u);
        if (projectMatch?.[1]) {
          json(response, 200, queries.project(requestId, projectMatch[1]), head);
          return;
        }
        error(response, 404, requestId, "NOT_FOUND", "Route was not found", false, head);
      } catch (caught) {
        if (caught instanceof InvalidCursorError) {
          error(response, 400, requestId, "INVALID_CURSOR", caught.message, false, head);
          return;
        }
        if (caught instanceof QueryInputError) {
          error(response, caught.status, requestId, caught.code, caught.message, false, head);
          return;
        }
        error(response, 500, requestId, "INTERNAL_ERROR", "The read request failed", true, head);
      }
    }
  );
  return {
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 43124, host, () => {
        const address = server.address();
        resolve({ host, port: typeof address === "object" && address ? address.port : options.port ?? 43124 });
      });
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((caught) => caught ? reject(caught) : resolve()))
  };
}
