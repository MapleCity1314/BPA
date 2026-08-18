import {
  DOUDIAN_ALLIANCE_NODE_ERROR_CODES,
  DoudianAllianceError,
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
  readDoudianHeaderShopIdentity,
  readDoudianHeaderShopName,
  resetDoudianShopSwitcherScroll,
  scrollDoudianShopSwitcher,
  selectDoudianAllianceShop,
  type AllianceShop,
  type DoudianAllianceNodeErrorCode,
  type RetiredProductsPage
} from "@bpa/adapter-doudian";

export type AllianceRetiredStageRequest =
  | { readonly stage: "discover-shops" }
  | { readonly stage: "read-shop-context" }
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
      readonly currentShop: {
        readonly id: string;
        readonly name: string;
      };
    }
  | {
      readonly stage: "read-shop-context";
      readonly currentShop: {
        readonly id: string;
        readonly name: string;
      };
    }
  | {
      readonly stage: "switch-shop";
      readonly shopName: string;
      readonly currentShop: {
        readonly id: string;
        readonly name: string;
      };
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

export function allianceRetiredErrorPayload(error: unknown): {
  readonly code: DoudianAllianceNodeErrorCode;
  readonly message: string;
} {
  const candidate =
    error instanceof DoudianAllianceError ? error.code : undefined;
  const code =
    candidate &&
    DOUDIAN_ALLIANCE_NODE_ERROR_CODES.has(
      candidate as DoudianAllianceNodeErrorCode
    )
      ? (candidate as DoudianAllianceNodeErrorCode)
      : "ALLIANCE_STAGE_FAILED";
  return { code, message: `Doudian alliance content error: ${code}` };
}

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

function assertNotCancelled(isCancelled: () => boolean): void {
  if (isCancelled()) {
    throw new DoudianAllianceError("COMMAND_CANCELLED");
  }
}

async function waitUntil<T>(
  read: () => T,
  timeoutMs: number,
  errorCode: string,
  doc: Document,
  isCancelled: () => boolean
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    assertNotCancelled(isCancelled);
    try {
      const result = read();
      assertNotCancelled(isCancelled);
      return result;
    } catch (error) {
      lastError = error;
      await waitForChange(250, doc);
      assertNotCancelled(isCancelled);
    }
  }
  if (
    lastError instanceof Error &&
    lastError.message !== errorCode
  ) {
    throw lastError;
  }
  throw new DoudianAllianceError(errorCode);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

async function openShopSwitcherWhenStable(
  doc: Document,
  isCancelled: () => boolean
): Promise<void> {
  await waitUntil(
    () => {
      openDoudianShopSwitcher(doc);
      return true;
    },
    8_000,
    "SHOP_SWITCH_TRIGGER_AMBIGUOUS",
    doc,
    isCancelled
  );
}

async function ensureShopDialog(
  doc: Document,
  isCancelled: () => boolean
): Promise<void> {
  assertNotCancelled(isCancelled);
  try {
    discoverDoudianAllianceShops(doc);
    return;
  } catch {
    assertNotCancelled(isCancelled);
    await openShopSwitcherWhenStable(doc, isCancelled);
  }
  await waitUntil(
    () => {
      try {
        return discoverDoudianAllianceShops(doc);
      } catch (error) {
        assertNotCancelled(isCancelled);
        openDoudianShopSwitcher(doc);
        throw error;
      }
    },
    8_000,
    "SHOP_SWITCH_DIALOG_TIMEOUT",
    doc,
    isCancelled
  );
}

async function readCurrentShopIdentity(
  doc: Document,
  isCancelled: () => boolean
): Promise<{ readonly id: string; readonly name: string }> {
  assertNotCancelled(isCancelled);
  try {
    return readDoudianHeaderShopIdentity(doc);
  } catch (error) {
    if (
      !(error instanceof DoudianAllianceError) ||
      error.code !== "SHOP_IDENTITY_UNCERTAIN"
    ) {
      throw error;
    }
    try {
      closeDoudianShopSwitcher(doc);
      await waitForChange(250, doc);
    } catch {
      // No switcher was open; continue through the authenticated header.
    }
    await openShopSwitcherWhenStable(doc, isCancelled);
  }
  return waitUntil(
    () => readDoudianHeaderShopIdentity(doc),
    15_000,
    "SHOP_IDENTITY_UNCERTAIN",
    doc,
    isCancelled
  );
}

async function discoverAllShops(
  doc: Document,
  currentShop: { readonly id: string; readonly name: string },
  isCancelled: () => boolean
): Promise<readonly AllianceShop[]> {
  assertNotCancelled(isCancelled);
  if (resetDoudianShopSwitcherScroll(doc)) {
    await waitForChange(250, doc);
  }
  const shops = new Map<string, AllianceShop>();
  for (let pass = 0; pass < 100; pass += 1) {
    assertNotCancelled(isCancelled);
    for (const shop of discoverDoudianAllianceShops(doc)) {
      const key = shop.id
        ? `id:${shop.id}`
        : `name:${normalize(shop.name)}:${shop.switcherOrdinal ?? 0}`;
      const existing = shops.get(key);
      if (
        existing &&
        (existing.name !== shop.name ||
          existing.status !== shop.status)
      ) {
        throw new DoudianAllianceError("SHOP_IDENTITY_DRIFT");
      }
      shops.set(key, shop);
    }
    const hasMore = scrollDoudianShopSwitcher(doc);
    if (!hasMore) break;
    if (pass === 99) throw new DoudianAllianceError("SHOP_LIST_INCOMPLETE");
    await waitForChange(450, doc);
    assertNotCancelled(isCancelled);
  }
  const sourceMatches = [...shops.values()].filter(
    (shop) =>
      normalize(shop.name) === normalize(currentShop.name) &&
      (shop.id === undefined || shop.id === currentShop.id)
  );
  if (sourceMatches.length === 0) {
    throw new DoudianAllianceError("CURRENT_SHOP_NOT_IN_LIST");
  }
  return [...shops.values()];
}

async function selectShopAcrossVirtualList(
  doc: Document,
  shop: AllianceShop,
  isCancelled: () => boolean
): Promise<void> {
  assertNotCancelled(isCancelled);
  if (filterDoudianShopSwitcher(doc, shop.name)) {
    await waitUntil(
      () => selectDoudianAllianceShop(doc, shop),
      8_000,
      "SHOP_TARGET_TIMEOUT",
      doc,
      isCancelled
    );
    return;
  }
  if (resetDoudianShopSwitcherScroll(doc)) {
    await waitForChange(250, doc);
  }
  let lastError: unknown;
  for (let pass = 0; pass < 100; pass += 1) {
    assertNotCancelled(isCancelled);
    try {
      selectDoudianAllianceShop(doc, shop);
      return;
    } catch (error) {
      lastError = error;
    }
    const hasMore = scrollDoudianShopSwitcher(doc);
    if (!hasMore) break;
    if (pass === 99) throw new DoudianAllianceError("SHOP_LIST_INCOMPLETE");
    await waitForChange(450, doc);
    assertNotCancelled(isCancelled);
  }
  if (lastError instanceof Error) throw lastError;
  throw new DoudianAllianceError("SHOP_TARGET_TIMEOUT");
}

export async function executeAllianceRetiredStage(
  request: AllianceRetiredStageRequest,
  doc: Document = document,
  pageUrl: string = location.href,
  isCancelled: () => boolean = () => false
): Promise<AllianceRetiredStageResult> {
  assertNotCancelled(isCancelled);
  if (request.stage === "discover-shops") {
    assertDoudianProductListPage(pageUrl);
    const currentShop = await readCurrentShopIdentity(doc, isCancelled);
    await ensureShopDialog(doc, isCancelled);
    const discovered = await discoverAllShops(doc, currentShop, isCancelled);
    assertNotCancelled(isCancelled);
    closeDoudianShopSwitcher(doc);
    return { stage: request.stage, shops: discovered, currentShop };
  }
  if (request.stage === "read-shop-context") {
    assertDoudianProductListPage(pageUrl);
    const currentShop = await readCurrentShopIdentity(doc, isCancelled);
    return { stage: request.stage, currentShop };
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
      const currentShop = await readCurrentShopIdentity(doc, isCancelled);
      return { stage: request.stage, shopName: current, currentShop };
    }
    await ensureShopDialog(doc, isCancelled);
    await selectShopAcrossVirtualList(doc, request.shop, isCancelled);
    const shopName = await waitUntil(
      () => {
        const observed = readDoudianHeaderShopName(doc);
        if (normalize(observed) !== normalize(request.shop.name)) {
          throw new DoudianAllianceError("SHOP_SWITCH_NOT_CONFIRMED");
        }
        return observed;
      },
      15_000,
      "SHOP_SWITCH_NOT_CONFIRMED",
      doc,
      isCancelled
    );
    assertNotCancelled(isCancelled);
    const identity = await readCurrentShopIdentity(doc, isCancelled);
    if (request.shop.id !== undefined && identity.id !== request.shop.id) {
      throw new DoudianAllianceError("SHOP_IDENTITY_MISMATCH");
    }
    return { stage: request.stage, shopName, currentShop: identity };
  }
  if (request.stage === "open-promotion") {
    assertDoudianProductListPage(pageUrl);
    openDoudianAllianceMenu(doc);
    await waitUntil(
      () => openDoudianAlliancePromoteEntry(doc),
      8_000,
      "ALLIANCE_PROMOTION_ENTRY_TIMEOUT",
      doc,
      isCancelled
    );
    return { stage: request.stage };
  }
  if (request.stage === "open-product-promotion") {
    assertBuyinDashboardPage(pageUrl);
    await waitUntil(
      () => openBuyinProductPromotion(doc),
      8_000,
      "BUYIN_PRODUCT_PROMOTION_ENTRY_TIMEOUT",
      doc,
      isCancelled
    );
    return { stage: request.stage };
  }
  if (request.stage === "open-retired-products") {
    assertBuyinPromotePage(pageUrl);
    let dismissedDialogs = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      assertNotCancelled(isCancelled);
      if (!dismissTopBuyinPromotionDialog(doc)) break;
      dismissedDialogs += 1;
      await waitForChange(500, doc);
      assertNotCancelled(isCancelled);
    }
    await waitUntil(
      () => openBuyinRetiredProducts(doc),
      8_000,
      "RETIRED_PRODUCTS_ENTRY_TIMEOUT",
      doc,
      isCancelled
    );
    return { stage: request.stage, dismissedDialogs };
  }
  assertBuyinRetiredPage(pageUrl);
  let page = await waitUntil(
    () => readBuyinRetiredProducts(doc),
    15_000,
    "RETIRED_PRODUCTS_PAGE_TIMEOUT",
    doc,
    isCancelled
  );
  if (
    normalize(page.shop.name) !== normalize(request.expectedShop.name) ||
    (request.expectedShop.id &&
      page.shop.id !== request.expectedShop.id)
  ) {
    throw new DoudianAllianceError("SHOP_IDENTITY_MISMATCH");
  }
  const products: RetiredProductsPage["products"][number][] = [];
  const productsByTreatmentId = new Map<
    string,
    RetiredProductsPage["products"][number]
  >();
  const addProduct = (
    product: RetiredProductsPage["products"][number]
  ): void => {
    const existing = productsByTreatmentId.get(product.treatmentId);
    if (existing) {
      if (
        existing.productId !== product.productId ||
        existing.title !== product.title ||
        existing.status !== product.status ||
        existing.processedAt !== product.processedAt ||
        existing.reason !== product.reason
      ) {
        throw new DoudianAllianceError("RETIRED_PRODUCT_ROW_CHANGED");
      }
      return;
    }
    productsByTreatmentId.set(product.treatmentId, product);
    products.push(product);
    if (products.length > 50) {
      throw new DoudianAllianceError("RETIRED_PRODUCT_LIMIT_EXCEEDED");
    }
  };
  for (const product of page.products) addProduct(product);
  for (let pageIndex = 1; pageIndex <= 100; pageIndex += 1) {
    assertNotCancelled(isCancelled);
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
          throw new DoudianAllianceError("RETIRED_PRODUCTS_PAGE_LOADING");
        }
        return observed;
      },
      15_000,
      "RETIRED_PRODUCTS_PAGINATION_TIMEOUT",
      doc,
      isCancelled
    );
    if (
      normalize(nextPage.shop.name) !==
        normalize(request.expectedShop.name) ||
      (request.expectedShop.id &&
        nextPage.shop.id !== request.expectedShop.id)
    ) {
      throw new DoudianAllianceError("SHOP_IDENTITY_MISMATCH");
    }
    for (const product of nextPage.products) {
      addProduct(product);
    }
    page = {
      ...nextPage,
      empty: products.length === 0,
      products: [...products]
    };
    if (pageIndex === 100 && advanceBuyinRetiredProductsPage(doc)) {
      throw new DoudianAllianceError("RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED");
    }
  }
  return { stage: request.stage, page };
}
