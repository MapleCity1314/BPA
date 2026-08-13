import { detectBinanceRiskSignals } from "./index.js";

export const BINANCE_DETAIL_TAB_LABELS = [
  "仓位",
  "仓位历史记录",
  "历史委托",
  "交易历史",
  "分润记录",
  "转账记录",
  "资金费用",
  "跟单失败订单"
] as const;

export type BinanceDetailTab = (typeof BINANCE_DETAIL_TAB_LABELS)[number];

const BINANCE_ORIGIN = "https://www.binance.com";
const BINANCE_MANAGEMENT_PATH = "/zh-CN/copy-trading/copy-management";
const MAX_PAGES_PER_TAB = 100;
const MAX_ROWS_PER_TAB = 10_000;
const SENSITIVE_HEADER = /交易员|带单员|trader\s*(?:display\s*)?name|display\s*name/iu;
const TAB_SUMMARY_LABELS = [
  "总交易手续费",
  "总资金费用",
  "分润前总盈亏",
  "分润金额"
] as const;

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function visible(element: Element): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 20; depth += 1) {
    if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.getAttribute("style") ?? "";
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test(style)) return false;
    const computed = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (computed?.display === "none" || computed?.visibility === "hidden") return false;
    current = current.parentElement;
  }
  return true;
}

function exactVisibleElements(root: ParentNode, label: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    "[role='tab'],button,[role='button']"
  )).filter((element) => visible(element) && normalize(element.textContent) === label);
}

function uniqueTabControl(root: ParentNode, label: BinanceDetailTab): HTMLElement {
  const candidates = exactVisibleElements(root, label);
  if (candidates.length !== 1) throw new Error("BINANCE_DETAIL_TAB_AMBIGUOUS");
  return candidates[0]!;
}

function selectedTab(root: ParentNode): BinanceDetailTab | undefined {
  const selected = Array.from(root.querySelectorAll<HTMLElement>(
    "[role='tab'][aria-selected='true'],[role='tab'][data-state='active'],[role='tab'][class*='active']"
  )).filter(visible);
  const labels = selected
    .map((element) => normalize(element.textContent))
    .filter((label): label is BinanceDetailTab =>
      BINANCE_DETAIL_TAB_LABELS.includes(label as BinanceDetailTab)
    );
  return labels.length === 1 ? labels[0] : undefined;
}

function pageNumber(root: ParentNode): number {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(
    "[aria-current='page'],[class*='pagination'] [class*='active'],[class*='pagination-item-active']"
  )).filter(visible);
  const numbers = candidates
    .map((element) => Number(normalize(element.textContent)))
    .filter((value) => Number.isSafeInteger(value) && value >= 1);
  const unique = [...new Set(numbers)];
  if (unique.length > 1) throw new Error("BINANCE_PAGINATION_AMBIGUOUS");
  return unique[0] ?? 1;
}

function nextPageControl(root: ParentNode): HTMLElement | undefined {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(
    "button[aria-label='下一页'],button[title='下一页'],button[aria-label='Next page'],button[title='Next page'],li[class*='pagination-next']"
  )).filter(visible);
  if (candidates.length > 1) throw new Error("BINANCE_PAGINATION_AMBIGUOUS");
  return candidates[0];
}

function controlDisabled(control: HTMLElement): boolean {
  const button = control.matches("button")
    ? control
    : control.querySelector<HTMLElement>("button") ?? control;
  return (
    control.hasAttribute("disabled") ||
    button.hasAttribute("disabled") ||
    control.getAttribute("aria-disabled") === "true" ||
    button.getAttribute("aria-disabled") === "true" ||
    `${control.className} ${button.className}`.toLowerCase().includes("disabled")
  );
}

function activeTable(root: ParentNode): HTMLTableElement | undefined {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>("table"))
    .filter((table) => visible(table) && table.querySelectorAll("tr").length > 0);
  if (tables.length > 1) throw new Error("BINANCE_DETAIL_TABLE_AMBIGUOUS");
  return tables[0];
}

function explicitEmpty(root: ParentNode): boolean {
  const text = normalize(root.textContent);
  return /暂无(?:仓位|记录|数据|订单)|没有(?:仓位|记录|数据|订单)|No (?:position|record|data|order)/iu.test(text);
}

