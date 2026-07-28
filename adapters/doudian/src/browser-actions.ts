import {
  readDoudianEditorDom,
  readDoudianScopeDom,
  type ScopeDomObservation
} from "./dom-readers.js";
import {
  inspectPriorityItems,
  type PriorityItemsInspectionReplay,
  type PriorityItemsInspectionResult
} from "./editor-inspector.js";
import {
  MAX_SCOPE_RECONCILIATION_ROUNDS,
  reconcileProductScope,
  type ScopeCollectionReplay,
  type ScopeCollectionResult,
  type ScopeFingerprint,
  type ScopePageReplay,
  type ScopeRiskSignal,
  type ScopeVirtualView
} from "./scope-collector.js";

const PAGE_CONTROLS =
  "[class*='pagination'] [title],[class*='pagination'] [data-page]";
const PRODUCT_ROWS = "tr[data-row-key]";
const DEFAULT_WAIT_MS = 120;
const MAX_VIRTUAL_VIEWS = 200;
const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
const PRODUCT_LIST_PATH = "/ffa/g/list";

export const DOUDIAN_SCOPE_ACTION_VERSION = "1.1.0";

export interface DoudianReadOnlyActionOptions {
  readonly deadline: string;
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface DoudianScopeActionOptions extends DoudianReadOnlyActionOptions {
  readonly shop: {
    readonly id: string;
    readonly name: string;
  };
}

export interface DoudianEditorTarget {
  readonly productId: string;
  readonly editUrl: string;
}

export interface DoudianScopeRestoreTarget {
  readonly listUrl: string;
  readonly page: number;
  readonly scrollTop: number;
  readonly shopId: string;
  readonly shopName: string;
  readonly scopeDigest: string;
}

export interface DoudianScopeCollectionV1_1Result
  extends Omit<ScopeCollectionResult, "collectorVersion" | "restore"> {
  readonly collectorVersion: typeof DOUDIAN_SCOPE_ACTION_VERSION;
  readonly restore: DoudianScopeRestoreTarget & {
    readonly required: true;
  };
}

export interface DoudianScopeRestoreResult {
  readonly status: "restored";
  readonly restoreVersion: typeof DOUDIAN_SCOPE_ACTION_VERSION;
  readonly listUrl: string;
  readonly page: number;
  readonly scrollTop: number;
  readonly fingerprint: ScopeFingerprint;
  readonly formMutations: 0;
}

export interface DoudianEditorOpenResult {
  readonly status: "ready";
  readonly productId: string;
  readonly url: string;
  readonly readiness: {
    readonly stableSamples: 3;
    readonly visibleControls: number;
    readonly knownAnchors: number;
    readonly requiredMarkers: number;
  };
  readonly domMutations: 0;
}

export function validateDoudianEditorTarget(
  input: Readonly<Record<string, unknown>>
): DoudianEditorTarget {
  const productId = input.productId;
  const editUrl = input.editUrl;
  if (
    Object.keys(input).some(
      (key) => key !== "productId" && key !== "editUrl"
    ) ||
    typeof productId !== "string" ||
    !/^\d{5,30}$/u.test(productId) ||
    typeof editUrl !== "string"
  ) {
    throw new Error("EDITOR_TARGET_INVALID");
  }
  let url: URL;
  try {
    url = new URL(editUrl);
  } catch {
    throw new Error("EDITOR_TARGET_INVALID");
  }
  const parameterKeys = [...url.searchParams.keys()];
  if (
    url.origin !== "https://fxg.jinritemai.com" ||
    url.pathname !== "/ffa/g/create" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get("product_id") !== productId ||
    url.searchParams.get("entrance") !== "edit" ||
    parameterKeys.some(
      (key) => key !== "product_id" && key !== "entrance"
    )
  ) {
    throw new Error("EDITOR_TARGET_INVALID");
  }
  const canonical = new URL("/ffa/g/create", url.origin);
  canonical.searchParams.set("product_id", productId);
  canonical.searchParams.set("entrance", "edit");
  return { productId, editUrl: canonical.href };
}

export function validateDoudianScopeRestoreTarget(
  input: Readonly<Record<string, unknown>>,
  currentUrl?: string
): DoudianScopeRestoreTarget {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "listUrl",
          "page",
          "scrollTop",
          "shopId",
          "shopName",
          "scopeDigest",
          "required"
        ].includes(key)
    ) ||
    typeof input.listUrl !== "string" ||
    typeof input.page !== "number" ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    typeof input.scrollTop !== "number" ||
    !Number.isFinite(input.scrollTop) ||
    input.scrollTop < 0 ||
    typeof input.shopId !== "string" ||
    input.shopId.trim().length === 0 ||
    typeof input.shopName !== "string" ||
    input.shopName.trim().length === 0 ||
    typeof input.scopeDigest !== "string" ||
    !/^[a-f0-9]{8}$/u.test(input.scopeDigest) ||
    (input.required !== undefined && input.required !== true)
  ) {
    throw new Error("SCOPE_RESTORE_TARGET_INVALID");
  }
  let target: URL;
  try {
    target = new URL(input.listUrl);
  } catch {
    throw new Error("SCOPE_RESTORE_TARGET_INVALID");
  }
  let current: URL | undefined;
  try {
    current = currentUrl === undefined ? undefined : new URL(currentUrl);
  } catch {
    throw new Error("SCOPE_RESTORE_TARGET_INVALID");
  }
  if (
    target.origin !== DOUDIAN_ORIGIN ||
    target.pathname !== PRODUCT_LIST_PATH ||
    target.username ||
    target.password ||
    target.hash ||
    target.href.length > 4_096 ||
    (current !== undefined && current.origin !== target.origin)
  ) {
    throw new Error("SCOPE_RESTORE_TARGET_INVALID");
  }
  return {
    listUrl: target.href,
    page: input.page,
    scrollTop: input.scrollTop,
    shopId: input.shopId.trim(),
    shopName: input.shopName.trim(),
    scopeDigest: input.scopeDigest
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function integerFromElement(element: Element): number | undefined {
  const value =
    element.getAttribute("title") ??
    element.getAttribute("data-page") ??
    element.textContent ??
    "";
  const matched = normalizeText(value).match(/^\d+$/u)?.[0];
  const parsed = matched ? Number(matched) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertBeforeDeadline(
  deadline: string,
  now: () => number
): void {
  if (
    !Number.isFinite(Date.parse(deadline)) ||
    now() >= Date.parse(deadline)
  ) {
    throw new Error("DEADLINE_EXCEEDED");
  }
}

function scrollTarget(doc: Document): HTMLElement | undefined {
  const firstRow = doc.querySelector(PRODUCT_ROWS);
  let current = firstRow?.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const candidate = current as HTMLElement;
    if (
      Number(candidate.scrollHeight) >
      Math.max(Number(candidate.clientHeight), 0) + 1
    ) {
      return candidate;
    }
    current = current.parentElement;
  }
  return (doc.scrollingElement as HTMLElement | null) ?? undefined;
}

function setReadOnlyScroll(target: HTMLElement | undefined, top: number): void {
  if (!target) return;
  if (typeof target.scrollTo === "function") {
    target.scrollTo({ top, behavior: "instant" });
  } else {
    target.scrollTop = top;
  }
}

function pageControl(doc: Document, page: number): HTMLElement | undefined {
  return Array.from(doc.querySelectorAll(PAGE_CONTROLS))
    .filter(
      (element) =>
        element.getAttribute("aria-disabled") !== "true" &&
        !element.hasAttribute("disabled")
    )
    .find((element) => integerFromElement(element) === page) as
    | HTMLElement
    | undefined;
}

async function moveToPage(input: {
  readonly doc: Document;
  readonly page: number;
  readonly shopId: string;
  readonly shopName: string;
  readonly deadline: string;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly waitMs: number;
}): Promise<boolean> {
  const current = readDoudianScopeDom(input.doc, {
    shopId: input.shopId,
    shopName: input.shopName
  });
  if (current.page === input.page) return true;
  const control = pageControl(input.doc, input.page);
  if (!control || typeof control.click !== "function") return false;
  control.click();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertBeforeDeadline(input.deadline, input.now);
    await input.wait(input.waitMs);
    const observed = readDoudianScopeDom(input.doc, {
      shopId: input.shopId,
      shopName: input.shopName
    });
    if (observed.page === input.page) return true;
  }
  return false;
}

