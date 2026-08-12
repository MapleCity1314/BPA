import {
  validateBinanceProjectTarget,
  type BinanceProjectDetailSnapshot
} from "@bpa/adapter-binance";
import type { RiskSignal } from "@bpa/schemas";
import type {
  BinanceDetailStageRequest,
  BinanceDetailStageResult
} from "./binance-detail-content";

export type BinanceDetailDriverErrorCode =
  | "BINANCE_CONTENT_RESPONSE_TIMEOUT"
  | "BINANCE_DETAIL_HEADERS_MISSING"
  | "BINANCE_DETAIL_ROW_CHANGED"
  | "BINANCE_DETAIL_ROW_LIMIT_EXCEEDED"
  | "BINANCE_DETAIL_STAGE_FAILED"
  | "BINANCE_DETAIL_STRUCTURE_UNCONFIRMED"
  | "BINANCE_DETAIL_TAB_AMBIGUOUS"
  | "BINANCE_DETAIL_TAB_NOT_ACTIVE"
  | "BINANCE_DETAIL_TAB_TIMEOUT"
  | "BINANCE_MANAGEMENT_RESTORE_FAILED"
  | "BINANCE_MANAGEMENT_TAB_AMBIGUOUS"
  | "BINANCE_MANAGEMENT_TAB_TIMEOUT"
  | "BINANCE_PAGE_LIMIT_EXCEEDED"
  | "BINANCE_PAGINATION_AMBIGUOUS"
  | "BINANCE_PAGINATION_CHANGED"
  | "BINANCE_PAGINATION_REPEATED"
  | "BINANCE_PAGINATION_TIMEOUT"
  | "BINANCE_PROJECT_IDENTITY_MISMATCH"
  | "BINANCE_PROJECT_CARD_AMBIGUOUS"
  | "BINANCE_PROJECT_CARD_MISSING"
  | "BINANCE_PROJECT_COLLAPSE_FAILED"
  | "BINANCE_PROJECT_EXPAND_AMBIGUOUS"
  | "BINANCE_PROJECT_EXPAND_TIMEOUT"
  | "BINANCE_PROJECT_TARGET_INVALID"
  | "BROWSER_DISCONNECTED"
  | "CAPTCHA_REQUIRED"
  | "COMMAND_CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "PAGE_CONTEXT_CHANGED"
  | "PAGE_LOADING"
  | "RATE_LIMITED"
  | "RISK_CONTROL"
  | "SESSION_EXPIRED";

