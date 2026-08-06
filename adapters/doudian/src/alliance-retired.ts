import { readDoudianVisibleShopIdentity } from "./shop-context.js";

const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
const BUYIN_ORIGIN = "https://buyin.jinritemai.com";
const DOUDIAN_PRODUCT_LIST_PATH = "/ffa/g/list";
const BUYIN_PROMOTE_PATH = "/dashboard/product/promote-manage";
const BUYIN_RETIRED_PATH = "/dashboard/regulation/clear-out";

const PRODUCT_ID_PATTERN = /(?:商品\s*ID|ID)[：:\s]*(\d{5,30})/iu;
const NUMBER_PATTERN = /\d{5,30}/u;

export const DOUDIAN_ALLIANCE_RUNTIME_VERSION = "1.0.0";

export interface AllianceShop {
  readonly id?: string;
  readonly name: string;
  readonly status: "active" | "blocked";
  readonly statusText: string;
}

export interface RetiredProduct {
  readonly treatmentId: string;
  readonly productId?: string;
  readonly title: string;
  readonly status: string;
  readonly processedAt: string;
  readonly reason: string;
}

export interface RetiredProductsPage {
  readonly shop: {
    readonly id?: string;
    readonly name: string;
  };
  readonly updatedAt?: string;
  readonly empty: boolean;
  readonly products: readonly RetiredProduct[];
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function compactText(value: string | null | undefined): string {
  return normalizeText(value).replace(/\s+/gu, "");
}

function exactElements(
  root: ParentNode,
  selector: string,
  text: string
): HTMLElement[] {
  const expected = normalizeText(text);
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => normalizeText(element.textContent) === expected
  );
}

function requireUnique(
  elements: readonly HTMLElement[],
  errorCode: string
): HTMLElement {
  if (elements.length !== 1) throw new Error(errorCode);
  return elements[0]!;
}

function parsedUrl(pageUrl: string): URL {
  try {
    return new URL(pageUrl);
  } catch {
    throw new Error("PAGE_URL_INVALID");
  }
}

export function assertDoudianProductListPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (
    url.origin !== DOUDIAN_ORIGIN ||
    url.pathname !== DOUDIAN_PRODUCT_LIST_PATH
  ) {
    throw new Error("PAGE_MISMATCH");
  }
}

export function assertBuyinPromotePage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (url.origin !== BUYIN_ORIGIN || url.pathname !== BUYIN_PROMOTE_PATH) {
    throw new Error("PAGE_MISMATCH");
  }
}

export function assertBuyinDashboardPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (
    url.origin !== BUYIN_ORIGIN ||
    !url.pathname.startsWith("/dashboard")
  ) {
    throw new Error("PAGE_MISMATCH");
  }
}

export function assertBuyinRetiredPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (url.origin !== BUYIN_ORIGIN || url.pathname !== BUYIN_RETIRED_PATH) {
    throw new Error("PAGE_MISMATCH");
  }
}

export function readDoudianHeaderShopName(doc: Document): string {
  const identity = readDoudianVisibleShopIdentity(doc);
  if (!identity.identityConfirmed) {
    throw new Error("SHOP_IDENTITY_UNCONFIRMED");
  }
  return identity.name;
}

export function openDoudianShopSwitcher(doc: Document): void {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "#fxg-pc-header [class*='headerShopName']"
    )
  ).filter((element) => normalizeText(element.textContent));
  const target = requireUnique(candidates, "SHOP_SWITCH_TRIGGER_AMBIGUOUS");
  target.click();
}

function visibleShopDialog(doc: Document): HTMLElement {
  const dialogs = Array.from(
    doc.querySelectorAll<HTMLElement>("[role='dialog']")
  ).filter((dialog) => {
    const text = normalizeText(dialog.textContent);
    return (
      text.includes("切换组织/店铺") ||
      text.includes("切换店铺") ||
      dialog.querySelector("[class*='roleItem']") !== null
    );
  });
  return requireUnique(dialogs, "SHOP_SWITCH_DIALOG_AMBIGUOUS");
}