async function collectVirtualViews(input: {
  readonly doc: Document;
  readonly shopId: string;
  readonly shopName: string;
  readonly baselineDigest: string;
  readonly deadline: string;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly waitMs: number;
}): Promise<{
  readonly views: readonly ScopeVirtualView[];
  readonly latest: ScopeDomObservation;
  readonly contextChanged: boolean;
}> {
  const target = scrollTarget(input.doc);
  const originalTop = Number(target?.scrollTop ?? 0);
  const views: ScopeVirtualView[] = [];
  const signatures = new Set<string>();
  let latest = readDoudianScopeDom(input.doc, {
    shopId: input.shopId,
    shopName: input.shopName,
    scrollTop: Number(target?.scrollTop ?? 0)
  });
  let contextChanged = latest.fingerprint.digest !== input.baselineDigest;
  try {
    setReadOnlyScroll(target, 0);
    for (let viewIndex = 0; viewIndex < MAX_VIRTUAL_VIEWS; viewIndex += 1) {
      assertBeforeDeadline(input.deadline, input.now);
      if (viewIndex > 0) await input.wait(input.waitMs);
      latest = readDoudianScopeDom(input.doc, {
        shopId: input.shopId,
        shopName: input.shopName,
        scrollTop: Number(target?.scrollTop ?? 0)
      });
      contextChanged ||= latest.fingerprint.digest !== input.baselineDigest;
      const signature = [
        latest.view.scrollTop,
        ...latest.view.products.map((product) => product.id)
      ].join(":");
      if (!signatures.has(signature)) {
        signatures.add(signature);
        views.push(latest.view);
      }
      const maxTop = Math.max(
        0,
        Number(target?.scrollHeight ?? 0) -
          Number(target?.clientHeight ?? 0)
      );
      const currentTop = Number(target?.scrollTop ?? 0);
      if (!target || currentTop >= maxTop) break;
      const step = Math.max(
        1,
        Math.floor(Number(target.clientHeight || 400) * 0.8)
      );
      const nextTop = Math.min(maxTop, currentTop + step);
      if (nextTop <= currentTop) break;
      setReadOnlyScroll(target, nextTop);
    }
  } finally {
    setReadOnlyScroll(target, originalTop);
  }
  return {
    views: views.length > 0 ? views : [latest.view],
    latest,
    contextChanged
  };
}

