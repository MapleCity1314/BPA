import type { RiskSignal } from "@bpa/schemas";

export const BINANCE_ADAPTER_ID = "binance-copy-trading";
export const BINANCE_ADAPTER_VERSION = "1.7.0";
export const BINANCE_ORIGIN = "https://www.binance.com";
export const BINANCE_MANAGEMENT_PATH = "/zh-CN/copy-trading/copy-management";

export * from "./project-detail.js";

const ACCOUNT_LABELS = [
  "保证金余额",
  "钱包余额",
  "已实现总盈亏",
  "净利润"
] as const;

const PROJECT_LABELS = [
  "跟单时间",
  "净跟单金额",
  "保证金余额",
  "已实现盈亏",
  "未实现盈亏",
  "累计分润",
  "净利润",
  "分润比例",
  "止损状态"
] as const;

const POSITION_HEADERS = [
  "交易对",
  "方向",
  "杠杆",
  "大小",
  "保证金",
  "收益率",
  "开仓价",
  "标记价",
  "强平价"
] as const;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function pageText(document: Document): string {
  return normalizeText(document.body?.innerText ?? document.body?.textContent)
    .slice(0, 200_000);
}

function blockingSignal(
  code: RiskSignal["code"],
  category: RiskSignal["category"],
  detail: string,
  detectedAt: Date
): RiskSignal {
  return {
    code,
    category,
    severity: "blocking",
    source: "page",
    detected_at: detectedAt.toISOString(),
    detail
  };
}

export function detectBinanceRiskSignals(
  document: Document,
  pageUrl = document.defaultView?.location.href ?? "",
  detectedAt = new Date()
): RiskSignal[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [blockingSignal("PAGE_CONTEXT_CHANGED", "page_context", "Binance 页面 URL 无法解析。", detectedAt)];
  }
  if (url.origin !== BINANCE_ORIGIN) {
    return [blockingSignal("PAGE_CONTEXT_CHANGED", "page_context", "当前页面不是 Binance 主站。", detectedAt)];
  }
  if (/login|register|passport|signin|authorize/iu.test(url.pathname)) {
    return [blockingSignal("SESSION_EXPIRED", "session", "Binance 会话需要人工重新登录。", detectedAt)];
  }
  const text = pageText(document);
  const definitions: Array<[RegExp, RiskSignal["code"], RiskSignal["category"], string]> = [
    [/(?:请完成|需要|进行)(?:安全)?验证|滑块验证|请输入验证码|captcha/iu, "CAPTCHA_REQUIRED", "challenge", "Binance 页面要求人工完成验证。"],
    [/访问过于频繁|操作过于频繁|请求过于频繁|too many requests|try again later/iu, "RATE_LIMITED", "throttle", "Binance 页面提示访问频率过高。"],
    [/当前访问存在风险|检测到异常操作|账号存在风险|risk control|suspicious activity/iu, "RISK_CONTROL", "challenge", "Binance 风控阻断了只读采集。"]
  ];
  return definitions
    .filter(([pattern]) => pattern.test(text))
    .map(([, code, category, detail]) => blockingSignal(code, category, detail, detectedAt));
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

function candidateElements(document: Document): Element[] {
  const root = document.querySelector("#__APP,main,[role='main']");
  if (!root) return [];
  return Array.from(root.querySelectorAll(
    "span,div,p,dt,dd,td,th"
  )).filter(visible).slice(0, 20_000);
}

function labeledFields(root: ParentNode, labels: readonly string[]): Record<string, string> {
  const elements = Array.from(root.querySelectorAll("span,div,p,dt,dd,td,th"))
    .filter(visible)
    .slice(0, 5_000);
  const result: Record<string, string> = {};
  for (const label of labels) {
    const element = elements.find((candidate) => normalizeText(candidate.textContent) === label);
    if (!element) continue;
    const candidates = [
      element.nextElementSibling,
      element.parentElement?.nextElementSibling,
      element.parentElement
    ];
    const value = candidates
      .map((candidate) => normalizeText(candidate?.textContent))
      .find((candidate) => candidate.length > 0 && candidate !== label && candidate.length <= 500);
    if (value) result[label] = value;
  }
  return result;
}

function projectIdFromElement(element: Element): string | undefined {
  const attributes = [
    element.getAttribute("data-project-id"),
    element.getAttribute("data-portfolio-id"),
    element.getAttribute("href")
  ].filter((value): value is string => Boolean(value));
  for (const value of attributes) {
    const match = value.match(/(?:project|portfolio|leadPortfolio)(?:Id|_id)?[=/:-]([A-Za-z0-9_-]{4,120})/iu);
    if (match?.[1]) return match[1];
  }
  const text = normalizeText(element.textContent);
  return text.match(/^(?:项目\s*ID|Project\s*ID)\s*[：:]?\s*([A-Za-z0-9_-]{4,120})$/iu)?.[1];
}