function shopIdFromText(value: string): string | undefined {
  return (
    /(?:店铺\s*ID|店铺ID|ID)[：:\s]*(\d{5,30})/iu.exec(value)?.[1] ??
    undefined
  );
}

function blockedShopStatus(value: string): string | undefined {
  const compact = compactText(value);
  if (compact.includes("正常营业")) return undefined;
  return [
    "停业整顿",
    "停止营业",
    "暂停营业",
    "已停业",
    "已关店",
    "店铺关闭",
    "退店中",
    "已退店",
    "清退",
    "冻结",
    "限制营业",
    "异常营业"
  ].find((status) => compact.includes(status));
}

export function discoverDoudianAllianceShops(
  doc: Document
): readonly AllianceShop[] {
  const dialog = visibleShopDialog(doc);
  const cards = Array.from(
    dialog.querySelectorAll<HTMLElement>("[class*='roleItem']")
  );
  if (cards.length === 0) throw new Error("SHOP_LIST_EMPTY");
  const shops = cards.flatMap((card): AllianceShop[] => {
    const nameElement = card.querySelector<HTMLElement>(
      "[class*='introName']"
    );
    const name = normalizeText(nameElement?.textContent);
    if (!name || name.length > 80) return [];
    const rowText = normalizeText(card.textContent);
    const blocked = blockedShopStatus(rowText);
    const id = shopIdFromText(rowText);
    return [
      {
        ...(id === undefined ? {} : { id }),
        name,
        status: blocked ? "blocked" : "active",
        statusText: blocked ?? "正常营业"
      }
    ];
  });
  const identities = new Set<string>();
  for (const shop of shops) {
    const identity = shop.id ? `id:${shop.id}` : `name:${shop.name}`;
    if (identities.has(identity)) throw new Error("SHOP_LIST_DUPLICATED");
    identities.add(identity);
  }
  for (const shop of shops) {
    if (
      shops.some(
        (candidate) =>
          candidate !== shop &&
          candidate.name === shop.name &&
          (!candidate.id || !shop.id)
      )
    ) {
      throw new Error("SHOP_IDENTITY_AMBIGUOUS");
    }
  }
  return shops;
}

export function closeDoudianShopSwitcher(doc: Document): void {
  const dialog = visibleShopDialog(doc);
  const closeButtons = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button[aria-label='Close'],button[aria-label='close']," +
        "button[aria-label*='关闭']"
    )
  );
  if (closeButtons.length === 0) return;
  requireUnique(
    closeButtons,
    "SHOP_SWITCH_DIALOG_CLOSE_AMBIGUOUS"
  ).click();
}

function shopSwitcherScrollTarget(doc: Document): HTMLElement | undefined {
  const dialog = visibleShopDialog(doc);
  return [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>("*"))]
    .filter(
      (element) => element.scrollHeight > element.clientHeight + 20
    )
    .sort(
      (left, right) =>
        right.scrollHeight -
        right.clientHeight -
        (left.scrollHeight - left.clientHeight)
    )[0];
}

export function resetDoudianShopSwitcherScroll(doc: Document): boolean {
  const target = shopSwitcherScrollTarget(doc);
  if (!target || target.scrollTop === 0) return false;
  target.scrollTop = 0;
  target.dispatchEvent(
    new (doc.defaultView?.Event ?? Event)("scroll", { bubbles: true })
  );
  return true;
}

export function scrollDoudianShopSwitcher(doc: Document): boolean {
  const target = shopSwitcherScrollTarget(doc);
  if (!target) return false;
  const before = target.scrollTop;
  const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
  target.scrollTop = Math.min(
    before + Math.max(300, target.clientHeight || 300),
    maximum
  );
  if (target.scrollTop === before) return false;
  target.dispatchEvent(
    new (doc.defaultView?.Event ?? Event)("scroll", { bubbles: true })
  );
  return true;
}

