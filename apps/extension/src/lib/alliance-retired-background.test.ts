import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeCoreCancellationAfterStageStop,
  createAllianceRetiredBrowserDriver,
  requestAllianceStageCancellation
} from "./alliance-retired-background.js";

const shop = {
  id: "10001",
  name: "甲食品旗舰店",
  status: "active" as const,
  statusText: "正常营业"
};

function installBrowser(
  initialTabs: Array<Record<string, unknown>>,
  navigate: (stage: string, tabs: Map<number, Record<string, unknown>>) => void
) {
  const tabs = new Map(
    initialTabs.map((tab) => [Number(tab.id), { ...tab }])
  );
  const removed: number[][] = [];
  const sentMessages: Array<{ type: string; requestId?: string }> = [];
  const api = {
    tabs: {
      async query(query: { windowId?: number }) {
        return [...tabs.values()]
          .filter(
            (tab) =>
              query.windowId === undefined ||
              tab.windowId === query.windowId
          )
          .map((tab) => ({ ...tab }));
      },
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("missing tab");
        return { ...tab };
      },
      async sendMessage(
        _tabId: number,
        message: {
          type: string;
          requestId?: string;
          request?: { stage?: string };
        }
      ) {
        sentMessages.push({
          type: message.type,
          ...(message.requestId ? { requestId: message.requestId } : {})
        });
        if (message.type === "bpa.risk.preflight") {
          return { riskSignals: [] };
        }
        if (message.type === "bpa.doudian.alliance.cancel-stage") {
          return {
            ok: true,
            requestId: message.requestId,
            stopped: true
          };
        }
        const stage = String(message.request?.stage);
        navigate(stage, tabs);
        if (stage === "discover-shops") {
          return {
            ok: true,
            requestId: message.requestId,
            result: {
              stage,
              shops: [shop],
              currentShop: { id: shop.id!, name: shop.name }
            }
          };
        }
        if (stage === "collect-retired-products") {
          return {
            ok: true,
            requestId: message.requestId,
            result: {
              stage,
              page: {
                shop: { id: shop.id, name: shop.name },
                empty: true,
                products: []
              }
            }
          };
        }
        if (stage === "read-shop-context") {
          return {
            ok: true,
            requestId: message.requestId,
            result: {
              stage,
              currentShop: { id: shop.id!, name: shop.name }
            }
          };
        }
        if (stage === "switch-shop") {
          return {
            ok: true,
            requestId: message.requestId,
            result: {
              stage,
              shopName: shop.name,
              currentShop: { id: shop.id!, name: shop.name }
            }
          };
        }
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, dismissedDialogs: 0 }
        };
      },
      async update(tabId: number, update: { url: string }) {
        const current = tabs.get(tabId)!;
        const next = { ...current, url: update.url, status: "complete" };
        tabs.set(tabId, next);
        return { ...next };
      },
      async remove(tabIds: number[]) {
        removed.push([...tabIds]);
        for (const tabId of tabIds) tabs.delete(tabId);
      }
    }
  };
  vi.stubGlobal("browser", api);
  return { tabs, removed, sentMessages };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alliance retired-products browser navigation", () => {
  it("emits cancel.effective only after the active stage stopped ack", async () => {
    let resolveSafeStop!: (value: boolean) => void;
    const safeStop = new Promise<boolean>((resolve) => {
      resolveSafeStop = resolve;
    });
    const effective = vi.fn();
    const completion = completeCoreCancellationAfterStageStop({
      safeStop,
      onStopped: effective
    });

    await Promise.resolve();
    expect(effective).not.toHaveBeenCalled();
    resolveSafeStop(true);
    await expect(completion).resolves.toBe(true);
    expect(effective).toHaveBeenCalledOnce();
  });

  it("never emits safe-stop effectiveness when the active stage ack fails", async () => {
    const effective = vi.fn();
    await expect(
      completeCoreCancellationAfterStageStop({
        safeStop: Promise.resolve(false),
        onStopped: effective
      })
    ).resolves.toBe(false);
    expect(effective).not.toHaveBeenCalled();
  });

  it("does not start a DOM stage when Core cancels during preflight", async () => {
    installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        }
      ],
      () => undefined
    );
    let resolvePreflight!: (value: { riskSignals: never[] }) => void;
    const preflight = new Promise<{ riskSignals: never[] }>((resolve) => {
      resolvePreflight = resolve;
    });
    let stageSent = false;
    let cancelled = false;
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: { type: string }
    ) => {
      if (message.type === "bpa.risk.preflight") return preflight;
      if (message.type === "bpa.doudian.alliance.stage") stageSent = true;
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      isCancelled: () => cancelled
    });
    const discovery = driver.discoverShopContext();

    await Promise.resolve();
    cancelled = true;
    resolvePreflight({ riskSignals: [] });

    await expect(discovery).rejects.toMatchObject({
      code: "COMMAND_CANCELLED"
    });
    expect(stageSent).toBe(false);
  });

  it("supports the entire flow navigating in the source tab and restores it", async () => {
    const sourceUrl = "https://fxg.jinritemai.com/ffa/g/list";
    const state = installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: sourceUrl
        }
      ],
      (stage, tabs) => {
        const current = tabs.get(1)!;
        const target =
          stage === "open-promotion"
            ? "https://buyin.jinritemai.com/dashboard"
            : stage === "open-product-promotion"
              ? "https://buyin.jinritemai.com/dashboard/product/promote-manage"
              : stage === "open-retired-products"
                ? "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
                : undefined;
        if (target) tabs.set(1, { ...current, url: target });
      }
    );
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });
    await driver.discoverShops();
    await driver.switchShop(shop);
    await driver.openPromotion(shop);
    await driver.openRetiredProducts(shop);
    await expect(driver.collectRetiredProducts(shop)).resolves.toMatchObject({
      empty: true
    });
    await driver.cleanupShopTabs();
    expect(state.tabs.get(1)?.url).toBe(sourceUrl);
    expect(state.removed).toEqual([]);
  });

  it("resumes id-less discovery after a shop switch reloads the source tab", async () => {
    const sourceUrl = "https://fxg.jinritemai.com/ffa/g/list";
    const state = installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: sourceUrl
      }],
      () => undefined
    );
    let currentShop = { id: "10001", name: "甲食品旗舰店" };
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: typeof shop };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            currentShop,
            shops: [
              {
                name: "甲食品旗舰店",
                status: "active",
                statusText: "正常营业",
                switcherOrdinal: 0
              },
              {
                name: "乙食品专营店",
                status: "active",
                statusText: "正常营业",
                switcherOrdinal: 0
              }
            ]
          }
        };
      }
      if (stage === "switch-shop") {
        const requested = message.request?.shop;
        currentShop = requested?.name === "乙食品专营店"
          ? { id: "10002", name: requested.name }
          : { id: "10001", name: "甲食品旗舰店" };
        state.tabs.set(tabId, {
          ...state.tabs.get(tabId)!,
          url: "https://fxg.jinritemai.com/ffa/mshop/homepage/index",
          status: "complete"
        });
        throw new Error("The message port closed during navigation");
      }
      if (stage === "read-shop-context") {
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, currentShop }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).resolves.toMatchObject({
      currentShop: { id: "10001", name: "甲食品旗舰店" },
      shops: [
        { id: "10001", name: "甲食品旗舰店" },
        { id: "10002", name: "乙食品专营店" }
      ]
    });
    expect(state.tabs.get(1)?.url).toBe(sourceUrl);
    expect(currentShop).toEqual({ id: "10001", name: "甲食品旗舰店" });
  });

  it("waits for a numeric identity during the controlled post-navigation recovery window", async () => {
    const sourceUrl = "https://fxg.jinritemai.com/ffa/g/list";
    const state = installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: sourceUrl
      }],
      () => undefined
    );
    let currentShop = { id: "10001", name: "甲食品旗舰店" };
    let targetReadAttempts = 0;
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: typeof shop };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            currentShop,
            shops: [
              {
                name: "甲食品旗舰店",
                status: "active",
                statusText: "正常营业"
              },
              {
                name: "乙食品专营店",
                status: "active",
                statusText: "正常营业"
              }
            ]
          }
        };
      }
      if (stage === "switch-shop") {
        const requested = message.request?.shop;
        currentShop = requested?.name === "乙食品专营店"
          ? { id: "10002", name: requested.name }
          : { id: "10001", name: "甲食品旗舰店" };
        state.tabs.set(tabId, {
          ...state.tabs.get(tabId)!,
          url: "https://fxg.jinritemai.com/ffa/mshop/homepage/index",
          status: "complete"
        });
        throw new Error("The message port closed during navigation");
      }
      if (stage === "read-shop-context") {
        if (currentShop.id === "10002" && targetReadAttempts++ === 0) {
          return {
            ok: false,
            requestId: message.requestId,
            error: {
              code: "SHOP_IDENTITY_UNCERTAIN",
              message: "Identity is still stabilizing."
            }
          };
        }
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, currentShop }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).resolves.toMatchObject({
      shops: [
        { id: "10001", name: "甲食品旗舰店" },
        { id: "10002", name: "乙食品专营店" }
      ]
    });
    expect(targetReadAttempts).toBe(3);
    expect(currentShop).toEqual({ id: "10001", name: "甲食品旗舰店" });
  });

  it("recovers when the switch stage reports transient identity uncertainty during navigation", async () => {
    const sourceUrl = "https://fxg.jinritemai.com/ffa/g/list";
    const state = installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: sourceUrl
      }],
      () => undefined
    );
    let currentShop = { id: "10001", name: "甲食品旗舰店" };
    let recoveredReads = 0;
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: typeof shop };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            currentShop,
            shops: [
              {
                name: "甲食品旗舰店",
                status: "active",
                statusText: "正常营业"
              },
              {
                name: "乙食品专营店",
                status: "active",
                statusText: "正常营业"
              }
            ]
          }
        };
      }
      if (stage === "switch-shop") {
        const requested = message.request?.shop;
        currentShop = requested?.name === "乙食品专营店"
          ? { id: "10002", name: requested.name }
          : { id: "10001", name: "甲食品旗舰店" };
        state.tabs.set(tabId, {
          ...state.tabs.get(tabId)!,
          url: "https://fxg.jinritemai.com/ffa/mshop/homepage/index",
          status: "complete"
        });
        return {
          ok: false,
          requestId: message.requestId,
          error: {
            code: "SHOP_IDENTITY_UNCERTAIN",
            message: "Identity changed while navigation was settling."
          }
        };
      }
      if (stage === "read-shop-context") {
        recoveredReads += 1;
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, currentShop }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).resolves.toMatchObject({
      shops: [
        { id: "10001", name: "甲食品旗舰店" },
        { id: "10002", name: "乙食品专营店" }
      ]
    });
    expect(recoveredReads).toBeGreaterThanOrEqual(2);
    expect(state.tabs.get(1)?.url).toBe(sourceUrl);
    expect(currentShop).toEqual({ id: "10001", name: "甲食品旗舰店" });
  });

  it("waits past a stale pre-switch identity until the requested shop is visible", async () => {
    const sourceUrl = "https://fxg.jinritemai.com/ffa/g/list";
    installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: sourceUrl
      }],
      () => undefined
    );
    let currentShop = { id: "10001", name: "甲食品旗舰店" };
    let pendingShop: typeof currentShop | undefined;
    let staleReads = 0;
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: typeof shop };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            currentShop,
            shops: [
              {
                name: "甲食品旗舰店",
                status: "active",
                statusText: "正常营业"
              },
              {
                name: "乙食品专营店",
                status: "active",
                statusText: "正常营业"
              }
            ]
          }
        };
      }
      if (stage === "switch-shop") {
        const requested = message.request?.shop;
        pendingShop = requested?.name === "乙食品专营店"
          ? { id: "10002", name: requested.name }
          : { id: "10001", name: "甲食品旗舰店" };
        return {
          ok: false,
          requestId: message.requestId,
          error: {
            code: "SHOP_IDENTITY_UNCERTAIN",
            message: "Navigation started."
          }
        };
      }
      if (stage === "read-shop-context") {
        if (pendingShop && staleReads++ > 0) {
          currentShop = pendingShop;
          pendingShop = undefined;
        }
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, currentShop }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).resolves.toMatchObject({
      shops: [
        { id: "10001", name: "甲食品旗舰店" },
        { id: "10002", name: "乙食品专营店" }
      ]
    });
    expect(staleReads).toBeGreaterThanOrEqual(3);
    expect(currentShop).toEqual({ id: "10001", name: "甲食品旗舰店" });
  });

  it("rejects before a tab-opening stage when no managed slot is available", async () => {
    const state = installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        }
      ],
      () => undefined
    );
    const releaseManagedTabReservation = vi.fn();
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      reserveManagedTab: () => false,
      releaseManagedTabReservation
    });

    await expect(driver.openPromotion(shop)).rejects.toMatchObject({
      code: "BROWSER_TAB_CAPACITY_EXCEEDED"
    });
    expect(releaseManagedTabReservation).not.toHaveBeenCalled();
    expect(
      state.sentMessages.some(
        (message) => message.type === "bpa.doudian.alliance.stage"
      )
    ).toBe(false);
  });

  it("reuses an existing Buyin tab without claiming or closing it", async () => {
    const state = installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        },
        {
          id: 2,
          windowId: 10,
          active: false,
          status: "complete",
          url: "https://buyin.jinritemai.com/dashboard"
        }
      ],
      (stage, tabs) => {
        if (stage === "open-promotion") {
          tabs.set(1, { ...tabs.get(1)!, active: false });
          tabs.set(2, { ...tabs.get(2)!, active: true });
        }
        if (stage === "open-product-promotion") {
          tabs.set(2, {
            ...tabs.get(2)!,
            url: "https://buyin.jinritemai.com/dashboard/product/promote-manage"
          });
        }
        if (stage === "open-retired-products") {
          tabs.set(2, {
            ...tabs.get(2)!,
            url: "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
          });
        }
      }
    );
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });
    await driver.discoverShops();
    await driver.openPromotion(shop);
    await driver.openRetiredProducts(shop);
    await driver.collectRetiredProducts(shop);
    await driver.cleanupShopTabs();
    expect(state.tabs.has(2)).toBe(true);
    expect(state.removed).toEqual([]);
  });

  it("owns and closes an attributed new Buyin tab without an opener", async () => {
    const state = installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        }
      ],
      (stage, tabs) => {
        if (stage === "open-promotion") {
          tabs.set(1, { ...tabs.get(1)!, active: false });
          tabs.set(2, {
            id: 2,
            windowId: 10,
            active: true,
            status: "complete",
            url: "https://buyin.jinritemai.com/dashboard"
          });
        }
        if (stage === "open-product-promotion") {
          tabs.set(2, {
            ...tabs.get(2)!,
            url: "https://buyin.jinritemai.com/dashboard/product/promote-manage"
          });
        }
        if (stage === "open-retired-products") {
          tabs.set(2, {
            ...tabs.get(2)!,
            url: "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
          });
        }
      }
    );
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await driver.discoverShops();
    await driver.openPromotion(shop);
    await driver.openRetiredProducts(shop);
    await driver.collectRetiredProducts(shop);
    await driver.cleanupShopTabs();

    expect(state.tabs.has(2)).toBe(false);
    expect(state.removed).toEqual([[2]]);
  });

  it("returns a precise timeout when an injected stage never answers", async () => {
    const state = installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      }],
      () => undefined
    );
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: { type: string; requestId?: string }
    ) =>
      message.type === "bpa.risk.preflight"
        ? originalSendMessage(tabId, message)
        : message.type === "bpa.doudian.alliance.cancel-stage"
          ? originalSendMessage(tabId, message)
          : (void originalSendMessage(tabId, message),
            new Promise(() => undefined))) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      stageResponseTimeoutMs: 10
    });
    await expect(driver.discoverShops()).rejects.toMatchObject({
      code: "ALLIANCE_CONTENT_RESPONSE_TIMEOUT"
    });
    const stageMessage = state.sentMessages.find(
      (message) => message.type === "bpa.doudian.alliance.stage"
    );
    expect(stageMessage?.requestId).toEqual(expect.any(String));
    expect(state.sentMessages).toContainEqual({
      type: "bpa.doudian.alliance.cancel-stage",
      requestId: stageMessage?.requestId
    });
  });

  it("reports the deidentified discovery stage when a configured shop cannot switch", async () => {
    installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      }],
      () => undefined
    );
    const discovered = [
      "甲食品旗舰店",
      "乙食品专营店",
      "丙食品专卖店",
      "丁食品旗舰店"
    ].map((name) => ({
      name,
      status: "active" as const,
      statusText: "正常营业"
    }));
    let currentShop = { id: "10001", name: discovered[0]!.name };
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: (typeof discovered)[number] };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, shops: discovered, currentShop }
        };
      }
      if (stage === "switch-shop") {
        const requested = message.request?.shop;
        const index = discovered.findIndex(
          (candidate) => candidate.name === requested?.name
        );
        if (index === 3) {
          return {
            ok: false,
            requestId: message.requestId,
            error: {
              code: "SHOP_SWITCH_NOT_CONFIRMED",
              message: "The switch action was not confirmed."
            }
          };
        }
        currentShop = {
          id: String(10001 + index),
          name: requested!.name
        };
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            shopName: currentShop.name,
            currentShop
          }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).rejects.toMatchObject({
      code: "SHOP_SWITCH_NOT_CONFIRMED",
      diagnostic: {
        phase: "resolve-shop",
        shopOrdinal: 4,
        switchResponse: "failed",
        navigationIdentity: "not-required",
        restoreResult: "succeeded"
      }
    });
  });

  it("does not repeat a source-shop click when a failed switch left the source identity intact", async () => {
    installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      }],
      () => undefined
    );
    const sourceShop = {
      name: "甲食品旗舰店",
      status: "active" as const,
      statusText: "正常营业"
    };
    const targetShop = {
      name: "乙食品专营店",
      status: "active" as const,
      statusText: "正常营业"
    };
    const currentShop = { id: "10001", name: sourceShop.name };
    const switchRequests: string[] = [];
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string; shop?: typeof sourceShop };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      const stage = message.request?.stage;
      if (stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage,
            currentShop,
            shops: [sourceShop, targetShop]
          }
        };
      }
      if (stage === "switch-shop") {
        switchRequests.push(message.request!.shop!.name);
        return {
          ok: false,
          requestId: message.requestId,
          error: {
            code: "SHOP_SWITCH_NOT_CONFIRMED",
            message: "The switch action was not confirmed."
          }
        };
      }
      if (stage === "read-shop-context") {
        return {
          ok: true,
          requestId: message.requestId,
          result: { stage, currentShop }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).rejects.toMatchObject({
      code: "SHOP_SWITCH_NOT_CONFIRMED",
      diagnostic: {
        phase: "resolve-shop",
        shopOrdinal: 2,
        restoreResult: "succeeded"
      }
    });
    expect(switchRequests).toEqual([targetShop.name]);
  });

  it("preserves switch, navigation, and restore error codes in discovery diagnostics", async () => {
    installBrowser(
      [{
        id: 1,
        windowId: 10,
        active: true,
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      }],
      () => undefined
    );
    const sourceShop = {
      name: "甲食品旗舰店",
      status: "active" as const,
      statusText: "正常营业"
    };
    const targetShop = {
      name: "乙食品专营店",
      status: "active" as const,
      statusText: "正常营业"
    };
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (message.type !== "bpa.doudian.alliance.stage") {
        return originalSendMessage(tabId, message);
      }
      if (message.request?.stage === "discover-shops") {
        return {
          ok: true,
          requestId: message.requestId,
          result: {
            stage: "discover-shops",
            currentShop: { id: "10001", name: sourceShop.name },
            shops: [sourceShop, targetShop]
          }
        };
      }
      return {
        ok: false,
        requestId: message.requestId,
        error: { code: "PAGE_LOADING", message: "Page is loading." }
      };
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 2_000).toISOString(),
      shopIdentityWaitMs: 5
    });

    await expect(driver.discoverShopContext()).rejects.toMatchObject({
      code: "SHOP_CONTEXT_RESTORE_FAILED",
      diagnostic: {
        phase: "resolve-shop",
        shopOrdinal: 2,
        switchErrorCode: "PAGE_LOADING",
        navigationErrorCode: "PAGE_LOADING",
        restoreErrorCode: "PAGE_LOADING"
      }
    });
  });

  it("maps a rejected source-tab read to BROWSER_DISCONNECTED", async () => {
    installBrowser([], () => undefined);
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 404,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).rejects.toMatchObject({
      code: "BROWSER_DISCONNECTED"
    });
  });

  it("reports an initial source identity failure before any shop switch", async () => {
    installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        }
      ],
      () => undefined
    );
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: {
        type: string;
        requestId?: string;
        request?: { stage?: string };
      }
    ) => {
      if (message.type === "bpa.risk.preflight") {
        return { riskSignals: [] };
      }
      if (
        message.type === "bpa.doudian.alliance.stage" &&
        message.request?.stage === "discover-shops"
      ) {
        return {
          ok: false,
          requestId: message.requestId,
          error: {
            code: "SHOP_IDENTITY_UNCERTAIN",
            message: "The current shop identity is unavailable."
          }
        };
      }
      return originalSendMessage(tabId, message);
    }) as typeof browser.tabs.sendMessage;
    const driver = createAllianceRetiredBrowserDriver({
      sourceTabId: 1,
      deadline: new Date(Date.now() + 10_000).toISOString()
    });

    await expect(driver.discoverShopContext()).rejects.toMatchObject({
      code: "SHOP_IDENTITY_UNCERTAIN",
      diagnostic: {
        phase: "discover-source",
        switchResponse: "not-started",
        navigationIdentity: "unavailable",
        restoreResult: "not-required"
      }
    });
  });

  it("does not confirm an active Core cancellation with a mismatched request id ack", async () => {
    installBrowser(
      [
        {
          id: 1,
          windowId: 10,
          active: true,
          status: "complete",
          url: "https://fxg.jinritemai.com/ffa/g/list"
        }
      ],
      () => undefined
    );
    const originalSendMessage = browser.tabs.sendMessage;
    browser.tabs.sendMessage = (async (
      tabId: number,
      message: { type: string; requestId?: string }
    ) =>
      message.type === "bpa.doudian.alliance.cancel-stage"
        ? { ok: true, requestId: "stale-request", stopped: true }
        : originalSendMessage(tabId, message)) as typeof browser.tabs.sendMessage;

    await expect(
      requestAllianceStageCancellation(1, "active-request")
    ).resolves.toBe(false);
  });
});