function nearestProjectRoot(element: Element): Element {
  let current = element;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const text = normalizeText(current.textContent);
    const detailControls = Array.from(current.querySelectorAll<HTMLElement>(
      "button,[role='button'],a,span,div,p"
    )).filter((candidate) => {
      if (!visible(candidate)) return false;
      const label = normalizeText(candidate.textContent);
      if (!["展开详情", "收起详情", "收起"].includes(label)) return false;
      return !Array.from(candidate.children).some(
        (child) => normalizeText(child.textContent) === label
      );
    });
    if (
      detailControls.length === 1 &&
      PROJECT_LABELS.some((label) => text.includes(label))
    ) return current;
    if (!current.parentElement) break;
    current = current.parentElement;
  }
  throw new Error("BINANCE_PROJECT_CARD_MISSING");
}

export interface BinancePositionRow {
  readonly values: Readonly<Record<string, string>>;
}

export interface BinanceCopyProject {
  readonly projectId: string;
  readonly status: "ongoing" | "ended";
  readonly summary: Readonly<Record<string, string>>;
  readonly currentPositions: readonly BinancePositionRow[];
}

export interface BinanceManagementSnapshot {
  readonly schemaVersion: "binance-copy-trading/v0.1";
  readonly status: "complete" | "empty_confirmed";
  readonly observedAt: string;
  readonly pageUrl: string;
  readonly accountSummary: Readonly<Record<string, string>>;
  readonly activeTab: "ongoing" | "ended";
  readonly projects: readonly BinanceCopyProject[];
  readonly warnings: readonly string[];
  readonly formMutations: 0;
}

function managementTabControl(
  document: Document,
  label: "进行中" | "已结束"
): HTMLElement {
  const matches = (value: string): boolean => {
    const normalized = normalizeText(value);
    if (normalized === label) return true;
    const suffix = normalized.slice(label.length).replace(/\s+/gu, "");
    return normalized.startsWith(label) && /^(?:\(\d+\)|（\d+）|\d+)$/u.test(suffix);
  };
  const controls = Array.from(document.querySelectorAll<HTMLElement>(
    "[role='tab'],button,[role='button']"
  )).filter(
    (element) => visible(element) && matches(element.textContent ?? "")
  );
  if (controls.length !== 1) throw new Error("BINANCE_MANAGEMENT_TAB_AMBIGUOUS");
  return controls[0]!;
}

function managementSignature(snapshot: BinanceManagementSnapshot): string {
  return `${snapshot.status}:${snapshot.projects
    .map((project) => project.projectId)
    .join("\u0000")}`;
}

export async function collectBinanceManagementSnapshot(
  document: Document,
  pageUrl = document.defaultView?.location.href ?? "",
  options: {
    readonly deadline: string;
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly observedAt?: Date;
    readonly projectId?: string;
  }
): Promise<BinanceManagementSnapshot> {
  const deadline = Date.parse(options.deadline);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    throw new Error("DEADLINE_EXCEEDED");
  }
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const initial = readBinanceManagementSnapshot(document, pageUrl, options.observedAt);
  const targetProjectId = options.projectId;
  if (
    targetProjectId !== undefined &&
    !/^[A-Za-z0-9_-]{4,120}$/u.test(targetProjectId)
  ) {
    throw new Error("BINANCE_PROJECT_TARGET_INVALID");
  }
  const collected: BinanceCopyProject[] = [];
  const seen = new Set<string>();
  const add = (snapshot: BinanceManagementSnapshot): void => {
    for (const project of snapshot.projects) {
      if (targetProjectId !== undefined && project.projectId !== targetProjectId) {
        continue;
      }
      if (seen.has(project.projectId)) throw new Error("BINANCE_PROJECT_DUPLICATED_ACROSS_TABS");
      seen.add(project.projectId);
      collected.push(project);
    }
  };
  const initialLabel = initial.activeTab === "ended" ? "已结束" : "进行中";
  try {
    const targets = initial.activeTab === "ongoing"
      ? (["ongoing", "ended"] as const)
      : (["ended", "ongoing"] as const);
    for (const target of targets) {
      const label = target === "ended" ? "已结束" : "进行中";
      let snapshot = readBinanceManagementSnapshot(document, pageUrl, options.observedAt);
      if (snapshot.activeTab !== target) {
        const before = managementSignature(snapshot);
        managementTabControl(document, label).click();
        while (Date.now() < deadline) {
          snapshot = readBinanceManagementSnapshot(document, pageUrl, options.observedAt);
          if (snapshot.activeTab === target && managementSignature(snapshot) !== before) break;
          await wait(120);
        }
        if (snapshot.activeTab !== target) throw new Error("BINANCE_MANAGEMENT_TAB_TIMEOUT");
      }
      add(snapshot);
      if (targetProjectId !== undefined && collected.length === 1) break;
    }
  } finally {
    const current = readBinanceManagementSnapshot(document, pageUrl, options.observedAt);
    if (current.activeTab !== initial.activeTab) {
      managementTabControl(document, initialLabel).click();
      const cleanupDeadline = Math.max(deadline, Date.now() + 5_000);
      while (Date.now() < cleanupDeadline) {
        if (readBinanceManagementSnapshot(document, pageUrl, options.observedAt).activeTab === initial.activeTab) break;
        await wait(120);
      }
      if (readBinanceManagementSnapshot(document, pageUrl, options.observedAt).activeTab !== initial.activeTab) {
        throw new Error("BINANCE_MANAGEMENT_RESTORE_FAILED");
      }
    }
  }
  if (targetProjectId !== undefined && collected.length !== 1) {
    throw new Error("BINANCE_PROJECT_TARGET_MISSING");
  }
  return {
    ...initial,
    status: collected.length === 0 ? "empty_confirmed" : "complete",
    projects: collected,
    warnings: [],
    formMutations: 0
  };
}