/**
 * Collects pagination and virtualized list views with read-only navigation,
 * reconciles dynamic totals for at most three rounds, and always restores the
 * original page and scroll position.
 */
export async function collectDoudianProductScope(
  doc: Document,
  options: DoudianScopeActionOptions
): Promise<DoudianScopeCollectionV1_1Result> {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  assertBeforeDeadline(options.deadline, now);
  const initial = readDoudianScopeDom(doc, {
    shopId: options.shop.id,
    shopName: options.shop.name
  });
  const listUrl = validateDoudianScopeRestoreTarget({
    listUrl: doc.defaultView?.location.href ?? "",
    page: initial.page,
    scrollTop: initial.view.scrollTop,
    shopId: initial.fingerprint.shopId,
    shopName: initial.fingerprint.shopName,
    scopeDigest: initial.fingerprint.digest
  }).listUrl;
  const initialTarget = scrollTarget(doc);
  const initialLocation = {
    page: initial.page,
    scrollTop: Number(initialTarget?.scrollTop ?? initial.view.scrollTop)
  };
  const rounds: ScopeCollectionReplay["rounds"][number][] = [];
  let result: ScopeCollectionResult | undefined;
  try {
    for (
      let roundIndex = 0;
      roundIndex < MAX_SCOPE_RECONCILIATION_ROUNDS;
      roundIndex += 1
    ) {
      assertBeforeDeadline(options.deadline, now);
      const reachedFirst = await moveToPage({
        doc,
        page: 1,
        shopId: options.shop.id,
        shopName: options.shop.name,
        deadline: options.deadline,
        now,
        wait,
        waitMs
      });
      const first = readDoudianScopeDom(doc, {
        shopId: options.shop.id,
        shopName: options.shop.name
      });
      const pages: ScopePageReplay[] = [];
      const riskSignals: ScopeRiskSignal[] = [...first.riskSignals];
      let contextChanged = !reachedFirst;
      let latest = first;
      for (let page = 1; page <= first.totalPages; page += 1) {
        const reached = await moveToPage({
          doc,
          page,
          shopId: options.shop.id,
          shopName: options.shop.name,
          deadline: options.deadline,
          now,
          wait,
          waitMs
        });
        if (!reached) break;
        const collected = await collectVirtualViews({
          doc,
          shopId: options.shop.id,
          shopName: options.shop.name,
          baselineDigest: first.fingerprint.digest,
          deadline: options.deadline,
          now,
          wait,
          waitMs
        });
        latest = collected.latest;
        contextChanged ||= collected.contextChanged;
        riskSignals.push(...latest.riskSignals);
        pages.push({
          page: latest.page,
          totalPages: latest.totalPages,
          views: collected.views
        });
      }
      if (contextChanged) {
        riskSignals.push({
          code: "PAGE_CONTEXT_CHANGED",
          severity: "blocking"
        });
      }
      rounds.push({
        fingerprint: first.fingerprint,
        topTotal: first.topTotal ?? -1,
        bottomTotal: latest.bottomTotal ?? -1,
        pages,
        riskSignals
      });
      result = reconcileProductScope({ initialLocation, rounds });
      if (
        result.status === "blocked" ||
        (result.status === "complete" && rounds.length >= 2)
      ) {
        break;
      }
    }
  } finally {
    try {
      const restoreDeadline = new Date(now() + 5_000).toISOString();
      await moveToPage({
        doc,
        page: initialLocation.page,
        shopId: options.shop.id,
        shopName: options.shop.name,
        deadline: restoreDeadline,
        now,
        wait,
        waitMs
      });
      setReadOnlyScroll(scrollTarget(doc), initialLocation.scrollTop);
    } catch {
      // The deterministic result still carries an explicit restore instruction.
    }
  }
  const reconciled =
    result ??
    reconcileProductScope({
      initialLocation,
      rounds: []
    });
  return {
    ...reconciled,
    collectorVersion: DOUDIAN_SCOPE_ACTION_VERSION,
    restore: {
      listUrl,
      ...initialLocation,
      shopId: initial.fingerprint.shopId,
      shopName: initial.fingerprint.shopName,
      scopeDigest: initial.fingerprint.digest,
      required: true
    }
  };
}

