import type {
  BinanceCollectionRunRecord,
  BinanceProjectReadRecord,
  BinancePositionReadRecord,
  BinanceRecordReadRecord,
  BinanceValidationReadRecord,
  BinanceCandleReadRecord,
  BinanceFundingReadRecord
} from "@bpa/persistence";

export const BINANCE_SOURCE = "binance_follower_copy_management" as const;
export const BINANCE_MARKET_SOURCE = "binance_futures_public_market" as const;

export type StaleStatus = "fresh" | "stale" | "unknown";
export type PartialStatus = "complete" | "partial" | "unknown";

export interface ResponseMeta {
  request_id: string;
  as_of: string;
  last_success_at: string | null;
  last_seen_at: string | null;
  stale_status: StaleStatus;
  partial_status: PartialStatus;
  source: typeof BINANCE_SOURCE | typeof BINANCE_MARKET_SOURCE;
}

export interface ResponsePage {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface SuccessEnvelope<T> {
  meta: ResponseMeta;
  data: T;
  page?: ResponsePage;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, string | number | boolean | null>;
  };
}

export interface ServiceReadiness {
  ready: boolean;
  database_readable: boolean;
  schema_ready: boolean;
  schema_version: number | null;
}

export interface DataReadiness {
  ready: boolean;
  collection_status: string | null;
  stale_status: StaleStatus;
  partial_status: PartialStatus;
  reason_codes: readonly string[];
}

export interface PublicBinanceAccountSummary {
  available: boolean;
  capturedAt: string | null;
  balances: {
    totalMarginBalance: string | null;
    walletBalance: string | null;
    realizedPnl: string | null;
    netProfit: string | null;
    asset: string | null;
  };
}

export interface PublicBinanceAccountSnapshot extends PublicBinanceAccountSummary {
  capturedAt: string;
}

export type PublicBinanceRun = Omit<
  BinanceCollectionRunRecord,
  "workflowRunId" | "sourceUrl" | "contentDigest"
>;
export type PublicBinanceProject = BinanceProjectReadRecord;
export type PublicBinancePosition = BinancePositionReadRecord;
export type PublicBinanceRecord = BinanceRecordReadRecord;
export type PublicBinanceValidation = BinanceValidationReadRecord;
export type PublicBinanceCandle = BinanceCandleReadRecord;
export type PublicBinanceFunding = BinanceFundingReadRecord;
