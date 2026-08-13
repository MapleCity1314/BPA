import { readDoudianVisibleShopIdentity } from "./shop-context.js";

const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
const BUYIN_ORIGIN = "https://buyin.jinritemai.com";
const DOUDIAN_PRODUCT_LIST_PATH = "/ffa/g/list";
const BUYIN_PROMOTE_PATH = "/dashboard/product/promote-manage";
const BUYIN_RETIRED_PATH = "/dashboard/regulation/clear-out";

const PRODUCT_ID_PATTERN = /(?:商品\s*ID|ID)[：:\s]*(\d{5,30})/iu;
const NUMBER_PATTERN = /\d{5,30}/u;

export const DOUDIAN_ALLIANCE_RUNTIME_VERSION = "2.0.5";

export type DoudianAllianceNodeErrorCode =
  | "ALLIANCE_CONTENT_RESPONSE_TIMEOUT"
  | "ALLIANCE_SOURCE_TAB_MISSING"
  | "ALLIANCE_STAGE_FAILED"
  | "ALLIANCE_TAB_TIMEOUT"
  | "AUTH_REQUIRED"
  | "BROWSER_DISCONNECTED"
  | "BROWSER_TAB_CAPACITY_EXCEEDED"
  | "CAPTCHA_REQUIRED"
  | "COMMAND_RESULT_TOO_LARGE"
  | "COMMAND_CANCELLED"
  | "CURRENT_SHOP_NOT_IN_LIST"
  | "DEADLINE_EXCEEDED"
  | "DOUDIAN_ALLIANCE_DISCOVERY_FAILED"
  | "DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID"
  | "PAGE_LOADING"
  | "PAGE_MISMATCH"
  | "PAGE_URL_INVALID"
  | "RATE_LIMITED"
  | "PROMOTION_DIALOG_CLOSE_AMBIGUOUS"
  | "PROMOTION_DIALOG_UNRECOGNIZED"
  | "PROMOTION_TAB_MISSING"
  | "RETIRED_PRODUCT_LIMIT_EXCEEDED"
  | "RETIRED_PRODUCT_ROW_CHANGED"
  | "RETIRED_PRODUCTS_MISSING"
  | "RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED"
  | "RETIRED_PRODUCTS_TABLE_CHANGED"
  | "RETIRED_TAB_MISSING"
  | "RISK_CONTROL"
  | "SESSION_EXPIRED"
  | "SHOP_CONTEXT_RESTORE_FAILED"
  | "SHOP_IDENTITY_DRIFT"
  | "SHOP_IDENTITY_AMBIGUOUS"
  | "SHOP_IDENTITY_MISMATCH"
  | "SHOP_IDENTITY_UNCERTAIN"
  | "SHOP_IDENTITY_UNCONFIRMED"
  | "SHOP_LIMIT_EXCEEDED"
  | "SHOP_LIST_EMPTY"
  | "SHOP_LIST_INCOMPLETE"
  | "SHOP_LIST_DUPLICATED"
  | "SHOP_NOT_ACTIVE"
  | "SHOP_SWITCH_DIALOG_AMBIGUOUS"
  | "SHOP_SWITCH_DIALOG_CLOSE_AMBIGUOUS"
  | "SHOP_SWITCH_DIALOG_TIMEOUT"
  | "SHOP_SWITCH_NOT_CONFIRMED"
  | "SHOP_SWITCH_SEARCH_AMBIGUOUS"
  | "SHOP_SWITCH_TRIGGER_AMBIGUOUS"
  | "SHOP_TARGET_AMBIGUOUS"
  | "SHOP_TARGET_INVALID"
  | "SHOP_TARGET_TIMEOUT";

