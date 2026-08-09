import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
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

const MockExperienceScoreDriverError = vi.hoisted(
  () =>
    class MockExperienceScoreDriverError extends Error {
      readonly riskSignals = [];

      constructor(
        readonly code: string,
        readonly detail?: Readonly<Record<string, string>>
      ) {
        super(`safe:${code}`);
      }
    }
);

vi.mock("./alliance-retired-background.js", () => ({
  AllianceRetiredDriverError: class AllianceRetiredDriverError extends Error {
    readonly riskSignals = [];
  },
  createAllianceRetiredBrowserDriver: () => driver
}));

vi.mock("./experience-score-background.js", () => ({
  ExperienceScoreDriverError: MockExperienceScoreDriverError,
  createExperienceScoreBrowserDriver: () => experienceDriver
}));

const context = {
  sourceTabId: 42,
  deadline: "2026-07-31T23:00:00.000Z"
};

const sourceShop = {
  id: "12345678",
  name: "源食品旗舰店",
  status: "active",
  statusText: "正常营业"
};

const targetShop = {
  id: "87654321",
  name: "目标食品旗舰店",
  status: "active",
  statusText: "正常营业"
};

const noScoreSnapshot = {
  status: "no_score",
  observedAt: "2026-08-09T05:00:00.000Z",
  sourceUpdatedAt: null,
  shop: { id: targetShop.id, name: targetShop.name },
  summary: {
    totalScore: null,
    totalScoreRaw: null,
    level: null,
    industry: null,
    orders30d: 8,
    orders30dRaw: "8"
  },
  dimensions: [],
  evidence: {
    pageUrl: "https://fxg.jinritemai.com/ffa/eco/experience-score",
    capturedAt: "2026-08-09T05:00:00.000Z",
    structuredSnapshotRef: "inline:test"
  },
  diagnostics: ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"],
  formMutations: 0
};

function declaredNodeErrors(fileName: string): Set<string> {
  const definition = parseWorkflowYaml(
    readFileSync(
      new URL(`../../../../nodes/core/${fileName}`, import.meta.url),
      "utf8"
    )
  ) as { errors: string[] };
  return new Set(definition.errors);
}

const discoveryDriverCodes = [
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED",
  "DOUDIAN_EXPERIENCE_MAX_SHOPS_INVALID",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_LIMIT_EXCEEDED",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE"
] as const;

const readDriverCodes = [
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT",
  "EXPERIENCE_DIMENSION_INCOMPLETE",
  "EXPERIENCE_PAGE_TIMEOUT",
  "EXPERIENCE_SNAPSHOT_MISSING",
  "EXPERIENCE_STAGE_FAILED",
  "EXPERIENCE_TOTAL_SCORE_MISSING",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN"
] as const;

const discoveryRetryableCodes = new Set([
  "BROWSER_DISCONNECTED",
  "PAGE_LOADING"
]);

