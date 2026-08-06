import type { RiskSignal } from "@bpa/schemas";

export * from "./dom-readers.js";
export * from "./browser-actions.js";
export * from "./editor-inspector.js";
export * from "./scope-collector.js";
export * from "./alliance-retired.js";
export * from "./shop-context.js";
export * from "./inventory-snapshot.js";
export * from "./recent-orders.js";

export const DOUDIAN_ADAPTER_ID = "doudian";
export const DOUDIAN_ADAPTER_VERSION = "1.1.0";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
export const DOUDIAN_BUYIN_ORIGIN = "https://buyin.jinritemai.com";
export const DOUDIAN_LIST_PATH = "/ffa/g/list";

const RISK_TEXT_LIMIT = 200_000;

export function detectDoudianRiskSignals(
  doc: Document,
  pageUrl = doc.defaultView?.location.href ?? "",
  detectedAt = new Date()
): RiskSignal[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [
      {
        code: "PAGE_CONTEXT_CHANGED",
        category: "page_context",
        severity: "blocking",
        source: "adapter",
        detected_at: detectedAt.toISOString(),
        detail: "当前页面 URL 无法解析。"
      }
    ];
  }
  if (
    url.origin !== DOUDIAN_ORIGIN &&
    url.origin !== DOUDIAN_BUYIN_ORIGIN
  ) {
    return [];
  }
  if (/login|passport|signin|authorize/i.test(url.pathname)) {
    return [
      {
        code: "SESSION_EXPIRED",
        category: "session",
        severity: "blocking",
        source: "page",
        detected_at: detectedAt.toISOString(),
        detail: "页面已跳转到登录或授权流程，需要人工恢复会话。"
      }
    ];
  }
  const text = normalizeText(doc.body?.innerText).slice(0, RISK_TEXT_LIMIT);
  const definitions: Array<{
    pattern: RegExp;
    signal: Omit<RiskSignal, "detected_at">;
  }> = [
    {
      pattern: /(?:请完成|需要|进行)(?:安全)?验证|滑块验证|请输入验证码/u,
      signal: {
        code: "CAPTCHA_REQUIRED",
        category: "challenge",
        severity: "blocking",
        source: "page",
        detail: "页面要求完成验证码或安全验证。"
      }
    },
    {
      pattern: /操作过于频繁|访问过于频繁|请求过于频繁|请稍后再试/u,
      signal: {
        code: "RATE_LIMITED",
        category: "throttle",
        severity: "blocking",
        source: "page",
        retry_after_ms: 30_000,
        detail: "平台提示访问或操作频率过高。"
      }
    },
    {
      pattern: /当前访问存在风险|检测到异常操作|账号存在风险/u,
      signal: {
        code: "RISK_CONTROL",
        category: "challenge",
        severity: "blocking",
        source: "page",
        detail: "平台显示风险控制提示，需要人工检查。"
      }
    }
  ];
  return definitions
    .filter(({ pattern }) => pattern.test(text))
    .map(({ signal }) => ({
      ...signal,
      detected_at: detectedAt.toISOString()
    }));
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