export const DOUDIAN_ALLIANCE_NODE_ERROR_CODES = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "ALLIANCE_SOURCE_TAB_MISSING",
  "ALLIANCE_STAGE_FAILED",
  "ALLIANCE_TAB_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "BROWSER_TAB_CAPACITY_EXCEEDED",
  "CAPTCHA_REQUIRED",
  "COMMAND_RESULT_TOO_LARGE",
  "COMMAND_CANCELLED",
  "CURRENT_SHOP_NOT_IN_LIST",
  "DEADLINE_EXCEEDED",
  "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
  "DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "RATE_LIMITED",
  "PROMOTION_DIALOG_CLOSE_AMBIGUOUS",
  "PROMOTION_DIALOG_UNRECOGNIZED",
  "PROMOTION_TAB_MISSING",
  "RETIRED_PRODUCT_LIMIT_EXCEEDED",
  "RETIRED_PRODUCT_ROW_CHANGED",
  "RETIRED_PRODUCTS_MISSING",
  "RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED",
  "RETIRED_PRODUCTS_TABLE_CHANGED",
  "RETIRED_TAB_MISSING",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_DRIFT",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_LIMIT_EXCEEDED",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE",
  "SHOP_LIST_DUPLICATED",
  "SHOP_NOT_ACTIVE",
  "SHOP_SWITCH_DIALOG_AMBIGUOUS",
  "SHOP_SWITCH_DIALOG_CLOSE_AMBIGUOUS",
  "SHOP_SWITCH_DIALOG_TIMEOUT",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_SWITCH_SEARCH_AMBIGUOUS",
  "SHOP_SWITCH_TRIGGER_AMBIGUOUS",
  "SHOP_TARGET_AMBIGUOUS",
  "SHOP_TARGET_INVALID",
  "SHOP_TARGET_TIMEOUT"
]);

export class DoudianAllianceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DoudianAllianceError";
  }
}

export interface AllianceShop {
  readonly id?: string;
  readonly switcherOrdinal?: number;
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
  if (elements.length !== 1) throw new DoudianAllianceError(errorCode);
  return elements[0]!;
}

function requireUniqueInteractive(
  doc: Document,
  elements: readonly HTMLElement[],
  errorCode: string
): HTMLElement {
  if (elements.length === 1) return elements[0]!;
  const elementFromPoint = doc.elementFromPoint?.bind(doc);
  if (!elementFromPoint) throw new DoudianAllianceError(errorCode);
  const hitCandidates = elements.filter((element) => {
    if (
      element.getAttribute("aria-hidden") === "true" ||
      element.closest("[aria-hidden='true'],[inert]")
    ) {
      return false;
    }
    const view = doc.defaultView;
    if (view?.getComputedStyle(element).pointerEvents === "none") return false;
    const rect = element.getBoundingClientRect();
    const hit = elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return Boolean(hit && (element.contains(hit) || hit.contains(element)));
  });
  return requireUnique(hitCandidates, errorCode);
}

function parsedUrl(pageUrl: string): URL {
  try {
    return new URL(pageUrl);
  } catch {
    throw new DoudianAllianceError("PAGE_URL_INVALID");
  }
}

export function assertDoudianProductListPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (
    url.origin !== DOUDIAN_ORIGIN ||
    url.pathname !== DOUDIAN_PRODUCT_LIST_PATH
  ) {
    throw new DoudianAllianceError("PAGE_MISMATCH");
  }
}

export function assertBuyinPromotePage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (url.origin !== BUYIN_ORIGIN || url.pathname !== BUYIN_PROMOTE_PATH) {
    throw new DoudianAllianceError("PAGE_MISMATCH");
  }
}

export function assertBuyinDashboardPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (
    url.origin !== BUYIN_ORIGIN ||
    !url.pathname.startsWith("/dashboard")
  ) {
    throw new DoudianAllianceError("PAGE_MISMATCH");
  }
}

export function assertBuyinRetiredPage(pageUrl: string): void {
  const url = parsedUrl(pageUrl);
  if (url.origin !== BUYIN_ORIGIN || url.pathname !== BUYIN_RETIRED_PATH) {
    throw new DoudianAllianceError("PAGE_MISMATCH");
  }
}

export function readDoudianHeaderShopName(doc: Document): string {
  const identity = readDoudianVisibleShopIdentity(doc);
  if (!identity.identityConfirmed) {
    throw new DoudianAllianceError("SHOP_IDENTITY_UNCONFIRMED");
  }
  return identity.name;
}

export function readDoudianHeaderShopIdentity(doc: Document): {
  readonly id: string;
  readonly name: string;
} {
  const identity = readDoudianVisibleShopIdentity(doc);
  if (!identity.identityConfirmed) {
    throw new DoudianAllianceError("SHOP_IDENTITY_UNCERTAIN");
  }
  const stableId =
    readNumericShopIdNearHeaderElement(identity.element) ??
    readCurrentAccountPopoverShopId(doc, identity.name);
  if (!stableId) {
    throw new DoudianAllianceError("SHOP_IDENTITY_UNCERTAIN");
  }
  return { id: stableId, name: identity.name };
}

