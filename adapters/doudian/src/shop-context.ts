export interface DoudianShopContext {
  supported: boolean;
  shop: {
    id: string;
    name: string;
    identity_confirmed: boolean;
  };
  url: string;
}

const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
const DOUDIAN_LIST_PATH = "/ffa/g/list";
const SHOP_NAME_PATTERN =
  /^.{2,60}(?:官方旗舰店|旗舰店|专营店|专卖店|企业店|个体店|食品店|商店|小店|店)$/u;

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

function visibleNearHeader(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.opacity === "0" ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  if (typeof element.getBoundingClientRect !== "function") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.top <= 240
  );
}

function preciseShopElements(doc: Document): Element[] {
  return Array.from(
    doc.querySelectorAll(
      "#fxg-pc-header [class*='headerShopName'] [class*='userName']," +
        "#fxg-pc-header [class*='headerShopName'] [class*='shopName']," +
        "[class*='headerShopName'] [class*='userName']," +
        "[class*='headerShopName'] [class*='shopName']," +
        "[data-testid*='shop-name'],[data-e2e*='shop-name']"
    )
  ).filter(
    (element) =>
      normalizeShopName(element.textContent) && visibleNearHeader(element)
  );
}

function fallbackShopElements(doc: Document): Element[] {
  const candidates = Array.from(doc.querySelectorAll("body *")).filter(
    (element) => {
      const name = normalizeShopName(element.textContent);
      return (
        name.length <= 80 &&
        SHOP_NAME_PATTERN.test(name) &&
        visibleNearHeader(element)
      );
    }
  );
  return candidates.filter(
    (element) =>
      !candidates.some(
        (descendant) =>
          descendant !== element && element.contains(descendant)
      )
  );
}

function shopElements(doc: Document): Element[] {
  const precise = preciseShopElements(doc);
  return precise.length > 0 ? precise : fallbackShopElements(doc);
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
      if (value && /^\d{5,30}$/.test(value)) return value;
    }
    const href = current.getAttribute("href");
    if (href) {
      try {
        const url = new URL(href, DOUDIAN_ORIGIN);
        for (const key of ["shop_id", "shopId", "shopid"]) {
          const value = url.searchParams.get(key);
          if (value && /^\d{5,30}$/.test(value)) return value;
        }
      } catch {
        // Ignore malformed attributes from untrusted page content.
      }
    }
    if (current === element) {
      const textId = normalizeText(current.textContent).match(
        /店铺\s*ID[：:\s]*(\d{5,30})/iu
      )?.[1];
      if (textId) return textId;
    }
    current = current.parentElement ?? undefined;
  }
  return undefined;
}

function hasAuthenticatedProductShell(doc: Document): boolean {
  if (doc.querySelector("#fxg-pc-header")) return true;
  if (
    doc.querySelector(
      "a[href*='/ffa/w/login/account']," +
        "a[href*='/ffa/morder/order/list']," +
        "a[href*='/ffa/g/stock-manage/list']"
    )
  ) {
    return true;
  }
  if (
    Array.from(doc.querySelectorAll("input[placeholder]")).some((element) =>
      /商品名称.*商品ID|商品ID.*商家编码/u.test(
        element.getAttribute("placeholder") ?? ""
      )
    )
  ) {
    return true;
  }
  const headings = new Set(
    Array.from(doc.querySelectorAll("th,[role='columnheader']"))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean)
  );
  return (
    headings.has("商品信息") &&
    headings.has("总库存") &&
    headings.has("总销量")
  );
}

export function readDoudianVisibleShopIdentity(doc: Document): {
  element?: Element;
  id: string;
  name: string;
  identityConfirmed: boolean;
} {
  let candidates: Array<{ element?: Element; name: string }> = shopElements(
    doc
  ).map((element) => ({
    element,
    name: normalizeShopName(element.textContent)
  }));
  if (candidates.length === 0) {
    const lineName = (doc.body?.innerText ?? "")
      .split(/\r?\n/u)
      .map(normalizeShopName)
      .find(
        (candidate) =>
          candidate.length <= 80 && SHOP_NAME_PATTERN.test(candidate)
      );
    candidates = lineName ? [{ name: lineName }] : [];
  }
  const names = [...new Set(candidates.map(({ name }) => name).filter(Boolean))];
  if (names.length === 0) throw new Error("PAGE_LOADING");
  if (names.length !== 1) throw new Error("SHOP_IDENTITY_AMBIGUOUS");
  const name = names[0]!;
  const matching = candidates.filter((candidate) => candidate.name === name);
  const withStableId = matching.find((candidate) =>
    extractStableShopId(candidate.element)
  );
  const element = withStableId?.element ?? matching[0]?.element;
  const stableId = extractStableShopId(element);
  const identityConfirmed =
    Boolean(stableId) || (Boolean(element) && hasAuthenticatedProductShell(doc));
  return {
    ...(element ? { element } : {}),
    id: stableId ?? `name:${stableHash(name)}`,
    name,
    identityConfirmed
  };
}

export function readDoudianShopContext(
  doc: Document,
  pageUrl = doc.defaultView?.location.href ?? ""
): DoudianShopContext {
  const url = new URL(pageUrl);
  if (url.origin !== DOUDIAN_ORIGIN || url.pathname !== DOUDIAN_LIST_PATH) {
    throw new Error("PAGE_MISMATCH");
  }
  const identity = readDoudianVisibleShopIdentity(doc);
  return {
    supported: true,
    shop: {
      id: identity.id,
      name: identity.name,
      identity_confirmed: identity.identityConfirmed
    },
    url: url.href
  };
}
