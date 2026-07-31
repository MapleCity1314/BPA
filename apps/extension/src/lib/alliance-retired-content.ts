import {
  advanceBuyinRetiredProductsPage,
  assertBuyinDashboardPage,
  assertBuyinPromotePage,
  assertBuyinRetiredPage,
  assertDoudianProductListPage,
  closeDoudianShopSwitcher,
  discoverDoudianAllianceShops,
  dismissTopBuyinPromotionDialog,
  filterDoudianShopSwitcher,
  openBuyinRetiredProducts,
  openBuyinProductPromotion,
  openDoudianAllianceMenu,
  openDoudianAlliancePromoteEntry,
  openDoudianShopSwitcher,
  readBuyinRetiredProducts,
  readDoudianHeaderShopName,
  resetDoudianShopSwitcherScroll,
  scrollDoudianShopSwitcher,
  selectDoudianAllianceShop,
  type AllianceShop,
  type RetiredProductsPage
} from "@bpa/adapter-doudian";

export type AllianceRetiredStageRequest =
  | { readonly stage: "discover-shops" }
  | {
      readonly stage: "switch-shop";
      readonly shop: AllianceShop;
    }
  | { readonly stage: "open-promotion" }
  | { readonly stage: "open-product-promotion" }
  | { readonly stage: "open-retired-products" }
  | {
      readonly stage: "collect-retired-products";
      readonly expectedShop: AllianceShop;
    };

export type AllianceRetiredStageResult =
  | {
      readonly stage: "discover-shops";
      readonly shops: readonly AllianceShop[];
      readonly currentShopName: string;
    }
  | {
      readonly stage: "switch-shop";
      readonly shopName: string;
    }
  | { readonly stage: "open-promotion" }
  | { readonly stage: "open-product-promotion" }
  | {
      readonly stage: "open-retired-products";
      readonly dismissedDialogs: number;
    }
  | {
      readonly stage: "collect-retired-products";
      readonly page: RetiredProductsPage;
    };

function waitForChange(maxWaitMs: number, doc: Document): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const Observer = doc.defaultView?.MutationObserver;
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      resolve();
    };
    observer =
      doc.documentElement && Observer
        ? new Observer(finish)
        : undefined;
    observer?.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    timer = setTimeout(finish, maxWaitMs);
  });
}

async function waitUntil<T>(
  read: () => T,
  timeoutMs: number,
  errorCode: string,
  doc: Document
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return read();
    } catch (error) {
      lastError = error;
      await waitForChange(250, doc);
    }
  }
  if (
    lastError instanceof Error &&
    lastError.message !== errorCode
  ) {
    throw lastError;
  }
  throw new Error(errorCode);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

async function ensureShopDialog(doc: Document): Promise<void> {
  try {
    discoverDoudianAllianceShops(doc);
    return;
  } catch {
    openDoudianShopSwitcher(doc);
  }
  await waitUntil(
    () => discoverDoudianAllianceShops(doc),
    8_000,
    "SHOP_SWITCH_DIALOG_TIMEOUT",
    doc
  );
}

async function discoverAllShops(
  doc: Document,
  currentShopName: string
): Promise<readonly AllianceShop[]> {
  if (resetDoudianShopSwitcherScroll(doc)) {
    await waitForChange(250, doc);
  }
  const shops = new Map<string, AllianceShop>();
  for (let pass = 0; pass < 100; pass += 1) {
    for (const shop of discoverDoudianAllianceShops(doc)) {
      const key = shop.id
        ? `id:${shop.id}`
        : `name:${normalize(shop.name)}`;
      const existing = shops.get(key);
      if (
        existing &&
        (existing.name !== shop.name ||
          existing.status !== shop.status)
      ) {
        throw new Error("SHOP_IDENTITY_DRIFT");
      }
      shops.set(key, shop);
    }
    const hasMore = scrollDoudianShopSwitcher(doc);
    if (!hasMore) break;
    if (pass === 99) throw new Error("SHOP_LIST_INCOMPLETE");
    await waitForChange(450, doc);
  }
  const sameName = [...shops.values()].filter(
    (shop) => normalize(shop.name) === normalize(currentShopName)
  );
  if (sameName.length === 0) {
    throw new Error("CURRENT_SHOP_NOT_IN_LIST");
  }
  if (sameName.length > 1) {
    throw new Error("SHOP_IDENTITY_AMBIGUOUS");
  }
  return [...shops.values()];
}