const CONTENT_CODES = new Set<BinanceDetailDriverErrorCode>([
  "BINANCE_DETAIL_HEADERS_MISSING",
  "BINANCE_DETAIL_ROW_CHANGED",
  "BINANCE_DETAIL_ROW_LIMIT_EXCEEDED",
  "BINANCE_DETAIL_STAGE_FAILED",
  "BINANCE_DETAIL_STRUCTURE_UNCONFIRMED",
  "BINANCE_DETAIL_TAB_AMBIGUOUS",
  "BINANCE_DETAIL_TAB_NOT_ACTIVE",
  "BINANCE_DETAIL_TAB_TIMEOUT",
  "BINANCE_PAGE_LIMIT_EXCEEDED",
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

export class BinanceDetailDriverError extends Error {
  constructor(
    readonly code: BinanceDetailDriverErrorCode,
    readonly riskSignals: readonly RiskSignal[] = []
  ) {
    super(`Binance 详情浏览器采集已停止：${code}`);
    this.name = "BinanceDetailDriverError";
  }
}

interface StageResponse {
  readonly ok?: boolean;
  readonly requestId?: string;
  readonly result?: BinanceDetailStageResult;
  readonly error?: { readonly code?: string };
}

interface PreflightResponse {
  readonly riskSignals?: readonly RiskSignal[];
}

export function createBinanceDetailBrowserDriver(input: {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly stageResponseTimeoutMs?: number;
}): { collectProject(target: Readonly<Record<string, unknown>>): Promise<BinanceProjectDetailSnapshot> } {
  const assertActive = (): void => {
    if (input.isCancelled?.()) throw new BinanceDetailDriverError("COMMAND_CANCELLED");
    if (!Number.isFinite(Date.parse(input.deadline)) || Date.now() >= Date.parse(input.deadline)) {
      throw new BinanceDetailDriverError("DEADLINE_EXCEEDED");
    }
  };
  const browserFailure = (): BinanceDetailDriverError =>
    new BinanceDetailDriverError("BROWSER_DISCONNECTED");
  const assertPage = async (expectedUrl: string): Promise<void> => {
    assertActive();
    const tab = await browser.tabs.get(input.sourceTabId).catch(() => undefined);
    if (!tab) throw browserFailure();
    if (tab.status !== "complete") throw new BinanceDetailDriverError("PAGE_LOADING");
    if (tab.url !== expectedUrl) throw new BinanceDetailDriverError("PAGE_CONTEXT_CHANGED");
  };
  const preflight = async (): Promise<void> => {
    const response = (await browser.tabs.sendMessage(input.sourceTabId, {
      type: "bpa.risk.preflight"
    }).catch(() => {
      throw browserFailure();
    })) as PreflightResponse;
    const blocking = response.riskSignals?.find((signal) => signal.severity === "blocking");
    if (blocking) {
      const code = ["CAPTCHA_REQUIRED", "RATE_LIMITED", "RISK_CONTROL", "SESSION_EXPIRED"].includes(blocking.code)
        ? (blocking.code as BinanceDetailDriverErrorCode)
        : "RISK_CONTROL";
      throw new BinanceDetailDriverError(code, response.riskSignals ?? []);
    }
  };
  return {
    async collectProject(rawTarget) {
      let target: ReturnType<typeof validateBinanceProjectTarget>;
      try {
        target = validateBinanceProjectTarget(rawTarget);
      } catch {
        throw new BinanceDetailDriverError("BINANCE_PROJECT_TARGET_INVALID");
      }
      let snapshot: BinanceProjectDetailSnapshot | undefined;
      let primaryError: unknown;
      try {
        await assertPage(target.managementUrl);
        await preflight();
        const requestId = `${input.sourceTabId}:${Date.now()}:${target.projectId}`;
        const request: BinanceDetailStageRequest = {
          stage: "collect-project",
          ...target,
          deadline: input.deadline
        };
        const remaining = Date.parse(input.deadline) - Date.now();
        const timeoutMs = Math.max(1, Math.min(input.stageResponseTimeoutMs ?? 5 * 60_000, remaining));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let response: StageResponse;
        try {
          response = (await Promise.race([
            browser.tabs.sendMessage(input.sourceTabId, {
              type: "bpa.binance.detail.stage",
              requestId,
              request
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new BinanceDetailDriverError("BINANCE_CONTENT_RESPONSE_TIMEOUT")), timeoutMs);
            })
          ])) as StageResponse;
        } catch (error) {
          if (error instanceof BinanceDetailDriverError && error.code === "BINANCE_CONTENT_RESPONSE_TIMEOUT") {
            const stopped = (await browser.tabs.sendMessage(input.sourceTabId, {
              type: "bpa.binance.detail.cancel-stage",
              requestId
            }).catch(() => undefined)) as { stopped?: boolean } | undefined;
            if (stopped?.stopped !== true) throw browserFailure();
          }
          throw error instanceof BinanceDetailDriverError ? error : browserFailure();
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!response?.ok || response.requestId !== requestId || response.result?.stage !== "collect-project") {
          const contentCode = response?.error?.code;
          throw new BinanceDetailDriverError(
            typeof contentCode === "string" && CONTENT_CODES.has(contentCode as BinanceDetailDriverErrorCode)
              ? (contentCode as BinanceDetailDriverErrorCode)
              : "BINANCE_DETAIL_STAGE_FAILED"
          );
        }
        snapshot = response.result.snapshot;
        await assertPage(target.managementUrl);
      } catch (error) {
        primaryError = error;
      }
      if (primaryError) throw primaryError;
      if (!snapshot) throw new BinanceDetailDriverError("BINANCE_DETAIL_STAGE_FAILED");
      return snapshot;
    }
  };
}
