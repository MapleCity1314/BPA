import { prepareDoudianProductList } from "./product-list-guard.js";

export const DOUDIAN_INVENTORY_SNAPSHOT_VERSION = "1.0.0";

export interface DoudianInventoryChannelSnapshot {
  readonly channelGoodsId: string;
  readonly stock: number;
}

export interface DoudianInventorySkuSnapshot {
  readonly platformSkuId: string;
  readonly merchantCode: string;
  readonly currentStock: number;
  readonly occupiedStock: number;
  readonly unoccupiedStock: number;
  readonly channels: readonly DoudianInventoryChannelSnapshot[];
}

export interface DoudianProductInventorySnapshot {
  readonly status: "complete";
  readonly snapshotVersion: typeof DOUDIAN_INVENTORY_SNAPSHOT_VERSION;
  readonly observedAt: string;
  readonly shop: { readonly id: string; readonly name: string };
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly totalStock: number;
  };
  readonly skus: readonly DoudianInventorySkuSnapshot[];
  readonly diagnostics: readonly string[];
  readonly formMutations: 0;
}

export interface DoudianInventorySnapshotInput {
  readonly shop: { readonly id: string; readonly name: string };
  readonly product: { readonly id: string; readonly title: string };
}

export interface DoudianInventoryActionOptions {
  readonly deadline: string;
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface InventoryTableObservation {
  readonly table: Element;
  readonly headers: readonly string[];
  readonly rows: readonly Element[];
  readonly indexes: {
    readonly sku: number;
    readonly merchant: number;
    readonly current: number;
    readonly occupied: number;
    readonly unoccupied: number;
  };
}

interface DoudianStockApiSnapshot {
  readonly productTotalStock: number;
  readonly skus: readonly DoudianInventorySkuSnapshot[];
  readonly diagnostics: readonly string[];
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function integer(value: string | null | undefined, label: string): number {
  const matched = normalize(value).replace(/,/gu, "").match(/\d+/u)?.[0];
  const parsed = matched ? Number(matched) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}_INVALID`);
  }
  return parsed;
}

function stockInteger(value: string | null | undefined, label: string): number {
  const normalized = normalize(value);
  return /^[-—]$/u.test(normalized) ? 0 : integer(normalized, label);
}

function apiRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function apiInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}_INVALID`);
  }
  return parsed;
}

function apiIdentity(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d{5,30}$/u.test(normalized)) throw new Error(`${label}_INVALID`);
  return normalized;
}

