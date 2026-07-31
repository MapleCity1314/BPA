import { afterEach, describe, expect, it, vi } from "vitest";
import { createAllianceRetiredBrowserDriver } from "./alliance-retired-background.js";

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
          request?: { stage?: string };
        }
      ) {
        if (message.type === "bpa.risk.preflight") {
          return { riskSignals: [] };
        }
        const stage = String(message.request?.stage);
        navigate(stage, tabs);
        if (stage === "discover-shops") {
          return {
            ok: true,
            result: {
              stage,
              shops: [shop],
              currentShopName: shop.name
            }
          };
        }
        if (stage === "collect-retired-products") {
          return {
            ok: true,
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
        return { ok: true, result: { stage, dismissedDialogs: 0 } };
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
  return { tabs, removed };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alliance retired-products browser navigation", () => {
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
});
