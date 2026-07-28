import type {
  EditorObservation,
  PlatformFillCheckObservation,
  RequiredFieldObservation,
  SkuRequiredCellObservation
} from "./editor-inspector.js";
import {
  createScopeFingerprint,
  type ProductCandidate,
  type ScopeFingerprint,
  type ScopeRiskSignal,
  type ScopeVirtualView
} from "./scope-collector.js";

const LIST_SELECTORS = {
  productRows: "tr[data-row-key]",
  activeTab:
    "[role='tab'][aria-selected='true'],[role='tab'][class*='active']",
  filterInputs:
    "input:not([type='hidden']),[role='combobox'],[role='searchbox']",
  paginationTotal:
    ".ecom-g-pagination-total-text,[class*='pagination'] [class*='total']",
  currentPage:
    ".ecom-g-pagination-item-active,[class*='pagination'] [aria-current='page']",
  pageItems:
    "[class*='pagination'] [title],[class*='pagination'] [data-page]"
} as const;

const EDITOR_SELECTORS = {
  main: "main",
  controls:
    "main input:not([type='hidden']),main textarea,main [role='combobox'],main table,main [contenteditable='true']",
  anchors: "main div,main span,main h1,main h2,main h3",
  requiredMarkers:
    "main span[class*='required'],main [aria-required='true'],main input[required],main textarea[required]",
  fieldRoots:
    "main [attr-field-id],main [data-field-id],main [class*='form-item']",
  loading:
    "main [aria-busy='true'],main [class*='spin-spinning'],main [class*='skeleton']",
  platformButtons: "main button",
  platformWarnings:
    "[role='dialog'],main [role='alert'],main [class*='error-message'],main [class*='form-item-error']",
  skuTables: "main table"
} as const;

const KNOWN_EDITOR_ANCHORS = new Set([
  "基础信息",
  "图文信息",
  "价格库存",
  "价格与库存",
  "服务与履约",
  "其他信息",
  "产地与包装"
]);

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function visible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  const style = element.getAttribute("style") ?? "";
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/iu.test(style)) {
    return false;
  }
  if (typeof element.getBoundingClientRect !== "function") return true;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function riskSignals(doc: Document, pageUrl: string): ScopeRiskSignal[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [{ code: "PAGE_CONTEXT_CHANGED", severity: "blocking" }];
  }
  if (/login|passport|signin|authorize/iu.test(url.pathname)) {
    return [{ code: "SESSION_EXPIRED", severity: "blocking" }];
  }
  const text = normalizeText(doc.body?.innerText).slice(0, 200_000);
  const signals: ScopeRiskSignal[] = [];
  if (/(?:请完成|需要|进行)(?:安全)?验证|滑块验证|请输入验证码/u.test(text)) {
    signals.push({ code: "CAPTCHA_REQUIRED", severity: "blocking" });
  }
  if (/操作过于频繁|访问过于频繁|请求过于频繁|请稍后再试/u.test(text)) {
    signals.push({ code: "RATE_LIMITED", severity: "blocking" });
  }
  if (/当前访问存在风险|检测到异常操作|账号存在风险/u.test(text)) {
    signals.push({ code: "RISK_CONTROL", severity: "blocking" });
  }
  return signals;
}