function apiText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${label}_INVALID`);
  }
  return value.trim();
}

async function postStockApi(
  doc: Document,
  path: "/stock/manage/get_product_info" | "/stock/manage/detail",
  body: Readonly<Record<string, string>>,
  options: Required<Pick<DoudianInventoryActionOptions, "now">> & {
    deadline: string;
  }
): Promise<Record<string, unknown> | undefined> {
  const view = doc.defaultView;
  if (!view || typeof view.fetch !== "function") return undefined;
  assertDeadline(options.deadline, options.now);
  const remainingMs = Date.parse(options.deadline) - options.now();
  const controller = new view.AbortController();
  const timer = view.setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(15_000, remainingMs))
  );
  try {
    const response = await view.fetch(new URL(path, view.location.href), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`INVENTORY_API_HTTP_${response.status}`);
    const payload = apiRecord(await response.json(), "INVENTORY_API_RESPONSE");
    if (payload.code !== 0) throw new Error("INVENTORY_API_REJECTED");
    return apiRecord(payload.data, "INVENTORY_API_DATA");
  } finally {
    view.clearTimeout(timer);
  }
}

async function collectStockApiSnapshot(
  doc: Document,
  input: DoudianInventorySnapshotInput,
  options: Required<Pick<DoudianInventoryActionOptions, "now">> & {
    deadline: string;
  }
): Promise<DoudianStockApiSnapshot | undefined> {
  const productInfo = await postStockApi(
    doc,
    "/stock/manage/get_product_info",
    { product_id: input.product.id },
    options
  );
  if (!productInfo) return undefined;
  if (apiIdentity(productInfo.product_id, "INVENTORY_API_PRODUCT_ID") !== input.product.id) {
    throw new Error("INVENTORY_API_PRODUCT_MISMATCH");
  }
  const detail = await postStockApi(
    doc,
    "/stock/manage/detail",
    { product_id: input.product.id, source: "pc" },
    options
  );
  if (!detail) throw new Error("INVENTORY_API_DETAIL_UNAVAILABLE");
  if (!Array.isArray(detail.sku_detail_list) || detail.sku_detail_list.length === 0) {
    throw new Error("INVENTORY_API_SKUS_EMPTY");
  }
  const diagnostics: string[] = ["SNAPSHOT_SOURCE:DOUDIAN_STOCK_API"];
  const skus = detail.sku_detail_list.map((rawSku, index) => {
    const sku = apiRecord(rawSku, `INVENTORY_API_SKU_${index}`);
    const platformSkuId = apiIdentity(
      sku.sku_id,
      `INVENTORY_API_SKU_${index}_ID`
    );
    const currentStock = apiInteger(
      sku.total_stock_num,
      `INVENTORY_API_SKU_${index}_CURRENT`
    );
    const occupiedStock = apiInteger(
      sku.total_occupied_stock_num,
      `INVENTORY_API_SKU_${index}_OCCUPIED`
    );
    if (occupiedStock > currentStock) {
      throw new Error("SKU_STOCK_TOTAL_MISMATCH");
    }
    const channels = new Map<string, number>();
    const occupiedItems = sku.occupy_items;
    if (occupiedItems !== null && occupiedItems !== undefined) {
      if (!Array.isArray(occupiedItems)) {
        throw new Error(`INVENTORY_API_SKU_${index}_OCCUPY_ITEMS_INVALID`);
      }
      for (const [itemIndex, rawItem] of occupiedItems.entries()) {
        const item = apiRecord(
          rawItem,
          `INVENTORY_API_SKU_${index}_OCCUPY_${itemIndex}`
        );
        if (item.stock_occupy_type !== "channel") continue;
        const channelGoodsId = apiIdentity(
          item.channel_id,
          `INVENTORY_API_SKU_${index}_CHANNEL_${itemIndex}_ID`
        );
        const stock = apiInteger(
          item.occupy_stock_num,
          `INVENTORY_API_SKU_${index}_CHANNEL_${itemIndex}_STOCK`
        );
        channels.set(channelGoodsId, (channels.get(channelGoodsId) ?? 0) + stock);
      }
    }
    const channelRows = [...channels.entries()]
      .map(([channelGoodsId, stock]) => ({ channelGoodsId, stock }))
      .sort((left, right) =>
        left.channelGoodsId.localeCompare(right.channelGoodsId)
      );
    const channelTotal = channelRows.reduce(
      (sum, channel) => sum + channel.stock,
      0
    );
    if (channelRows.length > 0 && channelTotal !== occupiedStock) {
      diagnostics.push(
        `CHANNEL_STOCK_TOTAL_DIFF:${platformSkuId}:occupied=${occupiedStock}:channels=${channelTotal}`
      );
    }
    return {
      platformSkuId,
      merchantCode: apiText(
        sku.sku_code,
        `INVENTORY_API_SKU_${index}_MERCHANT_CODE`
      ),
      currentStock,
      occupiedStock,
      unoccupiedStock: currentStock - occupiedStock,
      channels: channelRows
    } satisfies DoudianInventorySkuSnapshot;
  });
  const declaredTotal = apiInteger(
    productInfo.total_stock_num,
    "INVENTORY_API_PRODUCT_TOTAL"
  );
  const skuTotal = skus.reduce((sum, sku) => sum + sku.currentStock, 0);
  if (declaredTotal !== skuTotal) {
    diagnostics.push(
      `PRODUCT_STOCK_TOTAL_DIFF:api=${declaredTotal}:skus=${skuTotal}`
    );
  }
  return { productTotalStock: skuTotal, skus, diagnostics };
}

function columnIndex(headers: readonly string[], patterns: readonly RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function inventoryTable(doc: Document): InventoryTableObservation {
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll("thead th,[role='columnheader']"))
      .map((element) => normalize(element.textContent));
    const current = columnIndex(headers, [/^当前库存$/u]);
    const occupied = columnIndex(headers, [/^占用库存/u]);
    const unoccupied = columnIndex(headers, [/^未占用库存/u]);
    if (current < 0 || occupied < 0 || unoccupied < 0) continue;
    const sku = columnIndex(headers, [/SKU\s*(?:ID|信息)/iu, /规格\s*ID/u]);
    const merchantColumn = columnIndex(headers, [/商家编码/u, /SKU编码/iu]);
    if (sku < 0) throw new Error("INVENTORY_SKU_COLUMNS_MISSING");
    const merchant = merchantColumn < 0 ? sku : merchantColumn;
    const scope =
      table.closest("[role='dialog'],[class*='drawer'],[class*='Drawer']") ??
      table.parentElement;
    const rows = Array.from(scope?.querySelectorAll("tbody tr") ?? []).filter(
      (row) =>
        normalize(row.textContent).length > 0 &&
        cells(row).length >= headers.length
    );
    if (rows.length === 0) throw new Error("INVENTORY_SKU_ROWS_EMPTY");
    const scopeText = normalize(scope?.textContent);
    const declaredRows = scopeText.match(
      /共\s*(\d+)\s*(?:条|个)\s*(?:SKU|规格)?/iu
    )?.[1];
    if (
      declaredRows &&
      integer(declaredRows, "INVENTORY_SKU_TOTAL") !== rows.length
    ) {
      throw new Error("INVENTORY_SKU_LIST_INCOMPLETE");
    }
    const enabledNext = Array.from(
      scope?.querySelectorAll(
        "button[aria-label='下一页'],button[title='下一页'],li[class*='pagination-next']"
      ) ?? []
    ).some(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        !element.className.includes("disabled")
    );
    if (enabledNext) throw new Error("INVENTORY_SKU_LIST_INCOMPLETE");
    if (
      scope?.querySelector(
        ".rc-virtual-list,[class*='virtual-list'],[class*='VirtualList']"
      ) &&
      !declaredRows
    ) {
      throw new Error("INVENTORY_SKU_LIST_INCOMPLETE");
    }
    return { table, headers, rows, indexes: { sku, merchant, current, occupied, unoccupied } };
  }
  throw new Error("INVENTORY_DRAWER_NOT_READY");
}

function drawer(doc: Document): Element | undefined {
  const roots = new Set<Element>();
  for (const element of Array.from(
    doc.querySelectorAll("[role='dialog'],[class*='drawer'],[class*='Drawer']")
  )) {
    const root =
      element.closest(".auxo-drawer,[role='dialog']") ?? element;
    if (roots.has(root)) continue;
    roots.add(root);
    if (
      root.classList.contains("auxo-drawer") &&
      !root.classList.contains("auxo-drawer-open")
    ) {
      continue;
    }
    const text = normalize(root.textContent);
    if (
      text.includes("当前库存") &&
      text.includes("占用库存") &&
      text.includes("未占用库存")
    ) {
      return root;
    }
  }
  return undefined;
}

function cells(row: Element): Element[] {
  return Array.from(row.querySelectorAll("td,[role='cell']"));
}

function skuId(row: Element, cell: Element): string {
  const candidates = [
    row.getAttribute("data-row-key"),
    row.getAttribute("data-key"),
    normalize(cell.textContent)
  ];
  const value = candidates
    .flatMap((candidate) => normalize(candidate).match(/\d{5,30}/gu) ?? [])
    .find(Boolean);
  if (!value) throw new Error("PLATFORM_SKU_ID_MISSING");
  return value;
}

function merchantCode(cell: Element): string {
  const text = normalize(cell.textContent);
  const value =
    text.match(/商家编码\s*[：:]\s*(.+?)(?=已上架|已下架|$)/u)?.[1]?.trim() ??
    text.replace(/^商家编码[：:]?/u, "").trim();
  if (!value || value.length > 200) throw new Error("MERCHANT_CODE_MISSING");
  return value;
}

interface ChannelOverlayObservation {
  readonly root: Element;
  readonly channels: readonly DoudianInventoryChannelSnapshot[];
}

function channelRowsFromElement(
  overlay: Element
): readonly DoudianInventoryChannelSnapshot[] {
  const text = normalize(overlay.textContent);
  const results = new Map<string, number>();
  for (const row of Array.from(
    overlay.querySelectorAll("[class*='detailRow-'],tbody tr")
  )) {
    const rowCells = Array.from(row.children).map((cell) =>
      normalize(cell.textContent)
    );
    const id = rowCells[0]?.match(/^\d{5,30}$/u)?.[0];
    const stock = rowCells[1]?.match(/^[\d,]+$/u)?.[0];
    if (id && stock) results.set(id, integer(stock, "CHANNEL_STOCK"));
  }
  const pattern = /(?:渠道品|渠道商品)\s*ID\s*[：:]?\s*(\d{5,30})[\s\S]{0,80}?(?:剩余)?库存\s*[：:]?\s*([\d,]+)/giu;
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (!id) continue;
    results.set(id, integer(match[2], "CHANNEL_STOCK"));
  }
  if (results.size === 0) {
    const ids = text.match(/\d{10,30}/gu) ?? [];
    const numbers = [
      ...text.matchAll(/(?:剩余)?库存\s*[：:]?\s*([\d,]+)/giu)
    ].map((match) => match[1]);
    if (ids.length === numbers.length) {
      ids.forEach((id, index) =>
        results.set(id, integer(numbers[index], "CHANNEL_STOCK"))
      );
    }
  }
  return [...results.entries()]
    .map(([channelGoodsId, stock]) => ({ channelGoodsId, stock }))
    .sort((left, right) =>
      left.channelGoodsId.localeCompare(right.channelGoodsId)
    );
}

function channelRowsFromOverlay(
  doc: Document,
  consumedRoots: ReadonlySet<Element>
): ChannelOverlayObservation | undefined {
  const overlays = Array.from(
    doc.querySelectorAll(
      "[role='tooltip'],[role='dialog'] [class*='popover'],[class*='popover']:not([style*='display: none']),[class*='tooltip']:not([style*='display: none'])"
    )
  ).reverse();
  const inspectedRoots = new Set<Element>();
  for (const overlay of overlays) {
    if (
      overlay.closest(
        "[aria-hidden='true'],[class*='popover-hidden'],[class*='tooltip-hidden']"
      )
    ) {
      continue;
    }
    const root = overlay.closest("[class*='detailPopover']") ?? overlay;
    if (inspectedRoots.has(root) || consumedRoots.has(root)) continue;
    inspectedRoots.add(root);
    const text = normalize(root.textContent);
    if (!/(?:渠道品|渠道商品).*ID/iu.test(text)) continue;
    const channels = channelRowsFromElement(root);
    if (channels.length > 0) return { root, channels };
  }
  return undefined;
}

function moveChannelScroller(element: HTMLElement, top: number): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top, behavior: "auto" });
  } else {
    element.scrollTop = top;
  }
  const EventConstructor = element.ownerDocument.defaultView?.Event;
  if (EventConstructor) {
    element.dispatchEvent(
      new EventConstructor("scroll", { bubbles: true, cancelable: false })
    );
  }
}

async function collectScrollableChannelRows(
  observation: ChannelOverlayObservation,
  options: Required<Pick<DoudianInventoryActionOptions, "now" | "wait">> & {
    deadline: string;
    waitMs: number;
  }
): Promise<readonly DoudianInventoryChannelSnapshot[]> {
  const results = new Map<string, number>();
  const merge = (): void => {
    for (const channel of channelRowsFromElement(observation.root)) {
      results.set(channel.channelGoodsId, channel.stock);
    }
  };
  merge();
  const scrollers = Array.from(
    observation.root.querySelectorAll(
      "[class*='detailBody'],[class*='virtual-list-holder'],[class*='VirtualList']"
    )
  ).filter((element): element is HTMLElement => "scrollTop" in element);
  for (const scroller of scrollers) {
    assertDeadline(options.deadline, options.now);
    moveChannelScroller(scroller, 0);
    await options.wait(options.waitMs);
    merge();
    const visited = new Set<string>();
    for (let view = 0; view < 100; view += 1) {
      assertDeadline(options.deadline, options.now);
      const top = Number(scroller.scrollTop);
      const maxTop = Math.max(
        0,
        Number(scroller.scrollHeight) - Number(scroller.clientHeight)
      );
      const signature = `${top}:${maxTop}:${[...results.keys()].join(":")}`;
      if (visited.has(signature)) break;
      visited.add(signature);
      merge();
      if (top >= maxTop) break;
      const nextTop = Math.min(
        maxTop,
        top + Math.max(1, Math.floor(Number(scroller.clientHeight || 220) * 0.8))
      );
      moveChannelScroller(scroller, nextTop);
      await options.wait(options.waitMs);
    }
    merge();
    moveChannelScroller(scroller, 0);
    await options.wait(options.waitMs);
  }
  return [...results.entries()]
    .map(([channelGoodsId, stock]) => ({ channelGoodsId, stock }))
    .sort((left, right) =>
      left.channelGoodsId.localeCompare(right.channelGoodsId)
    );
}

function productRowOrUndefined(
  doc: Document,
  productId: string
): Element | undefined {
  const rows = Array.from(doc.querySelectorAll("tr[data-row-key],tbody tr"));
  const matches = rows.filter((row) => {
    if (row.getAttribute("data-row-key") === productId) return true;
    const hrefs = Array.from(row.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .join(" ");
    return hrefs.includes(productId) || normalize(row.textContent).includes(productId);
  });
  if (matches.length > 1) throw new Error("PRODUCT_ROW_AMBIGUOUS");
  return matches[0];
}

function listPage(element: Element): number | undefined {
  const value = normalize(
    element.getAttribute("title") ??
      element.getAttribute("data-page") ??
      element.textContent
  );
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

const LIST_PAGE_ITEMS =
  ".ecom-g-pagination-item[title],[class*='pagination-item-'][title],[class*='pagination'] [data-page]";
const LIST_CURRENT_PAGE =
  ".ecom-g-pagination-item-active,[class*='pagination'] [aria-current='page']";

function currentListPage(doc: Document): number {
  return (
    Array.from(doc.querySelectorAll(LIST_CURRENT_PAGE))
      .map(listPage)
      .find((page): page is number => page !== undefined) ?? 1
  );
}

function totalListPages(doc: Document): number {
  return Math.max(
    currentListPage(doc),
    ...Array.from(doc.querySelectorAll(LIST_PAGE_ITEMS))
      .map(listPage)
      .filter((page): page is number => page !== undefined)
  );
}

async function moveToListPage(
  doc: Document,
  page: number,
  options: Required<Pick<DoudianInventoryActionOptions, "now" | "wait">> & {
    deadline: string;
    waitMs: number;
  }
): Promise<boolean> {
  if (currentListPage(doc) === page) return true;
  const previousProducts = Array.from(
    doc.querySelectorAll("tr[data-row-key]")
  )
    .map((element) => element.getAttribute("data-row-key") ?? "")
    .join(":");
  const control = Array.from(doc.querySelectorAll(LIST_PAGE_ITEMS)).find(
    (element) =>
      listPage(element) === page &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.hasAttribute("disabled")
  ) as HTMLElement | undefined;
  if (!control) return false;
  control.click();
  const target = doc.scrollingElement as HTMLElement | null;
  if (target) {
    if (typeof target.scrollTo === "function") {
      target.scrollTo({ top: 0, behavior: "instant" });
    } else {
      target.scrollTop = 0;
    }
  }
  let stableSignature = "";
  let stableSamples = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertDeadline(options.deadline, options.now);
    await options.wait(options.waitMs);
    if (currentListPage(doc) !== page) continue;
    const signature = Array.from(doc.querySelectorAll("tr[data-row-key]"))
      .map((element) => element.getAttribute("data-row-key") ?? "")
      .join(":");
    if (!signature || signature === previousProducts) continue;
    if (signature === stableSignature) {
      stableSamples += 1;
    } else {
      stableSignature = signature;
      stableSamples = 1;
    }
    if (stableSamples >= 2) return true;
  }
  return false;
}

async function locateProductRow(
  doc: Document,
  productId: string,
  options: Required<Pick<DoudianInventoryActionOptions, "now" | "wait">> & {
    deadline: string;
    waitMs: number;
  }
): Promise<Element> {
  const visible = productRowOrUndefined(doc, productId);
  if (visible) return visible;
  const startingPage = currentListPage(doc);
  const pageCount = totalListPages(doc);
  const pages = Array.from(
    { length: pageCount },
    (_, index) => ((startingPage - 1 + index) % pageCount) + 1
  );
  for (const page of pages) {
    assertDeadline(options.deadline, options.now);
    if (!(await moveToListPage(doc, page, options))) continue;
    const target = doc.scrollingElement as HTMLElement | null;
    if (target) {
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: 0, behavior: "instant" });
      } else {
        target.scrollTop = 0;
      }
      await options.wait(options.waitMs);
    }
    const signatures = new Set<string>();
    for (let view = 0; view < 100; view += 1) {
      assertDeadline(options.deadline, options.now);
      const row = productRowOrUndefined(doc, productId);
      if (row) return row;
      const top = Number(target?.scrollTop ?? 0);
      const rowIds = Array.from(
        doc.querySelectorAll("tr[data-row-key]")
      ).map((element) => element.getAttribute("data-row-key") ?? "");
      const signature = `${top}:${rowIds.join(":")}`;
      if (signatures.has(signature)) break;
      signatures.add(signature);
      if (!target) break;
      const maxTop = Math.max(
        0,
        Number(target.scrollHeight) - Number(target.clientHeight)
      );
      if (top >= maxTop) break;
      const nextTop = Math.min(
        maxTop,
        top + Math.max(1, Math.floor(Number(target.clientHeight || 600) * 0.8))
      );
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: nextTop, behavior: "instant" });
      } else {
        target.scrollTop = nextTop;
      }
      await options.wait(options.waitMs);
    }
  }
  throw new Error("PRODUCT_ROW_NOT_FOUND");
}

function totalStockCell(row: Element, doc: Document): Element {
  const table = row.closest("table");
  if (!table) throw new Error("PRODUCT_TABLE_MISSING");
  const headers = Array.from(table.querySelectorAll("thead th,[role='columnheader']"))
    .map((element) => normalize(element.textContent));
  const index = columnIndex(headers, [/^总库存$/u]);
  const rowCells = cells(row);
  if (index < 0 || !rowCells[index]) throw new Error("TOTAL_STOCK_CELL_MISSING");
  return rowCells[index]!;
}

function linkedChannelGoodsCount(row: Element): number | undefined {
  const matched = normalize(row.textContent).match(/查看渠道品\s*\((\d+)\)/u)?.[1];
  return matched === undefined
    ? undefined
    : integer(matched, "LINKED_CHANNEL_GOODS_COUNT");
}

function editControl(cell: Element): HTMLElement | undefined {
  const exact = cell.querySelector("[data-kora='修改库存']");
  if (exact) return (exact.closest("a") ?? exact) as HTMLElement;
  const candidates = Array.from(
    cell.querySelectorAll("button,[role='button'],[title],[aria-label],[class*='edit'],[class*='Edit']")
  ).filter((element) => {
    const label = `${normalize(element.textContent)} ${element.getAttribute("title") ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("data-kora") ?? ""} ${element.getAttribute("class") ?? ""}`;
    return /编辑|库存/iu.test(label) || element.tagName.toLowerCase() === "button";
  });
  return candidates.length === 1 ? candidates[0] as HTMLElement : undefined;
}

function closeDrawer(element: Element): void {
  const root = element.closest(".auxo-drawer,[role='dialog']") ?? element;
  const exact = root.querySelector<HTMLElement>(
    "button.auxo-drawer-close,button[aria-label='Close'],button[aria-label='close'],button[aria-label='关闭']"
  );
  if (exact) {
    exact.click();
    return;
  }
  const buttons = Array.from(root.querySelectorAll("button,[role='button']"));
  const close = buttons.find((button) =>
    /关闭|close/iu.test(`${normalize(button.textContent)} ${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""}`)
  );
  const cancel = buttons.find(
    (button) => normalize(button.textContent) === "取消"
  );
  ((close ?? cancel) as HTMLElement | undefined)?.click();
}

function hover(element: Element, doc: Document): void {
  const MouseEventConstructor = doc.defaultView?.MouseEvent;
  if (!MouseEventConstructor) return;
  const PointerEventConstructor = doc.defaultView?.PointerEvent;
  if (PointerEventConstructor) {
    for (const type of ["pointerover", "pointerenter", "pointermove"]) {
      element.dispatchEvent(
        new PointerEventConstructor(type, {
          bubbles: true,
          cancelable: false,
          pointerType: "mouse"
        })
      );
    }
  }
  for (const type of ["mouseover", "mouseenter", "mousemove"]) {
    element.dispatchEvent(new MouseEventConstructor(type, { bubbles: true, cancelable: false }));
  }
}

function assertDeadline(deadline: string, now: () => number): void {
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed) || now() >= parsed) throw new Error("DEADLINE_EXCEEDED");
}

export function validateDoudianInventorySnapshotInput(
  value: Readonly<Record<string, unknown>>
): DoudianInventorySnapshotInput {
  if (Object.keys(value).some((key) => key !== "shop" && key !== "product")) {
    throw new Error("INVENTORY_INPUT_INVALID");
  }
  const shop = value.shop;
  const product = value.product;
  if (!shop || typeof shop !== "object" || Array.isArray(shop) || !product || typeof product !== "object" || Array.isArray(product)) {
    throw new Error("INVENTORY_INPUT_INVALID");
  }
  const shopRecord = shop as Record<string, unknown>;
  const productRecord = product as Record<string, unknown>;
  if (
    Object.keys(shopRecord).some((key) => key !== "id" && key !== "name") ||
    Object.keys(productRecord).some((key) => key !== "id" && key !== "title") ||
    typeof shopRecord.id !== "string" || !shopRecord.id.trim() ||
    typeof shopRecord.name !== "string" || !shopRecord.name.trim() ||
    typeof productRecord.id !== "string" || !/^\d{5,30}$/u.test(productRecord.id) ||
    typeof productRecord.title !== "string" || !productRecord.title.trim()
  ) {
    throw new Error("INVENTORY_INPUT_INVALID");
  }
  return {
    shop: { id: shopRecord.id.trim(), name: shopRecord.name.trim() },
    product: { id: productRecord.id, title: productRecord.title.trim() }
  };
}

export async function collectDoudianProductInventorySnapshot(
  doc: Document,
  rawInput: Readonly<Record<string, unknown>>,
  options: DoudianInventoryActionOptions
): Promise<DoudianProductInventorySnapshot> {
  const input = validateDoudianInventorySnapshotInput(rawInput);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const waitMs = options.waitMs ?? 200;
  assertDeadline(options.deadline, now);
  const url = new URL(doc.defaultView?.location.href ?? "");
  if (url.origin !== "https://fxg.jinritemai.com" || url.pathname !== "/ffa/g/list") {
    throw new Error("PAGE_MISMATCH");
  }
  await prepareDoudianProductList(doc, wait, waitMs);
  assertDeadline(options.deadline, now);
  const apiSnapshot = await collectStockApiSnapshot(doc, input, {
    deadline: options.deadline,
    now
  });
  if (apiSnapshot) {
    return {
      status: "complete",
      snapshotVersion: DOUDIAN_INVENTORY_SNAPSHOT_VERSION,
      observedAt: new Date(now()).toISOString(),
      shop: input.shop,
      product: {
        ...input.product,
        totalStock: apiSnapshot.productTotalStock
      },
      skus: apiSnapshot.skus,
      diagnostics: apiSnapshot.diagnostics,
      formMutations: 0
    };
  }
  const row = await locateProductRow(doc, input.product.id, {
    deadline: options.deadline,
    now,
    wait,
    waitMs
  });
  const declaredChannelGoodsCount = linkedChannelGoodsCount(row);
  const stockCell = totalStockCell(row, doc);
  let totalStock = integer(stockCell.textContent, "TOTAL_STOCK");
  const control = editControl(stockCell);
  if (!control) {
    return {
      status: "complete",
      snapshotVersion: DOUDIAN_INVENTORY_SNAPSHOT_VERSION,
      observedAt: new Date(now()).toISOString(),
      shop: input.shop,
      product: { ...input.product, totalStock },
      skus: [],
      diagnostics: ["SKU_DETAIL_UNAVAILABLE:INVENTORY_EDIT_CONTROL_UNRESOLVED"],
      formMutations: 0
    };
  }
  control.click();
  let opened: Element | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertDeadline(options.deadline, now);
    opened = drawer(doc);
    if (opened) break;
    await wait(waitMs);
  }
  if (!opened) throw new Error("INVENTORY_DRAWER_NOT_READY");
  try {
    const observed = inventoryTable(doc);
    const skus: DoudianInventorySkuSnapshot[] = [];
    const diagnostics: string[] = [];
    const consumedChannelOverlays = new Set<Element>();
    for (const skuRow of observed.rows) {
      const rowCells = cells(skuRow);
      const id = skuId(skuRow, rowCells[observed.indexes.sku]!);
      const occupiedStock = stockInteger(rowCells[observed.indexes.occupied]!.textContent, "OCCUPIED_STOCK");
      let channels: readonly DoudianInventoryChannelSnapshot[] = [];
      if (occupiedStock > 0) {
        const occupiedCell = rowCells[observed.indexes.occupied]!;
        const trigger =
          Array.from(occupiedCell.querySelectorAll("*")).find(
            (element) => normalize(element.textContent) === "渠道品占用"
          ) ??
          occupiedCell.querySelector(
            "button,a,[role='button'],[class*='summaryTrigger'],[class*='link']"
          ) ??
          occupiedCell;
        hover(trigger, doc);
        for (let attempt = 0; attempt < 15; attempt += 1) {
          assertDeadline(options.deadline, now);
          const observation = channelRowsFromOverlay(
            doc,
            consumedChannelOverlays
          );
          if (observation) {
            channels = await collectScrollableChannelRows(observation, {
              deadline: options.deadline,
              now,
              wait,
              waitMs
            });
            consumedChannelOverlays.add(observation.root);
            break;
          }
          await wait(waitMs);
        }
        if (channels.length === 0) {
          diagnostics.push(`CHANNEL_STOCK_UNAVAILABLE:${id}`);
        }
        const channelTotal = channels.reduce((sum, channel) => sum + channel.stock, 0);
        if (channels.length > 0 && channelTotal !== occupiedStock) {
          diagnostics.push(
            `CHANNEL_STOCK_TOTAL_DIFF:${id}:occupied=${occupiedStock}:channels=${channelTotal}`
          );
        }
      }
      const currentStock = integer(rowCells[observed.indexes.current]!.textContent, "CURRENT_STOCK");
      const unoccupiedStock = integer(rowCells[observed.indexes.unoccupied]!.textContent, "UNOCCUPIED_STOCK");
      if (currentStock !== occupiedStock + unoccupiedStock) {
        throw new Error("SKU_STOCK_TOTAL_MISMATCH");
      }
      skus.push({
        platformSkuId: id,
        merchantCode: merchantCode(rowCells[observed.indexes.merchant]!),
        currentStock,
        occupiedStock,
        unoccupiedStock,
        channels
      });
    }
    const observedChannelGoodsCount = new Set(
      skus.flatMap((sku) => sku.channels.map((channel) => channel.channelGoodsId))
    ).size;
    if (
      declaredChannelGoodsCount !== undefined &&
      declaredChannelGoodsCount !== observedChannelGoodsCount
    ) {
      diagnostics.push(
        `CHANNEL_LINK_COUNT_DIFF:linked=${declaredChannelGoodsCount}:observed=${observedChannelGoodsCount}`
      );
    }
    const skuTotalStock = skus.reduce((sum, sku) => sum + sku.currentStock, 0);
    if (skuTotalStock !== totalStock) {
      diagnostics.push(
        `PRODUCT_STOCK_TOTAL_DIFF:list=${totalStock}:skus=${skuTotalStock}`
      );
      totalStock = skuTotalStock;
    }
    return {
      status: "complete",
      snapshotVersion: DOUDIAN_INVENTORY_SNAPSHOT_VERSION,
      observedAt: new Date(now()).toISOString(),
      shop: input.shop,
      product: { ...input.product, totalStock },
      skus,
      diagnostics,
      formMutations: 0
    };
  } finally {
    closeDrawer(opened);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!drawer(doc)) break;
      await wait(waitMs);
    }
    if (drawer(doc)) throw new Error("INVENTORY_DRAWER_CLOSE_FAILED");
  }
}
