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
    readonly riskSignals: readonly RiskSignal[] = []
  ) {
    super(`Doudian alliance browser error: ${code}`);
    this.name = "AllianceRetiredDriverError";
  }
}

const DISCOVERY_ERROR_CODES = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE"
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
  "SHOP_LIST_INCOMPLETE",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_TARGET_INVALID"
]);

function safeContentCode(
  value: unknown,
  expectedStage: AllianceRetiredStageResult["stage"]
): DoudianAllianceNodeErrorCode {
  const fallback =
    expectedStage === "discover-shops"
      ? "DOUDIAN_ALLIANCE_DISCOVERY_FAILED"
      : "ALLIANCE_STAGE_FAILED";
  if (typeof value !== "string" || !DOUDIAN_ALLIANCE_NODE_ERROR_CODES.has(
    value as DoudianAllianceNodeErrorCode
  )) {
    return fallback;
  }
  const allowed =
    expectedStage === "discover-shops"
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

export function createAllianceRetiredBrowserDriver(input: {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly stageResponseTimeoutMs?: number;
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
    let response: StageResponse;
    try {
      response = (await Promise.race([
        browser.tabs.sendMessage(tabId, {
          type: "bpa.doudian.alliance.stage",
          requestId,
          request
        }),
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

  const discoverShopContext = async () => {
    sourceUrl ??= (
      await browser.tabs.get(input.sourceTabId).catch(() => {
        throw new AllianceRetiredDriverError("BROWSER_DISCONNECTED");
      })
    ).url;
    const result = await stage<Extract<
      AllianceRetiredStageResult,
      { stage: "discover-shops" }
    >>(
      input.sourceTabId,
      { stage: "discover-shops" },
      "discover-shops"
    );
    return {
      shops: result.shops,
      currentShop: result.currentShop
    };
  };

  return {
    discoverShopContext,
    async discoverShops() {
      return (await discoverShopContext()).shops;
    },
    async switchShop(shop) {
      await stage(
        input.sourceTabId,
        { stage: "switch-shop", shop },
        "switch-shop"
      );
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
      managedTabIds.clear();
      promoteTabId = undefined;
      retiredTabId = undefined;
    }
  };
}