function readNumericShopIdNearHeaderElement(
  element: Element | undefined
): string | undefined {
  let current = element;
  while (
    current &&
    current !== current.ownerDocument.body &&
    current !== current.ownerDocument.documentElement
  ) {
    for (const key of [
      "data-shop-id",
      "data-shopid",
      "data-shop-key",
      "data-value",
      "value"
    ]) {
      const value = current.getAttribute(key);
      if (value && /^\d{5,30}$/u.test(value)) return value;
    }
    const href = current.getAttribute("href");
    if (href) {
      try {
        const url = new URL(href, DOUDIAN_ORIGIN);
        for (const key of ["shop_id", "shopId", "shopid"]) {
          const value = url.searchParams.get(key);
          if (value && /^\d{5,30}$/u.test(value)) return value;
        }
      } catch {
        // Ignore malformed attributes from untrusted page content.
      }
    }
    current = current.parentElement ?? undefined;
  }
  return undefined;
}

export function openDoudianShopSwitcher(doc: Document): void {
  if (visibleShopSwitcher(doc, false)) return;
  const switchEntries = Array.from(
    doc.querySelectorAll<HTMLElement>("body *")
  ).filter(
    (element) =>
      normalizeText(element.textContent) === "切换组织/店铺" &&
      visibleElement(element) &&
      !element.matches(".auxo-popover") &&
      element !== doc.body
  );
  if (switchEntries.length > 0) {
    const actionContainers = [
      ...new Set(
        switchEntries.map((element) => {
          let action = element;
          while (
            action.parentElement &&
            !action.parentElement.matches(".auxo-popover") &&
            normalizeText(action.parentElement.textContent) ===
              "切换组织/店铺" &&
            visibleElement(action.parentElement)
          ) {
            action = action.parentElement;
          }
          return action;
        })
      )
    ];
    activateElement(
      requireUniqueInteractive(
        doc,
        actionContainers,
        "SHOP_SWITCH_TRIGGER_AMBIGUOUS"
      )
    );
    return;
  }
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "#fxg-pc-header [class*='userName']," +
        "#fxg-pc-header [class*='headerShopName']"
    )
  ).filter(
    (element) => normalizeText(element.textContent) && visibleElement(element)
  );
  const actionCandidates = [
    ...new Set(
      candidates.map(
        (element) =>
          element.closest<HTMLElement>("[class*='headerShopName']") ??
          element
      )
    )
  ];
  const target = requireUniqueInteractive(
    doc,
    actionCandidates,
    "SHOP_SWITCH_TRIGGER_AMBIGUOUS"
  );
  activateElement(target);
}

function activateElement(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView;
  if (!view) {
    throw new DoudianAllianceError("SHOP_SWITCH_TRIGGER_AMBIGUOUS");
  }
  const rect = element.getBoundingClientRect();
  const clientX = Number.isFinite(rect.left + rect.width / 2)
    ? rect.left + rect.width / 2
    : 0;
  const clientY = Number.isFinite(rect.top + rect.height / 2)
    ? rect.top + rect.height / 2
    : 0;
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };
  const PointerEventConstructor = view.PointerEvent;
  if (PointerEventConstructor) {
    element.dispatchEvent(
      new PointerEventConstructor("pointerover", {
        ...eventInit,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      })
    );
  }
  element.dispatchEvent(new view.MouseEvent("mouseover", eventInit));
  if (PointerEventConstructor) {
    element.dispatchEvent(
      new PointerEventConstructor("pointerdown", {
        ...eventInit,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      })
    );
  }
  element.dispatchEvent(new view.MouseEvent("mousedown", eventInit));
  if (PointerEventConstructor) {
    element.dispatchEvent(
      new PointerEventConstructor("pointerup", {
        ...eventInit,
        buttons: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      })
    );
  }
  element.dispatchEvent(
    new view.MouseEvent("mouseup", { ...eventInit, buttons: 0 })
  );
  element.dispatchEvent(
    new view.MouseEvent("click", { ...eventInit, buttons: 0 })
  );
}

function visibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleShopSwitcher(
  doc: Document,
  required = true
): HTMLElement | undefined {
  const roots = new Set<HTMLElement>();
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(
      "[role='dialog'],.auxo-modal-wrap,.auxo-drawer-open," +
        ".auxo-drawer-content-wrapper"
    )
  )) {
    const root =
      element.closest<HTMLElement>(
        ".auxo-modal-wrap,.auxo-drawer-open"
      ) ??
      element.closest<HTMLElement>("[role='dialog']") ??
      element;
    if (!visibleElement(root) || roots.has(root)) continue;
    const text = normalizeText(root.textContent);
    if (
      text.includes("切换组织/店铺") ||
      text.includes("切换店铺") ||
      root.querySelector("[class*='roleItem'],[class*='introName']") !== null
    ) {
      roots.add(root);
    }
  }
  if (!required && roots.size === 0) return undefined;
  return requireUnique(
    [...roots],
    "SHOP_SWITCH_DIALOG_AMBIGUOUS"
  );
}

function visibleShopDialog(doc: Document): HTMLElement {
  return visibleShopSwitcher(doc)!;
}

function shopIdFromText(value: string): string | undefined {
  return (
    /(?:店铺\s*ID|店铺ID|ID)[：:\s]*(\d{5,30})/iu.exec(value)?.[1] ??
    undefined
  );
}