export interface BinanceDetailRecord {
  readonly recordKey: string;
  readonly projectId: string;
  readonly sourceTab: BinanceDetailTab;
  readonly page: number;
  readonly rowOrdinal: number;
  readonly fields: Readonly<Record<string, string>>;
}

export interface BinanceDetailPage {
  readonly projectId: string;
  readonly sourceTab: BinanceDetailTab;
  readonly page: number;
  readonly records: readonly BinanceDetailRecord[];
  readonly hasNextPage: boolean;
  readonly signature: string;
}

export interface BinanceProjectDetailSnapshot {
  readonly schemaVersion: "binance-copy-trading/v0.1";
  readonly status: "complete";
  readonly projectId: string;
  readonly observedAt: string;
  readonly pageUrl: string;
  readonly tabs: readonly {
    readonly sourceTab: BinanceDetailTab;
    readonly pageCount: number;
    readonly summary: Readonly<Record<string, string>>;
    readonly records: readonly BinanceDetailRecord[];
  }[];
  readonly formMutations: 0;
}

function tabSummary(root: ParentNode): Readonly<Record<string, string>> {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(
    "span,div,p,dt,dd"
  )).filter(visible).slice(0, 5_000);
  const result: Record<string, string> = {};
  for (const label of TAB_SUMMARY_LABELS) {
    const element = elements.find(
      (candidate) => normalize(candidate.textContent) === label
    );
    if (!element) continue;
    const value = [
      element.nextElementSibling,
      element.parentElement?.nextElementSibling,
      element.parentElement
    ].map((candidate) => normalize(candidate?.textContent)).find(
      (candidate) => candidate.length > 0 && candidate !== label && candidate.length <= 200
    );
    if (value) result[label] = value;
  }
  return result;
}

export function validateBinanceProjectTarget(
  input: Readonly<Record<string, unknown>>
): { projectId: string; projectStatus: "ongoing" | "ended"; managementUrl: string } {
  if (
    Object.keys(input).some((key) => !["projectId", "projectStatus", "managementUrl"].includes(key)) ||
    typeof input.projectId !== "string" ||
    !/^[A-Za-z0-9_-]{4,120}$/u.test(input.projectId) ||
    (input.projectStatus !== "ongoing" && input.projectStatus !== "ended") ||
    typeof input.managementUrl !== "string"
  ) {
    throw new Error("BINANCE_PROJECT_TARGET_INVALID");
  }
  let management: URL;
  try {
    management = new URL(input.managementUrl);
  } catch {
    throw new Error("BINANCE_PROJECT_TARGET_INVALID");
  }
  const safe = (url: URL): boolean =>
    url.origin === BINANCE_ORIGIN &&
    url.pathname.startsWith(BINANCE_MANAGEMENT_PATH) &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !/login|register|passport|signin|authorize/iu.test(url.pathname);
  if (
    !safe(management) ||
    management.pathname !== BINANCE_MANAGEMENT_PATH ||
    management.search !== ""
  ) {
    throw new Error("BINANCE_PROJECT_TARGET_INVALID");
  }
  return {
    projectId: input.projectId,
    projectStatus: input.projectStatus,
    managementUrl: management.href
  };
}

