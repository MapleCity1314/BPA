import { readDoudianVisibleShopIdentity } from "./shop-context.js";

export const DOUDIAN_RECENT_ORDERS_VERSION = "1.0.0";
export const DOUDIAN_RECENT_ORDERS_COLLECTOR_VERSION = "1.2.0";

interface DoudianOrderApiLine {
  readonly item_order_id?: unknown;
  readonly product_id?: unknown;
  readonly merchant_sku_code?: unknown;
  readonly combo_num?: unknown;
  readonly sku_spec?: unknown;
  readonly item_order_status_desc?: unknown;
  readonly after_sale_info?: unknown;
}

interface DoudianOrderApiRow {
  readonly create_time?: unknown;
  readonly pay_time?: unknown;
  readonly logistics_time?: unknown;
  readonly order_status_info?: unknown;
  readonly product_item?: unknown;
}

interface DoudianOrderApiResponse {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
  readonly page?: unknown;
  readonly size?: unknown;
  readonly total?: unknown;
}

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

function epochTimestamp(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const timestamp = new Date(seconds * 1_000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === "string" ? normalize(value).slice(0, maximum) : "";
}

function orderSpecification(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const item = objectValue(entry);
    const name = safeText(item.name ?? item.spec_name, 200);
    const detail = safeText(item.value ?? item.spec_value, 300);
    return detail ? `${name ? `${name}:` : ""}${detail}` : name;
  }).filter(Boolean).join(" | ").slice(0, 500);
}

function orderStatus(row: DoudianOrderApiRow): string {
  const status = objectValue(row.order_status_info);
  return safeText(status.order_status_text, 100) || "未知";
}

function isCancelledBeforeShipment(row: DoudianOrderApiRow): boolean {
  return !epochTimestamp(row.logistics_time) && /(?:已关闭|已取消|交易关闭)/u.test(orderStatus(row));
}

function apiRecords(rows: readonly DoudianOrderApiRow[]): DoudianRecentOrderLine[] {
  const records: DoudianRecentOrderLine[] = [];
  for (const row of rows) {
    const submittedAt = epochTimestamp(row.create_time);
    const paidAt = epochTimestamp(row.pay_time);
    if (!submittedAt || !paidAt || isCancelledBeforeShipment(row)) continue;
    const shippedAt = epochTimestamp(row.logistics_time);
    if (!Array.isArray(row.product_item)) throw new Error("RECENT_ORDER_ROWS_UNREADABLE");
    for (const rawLine of row.product_item) {
      const line = objectValue(rawLine) as DoudianOrderApiLine;
      const childOrderId = safeText(line.item_order_id, 40);
      const productId = safeText(line.product_id, 30);
      const merchantCode = safeText(line.merchant_sku_code, 200);
      const quantity = typeof line.combo_num === "number" ? line.combo_num : Number(line.combo_num);
      if (
        !/^\d{10,40}$/u.test(childOrderId) || !/^\d{5,30}$/u.test(productId) ||
        !merchantCode || !Number.isSafeInteger(quantity) || quantity < 1
      ) {
        throw new Error("RECENT_ORDER_ROWS_UNREADABLE");
      }
      const aftersale = objectValue(line.after_sale_info);
      records.push({
        childOrderId,
        productId,
        merchantCode,
        specification: orderSpecification(line.sku_spec),
        quantity,
        submittedAt,
        paidAt,
        ...(shippedAt ? { shippedAt } : {}),
        orderStatus: safeText(line.item_order_status_desc, 100) || orderStatus(row),
        aftersalesStatus: safeText(
          aftersale.after_sale_status_remark ?? aftersale.after_sale_text,
          100
        )
      });
    }
  }
  return records;
}

