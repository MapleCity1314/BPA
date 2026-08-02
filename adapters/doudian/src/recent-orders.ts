import { readDoudianVisibleShopIdentity } from "./shop-context.js";

export const DOUDIAN_RECENT_ORDERS_VERSION = "1.0.0";

export interface DoudianRecentOrderLine {
  readonly childOrderId: string;
  readonly productId: string;
  readonly merchantCode: string;
  readonly specification: string;
  readonly quantity: number;
  readonly submittedAt: string;
  readonly paidAt?: string;
  readonly shippedAt?: string;
  readonly orderStatus: string;
  readonly aftersalesStatus: string;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu," ").trim();
}

function shanghaiTimestamp(value: string): string | undefined {
  const match = value.match(/(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})/u);
  if (!match?.[1] || !match[2]) return undefined;
  const parsed = Date.parse(`${match[1].replace(/\//gu,"-")}T${match[2]}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function labelled(text: string, label: RegExp, value: RegExp): string | undefined {
  return text.match(new RegExp(`${label.source}\\s*[：:]?\\s*(${value.source})`,"u"))?.[1]?.trim();
}

function productId(row: Element): string | undefined {
  for (const anchor of Array.from(row.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    try {
      const url = new URL(href,"https://fxg.jinritemai.com");
      const value = url.searchParams.get("product_id") ?? url.searchParams.get("productId");
      if (value && /^\d{5,30}$/u.test(value)) return value;
    } catch {
      // An unrelated malformed link is untrusted page content.
    }
  }
  return labelled(normalize(row.textContent),/商品\s*ID/iu,/\d{5,30}/u);
}

function parseRow(row: Element): DoudianRecentOrderLine | undefined {
  const text = normalize(row.textContent);
  const childOrderId = labelled(text,/(?:子订单编号|子订单号|订单编号)/u,/\d{10,40}/u);
  const product = productId(row);
  const merchantCode = labelled(text,/(?:商家编码|SKU编码)/iu,/[A-Za-z0-9._-]{1,200}/u);
  const submitted = labelled(text,/订单提交时间/u,/20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/u);
  const paid = labelled(text,/(?:支付完成时间|支付时间)/u,/20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/u);
  if (!childOrderId || !product || !merchantCode || !submitted || !paid) return undefined;
  const quantityText = labelled(text,/(?:商品数量|数量)/u,/\d{1,8}/u) ?? text.match(/[×x]\s*(\d{1,8})/u)?.[1];
  const quantity = Number(quantityText ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1) return undefined;
  const shipped = labelled(text,/发货时间/u,/20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/u);
  const submittedAt = shanghaiTimestamp(submitted);
  const paidAt = shanghaiTimestamp(paid);
  const shippedAt = shipped ? shanghaiTimestamp(shipped) : undefined;
  if (!submittedAt || !paidAt) return undefined;
  return {
    childOrderId,
    productId:product,
    merchantCode,
    specification:(labelled(text,/商品规格/u,/[^|]{1,500}/u) ?? "").slice(0,500),
    quantity,
    submittedAt,
    paidAt,
    ...(shippedAt ? { shippedAt } : {}),
    orderStatus:(labelled(text,/订单状态/u,/[^|]{1,100}/u) ?? "未知").slice(0,100),
    aftersalesStatus:(labelled(text,/售后状态/u,/[^|]{1,100}/u) ?? "").slice(0,100)
  };
}

function hasEnabledNextPage(doc: Document): boolean {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      "li[class*='pagination-next'],button[aria-label*='下一页'],button[title*='下一页']"
    )
  ).some((element) => {
    const button: HTMLButtonElement | null = element.matches("button")
      ? (element as HTMLButtonElement)
      : element.querySelector<HTMLButtonElement>("button");
    return !(
      element.className.includes("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      button?.disabled ||
      button?.getAttribute("aria-disabled") === "true"
    );
  });
}

function assertCompleteOrderTable(doc: Document, rows: readonly Element[]): void {
  const headers = new Set(
    Array.from(doc.querySelectorAll("thead th,[role='columnheader']"))
      .map((element) => normalize(element.textContent))
      .filter(Boolean)
  );
  if (
    ![...headers].some((header) => /订单/u.test(header)) ||
    ![...headers].some((header) => /商品/u.test(header))
  ) {
    throw new Error("RECENT_ORDER_STRUCTURE_UNCONFIRMED");
  }
  const pageText = normalize(doc.body?.textContent);
  if (rows.length === 0 && !/(?:暂无订单|暂无数据|无搜索结果)/u.test(pageText)) {
    throw new Error("RECENT_ORDER_STRUCTURE_UNCONFIRMED");
  }
  if (hasEnabledNextPage(doc)) {
    throw new Error("RECENT_ORDER_LIST_INCOMPLETE");
  }
  const declaredCount = /共\s*(\d{1,8})\s*(?:条|个)\s*(?:订单)?/u.exec(
    pageText
  )?.[1];
  if (declaredCount !== undefined && Number(declaredCount) !== rows.length) {
    throw new Error("RECENT_ORDER_LIST_INCOMPLETE");
  }
}

export function readDoudianRecentOrders(
  doc: Document,
  input: { readonly shopId: string; readonly shopName: string },
  observedAt = new Date().toISOString()
): Record<string, unknown> {
  const url = new URL(doc.defaultView?.location.href ?? "");
  if (url.origin !== "https://fxg.jinritemai.com" || !/\/ffa\/.*order/iu.test(url.pathname)) {
    throw new Error("PAGE_MISMATCH");
  }
  if (!input.shopId.trim() || !input.shopName.trim()) throw new Error("RECENT_ORDER_INPUT_INVALID");
  const observedShop = readDoudianVisibleShopIdentity(doc);
  if (
    !observedShop.identityConfirmed ||
    normalize(observedShop.name) !== normalize(input.shopName) ||
    (/^\d{5,30}$/u.test(input.shopId) &&
      /^\d{5,30}$/u.test(observedShop.id) &&
      observedShop.id !== input.shopId)
  ) {
    throw new Error("SHOP_IDENTITY_MISMATCH");
  }
  const rows = Array.from(doc.querySelectorAll("tbody tr,[data-row-key]"));
  assertCompleteOrderTable(doc, rows);
  const records = rows.map(parseRow).filter((value): value is DoudianRecentOrderLine => Boolean(value));
  if (records.length !== rows.length) throw new Error("RECENT_ORDER_ROWS_UNREADABLE");
  if (records.length > 500) throw new Error("RECENT_ORDER_RESULT_LIMIT_EXCEEDED");
  if (new Set(records.map((record) => record.childOrderId)).size !== records.length) {
    throw new Error("RECENT_ORDER_ROWS_DUPLICATED");
  }
  return {
    status:"complete",
    readerVersion:DOUDIAN_RECENT_ORDERS_VERSION,
    observedAt,
    shop:{ id:input.shopId,name:input.shopName },
    records,
    quality:{ completeness:1,diagnostics:[] },
    redactedFields:["buyer_name","phone","address","raw_order_json"],
    formMutations:0
  };
}
