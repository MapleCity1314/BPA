import type { RiskSignal } from "@bpa/schemas";

export * from "./dom-readers.js";
export * from "./browser-actions.js";
export * from "./editor-inspector.js";
export * from "./scope-collector.js";
export * from "./alliance-retired.js";

export const DOUDIAN_ADAPTER_ID = "doudian";
export const DOUDIAN_ADAPTER_VERSION = "1.1.0";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
export const DOUDIAN_BUYIN_ORIGIN = "https://buyin.jinritemai.com";
export const DOUDIAN_LIST_PATH = "/ffa/g/list";

export interface DoudianShopContext {
  supported: boolean;
  shop: {
    id: string;
    name: string;
    identity_confirmed: boolean;
  };
  url: string;
}

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

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeShopName(value: string | null | undefined): string {
  return normalizeText((value ?? "").normalize("NFKC"))
    .replace(/[（(]\s*(?:当前|当前店铺)\s*[）)]$/u, "")
    .trim();
}

function extractStableShopId(element: Element | undefined): string | undefined {
  let current = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    for (const key of [
      "data-shop-id",
      "data-shopid",
      "data-shop-key",
      "data-value",
      "value"
    ]) {
      const value = current.getAttribute(key);
      if (value && /^\d{5,}$/.test(value)) return value;
    }
    const href = current.getAttribute("href");
    if (href) {
      try {
        const url = new URL(href, DOUDIAN_ORIGIN);
        for (const key of ["shop_id", "shopId", "shopid"]) {
          const value = url.searchParams.get(key);
          if (value && /^\d{5,}$/.test(value)) return value;
        }
      } catch {
        // Ignore malformed attributes.
      }
    }
    const textId = normalizeText(current.textContent).match(
      /店铺\s*ID[：:\s]*(\d{5,})/i
    )?.[1];
    if (textId) return textId;
    current = current.parentElement ?? undefined;
  }
  return undefined;
}

const SHOP_NAME_PATTERN =
  /^.{2,60}(?:旗舰店|专营店|专卖店|企业店|个体店|商店|小店)$/u;

function findFallbackShopElement(doc: Document): Element | undefined {
  return Array.from(doc.querySelectorAll("body *"))
    .map((element) => {
      const name = normalizeShopName(element.textContent);
      const rect =
        typeof element.getBoundingClientRect === "function"
          ? element.getBoundingClientRect()
          : undefined;
      return { element, name, rect };
    })
    .filter(
      ({ name, rect }) =>
        name.length <= 80 &&
        SHOP_NAME_PATTERN.test(name) &&
        (!rect ||
          (rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 0 &&
            rect.top <= 240))
    )
    .sort(
      (left, right) =>
        (left.rect?.top ?? 0) - (right.rect?.top ?? 0) ||
        left.name.length - right.name.length
    )[0]?.element;
}

function findFallbackShopName(doc: Document): string | undefined {
  return (doc.body?.innerText ?? "")
    .split(/\r?\n/u)
    .map(normalizeShopName)
    .find(
      (candidate) =>
        candidate.length <= 80 && SHOP_NAME_PATTERN.test(candidate)
    );
}

export function readDoudianShopContext(
  doc: Document,
  pageUrl = doc.defaultView?.location.href ?? ""
): DoudianShopContext {
  const url = new URL(pageUrl);
  if (url.origin !== DOUDIAN_ORIGIN || url.pathname !== DOUDIAN_LIST_PATH) {
    throw new Error("PAGE_MISMATCH");
  }
  const precise = Array.from(
    doc.querySelectorAll("[class*='headerShopName'] [class*='userName']")
  ).find((element) => normalizeText(element.textContent));
  const fallback = Array.from(
    doc.querySelectorAll("[class*='headerShopName']")
  ).find((element) => normalizeText(element.textContent));
  const element = precise ?? fallback ?? findFallbackShopElement(doc);
  const rawName =
    normalizeShopName(element?.textContent) || findFallbackShopName(doc) || "";
  const prefixName = rawName.match(
    /^(.{2,60}?(?:旗舰店|专营店|专卖店|企业店|个体店|商店|小店))/
  )?.[1];
  const name = prefixName || rawName;
  if (!name) throw new Error("PAGE_LOADING");
  const stableId = extractStableShopId(element);
  return {
    supported: true,
    shop: {
      id: stableId ?? `name:${stableHash(name)}`,
      name,
      identity_confirmed: Boolean(stableId)
    },
    url: url.href
  };
}
