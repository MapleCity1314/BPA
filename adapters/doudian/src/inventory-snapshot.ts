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

function columnIndex(headers: readonly string[], patterns: readonly RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function inventoryTable(doc: Document): InventoryTableObservation {
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll("thead th,[role='columnheader']"))
      .map((element) => normalize(element.textContent));
    const current = columnIndex(headers, [/^当前库存$/u]);
    const occupied = columnIndex(headers, [/^占用库存$/u]);
    const unoccupied = columnIndex(headers, [/^未占用库存$/u]);
    if (current < 0 || occupied < 0 || unoccupied < 0) continue;
    const sku = columnIndex(headers, [/SKU\s*ID/iu, /规格\s*ID/u]);
    const merchant = columnIndex(headers, [/商家编码/u, /SKU编码/iu]);
    if (sku < 0 || merchant < 0) throw new Error("INVENTORY_SKU_COLUMNS_MISSING");
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    if (rows.length === 0) throw new Error("INVENTORY_SKU_ROWS_EMPTY");
    const scope =
      table.closest("[role='dialog'],[class*='drawer'],[class*='Drawer']") ??
      table.parentElement;
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
  return Array.from(
    doc.querySelectorAll("[role='dialog'],[class*='drawer'],[class*='Drawer']")
  ).find((element) => {
    const text = normalize(element.textContent);
    return text.includes("当前库存") && text.includes("占用库存") && text.includes("未占用库存");
  });
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
  const value = normalize(cell.textContent).replace(/^商家编码[：:]?/u, "").trim();
  if (!value || value.length > 200) throw new Error("MERCHANT_CODE_MISSING");
  return value;
}

function channelRowsFromOverlay(doc: Document): DoudianInventoryChannelSnapshot[] {
  const overlays = Array.from(
    doc.querySelectorAll(
      "[role='tooltip'],[role='dialog'] [class*='popover'],[class*='popover']:not([style*='display: none']),[class*='tooltip']:not([style*='display: none'])"
    )
  );
  const results = new Map<string, number>();
  for (const overlay of overlays) {
    const text = normalize(overlay.textContent);
    if (!/(?:渠道品|渠道商品).*ID/iu.test(text)) continue;
    const pattern = /(?:渠道品|渠道商品)\s*ID\s*[：:]?\s*(\d{5,30})[\s\S]{0,80}?(?:剩余)?库存\s*[：:]?\s*([\d,]+)/giu;
    for (const match of text.matchAll(pattern)) {
      const id = match[1];
      if (!id) continue;
      results.set(id, integer(match[2], "CHANNEL_STOCK"));
    }
    if (results.size === 0) {
      const ids = text.match(/\d{10,30}/gu) ?? [];
      const numbers = [...text.matchAll(/(?:剩余)?库存\s*[：:]?\s*([\d,]+)/giu)].map((match) => match[1]);
      if (ids.length === numbers.length) {
        ids.forEach((id, index) => results.set(id, integer(numbers[index], "CHANNEL_STOCK")));
      }
    }
  }
  return [...results.entries()]
    .map(([channelGoodsId, stock]) => ({ channelGoodsId, stock }))
    .sort((left, right) => left.channelGoodsId.localeCompare(right.channelGoodsId));
}

function productRow(doc: Document, productId: string): Element {
  const rows = Array.from(doc.querySelectorAll("tr[data-row-key],tbody tr"));
  const matches = rows.filter((row) => {
    if (row.getAttribute("data-row-key") === productId) return true;
    const hrefs = Array.from(row.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .join(" ");
    return hrefs.includes(productId) || normalize(row.textContent).includes(productId);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "PRODUCT_ROW_NOT_FOUND" : "PRODUCT_ROW_AMBIGUOUS");
  }
  return matches[0]!;
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

function editControl(cell: Element): HTMLElement {
  const candidates = Array.from(
    cell.querySelectorAll("button,[role='button'],[title],[aria-label],[class*='edit'],[class*='Edit']")
  ).filter((element) => {
    const label = `${normalize(element.textContent)} ${element.getAttribute("title") ?? ""} ${element.getAttribute("aria-label") ?? ""}`;
    return /编辑|库存/iu.test(label) || element.tagName.toLowerCase() === "button";
  });
  if (candidates.length !== 1) throw new Error("INVENTORY_EDIT_CONTROL_UNRESOLVED");
  return candidates[0] as HTMLElement;
}

function closeDrawer(element: Element): void {
  const buttons = Array.from(element.querySelectorAll("button,[role='button']"));
  const close = buttons.find((button) =>
    /关闭|close/iu.test(`${normalize(button.textContent)} ${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""}`)
  );
  (close as HTMLElement | undefined)?.click();
}

function hover(element: Element, doc: Document): void {
  const MouseEventConstructor = doc.defaultView?.MouseEvent;
  if (!MouseEventConstructor) return;
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
  const row = productRow(doc, input.product.id);
  const stockCell = totalStockCell(row, doc);
  const totalStock = integer(stockCell.textContent, "TOTAL_STOCK");
  editControl(stockCell).click();
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
    for (const skuRow of observed.rows) {
      const rowCells = cells(skuRow);
      const id = skuId(skuRow, rowCells[observed.indexes.sku]!);
      const occupiedStock = integer(rowCells[observed.indexes.occupied]!.textContent, "OCCUPIED_STOCK");
      let channels: readonly DoudianInventoryChannelSnapshot[] = [];
      if (occupiedStock > 0) {
        const occupiedCell = rowCells[observed.indexes.occupied]!;
        const trigger = occupiedCell.querySelector("button,a,[role='button'],[class*='link']") ?? occupiedCell;
        hover(trigger, doc);
        for (let attempt = 0; attempt < 15; attempt += 1) {
          assertDeadline(options.deadline, now);
          channels = channelRowsFromOverlay(doc);
          if (channels.length > 0) break;
          await wait(waitMs);
        }
        if (channels.length === 0) throw new Error("CHANNEL_STOCK_UNAVAILABLE");
        const channelTotal = channels.reduce((sum, channel) => sum + channel.stock, 0);
        if (channelTotal !== occupiedStock) throw new Error("CHANNEL_STOCK_TOTAL_MISMATCH");
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
    if (skus.reduce((sum, sku) => sum + sku.currentStock, 0) !== totalStock) {
      throw new Error("PRODUCT_STOCK_TOTAL_MISMATCH");
    }
    return {
      status: "complete",
      snapshotVersion: DOUDIAN_INVENTORY_SNAPSHOT_VERSION,
      observedAt: new Date(now()).toISOString(),
      shop: input.shop,
      product: { ...input.product, totalStock },
      skus,
      diagnostics: [],
      formMutations: 0
    };
  } finally {
    closeDrawer(opened);
  }
}