async function selectShopAcrossVirtualList(
  doc: Document,
  shop: AllianceShop
): Promise<void> {
  if (filterDoudianShopSwitcher(doc, shop.name)) {
    await waitUntil(
      () => selectDoudianAllianceShop(doc, shop),
      8_000,
      "SHOP_TARGET_TIMEOUT",
      doc
    );
    return;
  }
  if (resetDoudianShopSwitcherScroll(doc)) {
    await waitForChange(250, doc);
  }
  let lastError: unknown;
  for (let pass = 0; pass < 100; pass += 1) {
    try {
      selectDoudianAllianceShop(doc, shop);
      return;
    } catch (error) {
      lastError = error;
    }
    const hasMore = scrollDoudianShopSwitcher(doc);
    if (!hasMore) break;
    if (pass === 99) throw new Error("SHOP_LIST_INCOMPLETE");
    await waitForChange(450, doc);
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("SHOP_TARGET_TIMEOUT");
}

export async function executeAllianceRetiredStage(
  request: AllianceRetiredStageRequest,
  doc: Document = document,
  pageUrl: string = location.href
): Promise<AllianceRetiredStageResult> {
  if (request.stage === "discover-shops") {
    assertDoudianProductListPage(pageUrl);
    const currentShopName = readDoudianHeaderShopName(doc);
    await ensureShopDialog(doc);
    const shops = await discoverAllShops(doc, currentShopName);
    closeDoudianShopSwitcher(doc);
    return { stage: request.stage, shops, currentShopName };
  }
  if (request.stage === "switch-shop") {
    assertDoudianProductListPage(pageUrl);
    const current = readDoudianHeaderShopName(doc);
    if (
      !request.shop.id &&
      normalize(current) === normalize(request.shop.name)
    ) {
      try {
        closeDoudianShopSwitcher(doc);
      } catch {
        // The switcher is already closed.
      }
      return { stage: request.stage, shopName: current };
    }
    await ensureShopDialog(doc);
    await selectShopAcrossVirtualList(doc, request.shop);
    const shopName = await waitUntil(
      () => {
        const observed = readDoudianHeaderShopName(doc);
        if (normalize(observed) !== normalize(request.shop.name)) {
          throw new Error("SHOP_SWITCH_NOT_CONFIRMED");
        }
        return observed;
      },
      15_000,
      "SHOP_SWITCH_NOT_CONFIRMED",
      doc
    );
    return { stage: request.stage, shopName };
  }
  if (request.stage === "open-promotion") {
    assertDoudianProductListPage(pageUrl);
    openDoudianAllianceMenu(doc);
    await waitUntil(
      () => openDoudianAlliancePromoteEntry(doc),
      8_000,
      "ALLIANCE_PROMOTION_ENTRY_TIMEOUT",
      doc
    );
    return { stage: request.stage };
  }
  if (request.stage === "open-product-promotion") {
    assertBuyinDashboardPage(pageUrl);
    await waitUntil(
      () => openBuyinProductPromotion(doc),
      8_000,
      "BUYIN_PRODUCT_PROMOTION_ENTRY_TIMEOUT",
      doc
    );
    return { stage: request.stage };
  }
  if (request.stage === "open-retired-products") {
    assertBuyinPromotePage(pageUrl);
    let dismissedDialogs = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      if (!dismissTopBuyinPromotionDialog(doc)) break;
      dismissedDialogs += 1;
      await waitForChange(500, doc);
    }
    await waitUntil(
      () => openBuyinRetiredProducts(doc),
      8_000,
      "RETIRED_PRODUCTS_ENTRY_TIMEOUT",
      doc
    );
    return { stage: request.stage, dismissedDialogs };
  }
  assertBuyinRetiredPage(pageUrl);
  let page = await waitUntil(
    () => readBuyinRetiredProducts(doc),
    15_000,
    "RETIRED_PRODUCTS_PAGE_TIMEOUT",
    doc
  );
  if (
    normalize(page.shop.name) !== normalize(request.expectedShop.name) ||
    (request.expectedShop.id &&
      page.shop.id !== request.expectedShop.id)
  ) {
    throw new Error("SHOP_IDENTITY_MISMATCH");
  }
  const products = [...page.products];
  const treatmentIds = new Set(
    products.map((product) => product.treatmentId)
  );
  for (let pageIndex = 1; pageIndex <= 100; pageIndex += 1) {
    const previousSignature = page.products
      .map((product) => product.treatmentId)
      .join("\u0000");
    if (!advanceBuyinRetiredProductsPage(doc)) break;
    const nextPage = await waitUntil(
      () => {
        const observed = readBuyinRetiredProducts(doc);
        const signature = observed.products
          .map((product) => product.treatmentId)
          .join("\u0000");
        if (signature === previousSignature) {
          throw new Error("RETIRED_PRODUCTS_PAGE_LOADING");
        }
        return observed;
      },
      15_000,
      "RETIRED_PRODUCTS_PAGINATION_TIMEOUT",
      doc
    );
    if (
      normalize(nextPage.shop.name) !==
      normalize(request.expectedShop.name)
    ) {
      throw new Error("SHOP_IDENTITY_MISMATCH");
    }
    for (const product of nextPage.products) {
      if (treatmentIds.has(product.treatmentId)) continue;
      treatmentIds.add(product.treatmentId);
      products.push(product);
    }
    if (products.length > 500) {
      throw new Error("RETIRED_PRODUCT_LIMIT_EXCEEDED");
    }
    page = {
      ...nextPage,
      empty: products.length === 0,
      products: [...products]
    };
    if (pageIndex === 100 && advanceBuyinRetiredProductsPage(doc)) {
      throw new Error("RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED");
    }
  }
  return { stage: request.stage, page };
}