function managementTab(root: ParentNode): "ongoing" | "ended" | undefined {
  const selected = Array.from(root.querySelectorAll<HTMLElement>(
    "[role='tab'][aria-selected='true'],[role='tab'][data-state='active'],[role='tab'][class*='active']"
  )).filter(visible).map((element) => normalize(element.textContent));
  const statusForLabel = (label: string): "ongoing" | "ended" | undefined => {
    for (const [prefix, status] of [["进行中", "ongoing"], ["已结束", "ended"]] as const) {
      if (label === prefix) return status;
      const suffix = label.slice(prefix.length).replace(/\s+/gu, "");
      if (label.startsWith(prefix) && /^(?:\(\d+\)|（\d+）|\d+)$/u.test(suffix)) return status;
    }
    return undefined;
  };
  const matches = selected.flatMap((label) => {
    const status = statusForLabel(label);
    return status ? [status] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function managementTabControl(document: Document, status: "ongoing" | "ended"): HTMLElement {
  const label = status === "ongoing" ? "进行中" : "已结束";
  const controls = Array.from(document.querySelectorAll<HTMLElement>(
    "[role='tab'],button,[role='button']"
  )).filter((element) => {
    if (!visible(element)) return false;
    const text = normalize(element.textContent);
    if (text === label) return true;
    const suffix = text.slice(label.length).replace(/\s+/gu, "");
    return text.startsWith(label) && /^(?:\(\d+\)|（\d+）|\d+)$/u.test(suffix);
  });
  if (controls.length !== 1) throw new Error("BINANCE_MANAGEMENT_TAB_AMBIGUOUS");
  return controls[0]!;
}

function detailToggleControls(root: ParentNode, label: "展开详情" | "收起详情" | "收起"): HTMLElement[] {
  const preferred = Array.from(root.querySelectorAll<HTMLElement>(
    "button,[role='button'],a"
  )).filter((element) => visible(element) && normalize(element.textContent) === label);
  if (preferred.length > 0) return preferred;
  return Array.from(root.querySelectorAll<HTMLElement>("span,div,p"))
    .filter((element) =>
      visible(element) &&
      normalize(element.textContent) === label &&
      !Array.from(element.children).some((child) => normalize(child.textContent) === label)
    );
}

function projectIdentityElements(document: Document, projectId: string): HTMLElement[] {
  const root = document.querySelector<HTMLElement>("#__APP,main,[role='main']");
  if (!root) return [];
  const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>(
    "[data-project-id],[data-portfolio-id],span,div,p"
  ))].filter(visible);
  return candidates.filter((element) => {
    const attribute = element.getAttribute("data-project-id") ?? element.getAttribute("data-portfolio-id");
    if (attribute === projectId) return true;
    const match = normalize(element.textContent).match(
      /^(?:项目\s*ID|Project\s*ID)\s*[：:]?\s*([A-Za-z0-9_-]{4,120})$/iu
    );
    return match?.[1] === projectId;
  });
}

function projectRoot(document: Document, projectId: string): HTMLElement {
  const roots = new Set<HTMLElement>();
  for (const identity of projectIdentityElements(document, projectId)) {
    let current: HTMLElement | null = identity;
    for (let depth = 0; current && depth < 10; depth += 1) {
      const toggleCount = detailToggleControls(current, "展开详情").length +
        detailToggleControls(current, "收起详情").length +
        detailToggleControls(current, "收起").length;
      if (toggleCount === 1) {
        roots.add(current);
        break;
      }
      current = current.parentElement;
    }
  }
  if (roots.size === 0) throw new Error("BINANCE_PROJECT_CARD_MISSING");
  if (roots.size !== 1) throw new Error("BINANCE_PROJECT_CARD_AMBIGUOUS");
  return [...roots][0]!;
}

async function waitUntil(
  predicate: () => boolean,
  deadline: number,
  wait: (milliseconds: number) => Promise<void>,
  timeoutCode: string,
  isCancelled: () => boolean
): Promise<void> {
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("COMMAND_CANCELLED");
    if (predicate()) return;
    await wait(120);
  }
  throw new Error(timeoutCode);
}

function collapseControls(root: ParentNode): HTMLElement[] {
  return [
    ...detailToggleControls(root, "收起详情"),
    ...detailToggleControls(root, "收起")
  ];
}

function recordKey(
  projectId: string,
  sourceTab: BinanceDetailTab,
  page: number,
  rowOrdinal: number,
  fields: Readonly<Record<string, string>>
): string {
  const values = Object.entries(fields).flatMap(([key, value]) => [key, value]);
  return [projectId, sourceTab, String(page), String(rowOrdinal), ...values]
    .map((value) => encodeURIComponent(value))
    .join("|");
}

