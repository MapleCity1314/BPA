import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeRegisteredAdapterNode } from "./adapter-node-registry.js";

const driver = vi.hoisted(() => ({
  discoverShopContext: vi.fn(),
  discoverShops: vi.fn(),
  switchShop: vi.fn(),
  openPromotion: vi.fn(),
  openRetiredProducts: vi.fn(),
  collectRetiredProducts: vi.fn(),
  cleanupShopTabs: vi.fn()
}));

const experienceDriver = vi.hoisted(() => ({
  discoverShopContext: vi.fn(),
  collectShop: vi.fn()
}));

vi.mock("./alliance-retired-background.js", () => ({
  AllianceRetiredDriverError: class AllianceRetiredDriverError extends Error {
    readonly riskSignals = [];
  },
  createAllianceRetiredBrowserDriver: () => driver
}));

vi.mock("./experience-score-background.js", () => ({
  createExperienceScoreBrowserDriver: () => experienceDriver
}));

const context = {
  sourceTabId: 42,
  deadline: "2026-07-31T23:00:00.000Z"
};

describe("Adapter Node registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driver.switchShop.mockResolvedValue(undefined);
    driver.openPromotion.mockResolvedValue(undefined);
    driver.openRetiredProducts.mockResolvedValue(undefined);
    driver.cleanupShopTabs.mockResolvedValue(undefined);
    experienceDriver.collectShop.mockReset();
    experienceDriver.discoverShopContext.mockReset();
  });

  it("aggregates complete, no-score and failed experience shop outcomes", async () => {
    const result = await executeRegisteredAdapterNode(
      "doudian.experience.daily.aggregate",
      {
        foreachOutcome: {
          total: 3,
          succeeded: {
            count: 2,
            items: [
              { output: { status: "complete", shop: { id: "1" } } },
              { output: { status: "no_score", shop: { id: "2" } } }
            ]
          },
          failed: { count: 1, items: [{ itemKey: "id:3" }] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(result).toMatchObject({
      ok: true,
      output: {
        status: "partial",
        discoveredCount: 3,
        persistedCount: 2,
        failedCount: 1
      }
    });
  });

  it("returns undefined for an unregistered Node without platform branching", async () => {
    await expect(
      executeRegisteredAdapterNode("fictional.site.read", {}, context)
    ).resolves.toBeUndefined();
  });

  it("classifies complete empty, complete items and partial foreach outcomes", async () => {
    const empty = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 1,
          succeeded: {
            count: 1,
            items: [
              {
                itemKey: "id:1",
                output: {
                  shop: { key: "id:1", name: "店铺一" },
                  status: "complete",
                  retiredCount: 0,
                  products: []
                }
              }
            ]
          },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(empty).toMatchObject({
      ok: true,
      output: {
        status: "complete_empty",
        retiredProductCount: 0,
        scannedShopCount: 1
      }
    });

    const withItems = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 1,
          succeeded: {
            count: 1,
            items: [
              {
                itemKey: "id:1",
                output: {
                  shop: { key: "id:1", name: "店铺一" },
                  status: "complete",
                  retiredCount: 2,
                  products: [{}, {}]
                }
              }
            ]
          },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(withItems).toMatchObject({
      output: {
        status: "complete_with_items",
        retiredProductCount: 2,
        affectedShopCount: 1
      }
    });

    const partial = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 2,
          succeeded: { count: 1, items: [{ itemKey: "id:1", output: {} }] },
          failed: { count: 1, items: [{ itemKey: "id:2" }] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(partial).toMatchObject({
      output: { status: "partial", failedShopCount: 1 }
    });
  });

  it("reports source-shop restoration failure ahead of an earlier scan error", async () => {
    driver.openPromotion.mockRejectedValueOnce(new Error("PAGE_MISMATCH"));
    driver.cleanupShopTabs.mockRejectedValueOnce(
      new Error("ALLIANCE_TAB_TIMEOUT")
    );

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      {
        shop: {
          id: "12345",
          name: "目标店铺",
          status: "active",
          statusText: "正常营业"
        },
        sourceShop: {
          id: "67890",
          name: "源店铺",
          status: "active",
          statusText: "正常营业"
        }
      },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SHOP_CONTEXT_RESTORE_FAILED",
        retryable: false
      },
      riskSignals: [
        {
          severity: "blocking",
          category: "page_context"
        }
      ]
    });
  });
});
