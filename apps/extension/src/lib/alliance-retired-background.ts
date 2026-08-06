import type {
  AllianceShop,
  RetiredProductsPage
} from "@bpa/adapter-doudian";
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
  readonly result?: AllianceRetiredStageResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface PreflightResponse {
  readonly riskSignals?: readonly RiskSignal[];
}

export class AllianceRetiredDriverError extends Error {
  constructor(
    readonly code: string,
    readonly riskSignals: readonly RiskSignal[] = []
  ) {
    super(code);
    this.name = "AllianceRetiredDriverError";
  }
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
    readonly currentShopName: string;
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
}): AllianceRetiredBrowserDriver {
  const managedTabIds = new Set<number>();
  let promoteTabId: number | undefined;
  let retiredTabId: number | undefined;
  let sourceUrl: string | undefined;

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

  const preflight = async (tabId: number): Promise<void> => {
    assertBeforeDeadline();
    const response = (await browser.tabs.sendMessage(tabId, {
      type: "bpa.risk.preflight"
    })) as PreflightResponse;
    const blocking = response.riskSignals?.find(
      (signal) => signal.severity === "blocking"
    );
    if (blocking) {
      throw new AllianceRetiredDriverError(
        blocking.code,
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
          request
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("ALLIANCE_CONTENT_RESPONSE_TIMEOUT")),
            timeoutMs
          );
        })
      ])) as StageResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AllianceRetiredDriverError(
        /Extension context invalidated|Receiving end does not exist|message port closed/iu.test(
          message
        )
          ? "BROWSER_CONTENT_SCRIPT_MISSING"
          : message
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response?.ok || response.result?.stage !== expectedStage) {
      throw new AllianceRetiredDriverError(
        response?.error?.code ?? "ALLIANCE_STAGE_FAILED"
      );
    }
    return response.result as T;
  };

  const captureTabs = async (): Promise<Map<number, Browser.tabs.Tab>> =>
    new Map(
      (await browser.tabs.query({})).flatMap((tab) =>
        tab.id == null ? [] : [[tab.id, tab] as const]
      )
    );

  const waitForAttributedTab = async (
    before: ReadonlyMap<number, Browser.tabs.Tab>,
    initiatingTabId: number,
    matches: (tab: Browser.tabs.Tab) => boolean,
    timeoutCode: string
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
      const tabs = await browser.tabs.query({
        windowId: initiating.windowId
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
        if (
          !before.has(candidate.id) &&
          candidate.openerTabId === initiatingTabId
        ) {
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
      sourceUrl ??= (await browser.tabs.get(input.sourceTabId)).url;
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
        currentShopName: result.currentShopName
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
      const before = await captureTabs();
      await stage(
        input.sourceTabId,
        { stage: "open-promotion" },
        "open-promotion"
      );
      const landingTabId = await waitForAttributedTab(
        before,
        input.sourceTabId,
        (tab) =>
          typeof tab.url === "string" &&
          tab.url.startsWith(`${BUYIN_ORIGIN}/dashboard`),
        "BUYIN_LANDING_TAB_TIMEOUT"
      );
      const landingTab = await browser.tabs.get(landingTabId);
      if (tabMatches(landingTab, BUYIN_ORIGIN, PROMOTE_PATH)) {
        promoteTabId = landingTabId;
        return;
      }
      const beforePromote = await captureTabs();
      await stage(
        landingTabId,
        { stage: "open-product-promotion" },
        "open-product-promotion"
      );
      promoteTabId = await waitForAttributedTab(
        beforePromote,
        landingTabId,
        (tab) => tabMatches(tab, BUYIN_ORIGIN, PROMOTE_PATH),
        "ALLIANCE_TAB_TIMEOUT"
      );
    },
    async openRetiredProducts(_shop) {
      if (promoteTabId == null) {
        throw new AllianceRetiredDriverError("PROMOTION_TAB_MISSING");
      }
      const before = await captureTabs();
      await stage(
        promoteTabId,
        { stage: "open-retired-products" },
        "open-retired-products"
      );
      retiredTabId = await waitForAttributedTab(
        before,
        promoteTabId,
        (tab) => tabMatches(tab, BUYIN_ORIGIN, RETIRED_PATH),
        "ALLIANCE_TAB_TIMEOUT"
      );
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
