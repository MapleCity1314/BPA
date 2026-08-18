import type {
  AllianceShop,
  DoudianAllianceNodeErrorCode,
  RetiredProductsPage
} from "@bpa/adapter-doudian";
import { DOUDIAN_ALLIANCE_NODE_ERROR_CODES } from "@bpa/adapter-doudian";
import type { RiskSignal } from "@bpa/schemas";
import type {
  AllianceRetiredStageRequest,
  AllianceRetiredStageResult
} from "./alliance-retired-content";

const PROMOTE_PATH = "/dashboard/product/promote-manage";
const RETIRED_PATH = "/dashboard/regulation/clear-out";
const BUYIN_ORIGIN = "https://buyin.jinritemai.com";

interface StageResponse {
  readonly ok: boolean;
  readonly requestId?: string;
  readonly result?: AllianceRetiredStageResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface PreflightResponse {
  readonly riskSignals?: readonly RiskSignal[];
}

interface CancelStageResponse {
  readonly ok?: boolean;
  readonly requestId?: string;
  readonly stopped?: boolean;
}

export async function requestAllianceStageCancellation(
  tabId: number,
  requestId: string
): Promise<boolean> {
  const cancellation = (await browser.tabs
    .sendMessage(tabId, {
      type: "bpa.doudian.alliance.cancel-stage",
      requestId
    })
    .catch(() => undefined)) as CancelStageResponse | undefined;
  return (
    cancellation?.ok === true &&
    cancellation.requestId === requestId &&
    cancellation.stopped === true
  );
}

export async function completeCoreCancellationAfterStageStop(input: {
  readonly safeStop: Promise<boolean>;
  readonly onStopped: () => void | Promise<void>;
}): Promise<boolean> {
  if (!(await input.safeStop)) return false;
  await input.onStopped();
  return true;
}

export class AllianceRetiredDriverError extends Error {
  constructor(
    readonly code: DoudianAllianceNodeErrorCode,
    readonly riskSignals: readonly RiskSignal[] = [],
    readonly diagnostic?: AllianceRetiredStageDiagnostic
  ) {
    super(
      `Doudian alliance browser error: ${code}${
        diagnostic ? ` [${allianceStageDiagnosticText(diagnostic)}]` : ""
      }`
    );
    this.name = "AllianceRetiredDriverError";
  }
}

export interface AllianceRetiredStageDiagnostic {
  readonly phase: "discover-source" | "resolve-shop" | "restore-source";
  readonly shopOrdinal?: number;
  readonly switchResponse:
    | "not-started"
    | "confirmed"
    | "mismatched"
    | "recoverable-error"
    | "failed";
  readonly navigationIdentity:
    | "not-required"
    | "confirmed"
    | "mismatched"
    | "unavailable";
  readonly restoreResult: "not-required" | "succeeded" | "failed";
  readonly switchErrorCode?: DoudianAllianceNodeErrorCode;
  readonly navigationErrorCode?: DoudianAllianceNodeErrorCode;
  readonly restoreErrorCode?: DoudianAllianceNodeErrorCode;
}

function allianceStageDiagnosticText(
  diagnostic: AllianceRetiredStageDiagnostic
): string {
  return [
    `phase=${diagnostic.phase}`,
    ...(diagnostic.shopOrdinal === undefined
      ? []
      : [`shop_ordinal=${diagnostic.shopOrdinal}`]),
    `switch_response=${diagnostic.switchResponse}`,
    ...(diagnostic.switchErrorCode === undefined
      ? []
      : [`switch_error=${diagnostic.switchErrorCode}`]),
    `navigation_identity=${diagnostic.navigationIdentity}`,
    ...(diagnostic.navigationErrorCode === undefined
      ? []
      : [`navigation_error=${diagnostic.navigationErrorCode}`]),
    `restore_result=${diagnostic.restoreResult}`,
    ...(diagnostic.restoreErrorCode === undefined
      ? []
      : [`restore_error=${diagnostic.restoreErrorCode}`])
  ].join(";");
}

function allianceErrorCode(
  error: unknown
): DoudianAllianceNodeErrorCode | undefined {
  return error instanceof AllianceRetiredDriverError
    ? error.code
    : undefined;
}

function withAllianceDiagnostic(
  error: unknown,
  diagnostic: AllianceRetiredStageDiagnostic
): AllianceRetiredDriverError {
  if (error instanceof AllianceRetiredDriverError) {
    return new AllianceRetiredDriverError(
      error.code,
      error.riskSignals,
      diagnostic
    );
  }
  return new AllianceRetiredDriverError(
    "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
    [],
    diagnostic
  );
}

const DISCOVERY_ERROR_CODES = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "CURRENT_SHOP_NOT_IN_LIST",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_DRIFT",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_IDENTITY_UNCERTAIN",
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

const SCAN_ERROR_CODES = new Set<DoudianAllianceNodeErrorCode>([
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "PROMOTION_DIALOG_CLOSE_AMBIGUOUS",
  "PROMOTION_DIALOG_UNRECOGNIZED",
  "RETIRED_PRODUCT_LIMIT_EXCEEDED",
  "RETIRED_PRODUCT_ROW_CHANGED",
  "RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED",
  "RETIRED_PRODUCTS_TABLE_CHANGED",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_LIST_INCOMPLETE",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_TARGET_INVALID"
]);

function safeContentCode(
  value: unknown,
  expectedStage: AllianceRetiredStageResult["stage"]
): DoudianAllianceNodeErrorCode {
  const discoveryStage =
    expectedStage === "discover-shops" ||
    expectedStage === "read-shop-context";
  const fallback =
    discoveryStage
      ? "DOUDIAN_ALLIANCE_DISCOVERY_FAILED"
      : "ALLIANCE_STAGE_FAILED";
  if (typeof value !== "string" || !DOUDIAN_ALLIANCE_NODE_ERROR_CODES.has(
    value as DoudianAllianceNodeErrorCode
  )) {
    return fallback;
  }
  const allowed =
    discoveryStage
      ? DISCOVERY_ERROR_CODES
      : SCAN_ERROR_CODES;
  return allowed.has(value as DoudianAllianceNodeErrorCode)
    ? (value as DoudianAllianceNodeErrorCode)
    : fallback;
}

export interface AllianceRetiredBrowserDriver
{
  discoverShops(): Promise<readonly AllianceShop[]>;
  switchShop(shop: AllianceShop): Promise<void>;
  openPromotion(shop: AllianceShop): Promise<void>;
  openRetiredProducts(shop: AllianceShop): Promise<void>;
  collectRetiredProducts(shop: AllianceShop): Promise<RetiredProductsPage>;
  cleanupShopTabs(): Promise<void>;
  discoverShopContext(): Promise<{
    readonly shops: readonly AllianceShop[];
    readonly currentShop: {
      readonly id: string;
      readonly name: string;
    };
  }>;
}

function tabMatches(
  tab: Browser.tabs.Tab,
  origin: string,
  pathname: string
): boolean {
  if (tab.id == null || typeof tab.url !== "string") return false;
  try {
    const url = new URL(tab.url);
    return url.origin === origin && url.pathname === pathname;
  } catch {
    return false;
  }
}

function isAuthenticationRoute(tab: Browser.tabs.Tab): boolean {
  if (typeof tab.url !== "string") return false;
  try {
    return /login|passport|signin|authorize/iu.test(new URL(tab.url).pathname);
  } catch {
    return false;
  }
}

function normalizeShopName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

export function createAllianceRetiredBrowserDriver(input: {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly stageResponseTimeoutMs?: number;
  readonly shopIdentityWaitMs?: number;
  readonly restoreProductListAfterSwitch?: boolean;
  readonly reserveManagedTab?: () => boolean;
  readonly releaseManagedTabReservation?: () => void;
  readonly onStageStarted?: (stage: {
    readonly tabId: number;
    readonly requestId: string;
  }) => void;
  readonly onStageStopped?: (requestId: string) => void;
}): AllianceRetiredBrowserDriver {
  const managedTabIds = new Set<number>();
  let promoteTabId: number | undefined;
  let retiredTabId: number | undefined;
  let sourceUrl: string | undefined;
  let stageSequence = 0;

  const assertBeforeDeadline = (): void => {
    if (
      !Number.isFinite(Date.parse(input.deadline)) ||
      Date.now() >= Date.parse(input.deadline)
    ) {
      throw new AllianceRetiredDriverError("DEADLINE_EXCEEDED");
    }
  };

  const assertNotCancelled = (): void => {
    if (input.isCancelled?.()) {
      throw new AllianceRetiredDriverError("COMMAND_CANCELLED");
    }
  };

  const withManagedTabReservation = async <T>(
    operation: () => Promise<T>
  ): Promise<T> => {
    if (input.reserveManagedTab && !input.reserveManagedTab()) {
      throw new AllianceRetiredDriverError(
        "BROWSER_TAB_CAPACITY_EXCEEDED"
      );
    }
    try {
      return await operation();
    } finally {
      input.releaseManagedTabReservation?.();
    }
  };

  const preflight = async (tabId: number): Promise<void> => {
    assertBeforeDeadline();
    const response = (await browser.tabs
      .sendMessage(tabId, { type: "bpa.risk.preflight" })
      .catch(() => {
        throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
      })) as PreflightResponse;
    const blocking = response.riskSignals?.find(
      (signal) => signal.severity === "blocking"
    );
    if (blocking) {
      const code = [
        "AUTH_REQUIRED",
        "CAPTCHA_REQUIRED",
        "RISK_CONTROL",
        "SESSION_EXPIRED"
      ].includes(blocking.code)
        ? (blocking.code as DoudianAllianceNodeErrorCode)
        : "RISK_CONTROL";
      throw new AllianceRetiredDriverError(
        code,
        response.riskSignals ?? []
      );
    }
  };

  const stage = async <T extends AllianceRetiredStageResult>(
    tabId: number,
    request: AllianceRetiredStageRequest,
    expectedStage: T["stage"]
  ): Promise<T> => {
    await preflight(tabId);
    assertNotCancelled();
    const requestId = `${input.sourceTabId}:${Date.now()}:${++stageSequence}`;
    input.onStageStarted?.({ tabId, requestId });
    const remaining = Date.parse(input.deadline) - Date.now();
    const timeoutMs = Math.max(
      1,
      Math.min(input.stageResponseTimeoutMs ?? 75_000, remaining)
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopNavigationWatch = false;
    let response: StageResponse;
    try {
      const navigationStarted =
        expectedStage === "switch-shop"
          ? (async (): Promise<never> => {
              const initial = await browser.tabs
                .get(tabId)
                .catch(() => undefined);
              while (!stopNavigationWatch && Date.now() < Date.parse(input.deadline)) {
                const current = await browser.tabs
                  .get(tabId)
                  .catch(() => undefined);
                if (
                  !current ||
                  current.status === "loading" ||
                  (initial?.url !== undefined && current.url !== initial.url)
                ) {
                  throw new AllianceRetiredDriverError("PAGE_LOADING");
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              return await new Promise<never>(() => undefined);
            })()
          : new Promise<never>(() => undefined);
      response = (await Promise.race([
        browser.tabs.sendMessage(tabId, {
          type: "bpa.doudian.alliance.stage",
          requestId,
          request
        }),
        navigationStarted,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AllianceRetiredDriverError(
                  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT"
                )
              ),
            timeoutMs
          );
        })
      ])) as StageResponse;
    } catch (error) {
      if (
        error instanceof AllianceRetiredDriverError &&
        error.code === "ALLIANCE_CONTENT_RESPONSE_TIMEOUT"
      ) {
        if (!(await requestAllianceStageCancellation(tabId, requestId))) {
          throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
        }
        throw error;
      }
      if (error instanceof AllianceRetiredDriverError) throw error;
      throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
    } finally {
      stopNavigationWatch = true;
      if (timer) clearTimeout(timer);
      input.onStageStopped?.(requestId);
    }
    if (
      response?.requestId !== requestId ||
      !response.ok ||
      response.result?.stage !== expectedStage
    ) {
      throw new AllianceRetiredDriverError(
        safeContentCode(response?.error?.code, expectedStage)
      );
    }
    return response.result as T;
  };

