import type { RiskSignal } from "@bpa/schemas";

export const MARKETPLACE_ADAPTER_ID = "marketplace-search";
export const MARKETPLACE_ADAPTER_VERSION = "1.0.0";

export type MarketplacePlatform = "DOUYIN" | "TAOBAO" | "JD";

export interface MarketplaceProbeInput {
  readonly platform: MarketplacePlatform;
  readonly query: string;
  readonly maxItems: number;
}

export interface MarketplaceProbeItem {
  readonly productId: string;
  readonly title: string;
  readonly productUrl: string;
  readonly mainImageUrl?: string;
  readonly priceText?: string;
  readonly salesText?: string;
  readonly shopName?: string;
  readonly position: number;
}

export interface MarketplaceProbeResult {
  readonly schemaVersion: "marketplace-probe/v0.1";
  readonly platform: MarketplacePlatform;
  readonly query: string;
  readonly observedAt: string;
  readonly pageUrl: string;
  readonly queryConfirmed: boolean;
  readonly status: "READY" | "PARTIAL" | "EMPTY_CONFIRMED";
  readonly items: readonly MarketplaceProbeItem[];
  readonly warnings: readonly string[];
}

interface PlatformDefinition {
  readonly origin: string;
  readonly path: RegExp;
  readonly queryParameters: readonly string[];
  productUrl(url: URL): boolean;
  productId(url: URL): string | undefined;
}

const DEFINITIONS: Readonly<Record<MarketplacePlatform, PlatformDefinition>> = {
  DOUYIN: {
    origin: "https://www.douyin.com",
    path: /^\/search(?:\/|$)/u,
    queryParameters: ["keyword", "q"],
    productUrl: (url) =>
      (url.hostname === "haohuo.jinritemai.com" &&
        /(?:detail|product|item)/iu.test(url.pathname)) ||
      (url.hostname.endsWith("douyin.com") &&
        /(?:product|ecommerce|shop)/iu.test(url.pathname)),
    productId: (url) =>
      firstNonEmpty(
        url.searchParams.get("product_id"),
        url.searchParams.get("item_id"),
        url.searchParams.get("id"),
        lastNumericSegment(url.pathname)
      )
  },
  TAOBAO: {
    origin: "https://s.taobao.com",
    path: /^\/search(?:\/|$)/u,
    queryParameters: ["q", "keyword"],
    productUrl: (url) =>
      ["item.taobao.com", "detail.tmall.com"].includes(url.hostname) &&
      /(?:item|detail)\.htm$/iu.test(url.pathname),
    productId: (url) =>
      firstNonEmpty(
        url.searchParams.get("id"),
        url.searchParams.get("item_id"),
        lastNumericSegment(url.pathname)
      )
  },
  JD: {
    origin: "https://search.jd.com",
    path: /^\/Search(?:\/|$)/u,
    queryParameters: ["keyword", "q"],
    productUrl: (url) =>
      url.hostname === "item.jd.com" && /^\/\d+\.html$/u.test(url.pathname),
    productId: (url) => /^\/(\d+)\.html$/u.exec(url.pathname)?.[1]
  }
};