export function legacyDoudianScopeCollectionResult(
  result: DoudianScopeCollectionV1_1Result
): ScopeCollectionResult {
  return {
    ...result,
    collectorVersion: "1.0.0",
    restore: {
      page: result.restore.page,
      scrollTop: result.restore.scrollTop,
      required: true
    }
  };
}

/**
 * Restores the exact list scope after editor inspection. It only navigates
 * pagination and scroll state; it never types, saves, publishes or mutates a
 * form value.
 */
export async function restoreDoudianProductScope(
  doc: Document,
  input: Readonly<Record<string, unknown>>,
  options: DoudianReadOnlyActionOptions
): Promise<DoudianScopeRestoreResult> {
  const target = validateDoudianScopeRestoreTarget(
    input,
    doc.defaultView?.location.href
  );
  if (doc.defaultView?.location.href !== target.listUrl) {
    throw new Error("SCOPE_RESTORE_URL_MISMATCH");
  }
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  assertBeforeDeadline(options.deadline, now);
  const before = readDoudianScopeDom(doc, {
    shopId: target.shopId,
    shopName: target.shopName
  });
  if (before.fingerprint.digest !== target.scopeDigest) {
    throw new Error("SCOPE_RESTORE_CONTEXT_MISMATCH");
  }
  const reached = await moveToPage({
    doc,
    page: target.page,
    shopId: target.shopId,
    shopName: target.shopName,
    deadline: options.deadline,
    now,
    wait,
    waitMs
  });
  if (!reached) throw new Error("SCOPE_RESTORE_PAGE_UNAVAILABLE");
  const afterPage = readDoudianScopeDom(doc, {
    shopId: target.shopId,
    shopName: target.shopName
  });
  if (afterPage.fingerprint.digest !== target.scopeDigest) {
    throw new Error("SCOPE_RESTORE_CONTEXT_MISMATCH");
  }
  const scroll = scrollTarget(doc);
  setReadOnlyScroll(scroll, target.scrollTop);
  const restoredScrollTop = Number(scroll?.scrollTop ?? 0);
  const restored = readDoudianScopeDom(doc, {
    shopId: target.shopId,
    shopName: target.shopName,
    scrollTop: restoredScrollTop
  });
  if (
    restored.page !== target.page ||
    restored.fingerprint.digest !== target.scopeDigest ||
    Math.abs(restoredScrollTop - target.scrollTop) > 1
  ) {
    throw new Error("SCOPE_RESTORE_POSITION_MISMATCH");
  }
  return {
    status: "restored",
    restoreVersion: DOUDIAN_SCOPE_ACTION_VERSION,
    listUrl: target.listUrl,
    page: target.page,
    scrollTop: restoredScrollTop,
    fingerprint: restored.fingerprint,
    formMutations: 0
  };
}