function integerFromText(value: string): number | undefined {
  const matched = normalizeText(value).match(/(\d[\d,]*)/u)?.[1];
  if (!matched) return undefined;
  const parsed = Number(matched.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function productFromRow(row: Element): ProductCandidate | undefined {
  const id = normalizeText(
    row.getAttribute("data-row-key") ?? row.getAttribute("data-product-id")
  );
  if (!/^\d{5,30}$/u.test(id)) return undefined;
  const idPattern = new RegExp(`(?:ID[：:]?\\s*)?${id}`, "gu");
  const candidates = Array.from(row.querySelectorAll("a,div,span,p"))
    .map((element) =>
      normalizeText(element.textContent).replace(idPattern, "").trim()
    )
    .filter(
      (text) =>
        text.length >= 2 &&
        text.length <= 500 &&
        text !== id &&
        !/^(?:-+|暂无|商品图片|图片|加载中)$/u.test(text)
    )
    .sort((left, right) => right.length - left.length);
  const title = candidates[0] ?? "";
  return {
    id,
    title,
    editorUrl: `https://fxg.jinritemai.com/ffa/g/create?product_id=${id}&entrance=edit`
  };
}

export interface ScopeDomReadInput {
  readonly shopId: string;
  readonly shopName: string;
  readonly fallbackStatusTab?: {
    readonly id: string;
    readonly label: string;
  };
  readonly pageUrl?: string;
  readonly scrollTop?: number;
}

export interface ScopeDomObservation {
  readonly fingerprint: ScopeFingerprint;
  readonly topTotal?: number;
  readonly bottomTotal?: number;
  readonly page: number;
  readonly totalPages: number;
  readonly view: ScopeVirtualView;
  readonly riskSignals: readonly ScopeRiskSignal[];
}

/**
 * Thin read-only DOM layer for one list-page/scroll observation. Pagination,
 * scrolling, retries, and restore are controlled outside this function.
 */
export function readDoudianScopeDom(
  doc: Document,
  input: ScopeDomReadInput
): ScopeDomObservation {
  const activeTab = Array.from(
    doc.querySelectorAll(LIST_SELECTORS.activeTab)
  ).find(visible);
  const tabLabel = normalizeText(activeTab?.textContent);
  const tabId = normalizeText(
    activeTab?.getAttribute("data-tab-key") ??
      activeTab?.getAttribute("data-key") ??
      activeTab?.getAttribute("id")
  );
  const filters = Object.fromEntries(
    Array.from(doc.querySelectorAll(LIST_SELECTORS.filterInputs))
      .filter(visible)
      .map((element, index) => {
        const inputElement = element as HTMLInputElement;
        const key = normalizeText(
          element.getAttribute("name") ??
            element.getAttribute("aria-label") ??
            element.getAttribute("placeholder") ??
            `filter-${index + 1}`
        );
        const value = normalizeText(
          inputElement.value ??
            element.getAttribute("data-value") ??
            element.textContent
        );
        return [key, value] as const;
      })
      .filter(([, value]) => value.length > 0)
  );
  const totals = Array.from(
    doc.querySelectorAll(LIST_SELECTORS.paginationTotal)
  )
    .filter(visible)
    .map((element) => integerFromText(element.textContent ?? ""))
    .filter((value): value is number => value !== undefined);
  const currentPage =
    Array.from(doc.querySelectorAll(LIST_SELECTORS.currentPage))
      .map((element) =>
        integerFromText(
          element.getAttribute("title") ??
            element.getAttribute("data-page") ??
            element.textContent ??
            ""
        )
      )
      .find((value): value is number => value !== undefined) ?? 1;
  const totalPages = Math.max(
    currentPage,
    ...Array.from(doc.querySelectorAll(LIST_SELECTORS.pageItems))
      .map((element) =>
        integerFromText(
          element.getAttribute("title") ??
            element.getAttribute("data-page") ??
            element.textContent ??
            ""
        )
      )
      .filter((value): value is number => value !== undefined)
  );
  const products = Array.from(
    doc.querySelectorAll(LIST_SELECTORS.productRows)
  )
    .map(productFromRow)
    .filter((product): product is ProductCandidate => product !== undefined);
  const statusTab =
    tabId || tabLabel
      ? { id: tabId || tabLabel, label: tabLabel || tabId }
      : (input.fallbackStatusTab ?? { id: "unknown", label: "未识别页签" });
  const pageUrl =
    input.pageUrl ?? doc.defaultView?.location.href ?? "about:blank";
  const topTotal = totals[0];
  const bottomTotal = totals.at(-1);
  return {
    fingerprint: createScopeFingerprint({
      shopId: input.shopId,
      shopName: input.shopName,
      filters,
      statusTab
    }),
    ...(topTotal === undefined ? {} : { topTotal }),
    ...(bottomTotal === undefined ? {} : { bottomTotal }),
    page: currentPage,
    totalPages,
    view: {
      scrollTop:
        input.scrollTop ??
        Number((doc.scrollingElement as HTMLElement | null)?.scrollTop ?? 0),
      products
    },
    riskSignals: riskSignals(doc, pageUrl)
  };
}

function fieldValueState(
  root: Element
): RequiredFieldObservation["valueState"] {
  const selected = root.querySelector(
    "[aria-selected='true'],[class*='selection-item'],[class*='selectionItem'],img[src],[data-file-id]"
  );
  if (
    selected &&
    visible(selected) &&
    (normalizeText(
      selected.getAttribute("title") ??
        selected.getAttribute("alt") ??
        selected.textContent
    ).length > 0 ||
      Boolean(selected.getAttribute("src")) ||
      Boolean(selected.getAttribute("data-file-id")))
  ) {
    return "filled";
  }
  const controls = Array.from(
    root.querySelectorAll(
      "input:not([type='hidden']),textarea,[role='combobox'],[contenteditable='true']"
    )
  ).filter(visible);
  if (controls.length === 0) return "unknown";
  const choices = controls.filter((control) => {
    const type = control.getAttribute("type");
    return type === "radio" || type === "checkbox";
  }) as HTMLInputElement[];
  if (choices.length > 0) {
    return choices.some((choice) => choice.checked) ? "filled" : "empty";
  }
  for (const control of controls) {
    const input = control as HTMLInputElement;
    const value = normalizeText(
      input.value ??
        control.getAttribute("aria-valuetext") ??
        control.getAttribute("title") ??
        control.textContent
    );
    if (value && !/^(?:请选择|请选择\.{3}|--|-)$|^请选择/u.test(value)) {
      return "filled";
    }
  }
  return "empty";
}

function controlKind(
  root: Element
): RequiredFieldObservation["controlKind"] {
  if (root.querySelector("textarea")) return "textarea";
  if (root.querySelector("[contenteditable='true']")) return "rich_content";
  if (root.querySelector("[role='combobox']")) return "combobox";
  const input = root.querySelector("input");
  if (input?.getAttribute("type") === "number") return "number";
  if (input?.getAttribute("type") === "radio") return "radio";
  if (input?.getAttribute("type") === "checkbox") return "checkbox";
  if (input) return "text";
  return "composite";
}

function requiredFields(doc: Document): RequiredFieldObservation[] {
  const occurrences = new Map<string, number>();
  return Array.from(doc.querySelectorAll(EDITOR_SELECTORS.fieldRoots))
    .filter(visible)
    .map((root) => {
      const required =
        root.getAttribute("aria-required") === "true" ||
        Boolean(root.querySelector("[required],[aria-required='true'],span[class*='required']"));
      const rawLabel = normalizeText(
        root.getAttribute("attr-field-id") ??
          root.getAttribute("data-field-id") ??
          root.querySelector("label")?.textContent ??
          root.textContent
      ).replace(/^\*/u, "");
      const label = rawLabel.slice(0, 120) || "未命名必填项";
      const occurrence = (occurrences.get(label) ?? 0) + 1;
      occurrences.set(label, occurrence);
      const input = root.querySelector(
        "input,textarea,[role='combobox'],[contenteditable='true']"
      ) as HTMLInputElement | null;
      return {
        key:
          normalizeText(
            root.getAttribute("attr-field-id") ??
              root.getAttribute("data-field-id")
          ) || `${label}:${occurrence}`,
        label,
        section:
          normalizeText(root.closest("[data-section]")?.getAttribute("data-section")) ||
          "未分类",
        controlKind: controlKind(root),
        required,
        visible: true,
        disabled: Boolean(
          input?.disabled || input?.getAttribute("aria-disabled") === "true"
        ),
        valueState: fieldValueState(root)
      };
    });
}

function skuCells(doc: Document): SkuRequiredCellObservation[] {
  const cells: SkuRequiredCellObservation[] = [];
  for (const table of Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.skuTables)
  )) {
    const headers = Array.from(table.querySelectorAll("thead th"));
    const skuIndex = headers.findIndex((header) =>
      /SKUID/iu.test(normalizeText(header.textContent))
    );
    const requiredColumns = headers
      .map((header, index) => ({
        index,
        label: normalizeText(header.textContent).replaceAll("*", "").trim(),
        required: normalizeText(header.textContent).includes("*")
      }))
      .filter((column) => column.required);
    for (const [rowIndex, row] of Array.from(
      table.querySelectorAll("tbody tr")
    ).entries()) {
      const rowCells = Array.from(row.querySelectorAll("td"));
      const skuId =
        skuIndex < 0
          ? undefined
          : normalizeText(rowCells[skuIndex]?.textContent);
      for (const column of requiredColumns) {
        const cell = rowCells[column.index];
        if (!cell || !visible(cell)) continue;
        cells.push({
          ...(skuId ? { skuId } : {}),
          row: rowIndex + 1,
          column: column.label,
          required: true,
          visible: true,
          valueState: fieldValueState(cell)
        });
      }
    }
  }
  return cells;
}