const readRetryableCodes = new Set([
  "BROWSER_DISCONNECTED",
  "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT",
  "EXPERIENCE_PAGE_TIMEOUT",
  "PAGE_LOADING"
]);

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

  it("fails discovery when an active shop lacks a stable numeric id", async () => {
    experienceDriver.discoverShopContext.mockResolvedValue({
      currentShopName: "无ID店铺",
      shops: [
        {
          name: "无ID店铺",
          status: "active",
          statusText: "正常营业"
        },
        targetShop
      ]
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.experience.shops.discover",
      { maxShops: 100 },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SHOP_IDENTITY_UNCERTAIN", retryable: false }
    });
  });

  it("keeps an originally blocked id-less shop as a skipped discovery item", async () => {
    experienceDriver.discoverShopContext.mockResolvedValue({
      currentShopName: sourceShop.name,
      shops: [
        sourceShop,
        {
          name: "已停业店铺",
          status: "blocked",
          statusText: "已停业"
        }
      ]
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.experience.shops.discover",
      { maxShops: 100 },
      context
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        discoveredCount: 2,
        collectableCount: 1,
        diagnostics: [],
        shops: [
          { key: `id:${sourceShop.id}`, status: "active" },
          {
            key: "name:已停业店铺",
            status: "blocked",
            statusText: "已停业"
          }
        ]
      }
    });
  });

  it("fails closed when an active read target lacks a numeric id", async () => {
    const result = await executeRegisteredAdapterNode(
      "doudian.experience.shop.snapshot.read",
      {
        shop: {
          name: "无ID店铺",
          status: "active",
          statusText: "正常营业"
        },
        sourceShop
      },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SHOP_IDENTITY_UNCERTAIN", retryable: false }
    });
    expect(experienceDriver.collectShop).not.toHaveBeenCalled();
  });

  it.each(discoveryDriverCodes)(
    "keeps discovery handler code %s inside the published Node contract",
    async (code) => {
      experienceDriver.discoverShopContext.mockRejectedValueOnce(
        new MockExperienceScoreDriverError(code)
      );
      const result = await executeRegisteredAdapterNode(
        "doudian.experience.shops.discover",
        { maxShops: 100 },
        context
      );

      expect(result?.error?.code).toBe(code);
      expect(result?.error?.retryable).toBe(discoveryRetryableCodes.has(code));
      expect(
        declaredNodeErrors("doudian.experience.shops.discover.node.yaml")
      ).toContain(code);
    }
  );

  it.each(readDriverCodes)(
    "keeps snapshot handler code %s inside the published Node contract",
    async (code) => {
      experienceDriver.collectShop.mockRejectedValueOnce(
        new MockExperienceScoreDriverError(code)
      );
      const result = await executeRegisteredAdapterNode(
        "doudian.experience.shop.snapshot.read",
        { shop: targetShop, sourceShop },
        context
      );

      expect(result?.error?.code).toBe(code);
      expect(result?.error?.retryable).toBe(readRetryableCodes.has(code));
      expect(
        declaredNodeErrors("doudian.experience.shop.snapshot.read.node.yaml")
      ).toContain(code);
    }
  );

  it("surfaces PAGE_LOADING as retryable and succeeds on the next invocation", async () => {
    experienceDriver.collectShop
      .mockRejectedValueOnce(new MockExperienceScoreDriverError("PAGE_LOADING"))
      .mockResolvedValueOnce(noScoreSnapshot);

    const first = await executeRegisteredAdapterNode(
      "doudian.experience.shop.snapshot.read",
      { shop: targetShop, sourceShop },
      context
    );
    const second = await executeRegisteredAdapterNode(
      "doudian.experience.shop.snapshot.read",
      { shop: targetShop, sourceShop },
      context
    );

    expect(first).toMatchObject({
      ok: false,
      error: { code: "PAGE_LOADING", retryable: true }
    });
    expect(second).toMatchObject({ ok: true, output: { status: "no_score" } });
  });

  it("never promotes an arbitrary driver Error message to a Node error code", async () => {
    experienceDriver.discoverShopContext.mockRejectedValueOnce(
      new Error("secret discovery transport text")
    );
    experienceDriver.collectShop.mockRejectedValueOnce(
      new Error("secret snapshot transport text")
    );

    const discovery = await executeRegisteredAdapterNode(
      "doudian.experience.shops.discover",
      { maxShops: 100 },
      context
    );
    const snapshot = await executeRegisteredAdapterNode(
      "doudian.experience.shop.snapshot.read",
      { shop: targetShop, sourceShop },
      context
    );

    expect(discovery?.error).toMatchObject({
      code: "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED",
      message: "safe:DOUDIAN_EXPERIENCE_DISCOVERY_FAILED"
    });
    expect(snapshot?.error).toMatchObject({
      code: "EXPERIENCE_STAGE_FAILED",
      message: "safe:EXPERIENCE_STAGE_FAILED"
    });
  });
});