function readCurrentAccountPopoverShopId(
  doc: Document,
  currentShopName: string
): string | undefined {
  const accountPopovers = Array.from(
    doc.querySelectorAll<HTMLElement>(".auxo-popover")
  ).filter((popover) => {
    if (!visibleElement(popover)) return false;
    const text = normalizeText(popover.textContent);
    return text.includes("切换组织/店铺") && text.includes(currentShopName);
  });
  if (accountPopovers.length === 0) return undefined;
  if (accountPopovers.length !== 1) {
    throw new DoudianAllianceError("SHOP_IDENTITY_AMBIGUOUS");
  }
  const ids = [
    ...new Set(
      Array.from(
        normalizeText(accountPopovers[0]!.textContent).matchAll(
          /店铺\s*ID[：:\s]*(\d{5,30})/giu
        )
      ).map((match) => match[1]!)
    )
  ];
  if (ids.length !== 1) {
    throw new DoudianAllianceError("SHOP_IDENTITY_UNCERTAIN");
  }
  return ids[0];
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

function shopSwitcherCards(dialog: HTMLElement): HTMLElement[] {
  const legacyCards = Array.from(
    dialog.querySelectorAll<HTMLElement>("[class*='roleItem']")
  );
  if (legacyCards.length > 0) return legacyCards;
  const cards: HTMLElement[] = [];
  for (const nameElement of Array.from(
    dialog.querySelectorAll<HTMLElement>("[class*='introName']")
  )) {
    let candidate: HTMLElement = nameElement;
    while (candidate.parentElement && candidate.parentElement !== dialog) {
      const parent = candidate.parentElement;
      if (
        parent.querySelectorAll("[class*='introName']").length === 1 &&
        (shopIdFromText(normalizeText(parent.textContent)) !== undefined ||
          blockedShopStatus(normalizeText(parent.textContent)) !== undefined)
      ) {
        candidate = parent;
        break;
      }
      candidate = parent;
    }
    if (!cards.includes(candidate)) cards.push(candidate);
  }
  return cards;
}

function visibleWithinSwitcher(
  card: HTMLElement,
  viewport: HTMLElement
): boolean {
  if (!visibleElement(card)) return false;
  const cardRect = card.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const cardLeft = Number.isFinite(cardRect.left) ? cardRect.left : 0;
  const cardRight = Number.isFinite(cardRect.right)
    ? cardRect.right
    : cardLeft + cardRect.width;
  const viewportLeft = Number.isFinite(viewportRect.left)
    ? viewportRect.left
    : 0;
  const viewportRight = Number.isFinite(viewportRect.right)
    ? viewportRect.right
    : viewportLeft + viewportRect.width;
  return (
    cardRect.bottom > viewportRect.top &&
    cardRect.top < viewportRect.bottom &&
    cardRight > viewportLeft &&
    cardLeft < viewportRight
  );
}

export function discoverDoudianAllianceShops(
  doc: Document
): readonly AllianceShop[] {
  const dialog = visibleShopDialog(doc);
  const cards = shopSwitcherCards(dialog);
  if (cards.length === 0) throw new DoudianAllianceError("SHOP_LIST_EMPTY");
  const shops = cards.flatMap((card): AllianceShop[] => {
    const nameElement = card.querySelector<HTMLElement>(
      "[class*='introName']"
    ) ?? (card.matches("[class*='introName']") ? card : null);
    const name = normalizeText(nameElement?.textContent);
    if (!name || name.length > 80) {
      throw new DoudianAllianceError("SHOP_LIST_INCOMPLETE");
    }
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
  const nameCounts = new Map<string, number>();
  for (const shop of shops) {
    nameCounts.set(shop.name, (nameCounts.get(shop.name) ?? 0) + 1);
  }
  const nameOrdinals = new Map<string, number>();
  const distinguishable = shops.map((shop) => {
    if ((nameCounts.get(shop.name) ?? 0) < 2 || shop.id) return shop;
    const switcherOrdinal = nameOrdinals.get(shop.name) ?? 0;
    nameOrdinals.set(shop.name, switcherOrdinal + 1);
    return { ...shop, switcherOrdinal };
  });
  const identities = new Set<string>();
  for (const shop of distinguishable) {
    const identity = shop.id
      ? `id:${shop.id}`
      : `name:${shop.name}:${shop.switcherOrdinal ?? 0}`;
    if (identities.has(identity)) {
      throw new DoudianAllianceError("SHOP_LIST_DUPLICATED");
    }
    identities.add(identity);
  }
  return distinguishable;
}

export function closeDoudianShopSwitcher(doc: Document): void {
  const dialog = visibleShopSwitcher(doc, false);
  if (!dialog) return;
  const closeButtons = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button[aria-label='Close'],button[aria-label='close']," +
        "button[aria-label*='关闭']"
    )
  );
  if (closeButtons.length === 0) return;
  activateElement(requireUnique(
    closeButtons,
    "SHOP_SWITCH_DIALOG_CLOSE_AMBIGUOUS"
  ));
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
  if (!expected || expected.length > 80) {
    throw new DoudianAllianceError("SHOP_TARGET_INVALID");
  }
  const dialog = visibleShopDialog(doc);
  const viewport = shopSwitcherScrollTarget(doc) ?? dialog;
  const matches = shopSwitcherCards(dialog).filter((card) => {
    if (!visibleWithinSwitcher(card, viewport)) return false;
    const name = normalizeText(
      card.querySelector<HTMLElement>("[class*='introName']")?.textContent
    );
    if (name !== expected) return false;
    const cardId = shopIdFromText(normalizeText(card.textContent));
    return shop.id && cardId ? cardId === shop.id : true;
  });
  const card =
    shop.switcherOrdinal === undefined
      ? requireUnique(matches, "SHOP_TARGET_AMBIGUOUS")
      : matches[shop.switcherOrdinal];
  if (!card) throw new DoudianAllianceError("SHOP_TARGET_AMBIGUOUS");
  const blocked = blockedShopStatus(normalizeText(card.textContent));
  if (blocked) throw new DoudianAllianceError("SHOP_NOT_ACTIVE");
  activateElement(card);
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
    throw new DoudianAllianceError("PROMOTION_DIALOG_UNRECOGNIZED");
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
  if (uniqueNames.length !== 1) {
    throw new DoudianAllianceError("SHOP_IDENTITY_UNCONFIRMED");
  }
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

function validFieldLength(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
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
    throw new DoudianAllianceError("RETIRED_PRODUCTS_TABLE_CHANGED");
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
        if (cells.length < 5) {
          throw new DoudianAllianceError("RETIRED_PRODUCT_ROW_CHANGED");
        }
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
        if (
          !validFieldLength(cells[0]!, 1, 100) ||
          !validFieldLength(title, 1, 500) ||
          !validFieldLength(cells[2]!, 1, 100) ||
          !validFieldLength(cells[3]!, 1, 100) ||
          !validFieldLength(cells[4]!, 0, 1000)
        ) {
          throw new DoudianAllianceError("RETIRED_PRODUCT_ROW_CHANGED");
        }
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
  if (updatedAt && !validFieldLength(updatedAt, 1, 100)) {
    throw new DoudianAllianceError("RETIRED_PRODUCT_ROW_CHANGED");
  }
  return {
    shop: readBuyinShop(doc),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    empty,
    products
  };
}
