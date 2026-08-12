import type {
  ExperienceShop,
  ExperienceSnapshot
} from "@bpa/adapter-doudian";
import type { RiskSignal } from "@bpa/schemas";
import {
  AllianceRetiredDriverError,
  createAllianceRetiredBrowserDriver
} from "./alliance-retired-background";
import type {
  ExperienceScoreStageRequest,
  ExperienceScoreStageResult
} from "./experience-score-content";

const EXPERIENCE_URL =
  "https://fxg.jinritemai.com/ffa/eco/experience-score";

export type ExperienceScoreBrowserErrorCode =
  | "AUTH_REQUIRED"
  | "BROWSER_DISCONNECTED"
  | "CAPTCHA_REQUIRED"
  | "COMMAND_CANCELLED"
  | "COMMAND_RESULT_TOO_LARGE"
  | "DEADLINE_EXCEEDED"
  | "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED"
  | "DOUDIAN_EXPERIENCE_MAX_SHOPS_INVALID"
  | "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT"
  | "EXPERIENCE_DIMENSION_INCOMPLETE"
  | "EXPERIENCE_PAGE_TIMEOUT"
  | "EXPERIENCE_SNAPSHOT_MISSING"
  | "EXPERIENCE_STAGE_FAILED"
  | "EXPERIENCE_TOTAL_SCORE_MISSING"
  | "PAGE_LOADING"
  | "PAGE_MISMATCH"
  | "PAGE_URL_INVALID"
  | "RISK_CONTROL"
  | "SESSION_EXPIRED"
  | "SHOP_CONTEXT_RESTORE_FAILED"
  | "SHOP_IDENTITY_AMBIGUOUS"
  | "SHOP_IDENTITY_MISMATCH"
  | "SHOP_IDENTITY_UNCERTAIN"
  | "SHOP_IDENTITY_UNCONFIRMED"
  | "SHOP_LIMIT_EXCEEDED"
  | "SHOP_LIST_EMPTY"
  | "SHOP_LIST_INCOMPLETE";

const CONTENT_ERROR_CODES = new Set<ExperienceScoreBrowserErrorCode>([
  "EXPERIENCE_DIMENSION_INCOMPLETE",
  "EXPERIENCE_TOTAL_SCORE_MISSING",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN"
]);

const DISCOVERY_DRIVER_ERROR_CODES = new Set<ExperienceScoreBrowserErrorCode>([
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE"
]);

const COLLECT_DRIVER_ERROR_CODES = new Set<ExperienceScoreBrowserErrorCode>([
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_IDENTITY_MISMATCH"
]);

const ERROR_MESSAGES: Readonly<Record<ExperienceScoreBrowserErrorCode, string>> = {
  AUTH_REQUIRED: "抖店会话需要重新登录。",
  BROWSER_DISCONNECTED: "浏览器标签页或内容脚本暂不可用。",
  CAPTCHA_REQUIRED: "抖店页面要求人工完成验证。",
  COMMAND_CANCELLED: "体验分采集命令已取消。",
  COMMAND_RESULT_TOO_LARGE: "体验分结果超过浏览器协议载荷上限。",
  DEADLINE_EXCEEDED: "体验分采集已超过执行期限。",
  DOUDIAN_EXPERIENCE_DISCOVERY_FAILED: "体验分店铺发现失败。",
  DOUDIAN_EXPERIENCE_MAX_SHOPS_INVALID: "体验分店铺数量上限无效。",
  EXPERIENCE_CONTENT_RESPONSE_TIMEOUT: "体验分页内容读取响应超时。",
  EXPERIENCE_DIMENSION_INCOMPLETE: "体验分维度数据不完整。",
  EXPERIENCE_PAGE_TIMEOUT: "体验分页加载超时。",
  EXPERIENCE_SNAPSHOT_MISSING: "体验分快照响应缺失。",
  EXPERIENCE_STAGE_FAILED: "体验分页面读取失败。",
  EXPERIENCE_TOTAL_SCORE_MISSING: "体验分总分缺失。",
  PAGE_LOADING: "体验分页仍在加载。",
  PAGE_MISMATCH: "当前页面不是预期的抖店页面。",
  PAGE_URL_INVALID: "抖店标签页地址无效。",
  RISK_CONTROL: "抖店风险控制阻断了采集。",
  SESSION_EXPIRED: "抖店登录会话已失效。",
  SHOP_CONTEXT_RESTORE_FAILED: "无法安全恢复源店铺上下文。",
  SHOP_IDENTITY_AMBIGUOUS: "店铺身份存在多个候选。",
  SHOP_IDENTITY_MISMATCH: "当前店铺与目标店铺不一致。",
  SHOP_IDENTITY_UNCERTAIN: "无法确认当前店铺身份。",
  SHOP_IDENTITY_UNCONFIRMED: "无法确认源店铺身份。",
  SHOP_LIMIT_EXCEEDED: "发现的店铺数量超过上限。",
  SHOP_LIST_EMPTY: "未发现可识别的店铺。",
  SHOP_LIST_INCOMPLETE: "店铺列表尚未完整加载。"
};