function priorityReplayInput(
  input: Readonly<Record<string, unknown>>,
  observations: PriorityItemsInspectionReplay["observations"]
): PriorityItemsInspectionReplay {
  const product = input.product as PriorityItemsInspectionReplay["product"];
  const packagingMatch = input.packagingMatch as
    | PriorityItemsInspectionReplay["packagingMatch"]
    | undefined;
  return {
    product,
    ...(packagingMatch ? { packagingMatch } : {}),
    observations
  };
}

/**
 * Samples the editor three times and delegates all issue classification to the
 * deterministic inspector. It never clicks "填写检查", types, saves or publishes.
 */
export async function inspectDoudianPriorityItems(
  doc: Document,
  input: Readonly<Record<string, unknown>>,
  options: DoudianReadOnlyActionOptions
): Promise<PriorityItemsInspectionResult> {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const observations: PriorityItemsInspectionReplay["observations"][number][] =
    [];
  for (let sample = 0; sample < 3; sample += 1) {
    assertBeforeDeadline(options.deadline, now);
    if (sample > 0) await wait(waitMs);
    observations.push(
      readDoudianEditorDom(doc, {
        platformCheckRequested: input.platformFillCheck === true
      })
    );
  }
  return inspectPriorityItems(priorityReplayInput(input, observations));
}

/**
 * Verifies a navigation performed by the Extension background. This handler
 * only observes the destination document; navigation itself requires the
 * separately granted `browser.tabs.navigate` capability.
 */
export async function verifyDoudianEditorOpen(
  doc: Document,
  input: Readonly<Record<string, unknown>>,
  options: DoudianReadOnlyActionOptions
): Promise<DoudianEditorOpenResult> {
  const target = validateDoudianEditorTarget(input);
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const observations = [];
  for (let sample = 0; sample < 3; sample += 1) {
    assertBeforeDeadline(options.deadline, now);
    if (sample > 0) await wait(waitMs);
    observations.push(readDoudianEditorDom(doc));
  }
  const latest = observations.at(-1)!;
  if (
    latest.url !== target.editUrl ||
    new URL(latest.url).searchParams.get("product_id") !== target.productId
  ) {
    throw new Error("EDITOR_URL_MISMATCH");
  }
  const stable =
    observations.every(
      (observation) =>
        observation.readiness.signature === latest.readiness.signature
    ) &&
    latest.readiness.hasMain &&
    latest.readiness.visibleControls > 0 &&
    (latest.readiness.knownAnchors > 0 ||
      latest.readiness.requiredMarkers > 0) &&
    !latest.readiness.loading;
  if (!stable) throw new Error("NAVIGATION_UNCERTAIN");
  return {
    status: "ready",
    productId: target.productId,
    url: target.editUrl,
    readiness: {
      stableSamples: 3,
      visibleControls: latest.readiness.visibleControls,
      knownAnchors: latest.readiness.knownAnchors,
      requiredMarkers: latest.readiness.requiredMarkers
    },
    domMutations: 0
  };
}