async function collectRecentOrdersViaApi(
  doc: Document,
  observedAt: Date,
  lookbackMinutes: number,
  deadline: number
): Promise<{ readonly records: DoudianRecentOrderLine[]; readonly pages: number } | undefined> {
  const view = doc.defaultView;
  if (!view || typeof view.fetch !== "function") return undefined;
  const endSeconds = Math.floor(observedAt.getTime() / 1_000);
  const startSeconds = endSeconds - lookbackMinutes * 60;
  const records: DoudianRecentOrderLine[] = [];
  const pageSize = 100;
  let pages = 0;
  let total = Number.POSITIVE_INFINITY;
  while (pages * pageSize < total) {
    if (Date.now() >= deadline || pages >= 6) throw new Error("RECENT_ORDER_RESULT_LIMIT_EXCEEDED");
    const params = new URLSearchParams({
      page: String(pages),
      pageSize: String(pageSize),
      "compact_time[select]": "create_time_start,create_time_end",
      create_time_start: String(startSeconds),
      create_time_end: String(endSeconds),
      order_by: "create_time",
      order: "desc",
      tab: "all",
      appid: "1"
    });
    const response = await view.fetch(
      new URL(`/api/order/searchlist?${params.toString()}`, view.location.href),
      { credentials: "include", headers: { accept: "application/json" } }
    );
    if (!response.ok) throw new Error("RECENT_ORDER_PAGE_TIMEOUT");
    const body = await response.json() as DoudianOrderApiResponse;
    if (body.code !== 0 || !Array.isArray(body.data)) {
      throw new Error("RECENT_ORDER_STRUCTURE_UNCONFIRMED");
    }
    if (!Number.isSafeInteger(body.total) || Number(body.total) < 0) {
      throw new Error("RECENT_ORDER_STRUCTURE_UNCONFIRMED");
    }
    total = Number(body.total);
    records.push(...apiRecords(body.data as DoudianOrderApiRow[]));
    pages += 1;
    if (records.length > 500 || total > 600) throw new Error("RECENT_ORDER_RESULT_LIMIT_EXCEEDED");
    if (body.data.length === 0) break;
  }
  if (pages * pageSize < total) throw new Error("RECENT_ORDER_LIST_INCOMPLETE");
  return { records, pages };
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

function visible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function shanghaiInputTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type,part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function setNativeValue(input: HTMLInputElement,value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as object,"value"
  )?.set;
  if (!setter) throw new Error("RECENT_ORDER_FILTER_UNAVAILABLE");
  setter.call(input,value);
  for (const type of ["input","change","blur"]) {
    input.dispatchEvent(new Event(type,{ bubbles:true }));
  }
}

function exactVisible(doc: Document,selector: string,text: string): HTMLElement | undefined {
  return Array.from(doc.querySelectorAll<HTMLElement>(selector))
    .find((element) => visible(element) && normalize(element.textContent) === text);
}

async function waitFor(check: () => boolean,deadline: number,waitMs: number): Promise<void> {
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve,waitMs));
  }
  throw new Error("RECENT_ORDER_PAGE_TIMEOUT");
}

function rowSignature(doc: Document): string {
  return Array.from(doc.querySelectorAll("tbody tr[data-row-key]"))
    .slice(0,6).map((row) => row.getAttribute("data-row-key") ?? "").join("|");
}