function positionRows(root: ParentNode): BinancePositionRow[] {
  const rows = Array.from(root.querySelectorAll("tr,[role='row']")).filter(visible).slice(0, 500);
  return rows.flatMap((row) => {
    const cells = Array.from(row.querySelectorAll("th,td,[role='cell'],[role='gridcell']"))
      .map((cell) => normalizeText(cell.textContent));
    if (cells.length < 2 || cells.some((value) => POSITION_HEADERS.includes(value as never))) return [];
    const values = Object.fromEntries(POSITION_HEADERS.slice(0, cells.length).map((header, index) => [header, cells[index]!])) as Record<string, string>;
    return [{ values }];
  });
}

export function readBinanceManagementSnapshot(
  document: Document,
  pageUrl = document.defaultView?.location.href ?? "",
  observedAt = new Date()
): BinanceManagementSnapshot {
  const url = new URL(pageUrl);
  if (url.origin !== BINANCE_ORIGIN || !url.pathname.startsWith(BINANCE_MANAGEMENT_PATH)) {
    throw new Error("PAGE_MISMATCH");
  }
  const risks = detectBinanceRiskSignals(document, pageUrl, observedAt);
  if (risks.some((signal) => signal.severity === "blocking")) throw new Error(risks[0]!.code);
  const text = pageText(document);
  const activeTab = /已结束|Ended/iu.test(
    normalizeText(document.querySelector("[role='tab'][aria-selected='true']")?.textContent)
  ) ? "ended" : "ongoing";
  const projectElements = candidateElements(document).filter((element) => projectIdFromElement(element) !== undefined);
  const seen = new Set<string>();
  const projects = projectElements.flatMap((element) => {
    const projectId = projectIdFromElement(element)!;
    if (seen.has(projectId)) return [];
    seen.add(projectId);
    const root = nearestProjectRoot(element);
    const project: BinanceCopyProject = {
      projectId,
      status: /已结束|Ended/iu.test(normalizeText(root.textContent)) ? "ended" : activeTab,
      summary: labeledFields(root, PROJECT_LABELS),
      currentPositions: positionRows(root)
    };
    return [project];
  });
  const explicitEmpty = /暂无(?:进行中|已结束)?(?:跟单|项目|数据)|没有(?:进行中|已结束)?(?:跟单|项目)|No (?:copy|project|data)/iu.test(text);
  if (projects.length === 0 && !explicitEmpty) throw new Error("BINANCE_STRUCTURE_UNCONFIRMED");
  return {
    schemaVersion: "binance-copy-trading/v0.1",
    status: projects.length === 0 ? "empty_confirmed" : "complete",
    observedAt: observedAt.toISOString(),
    pageUrl: url.href,
    accountSummary: labeledFields(document, ACCOUNT_LABELS),
    activeTab,
    projects,
    warnings: ["DETAIL_TABS_NOT_COLLECTED_IN_V0_1"],
    formMutations: 0
  };
}