const BLOCKING_PATTERNS: ReadonlyArray<{
  readonly code: RiskSignal["code"];
  readonly category: RiskSignal["category"];
  readonly pattern: RegExp;
  readonly detail: string;
}> = [
  {
    code: "CAPTCHA_REQUIRED",
    category: "challenge",
    pattern: /滑块验证|请输入验证码|请完成(?:安全)?验证|安全验证/iu,
    detail: "页面要求完成人工验证码或安全验证。"
  },
  {
    code: "RATE_LIMITED",
    category: "throttle",
    pattern: /访问过于频繁|操作过于频繁|请求过于频繁|请稍后再试/iu,
    detail: "平台提示当前访问频率过高。"
  },
  {
    code: "RISK_CONTROL",
    category: "challenge",
    pattern: /访问存在风险|异常操作|账号存在风险|环境存在风险/iu,
    detail: "平台风险控制阻断了只读探查。"
  }
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function firstNonEmpty(
  ...values: readonly (string | null | undefined)[]
): string | undefined {
  return values.map(normalizeText).find((value) => value.length > 0);
}

function lastNumericSegment(pathname: string): string | undefined {
  return pathname.match(/(?:^|\/)(\d{5,30})(?:\.[a-z]+)?(?:\/|$)/iu)?.[1];
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function boundedInputText(value: unknown, label: string, maximum: number): string {
  const normalized = normalizeText(typeof value === "string" ? value : "");
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
}

export function validateMarketplaceProbeInput(
  value: Readonly<Record<string, unknown>>
): MarketplaceProbeInput {
  const allowed = new Set(["platform", "query", "maxItems"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("MARKETPLACE_INPUT_INVALID");
  }
  if (!Object.hasOwn(DEFINITIONS, String(value.platform))) {
    throw new Error("MARKETPLACE_INPUT_INVALID");
  }
  const maxItems = value.maxItems === undefined ? 20 : Number(value.maxItems);
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new Error("MARKETPLACE_INPUT_INVALID");
  }
  return {
    platform: value.platform as MarketplacePlatform,
    query: boundedInputText(value.query, "query", 200),
    maxItems
  };
}

function visible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !(
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.opacity === "0"
  );
}

function safeUrl(value: string | null | undefined, base: string): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalProductUrl(url: URL): string {
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (!/^(?:id|item_id|product_id)$/u.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function queryFromPage(
  document: Document,
  url: URL,
  definition: PlatformDefinition
): string[] {
  const candidates = definition.queryParameters
    .map((parameter) => url.searchParams.get(parameter))
    .filter((value): value is string => Boolean(value));
  if (url.origin === "https://www.douyin.com") {
    const pathQuery = url.pathname.match(/^\/search\/([^/]+)/u)?.[1];
    if (pathQuery) {
      try {
        candidates.push(decodeURIComponent(pathQuery));
      } catch {
        candidates.push(pathQuery);
      }
    }
  }
  for (const element of document.querySelectorAll(
    "input[type='search'],input[role='searchbox'],input[name='q'],input[name='keyword']"
  )) {
    if (element.localName === "input" && visible(element)) {
      candidates.push((element as HTMLInputElement).value);
    }
  }
  return candidates.map(normalizeText).filter(Boolean);
}

function confirmedEmptyState(document: Document): boolean {
  const candidates = Array.from(
    document.querySelectorAll(
      "main,[role='main'],[class*='empty'],[class*='Empty'],[class*='no-result'],[class*='noResult']"
    )
  ).filter(visible);
  return candidates.some((element) =>
    /没有找到|暂无(?:相关)?商品|无搜索结果|未找到相关商品|换个词试试/iu.test(
      normalizeText(element.textContent)
    )
  );
}

export function isMarketplaceSearchPageReady(
  document: Document,
  pageUrl = document.defaultView?.location.href ?? ""
): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  const definition = Object.values(DEFINITIONS).find(
    (candidate) =>
      candidate.origin === url.origin && candidate.path.test(url.pathname)
  );
  if (!definition || !document.body) return false;
  const hasQuery = queryFromPage(document, url, definition).length > 0;
  const hasProductLink = Array.from(document.querySelectorAll("a[href]")).some(
    (element) => {
      if (element.localName !== "a" || !visible(element)) return false;
      const candidate = safeUrl(element.getAttribute("href"), pageUrl);
      return Boolean(candidate && definition.productUrl(candidate));
    }
  );
  return hasQuery && (hasProductLink || confirmedEmptyState(document));
}

function nearestProductContainer(anchor: HTMLAnchorElement): Element {
  let current: Element = anchor;
  for (let depth = 0; depth < 7 && current.parentElement; depth += 1) {
    const text = normalizeText(current.textContent);
    if (
      text.length >= 8 &&
      text.length <= 2_000 &&
      current.querySelector("img")
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return anchor;
}

function imageUrl(container: Element, base: string): string | undefined {
  for (const image of container.querySelectorAll("img")) {
    if (!visible(image)) continue;
    const candidate = firstNonEmpty(
      (image as HTMLImageElement).currentSrc,
      image.getAttribute("src"),
      image.getAttribute("data-src"),
      image.getAttribute("data-lazy-img"),
      image.getAttribute("data-ks-lazyload")
    );
    const url = safeUrl(candidate, base);
    if (url) return url.href;
  }
  return undefined;
}

function validTitle(value: string, productId: string): boolean {
  return (
    value.length >= 4 &&
    value.length <= 500 &&
    value !== productId &&
    !/^(?:¥|￥)?\d+(?:\.\d+)?(?:元)?$/u.test(value) &&
    !/^(?:立即购买|查看详情|商品图片|图片|广告)$/u.test(value)
  );
}

function productTitle(
  anchor: HTMLAnchorElement,
  container: Element,
  productId: string
): string | undefined {
  const candidates = [
    anchor.getAttribute("title"),
    anchor.getAttribute("aria-label"),
    anchor.textContent,
    ...Array.from(
      container.querySelectorAll("[title],h1,h2,h3,h4,[class*='title'],[class*='name']")
    ).slice(0, 30).map((element) =>
      element.getAttribute("title") ?? element.textContent
    ),
    ...Array.from(container.querySelectorAll("img[alt]"))
      .slice(0, 10)
      .map((element) => element.getAttribute("alt"))
  ]
    .map(normalizeText)
    .filter((value) => validTitle(value, productId))
    .sort((left, right) => right.length - left.length);
  return candidates[0];
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  return normalizeText(text.match(pattern)?.[0]) || undefined;
}

function shopName(container: Element): string | undefined {
  const candidates = Array.from(
    container.querySelectorAll("[data-shop],[class*='shop'],[class*='seller'],a")
  )
    .slice(0, 50)
    .map((element) => normalizeText(element.textContent))
    .filter(
      (value) =>
        value.length >= 2 &&
        value.length <= 80 &&
        /(?:旗舰店|专卖店|专营店|食品店|官方店|自营店)$/u.test(value)
    );
  return candidates[0];
}

export function detectMarketplaceRiskSignals(
  document: Document,
  pageUrl = document.defaultView?.location.href ?? "",
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
        detail: "当前商品探查页 URL 无法解析。"
      }
    ];
  }
  if (/login|passport|signin|authorize/iu.test(url.pathname)) {
    return [
      {
        code: "SESSION_EXPIRED",
        category: "session",
        severity: "blocking",
        source: "page",
        detected_at: detectedAt.toISOString(),
        detail: "商品探查页已进入登录流程，需要人工恢复会话。"
      }
    ];
  }
  const body = normalizeText(document.body?.textContent).slice(0, 200_000);
  return BLOCKING_PATTERNS.filter(({ pattern }) => pattern.test(body)).map(
    ({ code, category, detail }) => ({
      code,
      category,
      severity: "blocking",
      source: "page",
      detected_at: detectedAt.toISOString(),
      ...(code === "RATE_LIMITED" ? { retry_after_ms: 30_000 } : {}),
      detail
    })
  );
}

export function collectMarketplaceSearchResults(
  document: Document,
  rawInput: Readonly<Record<string, unknown>>,
  options: { readonly observedAt?: string } = {}
): MarketplaceProbeResult {
  const input = validateMarketplaceProbeInput(rawInput);
  const definition = DEFINITIONS[input.platform];
  const pageUrl = document.defaultView?.location.href ?? "";
  const url = new URL(pageUrl);
  if (url.origin !== definition.origin || !definition.path.test(url.pathname)) {
    throw new Error("PAGE_MISMATCH");
  }
  const queryConfirmed = queryFromPage(document, url, definition).some(
    (candidate) => candidate === input.query
  );
  if (!queryConfirmed) throw new Error("SEARCH_QUERY_MISMATCH");

  const deduped = new Map<string, MarketplaceProbeItem>();
  for (const candidate of document.querySelectorAll("a[href]")) {
    if (candidate.localName !== "a" || !visible(candidate)) continue;
    const anchor = candidate as HTMLAnchorElement;
    const resolved = safeUrl(anchor.getAttribute("href"), pageUrl);
    if (!resolved || !definition.productUrl(resolved)) continue;
    const productUrl = canonicalProductUrl(resolved);
    const productId =
      definition.productId(resolved) ?? `url-${stableHash(productUrl)}`;
    const container = nearestProductContainer(anchor);
    const title = productTitle(anchor, container, productId);
    if (!title) continue;
    const text = normalizeText(container.textContent).slice(0, 2_000);
    const mainImageUrl = imageUrl(container, pageUrl);
    const priceText = firstMatch(
      text,
      /(?:¥|￥)\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*元/u
    );
    const salesText = firstMatch(
      text,
      /(?:已售|销量|付款|评价)\s*[:：]?\s*[0-9.]+\s*(?:万|千)?(?:件|人)?/u
    );
    const seller = shopName(container);
    const item: MarketplaceProbeItem = {
      productId,
      title,
      productUrl,
      ...(mainImageUrl ? { mainImageUrl } : {}),
      ...(priceText ? { priceText } : {}),
      ...(salesText ? { salesText } : {}),
      ...(seller ? { shopName: seller } : {}),
      position: deduped.size + 1
    };
    deduped.set(`${input.platform}:${productId}`, item);
    if (deduped.size >= input.maxItems) break;
  }

  const items = [...deduped.values()];
  const warnings: string[] = [];
  const emptyConfirmed = items.length === 0 && confirmedEmptyState(document);
  if (items.length === 0 && !emptyConfirmed) {
    throw new Error("MARKETPLACE_STRUCTURE_UNCONFIRMED");
  }
  if (items.some((item) => !item.mainImageUrl)) {
    warnings.push("SOME_MAIN_IMAGES_MISSING");
  }
  if (items.some((item) => !item.salesText)) {
    warnings.push("VISIBLE_SALES_TEXT_INCOMPLETE");
  }
  return {
    schemaVersion: "marketplace-probe/v0.1",
    platform: input.platform,
    query: input.query,
    observedAt: options.observedAt ?? new Date().toISOString(),
    pageUrl,
    queryConfirmed,
    status:
      emptyConfirmed
        ? "EMPTY_CONFIRMED"
        : warnings.length > 0
          ? "PARTIAL"
          : "READY",
    items,
    warnings
  };
}