function responsiveRowFields(row: Element): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  const symbols = Array.from(row.querySelectorAll<HTMLElement>(
    ".t-subtitle1.text-PrimaryText"
  )).filter((element) => visible(element) && normalize(element.textContent).length > 0);
  if (symbols.length !== 1) throw new Error("BINANCE_DETAIL_ROW_CHANGED");
  fields.Symbol = normalize(symbols[0]!.textContent);
  const directions = Array.from(row.querySelectorAll<HTMLElement>("div,span,p"))
    .filter((element) =>
      visible(element) &&
      (normalize(element.textContent) === "做多" || normalize(element.textContent) === "做空") &&
      !Array.from(element.children).some(
        (child) => normalize(child.textContent) === normalize(element.textContent)
      )
    );
  if (directions.length > 1) throw new Error("BINANCE_DETAIL_ROW_CHANGED");
  if (directions[0]) fields.方向 = normalize(directions[0].textContent);
  for (const container of Array.from(row.querySelectorAll<HTMLElement>("div"))) {
    const children = Array.from(container.children).filter((child) => visible(child));
    if (children.length !== 2) continue;
    const labelElement = children[0]!;
    const label = normalize(labelElement.textContent);
    const value = normalize(children[1]!.textContent);
    if (
      !/t-caption/iu.test(String(labelElement.className)) ||
      !/text-(?:Secondary|Tertiary)Text/iu.test(String(labelElement.className)) ||
      label.length < 1 ||
      value.length < 1 ||
      SENSITIVE_HEADER.test(label)
    ) continue;
    if (fields[label] !== undefined && fields[label] !== value) {
      throw new Error("BINANCE_DETAIL_ROW_CHANGED");
    }
    fields[label] = value;
  }
  if (Object.keys(fields).length < 2) throw new Error("BINANCE_DETAIL_ROW_CHANGED");
  return fields;
}

export function readBinanceDetailPage(
  root: ParentNode,
  input: { readonly projectId: string; readonly sourceTab: BinanceDetailTab }
): BinanceDetailPage {
  const active = selectedTab(root);
  if (active !== input.sourceTab) throw new Error("BINANCE_DETAIL_TAB_NOT_ACTIVE");
  const table = activeTable(root);
  if (!table) {
    if (!explicitEmpty(root)) throw new Error("BINANCE_DETAIL_STRUCTURE_UNCONFIRMED");
    const page = pageNumber(root);
    return {
      projectId: input.projectId,
      sourceTab: input.sourceTab,
      page,
      records: [],
      hasNextPage: false,
      signature: `${input.sourceTab}:${page}:empty`
    };
  }
  const headers = Array.from(table.querySelectorAll("thead th,[role='columnheader']"))
    .map((element, index) => normalize(element.textContent) || `_column_${index + 1}`);
  if (headers.length < 1) {
    throw new Error("BINANCE_DETAIL_HEADERS_MISSING");
  }
  const page = pageNumber(root);
  const tableRows = Array.from(table.querySelectorAll("tbody tr,[role='row']"))
    .filter((row) => visible(row));
  const placeholderRows = tableRows.filter((row) => {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(
      "td,[role='cell'],[role='gridcell']"
    ));
    return row.classList.contains("bn-web-table-placeholder") &&
      cells.length === 1 &&
      Number(cells[0]!.getAttribute("colspan")) === headers.length &&
      normalize(cells[0]!.textContent).length === 0;
  });
  const rows = tableRows
    .filter((row) => !placeholderRows.includes(row))
    .filter((row) => row.querySelectorAll("td,[role='cell'],[role='gridcell']").length > 0)
    .slice(0, MAX_ROWS_PER_TAB + 1);
  if (rows.length > MAX_ROWS_PER_TAB) throw new Error("BINANCE_DETAIL_ROW_LIMIT_EXCEEDED");
  const records = rows.map((row, index) => {
    const cells = Array.from(row.querySelectorAll("td,[role='cell'],[role='gridcell']"))
      .map((cell) => normalize(cell.textContent));
    if (cells.length !== headers.length) throw new Error("BINANCE_DETAIL_ROW_CHANGED");
    const fields = headers.length === 1 && headers[0] === "Symbol"
      ? responsiveRowFields(row)
      : Object.fromEntries(
          headers.flatMap((header, cellIndex) =>
            SENSITIVE_HEADER.test(header) ? [] : [[header, cells[cellIndex]!]]
          )
        );
    const rowOrdinal = index + 1;
    return {
      recordKey: recordKey(input.projectId, input.sourceTab, page, rowOrdinal, fields),
      projectId: input.projectId,
      sourceTab: input.sourceTab,
      page,
      rowOrdinal,
      fields
    };
  });
  const next = nextPageControl(root);
  return {
    projectId: input.projectId,
    sourceTab: input.sourceTab,
    page,
    records,
    hasNextPage: Boolean(next && !controlDisabled(next)),
    signature: `${input.sourceTab}:${page}:${records.map((record) => record.recordKey).join("\u0000")}`
  };
}