  const captureTabs = async (): Promise<Map<number, Browser.tabs.Tab>> =>
    new Map(
      (await browser.tabs.query({}).catch(() => {
        throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
      })).flatMap((tab) =>
        tab.id == null ? [] : [[tab.id, tab] as const]
      )
    );

  const waitForAttributedTab = async (
    before: ReadonlyMap<number, Browser.tabs.Tab>,
    initiatingTabId: number,
    matches: (tab: Browser.tabs.Tab) => boolean,
    timeoutCode: "ALLIANCE_TAB_TIMEOUT"
  ): Promise<number> => {
    const initiating = before.get(initiatingTabId);
    if (!initiating) {
      throw new AllianceRetiredDriverError("ALLIANCE_SOURCE_TAB_MISSING");
    }
    const activeBefore = new Set(
      [...before.values()]
        .filter(
          (tab) =>
            tab.windowId === initiating.windowId && tab.active === true
        )
        .flatMap((tab) => (tab.id == null ? [] : [tab.id]))
    );
    while (Date.now() < Date.parse(input.deadline)) {
      assertNotCancelled();
      const tabs = await browser.tabs
        .query({ windowId: initiating.windowId })
        .catch(() => {
          throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
        });
      const candidates = tabs
        .filter((tab) => {
          if (
            tab.id == null ||
            tab.windowId !== initiating.windowId ||
            tab.status !== "complete" ||
            !matches(tab)
          ) {
            return false;
          }
          const previous = before.get(tab.id);
          return (
            tab.id === initiatingTabId ||
            (!previous && tab.openerTabId === initiatingTabId) ||
            (previous && previous.url !== tab.url) ||
            (tab.active === true && !activeBefore.has(tab.id))
          );
        })
        .sort((left, right) => {
          const priority = (tab: Browser.tabs.Tab): number => {
            if (tab.id === initiatingTabId) return 0;
            if (
              !before.has(tab.id!) &&
              tab.openerTabId === initiatingTabId
            ) {
              return 1;
            }
            if (before.get(tab.id!)?.url !== tab.url) return 2;
            return 3;
          };
          return priority(left) - priority(right);
        });
      const candidate = candidates[0];
      if (candidate?.id != null) {
        if (!before.has(candidate.id)) {
          managedTabIds.add(candidate.id);
        }
        return candidate.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new AllianceRetiredDriverError(timeoutCode);
  };

  const waitForComplete = async (tabId: number): Promise<void> => {
    while (Date.now() < Date.parse(input.deadline)) {
      assertNotCancelled();
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (tab?.status === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new AllianceRetiredDriverError("ALLIANCE_TAB_TIMEOUT");
  };

  const readShopContextAfterNavigation = async (expectedShop?: AllianceShop) => {
    if (!sourceUrl) {
      throw new AllianceRetiredDriverError("ALLIANCE_SOURCE_TAB_MISSING");
    }
    const source = new URL(sourceUrl);
    const current = await browser.tabs
      .get(input.sourceTabId)
      .catch(() => undefined);
    if (!current) {
      throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
    }
    await waitForComplete(input.sourceTabId);
    const settled = await browser.tabs
      .get(input.sourceTabId)
      .catch(() => undefined);
    if (!settled) {
      throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
    }
    if (isAuthenticationRoute(settled)) {
      throw new AllianceRetiredDriverError("AUTH_REQUIRED");
    }
    if (!tabMatches(settled, source.origin, source.pathname)) {
      await browser.tabs
        .update(input.sourceTabId, { url: sourceUrl })
        .catch(() => {
          throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
        });
      await waitForComplete(input.sourceTabId);
      const restored = await browser.tabs
        .get(input.sourceTabId)
        .catch(() => undefined);
      if (!restored) {
        throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
      }
      if (isAuthenticationRoute(restored)) {
        throw new AllianceRetiredDriverError("AUTH_REQUIRED");
      }
    }
    const retryUntil = Math.min(
      Date.parse(input.deadline),
      Date.now() + (input.shopIdentityWaitMs ?? 60_000)
    );
    let lastError: unknown;
    while (Date.now() < retryUntil) {
      assertNotCancelled();
      try {
        const result = await stage<Extract<
          AllianceRetiredStageResult,
          { stage: "read-shop-context" }
        >>(
          input.sourceTabId,
          { stage: "read-shop-context" },
          "read-shop-context"
        );
        if (
          expectedShop &&
          (normalizeShopName(result.currentShop.name) !==
            normalizeShopName(expectedShop.name) ||
            (expectedShop.id !== undefined &&
              result.currentShop.id !== expectedShop.id))
        ) {
          lastError = new AllianceRetiredDriverError(
            "SHOP_IDENTITY_MISMATCH"
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof AllianceRetiredDriverError) ||
          ![
            "BROWSER_DISCONNECTED",
            "PAGE_LOADING",
            "SHOP_IDENTITY_UNCERTAIN"
          ].includes(error.code)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError instanceof AllianceRetiredDriverError
      ? lastError
      : new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
  };

  const switchAndConfirmShop = async (
    shop: AllianceShop,
    diagnosticBase: {
      readonly phase: AllianceRetiredStageDiagnostic["phase"];
      readonly shopOrdinal?: number;
    }
  ) => {
    if (diagnosticBase.phase === "restore-source") {
      try {
        const observed = (await readShopContextAfterNavigation()).currentShop;
        if (
          normalizeShopName(observed.name) === normalizeShopName(shop.name) &&
          (shop.id === undefined || observed.id === shop.id)
        ) {
          return observed;
        }
      } catch (error) {
        const navigationErrorCode = allianceErrorCode(error);
        if (
          !(error instanceof AllianceRetiredDriverError) ||
          ![
            "BROWSER_DISCONNECTED",
            "PAGE_LOADING",
            "SHOP_IDENTITY_UNCERTAIN"
          ].includes(error.code)
        ) {
          throw withAllianceDiagnostic(error, {
            ...diagnosticBase,
            switchResponse: "not-started",
            navigationIdentity:
              error instanceof AllianceRetiredDriverError &&
              error.code === "SHOP_IDENTITY_MISMATCH"
                ? "mismatched"
                : "unavailable",
            restoreResult: "failed",
            ...(navigationErrorCode === undefined
              ? {}
              : { navigationErrorCode })
          });
        }
      }
    }
    let switchResult:
      | Extract<AllianceRetiredStageResult, { stage: "switch-shop" }>
      | undefined;
    let switchResponse: AllianceRetiredStageDiagnostic["switchResponse"] =
      "not-started";
    let switchErrorCode: DoudianAllianceNodeErrorCode | undefined;
    try {
      switchResult = await stage<Extract<
        AllianceRetiredStageResult,
        { stage: "switch-shop" }
      >>(
        input.sourceTabId,
        { stage: "switch-shop", shop },
        "switch-shop"
      );
      switchResponse = "mismatched";
    } catch (error) {
      switchErrorCode = allianceErrorCode(error);
      if (
        !(error instanceof AllianceRetiredDriverError) ||
        ![
          "BROWSER_DISCONNECTED",
          "PAGE_LOADING",
          "SHOP_IDENTITY_UNCERTAIN"
        ].includes(error.code)
      ) {
        throw withAllianceDiagnostic(error, {
          ...diagnosticBase,
          switchResponse: "failed",
          navigationIdentity: "not-required",
          restoreResult: "not-required",
          ...(switchErrorCode === undefined ? {} : { switchErrorCode })
        });
      }
      switchResponse = "recoverable-error";
    }
    const immediate = switchResult?.currentShop;
    const immediateMatches =
      immediate !== undefined &&
      normalizeShopName(immediate.name) === normalizeShopName(shop.name) &&
      (shop.id === undefined || immediate.id === shop.id);
    if (immediateMatches) switchResponse = "confirmed";
    let observed: { readonly id: string; readonly name: string };
    try {
      if (immediateMatches && !input.restoreProductListAfterSwitch) {
        observed = immediate;
      } else {
        if (input.restoreProductListAfterSwitch) {
          const remainingMs = Date.parse(input.deadline) - Date.now();
          if (remainingMs <= 0) assertBeforeDeadline();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1_000, remainingMs))
          );
        }
        observed = (await readShopContextAfterNavigation(shop)).currentShop;
      }
    } catch (error) {
      const navigationErrorCode = allianceErrorCode(error);
      throw withAllianceDiagnostic(error, {
        ...diagnosticBase,
        switchResponse,
        ...(switchErrorCode === undefined ? {} : { switchErrorCode }),
        navigationIdentity:
          error instanceof AllianceRetiredDriverError &&
          error.code === "SHOP_IDENTITY_MISMATCH"
            ? "mismatched"
            : "unavailable",
        restoreResult: "not-required",
        ...(navigationErrorCode === undefined
          ? {}
          : { navigationErrorCode })
      });
    }
    if (
      normalizeShopName(observed.name) !== normalizeShopName(shop.name) ||
      (shop.id !== undefined && observed.id !== shop.id)
    ) {
      throw new AllianceRetiredDriverError(
        "SHOP_IDENTITY_MISMATCH",
        [],
        {
          ...diagnosticBase,
          switchResponse,
          navigationIdentity: "mismatched",
          restoreResult: "not-required",
          navigationErrorCode: "SHOP_IDENTITY_MISMATCH"
        }
      );
    }
    return observed;
  };

  const resolveDiscoveredShopIds = async (
    shops: readonly AllianceShop[],
    sourceShop: { readonly id: string; readonly name: string }
  ): Promise<readonly AllianceShop[]> => {
    const resolved: AllianceShop[] = [];
    let sourceSwitcherOrdinal: number | undefined;
    let mayNeedRestore = false;
    let primaryError: unknown;
    try {
      for (const [shopIndex, shop] of shops.entries()) {
        assertNotCancelled();
        if (shop.status === "blocked") {
          resolved.push(shop);
          continue;
        }
        if (
          normalizeShopName(shop.name) === normalizeShopName(sourceShop.name) &&
          (shop.id === sourceShop.id ||
            (shop.id === undefined &&
              shops.filter(
                (candidate) =>
                  candidate.status === "active" &&
                  normalizeShopName(candidate.name) ===
                    normalizeShopName(sourceShop.name)
              ).length === 1))
        ) {
          resolved.push({ ...shop, id: sourceShop.id });
          sourceSwitcherOrdinal = shop.switcherOrdinal;
          continue;
        }
        if (shop.id !== undefined) {
          resolved.push(shop);
          continue;
        }
        mayNeedRestore = true;
        const identity = await switchAndConfirmShop(shop, {
          phase: "resolve-shop",
          shopOrdinal: shopIndex + 1
        });
        if (
          identity.id === sourceShop.id &&
          normalizeShopName(identity.name) === normalizeShopName(sourceShop.name)
        ) {
          sourceSwitcherOrdinal = shop.switcherOrdinal;
        }
        resolved.push({ ...shop, id: identity.id });
      }
    } catch (error) {
      primaryError = error;
    }
    const restorationBlocked =
      primaryError instanceof AllianceRetiredDriverError &&
      [
        "AUTH_REQUIRED",
        "CAPTCHA_REQUIRED",
        "RISK_CONTROL",
        "SESSION_EXPIRED"
      ].includes(primaryError.code);
    if (mayNeedRestore && !restorationBlocked) {
      try {
        await switchAndConfirmShop(
          {
            id: sourceShop.id,
            ...(sourceSwitcherOrdinal === undefined
              ? {}
              : { switcherOrdinal: sourceSwitcherOrdinal }),
            name: sourceShop.name,
            status: "active",
            statusText: "正常营业"
          },
          { phase: "restore-source" }
        );
      } catch (restoreError) {
        const restoreErrorCode = allianceErrorCode(restoreError);
        const diagnostic =
          primaryError instanceof AllianceRetiredDriverError &&
          primaryError.diagnostic
            ? primaryError.diagnostic
            : restoreError instanceof AllianceRetiredDriverError &&
                restoreError.diagnostic
              ? restoreError.diagnostic
              : {
                  phase: "restore-source" as const,
                  switchResponse: "failed" as const,
                  navigationIdentity: "unavailable" as const,
                  restoreResult: "failed" as const
                };
        throw new AllianceRetiredDriverError(
          "SHOP_CONTEXT_RESTORE_FAILED",
          [],
          {
            ...diagnostic,
            restoreResult: "failed",
            ...(restoreErrorCode === undefined
              ? {}
              : { restoreErrorCode })
          }
        );
      }
    }
    if (primaryError) {
      if (
        mayNeedRestore &&
        primaryError instanceof AllianceRetiredDriverError &&
        primaryError.diagnostic
      ) {
        throw new AllianceRetiredDriverError(
          primaryError.code,
          primaryError.riskSignals,
          { ...primaryError.diagnostic, restoreResult: "succeeded" }
        );
      }
      throw primaryError;
    }
    const ids = resolved
      .filter((shop) => shop.status === "active")
      .map((shop) => shop.id);
    if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) {
      throw new AllianceRetiredDriverError("SHOP_IDENTITY_AMBIGUOUS");
    }
    return resolved;
  };

  const discoverShopContext = async () => {
    sourceUrl ??= (
      await browser.tabs.get(input.sourceTabId).catch(() => {
        throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
      })
    ).url;
    let result: Extract<
      AllianceRetiredStageResult,
      { stage: "discover-shops" }
    >;
    try {
      result = await stage(
        input.sourceTabId,
        { stage: "discover-shops" },
        "discover-shops"
      );
    } catch (error) {
      throw withAllianceDiagnostic(error, {
        phase: "discover-source",
        switchResponse: "not-started",
        navigationIdentity: "unavailable",
        restoreResult: "not-required"
      });
    }
    return {
      shops: await resolveDiscoveredShopIds(result.shops, result.currentShop),
      currentShop: result.currentShop
    };
  };

  return {
    discoverShopContext,
    async discoverShops() {
      return (await discoverShopContext()).shops;
    },
    async switchShop(shop) {
      sourceUrl ??= (
        await browser.tabs.get(input.sourceTabId).catch(() => {
          throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
        })
      ).url;
      if (!sourceUrl) {
        throw new AllianceRetiredDriverError("ALLIANCE_SOURCE_TAB_MISSING");
      }
      await switchAndConfirmShop(shop, { phase: "resolve-shop" });
    },
    async openPromotion(_shop) {
      const landingTabId = await withManagedTabReservation(async () => {
        const before = await captureTabs();
        await stage(
          input.sourceTabId,
          { stage: "open-promotion" },
          "open-promotion"
        );
        return waitForAttributedTab(
          before,
          input.sourceTabId,
          (tab) =>
            typeof tab.url === "string" &&
            tab.url.startsWith(`${BUYIN_ORIGIN}/dashboard`),
          "ALLIANCE_TAB_TIMEOUT"
        );
      });
      const landingTab = await browser.tabs.get(landingTabId);
      if (tabMatches(landingTab, BUYIN_ORIGIN, PROMOTE_PATH)) {
        promoteTabId = landingTabId;
        return;
      }
      promoteTabId = await withManagedTabReservation(async () => {
        const beforePromote = await captureTabs();
        await stage(
          landingTabId,
          { stage: "open-product-promotion" },
          "open-product-promotion"
        );
        return waitForAttributedTab(
          beforePromote,
          landingTabId,
          (tab) => tabMatches(tab, BUYIN_ORIGIN, PROMOTE_PATH),
          "ALLIANCE_TAB_TIMEOUT"
        );
      });
    },
    async openRetiredProducts(_shop) {
      if (promoteTabId == null) {
        throw new AllianceRetiredDriverError("PROMOTION_TAB_MISSING");
      }
      const promotionSourceTabId = promoteTabId;
      retiredTabId = await withManagedTabReservation(async () => {
        const before = await captureTabs();
        await stage(
          promotionSourceTabId,
          { stage: "open-retired-products" },
          "open-retired-products"
        );
        return waitForAttributedTab(
          before,
          promotionSourceTabId,
          (tab) => tabMatches(tab, BUYIN_ORIGIN, RETIRED_PATH),
          "ALLIANCE_TAB_TIMEOUT"
        );
      });
    },
    async collectRetiredProducts(
      shop: AllianceShop
    ): Promise<RetiredProductsPage> {
      if (retiredTabId == null) {
        throw new AllianceRetiredDriverError("RETIRED_TAB_MISSING");
      }
      const result = await stage<Extract<
        AllianceRetiredStageResult,
        { stage: "collect-retired-products" }
      >>(
        retiredTabId,
        { stage: "collect-retired-products", expectedShop: shop },
        "collect-retired-products"
      );
      return result.page;
    },
    async cleanupShopTabs() {
      const existing = new Set(
        (await browser.tabs.query({}))
          .map((tab) => tab.id)
          .filter((id): id is number => id != null)
      );
      const removable = [...managedTabIds].filter(
        (id) => id !== input.sourceTabId && existing.has(id)
      );
      if (removable.length > 0) await browser.tabs.remove(removable);
      const source = await browser.tabs
        .get(input.sourceTabId)
        .catch(() => undefined);
      if (
        source?.id != null &&
        sourceUrl &&
        source.url !== sourceUrl
      ) {
        await browser.tabs.update(source.id, { url: sourceUrl });
        await waitForComplete(source.id);
      }
      if (sourceUrl && input.restoreProductListAfterSwitch) {
        await readShopContextAfterNavigation();
      }
      managedTabIds.clear();
      promoteTabId = undefined;
      retiredTabId = undefined;
    }
  };
}
