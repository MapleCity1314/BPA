import type {
  BinanceReadStore,
  BinanceRecordSeek,
  BinanceRunSeek,
  BinanceProjectSeek,
  BinanceValidationSeek,
  BinanceMarketSeek
} from "@bpa/persistence";
import {
  BINANCE_SOURCE,
  BINANCE_MARKET_SOURCE,
  type DataReadiness,
  type PartialStatus,
  type PublicBinanceRun,
  type ResponseMeta,
  type StaleStatus,
  type SuccessEnvelope
} from "../core/contracts.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const SUCCESS = new Set(["success", "authenticated_but_no_data"]);
const PARTIAL = new Set([
  "page_not_updated_yet",
  "required_field_missing",
  "pagination_failed",
  "partial_collection"
]);

function limitValue(value: string | null): number {
  if (value === null) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new QueryInputError("INVALID_LIMIT", "limit must be between 1 and 500");
  }
  return parsed;
}

function utc(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new QueryInputError("INVALID_TIME", `${label} must be UTC ISO 8601`);
  }
  return value;
}

function staleStatus(lastSuccessAt: string | undefined, now: Date): StaleStatus {
  if (!lastSuccessAt) return "unknown";
  return now.getTime() - Date.parse(lastSuccessAt) <= 30 * 60_000
    ? "fresh"
    : "stale";
}

function partialStatus(status: string | undefined): PartialStatus {
  if (!status) return "unknown";
  if (SUCCESS.has(status)) return "complete";
  return PARTIAL.has(status) ? "partial" : "unknown";
}

function publicRun(run: ReturnType<BinanceReadStore["listBinanceCollectionRuns"]>["items"][number]): PublicBinanceRun {
  const { workflowRunId: _workflowRunId, sourceUrl: _sourceUrl, contentDigest: _contentDigest, ...rest } = run;
  return rest;
}