function liveRecords(doc: Document): DoudianRecentOrderLine[] {
  const rows = Array.from(doc.querySelectorAll<HTMLElement>("tbody tr[data-row-key]"));
  const records: DoudianRecentOrderLine[] = [];
  let submittedAt: string | undefined;
  for (const row of rows) {
    const key = row.getAttribute("data-row-key") ?? "";
    const text = normalize(row.textContent);
    if (!key.startsWith("child")) {
      const submitted = labelled(text,/下单时间/u,/20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/u);
      submittedAt = submitted ? shanghaiTimestamp(submitted) : undefined;
      continue;
    }
    const productCell = row.children.item(1);
    const productText = normalize(productCell?.textContent);
    const childOrderId = key.slice("child".length);
    const merchantCode = productText.match(
      /商家编码\s*[：:]\s*[<〈《]?\s*([A-Za-z0-9._-]{1,200})/u
    )?.[1];
    const quantity = Number(productText.match(/[x×]\s*(\d{1,8})(?![\s\S]*[x×]\s*\d)/u)?.[1] ?? 1);
    if (
      !/^\d{10,40}$/u.test(childOrderId) || !merchantCode || !submittedAt ||
      !Number.isSafeInteger(quantity) || quantity < 1
    ) {
      throw new Error("RECENT_ORDER_ROWS_UNREADABLE");
    }
    const specification = normalize(
      productCell?.querySelector<HTMLElement>("[class*='property'],[class*='Property']")?.textContent
    ).slice(0,500);
    records.push({
      childOrderId,
      productId:`merchant:${merchantCode}`,
      merchantCode,
      specification,
      quantity,
      submittedAt,
      paidAt:submittedAt,
      orderStatus:normalize(row.children.item(4)?.textContent).slice(0,100) || "已支付",
      aftersalesStatus:normalize(row.children.item(3)?.textContent).slice(0,100)
    });
  }
  return records;
}

