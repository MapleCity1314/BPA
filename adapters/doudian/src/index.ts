export const DOUDIAN_ADAPTER_ID = "doudian";
export const DOUDIAN_ADAPTER_VERSION = "1.0.0";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
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
  const element = precise ?? fallback;
  const rawName = normalizeShopName(element?.textContent);
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