function platformCheck(
  doc: Document,
  requested: boolean,
  completed: boolean
): PlatformFillCheckObservation {
  const buttons = Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.platformButtons)
  ).filter(
    (element) =>
      visible(element) && normalizeText(element.textContent) === "填写检查"
  );
  const warnings = Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.platformWarnings)
  )
    .filter(visible)
    .map((element) => normalizeText(element.textContent))
    .filter(
      (message) =>
        message.length > 0 &&
        !/模板功能上线|去修改|返回确认|关闭/u.test(message)
    );
  return {
    requested,
    available: buttons.length === 1,
    completed: requested && (completed || warnings.length > 0),
    warnings
  };
}

export interface EditorDomReadInput {
  readonly pageUrl?: string;
  readonly platformCheckRequested?: boolean;
  /**
   * Supplied by the browser handler when it has separately observed a
   * completed platform check with no warning dialog. This reader never clicks.
   */
  readonly platformCheckCompleted?: boolean;
}

/**
 * Thin read-only DOM layer for one editor sample. Stability is decided by the
 * pure inspector from multiple observations, not by timers in this reader.
 */
export function readDoudianEditorDom(
  doc: Document,
  input: EditorDomReadInput = {}
): EditorObservation {
  const controls = Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.controls)
  ).filter(visible);
  const anchors = Array.from(doc.querySelectorAll(EDITOR_SELECTORS.anchors))
    .filter(visible)
    .filter((element) =>
      KNOWN_EDITOR_ANCHORS.has(normalizeText(element.textContent))
    );
  const markers = Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.requiredMarkers)
  ).filter(visible);
  const loading = Array.from(
    doc.querySelectorAll(EDITOR_SELECTORS.loading)
  ).some(visible);
  const fields = requiredFields(doc);
  const skuRequiredCells = skuCells(doc);
  const pageUrl =
    input.pageUrl ?? doc.defaultView?.location.href ?? "about:blank";
  const readiness = {
    signature: stableHash(
      [
        controls.length,
        anchors.length,
        markers.length,
        fields.map((field) => `${field.key}:${field.valueState}`).join("|"),
        skuRequiredCells
          .map((cell) => `${cell.skuId ?? cell.row}:${cell.column}:${cell.valueState}`)
          .join("|")
      ].join("#")
    ),
    hasMain: Boolean(doc.querySelector(EDITOR_SELECTORS.main)),
    visibleControls: controls.length,
    knownAnchors: anchors.length,
    requiredMarkers: markers.length,
    loading
  };
  return {
    url: pageUrl,
    readiness,
    riskSignals: riskSignals(doc, pageUrl),
    requiredFields: fields,
    skuRequiredCells,
    platformFillCheck: platformCheck(
      doc,
      input.platformCheckRequested ?? false,
      input.platformCheckCompleted ?? false
    )
  };
}
