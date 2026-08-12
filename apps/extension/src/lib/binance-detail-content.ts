import {
  collectBinanceProjectDetail,
  validateBinanceProjectTarget,
  type BinanceProjectDetailSnapshot
} from "@bpa/adapter-binance";

export interface BinanceDetailStageRequest {
  readonly stage: "collect-project";
  readonly projectId: string;
  readonly projectStatus: "ongoing" | "ended";
  readonly managementUrl: string;
  readonly deadline: string;
}

export interface BinanceDetailStageResult {
  readonly stage: "collect-project";
  readonly snapshot: BinanceProjectDetailSnapshot;
}

const SAFE_ERROR_CODES = new Set([
  "BINANCE_DETAIL_HEADERS_MISSING",
  "BINANCE_DETAIL_ROW_CHANGED",
  "BINANCE_DETAIL_ROW_LIMIT_EXCEEDED",
  "BINANCE_DETAIL_STRUCTURE_UNCONFIRMED",
  "BINANCE_DETAIL_TAB_AMBIGUOUS",
  "BINANCE_DETAIL_TAB_NOT_ACTIVE",
  "BINANCE_DETAIL_TAB_TIMEOUT",
  "BINANCE_PAGE_LIMIT_EXCEEDED",
  "BINANCE_MANAGEMENT_RESTORE_FAILED",
  "BINANCE_MANAGEMENT_TAB_AMBIGUOUS",
  "BINANCE_MANAGEMENT_TAB_TIMEOUT",
  "BINANCE_PAGINATION_AMBIGUOUS",
  "BINANCE_PAGINATION_CHANGED",
  "BINANCE_PAGINATION_REPEATED",
  "BINANCE_PAGINATION_TIMEOUT",
  "BINANCE_PROJECT_IDENTITY_MISMATCH",
  "BINANCE_PROJECT_CARD_AMBIGUOUS",
  "BINANCE_PROJECT_CARD_MISSING",
  "BINANCE_PROJECT_COLLAPSE_FAILED",
  "BINANCE_PROJECT_EXPAND_AMBIGUOUS",
  "BINANCE_PROJECT_EXPAND_TIMEOUT",
  "BINANCE_PROJECT_TARGET_INVALID",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "PAGE_CONTEXT_CHANGED",
  "RATE_LIMITED",
  "RISK_CONTROL",
  "SESSION_EXPIRED"
]);

export function binanceDetailErrorPayload(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  const code =
    error instanceof Error && SAFE_ERROR_CODES.has(error.message)
      ? error.message
      : "BINANCE_DETAIL_STAGE_FAILED";
  return { code, message: `Binance 详情只读采集已停止：${code}` };
}

export async function executeBinanceDetailStage(
  request: BinanceDetailStageRequest,
  document: Document,
  pageUrl: string,
  isCancelled: () => boolean
): Promise<BinanceDetailStageResult> {
  if (request?.stage !== "collect-project") {
    throw new Error("BINANCE_PROJECT_TARGET_INVALID");
  }
  const targetInput: Readonly<Record<string, unknown>> = {
    projectId: request.projectId,
    projectStatus: request.projectStatus,
    managementUrl: request.managementUrl
  };
  const target = validateBinanceProjectTarget(targetInput);
  if (pageUrl !== target.managementUrl) throw new Error("PAGE_CONTEXT_CHANGED");
  const snapshot = await collectBinanceProjectDetail(document, targetInput, {
    deadline: request.deadline,
    isCancelled
  });
  if (document.defaultView?.location.href !== target.managementUrl) {
    throw new Error("PAGE_CONTEXT_CHANGED");
  }
  return { stage: "collect-project", snapshot };
}