export function filterDoudianShopSwitcher(
  doc: Document,
  shopName: string
): boolean {
  const dialog = visibleShopDialog(doc);
  const inputs = Array.from(
    dialog.querySelectorAll<HTMLInputElement>("input[placeholder*='搜索']")
  );
  if (inputs.length === 0) return false;
  const input = requireUnique(
    inputs,
    "SHOP_SWITCH_SEARCH_AMBIGUOUS"
  ) as HTMLInputElement;
  const value = normalizeText(shopName);
  const view = doc.defaultView;
  const valueSetter = view
    ? Object.getOwnPropertyDescriptor(
        view.HTMLInputElement.prototype,
        "value"
      )?.set
    : undefined;
  if (valueSetter) valueSetter.call(input, value);
  else input.value = value;
  const EventConstructor = view?.Event ?? Event;
  input.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  input.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  return true;
}

export function selectDoudianAllianceShop(
  doc: Document,
  shop: AllianceShop
): void {
  const expected = normalizeText(shop.name);
  if (!expected || expected.length > 80) throw new Error("SHOP_TARGET_INVALID");
  const dialog = visibleShopDialog(doc);
  const matches = Array.from(
    dialog.querySelectorAll<HTMLElement>("[class*='roleItem']")
  ).filter((card) => {
    const name = normalizeText(
      card.querySelector<HTMLElement>("[class*='introName']")?.textContent
    );
    if (name !== expected) return false;
    return shop.id
      ? shopIdFromText(normalizeText(card.textContent)) === shop.id
      : true;
  });
  const card = requireUnique(matches, "SHOP_TARGET_AMBIGUOUS");
  const blocked = blockedShopStatus(normalizeText(card.textContent));
  if (blocked) throw new Error("SHOP_NOT_ACTIVE");
  card.click();
}

export function openDoudianAllianceMenu(doc: Document): void {
  const allianceTitle = requireUnique(
    exactElements(doc, "div[class*='menuTitle']", "精选联盟"),
    "ALLIANCE_ENTRY_AMBIGUOUS"
  );
  allianceTitle.click();
}

export function openDoudianAlliancePromoteEntry(doc: Document): void {
  const promote = requireUnique(
    exactElements(doc, "div[class*='layerTitle']", "去推广"),
    "ALLIANCE_PROMOTION_ENTRY_AMBIGUOUS"
  );
  promote.click();
}

export function openDoudianAlliancePromotion(doc: Document): void {
  openDoudianAllianceMenu(doc);
  openDoudianAlliancePromoteEntry(doc);
}

export function dismissTopBuyinPromotionDialog(doc: Document): boolean {
  const dialogs = Array.from(
    doc.querySelectorAll<HTMLElement>("[role='dialog']")
  ).filter((dialog) => normalizeText(dialog.textContent));
  if (dialogs.length === 0) return false;
  const dialog = dialogs[dialogs.length - 1]!;
  const dialogText = normalizeText(dialog.textContent);
  const knownDialog = [
    "如何迁移旧版数据",
    "推广策略支持分层设佣"
  ].some((signature) => dialogText.includes(signature));
  if (!knownDialog) {
    throw new Error("PROMOTION_DIALOG_UNRECOGNIZED");
  }
  const closeButtons = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button[aria-label='Close'],button[aria-label='close']"
    )
  );
  requireUnique(closeButtons, "PROMOTION_DIALOG_CLOSE_AMBIGUOUS").click();
  return true;
}

export function openBuyinProductPromotion(doc: Document): void {
  requireUnique(
    exactElements(doc, "li[role='menuitem']", "推商品"),
    "BUYIN_PRODUCT_PROMOTION_ENTRY_AMBIGUOUS"
  ).click();
}

export function dismissBuyinPromotionDialogs(doc: Document): number {
  let dismissed = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    if (!dismissTopBuyinPromotionDialog(doc)) break;
    dismissed += 1;
  }
  return dismissed;
}