export class ExperienceScoreDriverError extends Error {
  constructor(
    readonly code: ExperienceScoreBrowserErrorCode,
    readonly riskSignals: readonly RiskSignal[] = [],
    readonly detail?: Readonly<Record<string, string>>
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExperienceScoreDriverError";
  }
}

interface StageResponse {
  readonly ok: boolean;
  readonly result?: ExperienceScoreStageResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly detail?: Readonly<Record<string, string>>;
  };
}

interface PreflightResponse {
  readonly riskSignals?: readonly RiskSignal[];
}

export interface ExperienceScoreBrowserDriver {
  discoverShopContext(): Promise<{
    readonly shops: readonly ExperienceShop[];
    readonly currentShopName: string;
  }>;
  collectShop(
    shop: ExperienceShop,
    sourceShop: ExperienceShop
  ): Promise<ExperienceSnapshot>;
}

export function createExperienceScoreBrowserDriver(input: {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly stageResponseTimeoutMs?: number;
}): ExperienceScoreBrowserDriver {
  const shopDriver = createAllianceRetiredBrowserDriver(input);

  const browserFailure = (): ExperienceScoreDriverError =>
    new ExperienceScoreDriverError("BROWSER_DISCONNECTED");

  const mapShopDriverError = (
    error: unknown,
    fallback: ExperienceScoreBrowserErrorCode,
    allowedCodes: ReadonlySet<ExperienceScoreBrowserErrorCode>
  ): ExperienceScoreDriverError => {
    if (
      error instanceof AllianceRetiredDriverError &&
      allowedCodes.has(error.code as ExperienceScoreBrowserErrorCode)
    ) {
      return new ExperienceScoreDriverError(
        error.code as ExperienceScoreBrowserErrorCode,
        error.riskSignals
      );
    }
    if (
      error instanceof AllianceRetiredDriverError &&
      [
        "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
        "BROWSER_CONTENT_SCRIPT_MISSING"
      ].includes(error.code)
    ) {
      return browserFailure();
    }
    return new ExperienceScoreDriverError(fallback);
  };

  const assertActive = (): void => {
    if (input.isCancelled?.()) {
      throw new ExperienceScoreDriverError("COMMAND_CANCELLED");
    }
    if (
      !Number.isFinite(Date.parse(input.deadline)) ||
      Date.now() >= Date.parse(input.deadline)
    ) {
      throw new ExperienceScoreDriverError("DEADLINE_EXCEEDED");
    }
  };

  const waitForComplete = async (tabId: number): Promise<void> => {
    while (Date.now() < Date.parse(input.deadline)) {
      assertActive();
      const tab = await browser.tabs.get(tabId).catch(() => {
        throw browserFailure();
      });
      if (tab?.status === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ExperienceScoreDriverError("EXPERIENCE_PAGE_TIMEOUT");
  };

  const navigate = async (url: string): Promise<void> => {
    assertActive();
    await browser.tabs
      .update(input.sourceTabId, { url })
      .catch(() => {
        throw browserFailure();
      });
    await waitForComplete(input.sourceTabId);
  };

  const preflight = async (): Promise<void> => {
    const response = (await browser.tabs
      .sendMessage(input.sourceTabId, {
        type: "bpa.risk.preflight"
      })
      .catch(() => {
        throw browserFailure();
      })) as PreflightResponse;
    const blocking = response.riskSignals?.find(
      (signal) => signal.severity === "blocking"
    );
    if (blocking) {
      const code = [
        "AUTH_REQUIRED",
        "CAPTCHA_REQUIRED",
        "RISK_CONTROL",
        "SESSION_EXPIRED"
      ].includes(blocking.code)
        ? (blocking.code as ExperienceScoreBrowserErrorCode)
        : "RISK_CONTROL";
      throw new ExperienceScoreDriverError(code, response.riskSignals ?? []);
    }
  };

  const collect = async (shop: ExperienceShop): Promise<ExperienceSnapshot> => {
    await preflight();
    const request: ExperienceScoreStageRequest = {
      stage: "collect-snapshot",
      expectedShop: shop
    };
    const remaining = Date.parse(input.deadline) - Date.now();
    const timeoutMs = Math.max(
      1,
      Math.min(input.stageResponseTimeoutMs ?? 75_000, remaining)
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = (await Promise.race([
        browser.tabs.sendMessage(input.sourceTabId, {
          type: "bpa.doudian.experience.stage",
          request
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ExperienceScoreDriverError(
                  "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT"
                )
              ),
            timeoutMs
          );
        })
      ]).catch((error) => {
        if (error instanceof ExperienceScoreDriverError) throw error;
        throw browserFailure();
      })) as StageResponse;
      if (!response?.ok || response.result?.stage !== "collect-snapshot") {
        const responseCode = response?.error?.code;
        const code =
          responseCode &&
          CONTENT_ERROR_CODES.has(responseCode as ExperienceScoreBrowserErrorCode)
            ? (responseCode as ExperienceScoreBrowserErrorCode)
            : "EXPERIENCE_STAGE_FAILED";
        const dimension = response?.error?.detail?.dimension;
        throw new ExperienceScoreDriverError(
          code,
          [],
          code === "EXPERIENCE_DIMENSION_INCOMPLETE" &&
            ["goods", "logistics", "service"].includes(dimension ?? "")
            ? { dimension: dimension! }
            : undefined
        );
      }
      if (!response.result.snapshot) {
        throw new ExperienceScoreDriverError("EXPERIENCE_SNAPSHOT_MISSING");
      }
      return response.result.snapshot;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    async discoverShopContext() {
      try {
        const discovery = await shopDriver.discoverShopContext();
        return {
          shops: discovery.shops,
          currentShopName: discovery.currentShop.name
        };
      } catch (error) {
        throw mapShopDriverError(
          error,
          "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED",
          DISCOVERY_DRIVER_ERROR_CODES
        );
      }
    },
    async collectShop(shop, sourceShop) {
      const sourceTab = await browser.tabs.get(input.sourceTabId).catch(() => {
        throw browserFailure();
      });
      const sourceUrl = sourceTab.url;
      if (!sourceUrl) throw new ExperienceScoreDriverError("PAGE_URL_INVALID");
      let snapshot: ExperienceSnapshot | undefined;
      let primaryError: unknown;
      try {
        await shopDriver.switchShop(shop).catch((error) => {
          throw mapShopDriverError(
            error,
            "EXPERIENCE_STAGE_FAILED",
            COLLECT_DRIVER_ERROR_CODES
          );
        });
        await navigate(EXPERIENCE_URL);
        snapshot = await collect(shop);
      } catch (error) {
        primaryError = error;
      }
      try {
        await navigate(sourceUrl);
        await shopDriver.switchShop(sourceShop);
        await shopDriver.cleanupShopTabs();
      } catch {
        throw new ExperienceScoreDriverError("SHOP_CONTEXT_RESTORE_FAILED");
      }
      if (primaryError) throw primaryError;
      if (!snapshot) {
        throw new ExperienceScoreDriverError("EXPERIENCE_SNAPSHOT_MISSING");
      }
      return snapshot;
    }
  };
}
