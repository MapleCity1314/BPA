export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "BPA Binance Data API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:43124" }],
  paths: Object.fromEntries([
    "/healthz",
    "/readyz",
    "/api/v1/binance/readiness",
    "/api/v1/binance/overview",
    "/api/v1/binance/runs",
    "/api/v1/binance/projects",
    "/api/v1/binance/projects/{alias}",
    "/api/v1/binance/projects/{alias}/records",
    "/api/v1/binance/validations",
    "/api/v1/binance/market/candles",
    "/api/v1/binance/market/funding"
  ].map((path) => [path, {
    get: { responses: { "200": { description: "Read-only response" } } },
    head: { responses: { "200": { description: "Headers only" } } }
  }]))
} as const;
