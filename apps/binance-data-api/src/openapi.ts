const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (name: string, description = "Read-only response") => ({
  description,
  content: { "application/json": { schema: schema(name) } }
});
const commonErrors = {
  "400": jsonResponse("ErrorEnvelope", "Invalid query or cursor"),
  "401": jsonResponse("ErrorEnvelope", "Authentication required"),
  "403": jsonResponse("ErrorEnvelope", "CORS preflight denied"),
  "404": jsonResponse("ErrorEnvelope", "Resource not found"),
  "405": jsonResponse("ErrorEnvelope", "Method not allowed"),
  "500": jsonResponse("ErrorEnvelope", "Internal read error"),
  "503": jsonResponse("ErrorEnvelope", "Read service not ready")
};
const readinessErrors = {
  "401": commonErrors["401"]
};
const limit = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }
};
const cursor = {
  name: "cursor",
  in: "query",
  schema: { type: "string", minLength: 1 },
  description: "Opaque versioned keyset cursor bound to endpoint and filters"
};
const from = { name: "from", in: "query", schema: { type: "string", format: "date-time" } };
const to = { name: "to", in: "query", schema: { type: "string", format: "date-time" } };
const alias = {
  name: "alias",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^leader-[0-9]+$" }
};
const symbol = {
  name: "symbol",
  in: "query",
  required: true,
  schema: { type: "string", pattern: "^[A-Z0-9_]{5,30}$" }
};
const sourceTab = { name: "source_tab", in: "query", schema: { type: "string" } };
const collectionRunId = { name: "collection_run_id", in: "query", schema: { type: "string" } };
const operation = (
  operationId: string,
  responseSchema: string,
  parameters: readonly object[] = [],
  responses: Readonly<Record<string, object>> = commonErrors
) => ({
  operationId,
  parameters,
  responses: { "200": jsonResponse(responseSchema), ...responses }
});
const head = (
  operationId: string,
  parameters: readonly object[] = [],
  responses: Readonly<Record<string, object>> = commonErrors
) => ({
  operationId,
  parameters,
  responses: {
    "200": { description: "Same status and headers as GET, without a body" },
    ...responses
  }
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "BPA Binance Data API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:43124" }],
  security: [{ BearerAuth: [] }, {}],
  paths: {
    "/healthz": {
      get: operation("getHealth", "HealthResponse", [], readinessErrors),
      head: head("headHealth", [], readinessErrors)
    },
    "/readyz": {
      get: operation("getServiceReadiness", "ServiceReadiness", [], readinessErrors),
      head: head("headServiceReadiness", [], readinessErrors)
    },
    "/api/v1/binance/readiness": {
      get: operation("getBinanceDataReadiness", "DataReadinessEnvelope"),
      head: head("headBinanceDataReadiness")
    },
    "/api/v1/binance/overview": {
      get: operation("getBinanceOverview", "OverviewEnvelope"),
      head: head("headBinanceOverview")
    },
    "/api/v1/binance/runs": {
      get: operation("listBinanceRuns", "RunListEnvelope", [limit, cursor]),
      head: head("headBinanceRuns", [limit, cursor])
    },
    "/api/v1/binance/projects": {
      get: operation("listBinanceProjects", "ProjectListEnvelope", [limit, cursor]),
      head: head("headBinanceProjects", [limit, cursor])
    },
    "/api/v1/binance/positions": {
      get: operation("listBinancePositions", "PositionListEnvelope", [limit, cursor]),
      head: head("headBinancePositions", [limit, cursor])
    },
    "/api/v1/binance/projects/{alias}": {
      get: operation("getBinanceProject", "ProjectEnvelope", [alias]),
      head: head("headBinanceProject", [alias])
    },
    "/api/v1/binance/projects/{alias}/records": {
      get: operation("listBinanceRecords", "RecordListEnvelope", [
        alias,
        sourceTab,
        from,
        to,
        limit,
        cursor
      ]),
      head: head("headBinanceRecords", [alias, sourceTab, from, to, limit, cursor])
    },
    "/api/v1/binance/validations": {
      get: operation("listBinanceValidations", "ValidationListEnvelope", [
        collectionRunId,
        limit,
        cursor
      ]),
      head: head("headBinanceValidations", [collectionRunId, limit, cursor])
    },
    "/api/v1/binance/market/candles": {
      get: operation("listBinanceCandles", "CandleListEnvelope", [symbol, from, to, limit, cursor]),
      head: head("headBinanceCandles", [symbol, from, to, limit, cursor])
    },
    "/api/v1/binance/market/funding": {
      get: operation("listBinanceFunding", "FundingListEnvelope", [symbol, from, to, limit, cursor]),
      head: head("headBinanceFunding", [symbol, from, to, limit, cursor])
    }
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "service token",
        description: "Required whenever the API binds to a non-loopback interface; optional on the default loopback binding."
      }
    },
    schemas: {
      JsonValue: {},
      ResponseMeta: {
        type: "object",
        required: ["request_id", "as_of", "last_success_at", "last_seen_at", "stale_status", "partial_status", "source"],
        properties: {
          request_id: { type: "string", format: "uuid" },
          as_of: { type: "string", format: "date-time" },
          last_success_at: { type: ["string", "null"], format: "date-time" },
          last_seen_at: { type: ["string", "null"], format: "date-time" },
          stale_status: { enum: ["fresh", "stale", "unknown"] },
          partial_status: { enum: ["complete", "partial", "unknown"] },
          source: { enum: ["binance_follower_copy_management", "binance_futures_public_market"] }
        },
        additionalProperties: false
      },
      Page: {
        type: "object",
        required: ["next_cursor", "has_more", "limit"],
        properties: {
          next_cursor: { type: ["string", "null"] },
          has_more: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 }
        },
        additionalProperties: false
      },
      ErrorEnvelope: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "request_id", "retryable"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              request_id: { type: "string", format: "uuid" },
              retryable: { type: "boolean" },
              details: { type: "object", additionalProperties: true }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: { status: { const: "ok" } },
        additionalProperties: false
      },
      ServiceReadiness: {
        type: "object",
        required: ["ready", "database_readable", "schema_ready", "schema_version"],
        properties: {
          ready: { type: "boolean" },
          database_readable: { type: "boolean" },
          schema_ready: { type: "boolean" },
          schema_version: { type: ["integer", "null"] }
        },
        additionalProperties: false
      },
      DataReadiness: {
        type: "object",
        required: ["ready", "collection_status", "stale_status", "partial_status", "reason_codes"],
        properties: {
          ready: { type: "boolean" },
          collection_status: { type: ["string", "null"] },
          stale_status: { enum: ["fresh", "stale", "unknown"] },
          partial_status: { enum: ["complete", "partial", "unknown"] },
          reason_codes: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      Overview: {
        type: "object",
        required: ["projectCount", "ongoingProjectCount", "endedProjectCount", "currentRecordCount", "positionSnapshotCount"],
        properties: Object.fromEntries(["projectCount", "ongoingProjectCount", "endedProjectCount", "currentRecordCount", "positionSnapshotCount"].map((name) => [name, { type: "integer", minimum: 0 }])),
        additionalProperties: false
      },
      Run: {
        type: "object",
        required: ["collectionRunId", "attemptAt", "captureAt", "status", "projectCount", "pageCount", "recordCount", "createdAt"],
        properties: {
          collectionRunId: { type: "string" }, attemptAt: { type: "string", format: "date-time" },
          captureAt: { type: "string", format: "date-time" }, status: { type: "string" },
          projectCount: { type: "integer", minimum: 0 }, pageCount: { type: "integer", minimum: 0 },
          recordCount: { type: "integer", minimum: 0 }, oldestEventTimeUtc: { type: "string", format: "date-time" },
          newestEventTimeUtc: { type: "string", format: "date-time" }, lastSuccessAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" }
        }, additionalProperties: false
      },
      Project: {
        type: "object", required: ["projectAlias", "projectStatus", "capturedAt", "summary"],
        properties: { projectAlias: { type: "string", pattern: "^leader-[0-9]+$" }, projectStatus: { enum: ["ongoing", "ended"] }, capturedAt: { type: "string", format: "date-time" }, summary: schema("JsonValue") }, additionalProperties: false
      },
      Record: {
        type: "object", required: ["recordKey", "projectAlias", "sourceTab", "fields", "firstSeenAt", "lastSeenAt"],
        properties: { recordKey: { type: "string" }, projectAlias: { type: "string" }, sourceTab: { type: "string" }, originalEventTime: { type: "string" }, eventTimeUtc: { type: "string", format: "date-time" }, pageTimeZoneAssumption: { type: "string" }, fields: schema("JsonValue"), firstSeenAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" } }, additionalProperties: false
      },
      Position: {
        type: "object", required: ["projectAlias", "symbol", "positionSide", "ordinal", "capturedAt", "fields"],
        properties: { projectAlias: { type: "string", pattern: "^leader-[0-9]+$" }, symbol: { type: "string" }, positionSide: { type: "string" }, ordinal: { type: "integer", minimum: 1 }, capturedAt: { type: "string", format: "date-time" }, fields: schema("JsonValue") }, additionalProperties: false
      },
      Validation: {
        type: "object", required: ["validationId", "collectionRunId", "checkCode", "status", "severity", "observed", "expected", "createdAt"],
        properties: { validationId: { type: "string" }, collectionRunId: { type: "string" }, checkCode: { type: "string" }, status: { enum: ["passed", "warning", "failed", "unknown"] }, severity: { enum: ["info", "warning", "error"] }, observed: schema("JsonValue"), expected: schema("JsonValue"), createdAt: { type: "string", format: "date-time" } }, additionalProperties: false
      },
      Candle: {
        type: "object", required: ["symbol", "openTimeUtc", "closeTimeUtc", "open", "high", "low", "close", "volume", "quoteVolume", "tradeCount", "firstSeenAt", "lastSeenAt"],
        properties: { symbol: { type: "string" }, openTimeUtc: { type: "string", format: "date-time" }, closeTimeUtc: { type: "string", format: "date-time" }, open: { type: "string" }, high: { type: "string" }, low: { type: "string" }, close: { type: "string" }, volume: { type: "string" }, quoteVolume: { type: "string" }, tradeCount: { type: "integer", minimum: 0 }, firstSeenAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" } }, additionalProperties: false
      },
      Funding: {
        type: "object", required: ["symbol", "fundingTimeUtc", "fundingRate", "firstSeenAt", "lastSeenAt"],
        properties: { symbol: { type: "string" }, fundingTimeUtc: { type: "string", format: "date-time" }, fundingRate: { type: "string" }, markPrice: { type: "string" }, firstSeenAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" } }, additionalProperties: false
      },
      DataReadinessEnvelope: { allOf: [schema("EnvelopeBase"), { type: "object", properties: { data: schema("DataReadiness") } }] },
      OverviewEnvelope: { allOf: [schema("EnvelopeBase"), { type: "object", properties: { data: schema("Overview") } }] },
      ProjectEnvelope: { allOf: [schema("EnvelopeBase"), { type: "object", properties: { data: schema("Project") } }] },
      EnvelopeBase: { type: "object", required: ["meta", "data"], properties: { meta: schema("ResponseMeta"), data: {} } },
      RunListEnvelope: schema("RunList"), ProjectListEnvelope: schema("ProjectList"), PositionListEnvelope: schema("PositionList"), RecordListEnvelope: schema("RecordList"), ValidationListEnvelope: schema("ValidationList"), CandleListEnvelope: schema("CandleList"), FundingListEnvelope: schema("FundingList"),
      ...Object.fromEntries(([[
        "RunList", "Run"], ["ProjectList", "Project"], ["PositionList", "Position"], ["RecordList", "Record"], ["ValidationList", "Validation"], ["CandleList", "Candle"], ["FundingList", "Funding"]
      ] as const).map(([name, item]) => [name, { type: "object", required: ["meta", "data", "page"], properties: { meta: schema("ResponseMeta"), data: { type: "array", items: schema(item) }, page: schema("Page") }, additionalProperties: false }]))
    }
  }
} as const;