function waitForChange(
  read: () => BinanceDetailPage,
  previousSignature: string,
  deadline: number,
  wait: (milliseconds: number) => Promise<void>,
  isCancelled: () => boolean
): Promise<BinanceDetailPage> {
  return (async () => {
    while (Date.now() < deadline) {
      if (isCancelled()) throw new Error("COMMAND_CANCELLED");
      const observed = read();
      if (observed.signature !== previousSignature) return observed;
      await wait(150);
    }
    throw new Error("BINANCE_PAGINATION_TIMEOUT");
  })();
}

async function waitForDetailPageReady(
  root: ParentNode,
  input: { readonly projectId: string; readonly sourceTab: BinanceDetailTab },
  deadline: number,
  wait: (milliseconds: number) => Promise<void>,
  isCancelled: () => boolean
): Promise<BinanceDetailPage> {
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("COMMAND_CANCELLED");
    try {
      return readBinanceDetailPage(root, input);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "BINANCE_DETAIL_STRUCTURE_UNCONFIRMED") {
        throw error;
      }
    }
    await wait(100);
  }
  throw new Error("BINANCE_DETAIL_TAB_TIMEOUT");
}

export async function collectBinanceProjectDetail(
  document: Document,
  input: Readonly<Record<string, unknown>>,
  options: {
    readonly deadline: string;
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly observedAt?: Date;
    readonly isCancelled?: () => boolean;
  }
): Promise<BinanceProjectDetailSnapshot> {
  const target = validateBinanceProjectTarget(input);
  const deadline = Date.parse(options.deadline);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("DEADLINE_EXCEEDED");
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const isCancelled = options.isCancelled ?? (() => false);
  if (isCancelled()) throw new Error("COMMAND_CANCELLED");
  const risks = detectBinanceRiskSignals(document, document.defaultView?.location.href ?? "");
  if (risks.some((risk) => risk.severity === "blocking")) throw new Error(risks[0]!.code);
  if (document.defaultView?.location.href !== target.managementUrl) throw new Error("PAGE_CONTEXT_CHANGED");
  const initialManagementTab = managementTab(document);
  if (!initialManagementTab) throw new Error("BINANCE_MANAGEMENT_TAB_AMBIGUOUS");
  let root: HTMLElement | undefined;
  let initialTab: BinanceDetailTab | undefined;
  let expanded = false;
  let openedByCollector = false;
  const tabs: BinanceProjectDetailSnapshot["tabs"][number][] = [];
  try {
    if (initialManagementTab !== target.projectStatus) {
      managementTabControl(document, target.projectStatus).click();
      await waitUntil(
        () => managementTab(document) === target.projectStatus,
        deadline,
        wait,
        "BINANCE_MANAGEMENT_TAB_TIMEOUT",
        isCancelled
      );
    }
    root = projectRoot(document, target.projectId);
    const expand = detailToggleControls(root, "展开详情");
    const collapse = collapseControls(root);
    if (expand.length === 1 && collapse.length === 0) {
      expand[0]!.click();
      expanded = true;
      openedByCollector = true;
      await waitUntil(
        () => {
          try {
            root = projectRoot(document, target.projectId);
            return collapseControls(root).length === 1 &&
              BINANCE_DETAIL_TAB_LABELS.every((label) => exactVisibleElements(root!, label).length === 1);
          } catch {
            return false;
          }
        },
        deadline,
        wait,
        "BINANCE_PROJECT_EXPAND_TIMEOUT",
        isCancelled
      );
    } else if (expand.length === 0 && collapse.length === 1) {
      expanded = true;
      if (!BINANCE_DETAIL_TAB_LABELS.every((label) => exactVisibleElements(root!, label).length === 1)) {
        throw new Error("BINANCE_PROJECT_EXPAND_TIMEOUT");
      }
    } else {
      throw new Error("BINANCE_PROJECT_EXPAND_AMBIGUOUS");
    }
    initialTab = selectedTab(root);
    for (const sourceTab of BINANCE_DETAIL_TAB_LABELS) {
      if (isCancelled()) throw new Error("COMMAND_CANCELLED");
      if (Date.now() >= deadline) throw new Error("DEADLINE_EXCEEDED");
      const control = uniqueTabControl(root, sourceTab);
      if (selectedTab(root) !== sourceTab) {
        control.click();
        while (selectedTab(root) !== sourceTab) {
          if (isCancelled()) throw new Error("COMMAND_CANCELLED");
          if (Date.now() >= deadline) throw new Error("BINANCE_DETAIL_TAB_TIMEOUT");
          await wait(100);
        }
      }
      let page = await waitForDetailPageReady(
        root,
        { projectId: target.projectId, sourceTab },
        deadline,
        wait,
        isCancelled
      );
      const summary = tabSummary(root);
      const records: BinanceDetailRecord[] = [...page.records];
      const seenPages = new Set([page.page]);
      let pageCount = 1;
      while (page.hasNextPage) {
        if (isCancelled()) throw new Error("COMMAND_CANCELLED");
        if (pageCount >= MAX_PAGES_PER_TAB) throw new Error("BINANCE_PAGE_LIMIT_EXCEEDED");
        const next = nextPageControl(root);
        if (!next || controlDisabled(next)) throw new Error("BINANCE_PAGINATION_CHANGED");
        const clickable = next.matches("button") ? next : next.querySelector<HTMLElement>("button") ?? next;
        clickable.click();
        const nextPage = await waitForChange(
          () => readBinanceDetailPage(root!, { projectId: target.projectId, sourceTab }),
          page.signature,
          deadline,
          wait,
          isCancelled
        );
        if (nextPage.page <= page.page || seenPages.has(nextPage.page)) {
          throw new Error("BINANCE_PAGINATION_REPEATED");
        }
        seenPages.add(nextPage.page);
        records.push(...nextPage.records);
        if (records.length > MAX_ROWS_PER_TAB) throw new Error("BINANCE_DETAIL_ROW_LIMIT_EXCEEDED");
        page = nextPage;
        pageCount += 1;
      }
      tabs.push({ sourceTab, pageCount, summary, records });
    }
  } finally {
    let cleanupError: Error | undefined;
    const cleanupDeadline = Math.max(deadline, Date.now() + 5_000);
    const ignoreCancellation = (): boolean => false;
    if (root && expanded) {
      try {
        if (initialTab && selectedTab(root) !== initialTab) {
          uniqueTabControl(root, initialTab).click();
        }
        if (openedByCollector) {
          const collapse = collapseControls(root);
          if (collapse.length !== 1) throw new Error("BINANCE_PROJECT_COLLAPSE_FAILED");
          collapse[0]!.click();
          await waitUntil(
            () => {
              try {
                root = projectRoot(document, target.projectId);
                return detailToggleControls(root, "展开详情").length === 1;
              } catch {
                return false;
              }
            },
            cleanupDeadline,
            wait,
            "BINANCE_PROJECT_COLLAPSE_FAILED",
            ignoreCancellation
          );
        }
      } catch {
        cleanupError = new Error("BINANCE_PROJECT_COLLAPSE_FAILED");
      }
    }
    try {
      if (managementTab(document) !== initialManagementTab) {
        managementTabControl(document, initialManagementTab).click();
        await waitUntil(
          () => managementTab(document) === initialManagementTab,
          cleanupDeadline,
          wait,
          "BINANCE_MANAGEMENT_RESTORE_FAILED",
          ignoreCancellation
        );
      }
    } catch {
      cleanupError = new Error("BINANCE_MANAGEMENT_RESTORE_FAILED");
    }
    if (cleanupError) throw cleanupError;
  }
  return {
    schemaVersion: "binance-copy-trading/v0.1",
    status: "complete",
    projectId: target.projectId,
    observedAt: (options.observedAt ?? new Date()).toISOString(),
    pageUrl: target.managementUrl,
    tabs,
    formMutations: 0
  };
}
