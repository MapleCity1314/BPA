import type { RiskSignal } from "@bpa/schemas";
import {
  BinanceDetailDriverError,
  createBinanceDetailBrowserDriver
} from "./binance-detail-background";

export interface BinanceNodeResponse {
  readonly ok: boolean;
  readonly output?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
  readonly riskSignals?: RiskSignal[];
  readonly timingObservation?: {
    readonly readiness_wait_ms?: number;
    readonly stable_for_ms?: number;
  };
}

export interface BinanceNodeExecutionContext {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
}

const RETRYABLE_ERRORS = new Set([
  "BINANCE_CONTENT_RESPONSE_TIMEOUT",
  "BINANCE_DETAIL_TAB_TIMEOUT",
  "BINANCE_PAGINATION_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "PAGE_LOADING"
]);

function errorResponse(error: unknown): BinanceNodeResponse {
  const safe = error instanceof BinanceDetailDriverError
    ? error
    : new BinanceDetailDriverError("BINANCE_DETAIL_STAGE_FAILED");
  const blocking = [
    "BINANCE_MANAGEMENT_RESTORE_FAILED",
    "CAPTCHA_REQUIRED",
    "PAGE_CONTEXT_CHANGED",
    "RATE_LIMITED",
    "RISK_CONTROL",
    "SESSION_EXPIRED"
  ].includes(safe.code);
  const riskSignals = safe.riskSignals.length > 0
    ? [...safe.riskSignals]
    : blocking
      ? [{
          code: safe.code === "SESSION_EXPIRED"
            ? "SESSION_EXPIRED" as const
            : safe.code === "CAPTCHA_REQUIRED"
              ? "CAPTCHA_REQUIRED" as const
              : safe.code === "RATE_LIMITED"
                ? "RATE_LIMITED" as const
                : safe.code === "PAGE_CONTEXT_CHANGED" ||
                    safe.code === "BINANCE_MANAGEMENT_RESTORE_FAILED"
                  ? "PAGE_CONTEXT_CHANGED" as const
                  : "RISK_CONTROL" as const,
          category: safe.code === "SESSION_EXPIRED"
            ? "session" as const
            : safe.code === "PAGE_CONTEXT_CHANGED" ||
                safe.code === "BINANCE_MANAGEMENT_RESTORE_FAILED"
              ? "page_context" as const
              : safe.code === "RATE_LIMITED"
                ? "throttle" as const
                : "challenge" as const,
          severity: "blocking" as const,
          source: "adapter" as const,
          detected_at: new Date().toISOString(),
          detail: `Binance 详情采集已停止：${safe.code}`
        }]
      : [];
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
      retryable: RETRYABLE_ERRORS.has(safe.code)
    },
    ...(riskSignals.length > 0 ? { riskSignals } : {})
  };
}

export async function executeBinanceNode(
  nodeId: string,
  input: Record<string, unknown>,
  context: BinanceNodeExecutionContext
): Promise<BinanceNodeResponse | undefined> {
  if (nodeId !== "binance.copy-trading.project.detail.collect") {
    return undefined;
  }
  const startedAt = Date.now();
  const driver = createBinanceDetailBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {})
  });
  try {
    const snapshot = await driver.collectProject(input);
    return {
      ok: true,
      output: { ...snapshot },
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms: 300
      }
    };
  } catch (error) {
    return errorResponse(error);
  }
}