export async function collectDoudianRecentOrders(
  doc: Document,
  input: { readonly shopId: string; readonly shopName: string; readonly lookbackMinutes?: number },
  options: { readonly deadline: number; readonly waitMs?: number }
): Promise<Record<string, unknown>> {
  const url = new URL(doc.defaultView?.location.href ?? "");
  if (url.origin !== "https://fxg.jinritemai.com" || !/\/ffa\/.*order/iu.test(url.pathname)) {
    throw new Error("PAGE_MISMATCH");
  }
  const observedShop = readDoudianVisibleShopIdentity(doc);
  if (
    !observedShop.identityConfirmed || normalize(observedShop.name) !== normalize(input.shopName) ||
    (/^\d{5,30}$/u.test(input.shopId) && /^\d{5,30}$/u.test(observedShop.id) && observedShop.id !== input.shopId)
  ) {
    throw new Error("SHOP_IDENTITY_MISMATCH");
  }
  const lookbackMinutes = input.lookbackMinutes ?? 90;
  if (!Number.isSafeInteger(lookbackMinutes) || lookbackMinutes < 60 || lookbackMinutes > 180) {
    throw new Error("RECENT_ORDER_INPUT_INVALID");
  }
  const waitMs = options.waitMs ?? 250;
  const observedAt = new Date();
  const apiResult = await collectRecentOrdersViaApi(
    doc,
    observedAt,
    lookbackMinutes,
    options.deadline
  );
  if (apiResult) {
    const unique = new Map<string, DoudianRecentOrderLine>();
    for (const record of apiResult.records) {
      const previous = unique.get(record.childOrderId);
      if (
        previous && (
          previous.productId !== record.productId ||
          previous.merchantCode !== record.merchantCode ||
          previous.quantity !== record.quantity ||
          previous.paidAt !== record.paidAt
        )
      ) {
        throw new Error("RECENT_ORDER_ROWS_DUPLICATED");
      }
      if (!previous || (!previous.shippedAt && record.shippedAt)) {
        unique.set(record.childOrderId, record);
      }
    }
    const duplicateRows = apiResult.records.length - unique.size;
    return {
      status: "complete",
      readerVersion: DOUDIAN_RECENT_ORDERS_COLLECTOR_VERSION,
      observedAt: observedAt.toISOString(),
      shop: { id: input.shopId, name: input.shopName },
      records: [...unique.values()],
      quality: {
        completeness: 1,
        diagnostics: [
          `Collected a bounded ${lookbackMinutes}-minute order window across ${apiResult.pages} API page(s).`,
          ...(duplicateRows > 0
            ? [`Collapsed ${duplicateRows} identical row(s) repeated across live pagination boundaries.`]
            : [])
        ]
      },
      redactedFields: ["buyer_name", "phone", "address", "raw_order_json"],
      formMutations: 0
    };
  }
  const start = shanghaiInputTime(new Date(observedAt.getTime() - lookbackMinutes * 60_000));
  const end = shanghaiInputTime(observedAt);
  const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>(
    "input[placeholder='开始时间'],input[placeholder='结束时间']"
  )).filter(visible);
  if (inputs.length < 2) throw new Error("RECENT_ORDER_FILTER_UNAVAILABLE");
  setNativeValue(inputs[0]!,start);
  setNativeValue(inputs[1]!,end);
  inputs[1]!.dispatchEvent(new KeyboardEvent("keydown",{ bubbles:true,key:"Enter",code:"Enter" }));
  if (inputs[0]!.value !== start || inputs[1]!.value !== end) {
    throw new Error("RECENT_ORDER_FILTER_UNCONFIRMED");
  }
  let formMutations = 2;
  const before = rowSignature(doc);
  const query = exactVisible(doc,"button,[role='button']","查询");
  if (!query) throw new Error("RECENT_ORDER_FILTER_UNAVAILABLE");
  query.click();
  formMutations += 1;
  await waitFor(() => {
    const loading = doc.querySelector(".auxo-spin-spinning,[aria-busy='true']");
    return !loading && (rowSignature(doc) !== before || normalize(doc.body?.textContent).includes("共"));
  },options.deadline,waitMs);

  const sizeChanger = doc.querySelector<HTMLElement>(".auxo-pagination-options-size-changer");
  if (visible(sizeChanger) && !normalize(sizeChanger.textContent).startsWith("100")) {
    sizeChanger.click();
    await waitFor(() => Boolean(exactVisible(doc,"[role='option'],li,div","100 条/页")),options.deadline,waitMs);
    const option = exactVisible(doc,"[role='option'],li,div","100 条/页");
    if (option) {
      option.click();
      formMutations += 2;
      await waitFor(() => !doc.querySelector(".auxo-spin-spinning,[aria-busy='true']"),options.deadline,waitMs);
    }
  }

  const records: DoudianRecentOrderLine[] = [];
  let pages = 0;
  while (true) {
    pages += 1;
    if (pages > 60) throw new Error("RECENT_ORDER_RESULT_LIMIT_EXCEEDED");
    records.push(...liveRecords(doc));
    if (records.length > 500) throw new Error("RECENT_ORDER_RESULT_LIMIT_EXCEEDED");
    if (!hasEnabledNextPage(doc)) break;
    const prior = rowSignature(doc);
    const next = Array.from(doc.querySelectorAll<HTMLElement>("li[class*='pagination-next'],button[aria-label*='下一页'],button[title*='下一页']"))
      .find(visible);
    if (!next) throw new Error("RECENT_ORDER_LIST_INCOMPLETE");
    const button = next.matches("button") ? next : next.querySelector<HTMLElement>("button") ?? next;
    button.click();
    formMutations += 1;
    await waitFor(() => rowSignature(doc) !== prior && !doc.querySelector(".auxo-spin-spinning,[aria-busy='true']"),options.deadline,waitMs);
  }
  const unique = new Map(records.map((record) => [`${record.childOrderId}:${record.merchantCode}`,record]));
  if (unique.size !== records.length) throw new Error("RECENT_ORDER_ROWS_DUPLICATED");
  return {
    status:"complete",readerVersion:DOUDIAN_RECENT_ORDERS_COLLECTOR_VERSION,
    observedAt:observedAt.toISOString(),shop:{ id:input.shopId,name:input.shopName },
    records:[...unique.values()],
    quality:{ completeness:1,diagnostics:[
      `Collected a bounded ${lookbackMinutes}-minute order window across ${pages} page(s).`,
      ...(records.length ? ["Live order paid_at is conservatively approximated by submitted_at until the WDT fact arrives."] : [])
    ] },
    redactedFields:["buyer_name","phone","address","raw_order_json"],
    formMutations
  };
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