export function openBuyinRetiredProducts(doc: Document): void {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "div[class*='back_old_version'],div[class*='space-item']"
    )
  ).filter((element) =>
    normalizeText(element.textContent).includes("已清退商品")
  );
  const mostSpecific = candidates.filter(
    (element) =>
      Array.from(element.children).some(
        (child) => normalizeText(child.textContent) === "已清退商品"
      ) || normalizeText(element.textContent) === "已清退商品"
  );
  requireUnique(
    mostSpecific,
    "RETIRED_PRODUCTS_ENTRY_AMBIGUOUS"
  ).click();
}

function retiredProductsNextControl(doc: Document): HTMLElement | undefined {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "li[class*='pagination-next'],button[aria-label='下一页']," +
        "button[title='下一页']"
    )
  );
  if (candidates.length === 0) return undefined;
  return requireUnique(
    candidates,
    "RETIRED_PRODUCTS_PAGINATION_AMBIGUOUS"
  );
}

export function advanceBuyinRetiredProductsPage(doc: Document): boolean {
  const control = retiredProductsNextControl(doc);
  if (!control) return false;
  const button = control.matches("button")
    ? control
    : control.querySelector<HTMLElement>("button") ?? control;
  const classText = `${control.className} ${button.className}`.toLowerCase();
  const disabled =
    control.hasAttribute("disabled") ||
    button.hasAttribute("disabled") ||
    control.getAttribute("aria-disabled") === "true" ||
    button.getAttribute("aria-disabled") === "true" ||
    classText.includes("disabled");
  if (disabled) return false;
  button.click();
  return true;
}

function readBuyinShop(doc: Document): { id?: string; name: string } {
  const names = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "[class*='btn-item-role-exchange-name__title']"
    )
  )
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean);
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length !== 1) throw new Error("SHOP_IDENTITY_UNCONFIRMED");
  const headerText = normalizeText(
    doc.querySelector("header")?.textContent ?? doc.body?.textContent
  );
  const id = shopIdFromText(headerText);
  return {
    ...(id === undefined ? {} : { id }),
    name: uniqueNames[0]!
  };
}

function updatedAtFromDocument(doc: Document): string | undefined {
  const text = normalizeText(doc.body?.textContent);
  return /当前记录更新时间[：:\s]*([0-9/.-]{8,10})/u.exec(text)?.[1];
}

export function readBuyinRetiredProducts(
  doc: Document
): RetiredProductsPage {
  const table = requireUnique(
    Array.from(doc.querySelectorAll<HTMLTableElement>("table")),
    "RETIRED_PRODUCTS_TABLE_AMBIGUOUS"
  ) as HTMLTableElement;
  const headers = Array.from(table.querySelectorAll("th")).map((cell) =>
    normalizeText(cell.textContent)
  );
  const expectedHeaders = [
    "处理ID",
    "商品信息",
    "处理状态",
    "处理时间",
    "处理原因"
  ];
  if (
    expectedHeaders.some((header) => !headers.includes(header))
  ) {
    throw new Error("RETIRED_PRODUCTS_TABLE_CHANGED");
  }
  const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  const empty =
    rows.length === 0 ||
    rows.every((row) => normalizeText(row.textContent).includes("无搜索结果"));
  const products = empty
    ? []
    : rows.map((row): RetiredProduct => {
        const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
          normalizeText(cell.textContent)
        );
        if (cells.length < 5) throw new Error("RETIRED_PRODUCT_ROW_CHANGED");
        const productText = cells[1]!;
        const productId =
          PRODUCT_ID_PATTERN.exec(productText)?.[1] ??
          NUMBER_PATTERN.exec(productText)?.[0];
        const title = productId
          ? normalizeText(
              productText
                .replace(PRODUCT_ID_PATTERN, "")
                .replace(productId, "")
            )
          : productText;
        return {
          treatmentId: cells[0]!,
          ...(productId ? { productId } : {}),
          title,
          status: cells[2]!,
          processedAt: cells[3]!,
          reason: cells[4]!
        };
      });
  const updatedAt = updatedAtFromDocument(doc);
  return {
    shop: readBuyinShop(doc),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    empty,
    products
  };
}