export class BinanceQueries {
  constructor(
    private readonly store: BinanceReadStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  meta(requestId: string): ResponseMeta {
    const readiness = this.store.getBinanceReadiness();
    const latestSuccess = readiness.latestSuccessfulRun;
    return {
      request_id: requestId,
      as_of: this.now().toISOString(),
      last_success_at: latestSuccess?.lastSuccessAt ?? null,
      stale_status: staleStatus(latestSuccess?.lastSuccessAt, this.now()),
      partial_status: partialStatus(readiness.latestRun?.status),
      source: BINANCE_SOURCE
    };
  }

  marketMeta(requestId: string): ResponseMeta {
    return {
      request_id: requestId,
      as_of: this.now().toISOString(),
      last_success_at: null,
      stale_status: "unknown",
      partial_status: "unknown",
      source: BINANCE_MARKET_SOURCE
    };
  }

  readiness(requestId: string): SuccessEnvelope<DataReadiness> {
    const record = this.store.getBinanceReadiness();
    const meta = this.meta(requestId);
    const reasons: string[] = [];
    if (!record.latestSuccessfulRun) reasons.push("NO_SUCCESSFUL_COLLECTION");
    if (meta.stale_status === "stale") reasons.push("DATA_STALE");
    if (meta.partial_status === "partial") reasons.push("LATEST_COLLECTION_PARTIAL");
    const status = record.latestRun?.status ?? null;
    if (status === "login_required") reasons.push("LOGIN_REQUIRED");
    if (status === "captcha_or_risk_control") reasons.push("CAPTCHA_OR_RISK_CONTROL");
    return {
      meta,
      data: {
        ready:
          record.latestSuccessfulRun !== undefined &&
          meta.stale_status === "fresh" &&
          meta.partial_status === "complete",
        collection_status: status,
        stale_status: meta.stale_status,
        partial_status: meta.partial_status,
        reason_codes: reasons
      }
    };
  }

  overview(requestId: string): SuccessEnvelope<ReturnType<BinanceReadStore["getBinanceOverview"]>> {
    return { meta: this.meta(requestId), data: this.store.getBinanceOverview() };
  }

  runs(requestId: string, params: URLSearchParams) {
    const endpoint = "runs";
    const limit = limitValue(params.get("limit"));
    const filters = {};
    const seek = decodeCursor(params.get("cursor") ?? undefined, endpoint, filters, ["capture_at", "collection_run_id"]);
    const page = this.store.listBinanceCollectionRuns({
      limit,
      ...(seek
        ? { after: { captureAt: seek.capture_at!, collectionRunId: seek.collection_run_id! } satisfies BinanceRunSeek }
        : {})
    });
    return {
      meta: this.meta(requestId),
      data: page.items.map(publicRun),
      page: {
        next_cursor: page.nextSeek
          ? encodeCursor(endpoint, filters, {
              capture_at: page.nextSeek.captureAt,
              collection_run_id: page.nextSeek.collectionRunId
            })
          : null,
        has_more: page.hasMore,
        limit
      }
    };
  }

  projects(requestId: string, params: URLSearchParams) {
    const endpoint = "projects";
    const limit = limitValue(params.get("limit"));
    const filters = {};
    const seek = decodeCursor(params.get("cursor") ?? undefined, endpoint, filters, ["project_alias"]);
    const page = this.store.listBinanceProjects({
      limit,
      ...(seek ? { after: { projectAlias: seek.project_alias! } satisfies BinanceProjectSeek } : {})
    });
    return {
      meta: this.meta(requestId),
      data: page.items,
      page: {
        next_cursor: page.nextSeek
          ? encodeCursor(endpoint, filters, { project_alias: page.nextSeek.projectAlias })
          : null,
        has_more: page.hasMore,
        limit
      }
    };
  }

  project(requestId: string, alias: string) {
    const item = this.store.getBinanceProjectByAlias(alias);
    if (!item) throw new QueryInputError("NOT_FOUND", "Project was not found", 404);
    return { meta: this.meta(requestId), data: item };
  }

  records(requestId: string, alias: string, params: URLSearchParams) {
    const endpoint = "records";
    const sourceTab = params.get("source_tab") ?? undefined;
    const fromUtc = utc(params.get("from"), "from");
    const toUtc = utc(params.get("to"), "to");
    const limit = limitValue(params.get("limit"));
    const filters = { alias, sourceTab, fromUtc, toUtc };
    const seek = decodeCursor(params.get("cursor") ?? undefined, endpoint, filters, ["event_time_key", "record_key"]);
    const page = this.store.listBinanceRecords({
      projectAlias: alias,
      limit,
      ...(sourceTab ? { sourceTab } : {}),
      ...(fromUtc ? { fromUtc } : {}),
      ...(toUtc ? { toUtc } : {}),
      ...(seek ? { after: { eventTimeKey: seek.event_time_key!, currentRecordKey: seek.record_key! } satisfies BinanceRecordSeek } : {})
    });
    return {
      meta: this.meta(requestId),
      data: page.items,
      page: {
        next_cursor: page.nextSeek
          ? encodeCursor(endpoint, filters, { event_time_key: page.nextSeek.eventTimeKey, record_key: page.nextSeek.currentRecordKey })
          : null,
        has_more: page.hasMore,
        limit
      }
    };
  }

  validations(requestId: string, params: URLSearchParams) {
    const endpoint = "validations";
    const collectionRunId = params.get("collection_run_id") ?? undefined;
    const limit = limitValue(params.get("limit"));
    const filters = { collectionRunId };
    const seek = decodeCursor(params.get("cursor") ?? undefined, endpoint, filters, ["created_at", "validation_id"]);
    const page = this.store.listBinanceValidations({
      limit,
      ...(collectionRunId ? { collectionRunId } : {}),
      ...(seek ? { after: { createdAt: seek.created_at!, validationId: seek.validation_id! } satisfies BinanceValidationSeek } : {})
    });
    return listEnvelope(requestId, this.meta(requestId), endpoint, filters, limit, page, (next) => ({ created_at: next.createdAt, validation_id: next.validationId }));
  }

  candles(requestId: string, params: URLSearchParams) {
    return this.market(requestId, params, "candles");
  }

  funding(requestId: string, params: URLSearchParams) {
    return this.market(requestId, params, "funding");
  }

  private market(requestId: string, params: URLSearchParams, kind: "candles" | "funding") {
    const symbol = params.get("symbol");
    if (!symbol || !/^[A-Z0-9_]{5,30}$/u.test(symbol)) {
      throw new QueryInputError("INVALID_SYMBOL", "symbol is required");
    }
    const fromUtc = utc(params.get("from"), "from");
    const toUtc = utc(params.get("to"), "to");
    const limit = limitValue(params.get("limit"));
    const filters = { symbol, fromUtc, toUtc };
    const seek = decodeCursor(params.get("cursor") ?? undefined, kind, filters, ["event_time_utc"]);
    const options = {
      symbol,
      limit,
      ...(fromUtc ? { fromUtc } : {}),
      ...(toUtc ? { toUtc } : {}),
      ...(seek ? { after: { eventTimeUtc: seek.event_time_utc! } satisfies BinanceMarketSeek } : {})
    };
    if (kind === "candles") {
      const page = this.store.listBinanceCandles(options);
      return listEnvelope(requestId, this.marketMeta(requestId), kind, filters, limit, page, (next) => ({ event_time_utc: next.eventTimeUtc }));
    }
    const page = this.store.listBinanceFunding(options);
    return listEnvelope(requestId, this.marketMeta(requestId), kind, filters, limit, page, (next) => ({ event_time_utc: next.eventTimeUtc }));
  }
}

function listEnvelope<T, TSeek>(
  _requestId: string,
  meta: ResponseMeta,
  endpoint: string,
  filters: Readonly<Record<string, string | undefined>>,
  limit: number,
  page: { items: readonly T[]; nextSeek?: TSeek; hasMore: boolean },
  seek: (value: TSeek) => Record<string, string>
) {
  return {
    meta,
    data: page.items,
    page: {
      next_cursor: page.nextSeek ? encodeCursor(endpoint, filters, seek(page.nextSeek)) : null,
      has_more: page.hasMore,
      limit
    }
  };
}

export class QueryInputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "QueryInputError";
  }
}
