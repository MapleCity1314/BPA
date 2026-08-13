import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adapterNodeCommandResultStatus,
  commandResultPayloadBytes,
  enforceCommandResultPayloadBound,
  executeRegisteredAdapterNode
} from "./adapter-node-registry.js";
import { MAX_COMMAND_RESULT_PAYLOAD_BYTES } from "./adapter-node-registry.js";
import { AllianceRetiredDriverError } from "./alliance-retired-background.js";

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

    constructor(
      readonly code: string,
      _riskSignals: readonly unknown[] = [],
      readonly diagnostic?: {
        readonly phase: string;
        readonly shopOrdinal?: number;
        readonly switchResponse: string;
        readonly navigationIdentity: string;
        readonly restoreResult: string;
      }
    ) {
      super(
        diagnostic
          ? `safe:${code} [phase=${diagnostic.phase};` +
              `${diagnostic.shopOrdinal === undefined ? "" : `shop_ordinal=${diagnostic.shopOrdinal};`}` +
              `switch_response=${diagnostic.switchResponse};` +
              `navigation_identity=${diagnostic.navigationIdentity};` +
              `restore_result=${diagnostic.restoreResult}]`
          : `safe:${code}`
      );
    }
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
  "COMMAND_RESULT_TOO_LARGE",
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
  "COMMAND_RESULT_TOO_LARGE",
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

const allianceDiscoveryDriverCodes = [
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_RESULT_TOO_LARGE",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
  "DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_LIMIT_EXCEEDED",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE"
] as const;

const allianceScanDriverCodes = [
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "ALLIANCE_SOURCE_TAB_MISSING",
  "ALLIANCE_STAGE_FAILED",
  "ALLIANCE_TAB_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_RESULT_TOO_LARGE",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "PROMOTION_DIALOG_CLOSE_AMBIGUOUS",
  "PROMOTION_DIALOG_UNRECOGNIZED",
  "PROMOTION_TAB_MISSING",
  "RETIRED_PRODUCT_LIMIT_EXCEEDED",
  "RETIRED_PRODUCT_ROW_CHANGED",
  "RETIRED_PRODUCTS_MISSING",
  "RETIRED_PRODUCTS_PAGE_LIMIT_EXCEEDED",
  "RETIRED_PRODUCTS_TABLE_CHANGED",
  "RETIRED_TAB_MISSING",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_TARGET_INVALID"
] as const;

const allianceRetryableCodes = new Set([
  "PAGE_LOADING",
  "BROWSER_DISCONNECTED",
  "ALLIANCE_TAB_TIMEOUT"
]);

describe("Adapter Node registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driver.switchShop.mockResolvedValue(undefined);
    driver.openPromotion.mockResolvedValue(undefined);
    driver.openRetiredProducts.mockResolvedValue(undefined);
    driver.cleanupShopTabs.mockResolvedValue(undefined);
    driver.collectRetiredProducts.mockReset();
    experienceDriver.collectShop.mockReset();
    experienceDriver.discoverShopContext.mockReset();
  });

  it("returns undefined for an unregistered Node without platform branching", async () => {
    await expect(
      executeRegisteredAdapterNode("fictional.site.read", {}, context)
    ).resolves.toBeUndefined();
  });

  it("does not retain the browser aggregate v1 execution path", async () => {
    await expect(
      executeRegisteredAdapterNode(
        "doudian.alliance.retired-products.aggregate",
        {},
        context
      )
    ).resolves.toBeUndefined();
  });

  it("activates an exact inventory shop without opening another browser", async () => {
    const result = await executeRegisteredAdapterNode(
      "doudian.inventory.shop.activate",
      { targetShop: { id: targetShop.id, name: targetShop.name } },
      context
    );

    expect(driver.switchShop).toHaveBeenCalledWith({
      id: targetShop.id,
      name: targetShop.name,
      status: "active",
      statusText: "active"
    });
    expect(result).toMatchObject({
      ok: true,
      output: {
        status: "complete",
        currentShop: { id: targetShop.id, name: targetShop.name }
      }
    });
    expect(driver.cleanupShopTabs).toHaveBeenCalledOnce();
  });

  it("rejects an inventory shop target without a stable numeric id", async () => {
    const result = await executeRegisteredAdapterNode(
      "doudian.inventory.shop.activate",
      { targetShop: { id: "name-only", name: targetShop.name } },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SHOP_TARGET_INVALID", retryable: false }
    });
    expect(driver.switchShop).not.toHaveBeenCalled();
  });

  it("fails closed when inventory shop activation is not confirmed", async () => {
    driver.switchShop.mockRejectedValueOnce(
      new AllianceRetiredDriverError("SHOP_IDENTITY_MISMATCH")
    );

    const result = await executeRegisteredAdapterNode(
      "doudian.inventory.shop.activate",
      { targetShop: { id: targetShop.id, name: targetShop.name } },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SHOP_IDENTITY_MISMATCH", retryable: false }
    });
    expect(driver.cleanupShopTabs).toHaveBeenCalledOnce();
  });

  it("fails alliance discovery when an active shop lacks a stable numeric id", async () => {
    driver.discoverShopContext.mockResolvedValue({
      currentShop: { id: "10001", name: "无ID店铺" },
      shops: [
        { name: "无ID店铺", status: "active", statusText: "正常营业" }
      ]
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shops.discover",
      { maxShops: 100 },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SHOP_IDENTITY_UNCERTAIN", retryable: false }
    });
  });

  it("keeps an id-less blocked alliance shop and skips its scan", async () => {
    driver.discoverShopContext.mockResolvedValue({
      currentShop: { id: sourceShop.id!, name: sourceShop.name },
      shops: [
        sourceShop,
        { name: "已停业店铺", status: "blocked", statusText: "已停业" }
      ]
    });
    const discovery = await executeRegisteredAdapterNode(
      "doudian.alliance.shops.discover",
      { maxShops: 100 },
      context
    );
    const scan = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      {
        shop: {
          name: "已停业店铺",
          status: "blocked",
          statusText: "已停业"
        },
        sourceShop
      },
      context
    );

    expect(discovery).toMatchObject({
      ok: true,
      output: {
        status: "complete",
        discoveredCount: 2,
        collectableCount: 1,
        shops: [
          { key: `id:${sourceShop.id}`, status: "active" },
          { key: "name:已停业店铺", status: "blocked" }
        ]
      }
    });
    expect(scan).toMatchObject({
      ok: true,
      output: {
        shop: { key: "name:已停业店铺" },
        status: "skipped",
        retiredCount: 0,
        products: [],
        diagnostics: ["SHOP_NOT_ACTIVE"]
      }
    });
    expect(driver.switchShop).not.toHaveBeenCalled();
  });

  it("returns the complete v2 retired-products evidence shape", async () => {
    driver.collectRetiredProducts.mockResolvedValue({
      shop: { id: targetShop.id, name: targetShop.name },
      updatedAt: undefined,
      empty: true,
      products: []
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      { shop: targetShop, sourceShop },
      context
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        shop: { id: targetShop.id, key: `id:${targetShop.id}` },
        status: "complete",
        retiredCount: 0,
        updatedAt: null,
        products: [],
        evidence: {
          pageUrl:
            "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
        },
        diagnostics: []
      }
    });
    expect(result?.output?.observedAt).toEqual(expect.any(String));
    expect(result?.output?.evidence).toMatchObject({
      capturedAt: result?.output?.observedAt
    });
  });

  it("keeps the maximum 50-product Node output below the command envelope limit", async () => {
    const product = {
      treatmentId: "T".repeat(100),
      productId: "9".repeat(30),
      title: "商".repeat(500),
      status: "已".repeat(100),
      processedAt: "时".repeat(100),
      reason: "因".repeat(1000)
    };
    driver.collectRetiredProducts.mockResolvedValue({
      shop: { id: targetShop.id, name: targetShop.name },
      updatedAt: "更".repeat(100),
      empty: false,
      products: Array.from({ length: 50 }, () => ({ ...product }))
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      { shop: targetShop, sourceShop },
      context
    );

    expect(result).toMatchObject({
      ok: true,
      output: { retiredCount: 50 }
    });
    expect(commandResultPayloadBytes(result)).toBeLessThan(512 * 1024);
    expect(commandResultPayloadBytes(result)).toBeLessThan(
      MAX_COMMAND_RESULT_PAYLOAD_BYTES
    );
  });

  it("fails closed instead of truncating a page above 50 products", async () => {
    driver.collectRetiredProducts.mockResolvedValue({
      shop: { id: targetShop.id, name: targetShop.name },
      empty: false,
      products: Array.from({ length: 51 }, (_, index) => ({
        treatmentId: `T-${index}`,
        title: "商品",
        status: "已清退",
        processedAt: "2026/08/09",
        reason: "原因"
      }))
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      { shop: targetShop, sourceShop },
      context
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RETIRED_PRODUCT_LIMIT_EXCEEDED",
        retryable: false
      }
    });
    expect(result?.output).toBeUndefined();
  });

  it("replaces an oversized UTF-8 command payload with a static bounded error", () => {
    const base = {
      command_seq: 1,
      command_id: "command-1",
      node_execution_id: "node-1",
      idempotency_key: "key-1",
      fencing_token: 1,
      status: "succeeded",
      timing_observation: {},
      evidence_refs: [],
      page_epoch: "tab-1:1:nonce"
    };
    let low = 0;
    let high = MAX_COMMAND_RESULT_PAYLOAD_BYTES;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = { ...base, output: { value: "界".repeat(middle) } };
      if (commandResultPayloadBytes(candidate) <= MAX_COMMAND_RESULT_PAYLOAD_BYTES) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const below = { ...base, output: { value: "界".repeat(low) } };
    const above = { ...base, output: { value: "界".repeat(high) } };

    expect(commandResultPayloadBytes(below)).toBeLessThanOrEqual(
      MAX_COMMAND_RESULT_PAYLOAD_BYTES
    );
    expect(enforceCommandResultPayloadBound(below)).toBe(below);
    expect(commandResultPayloadBytes(above)).toBeGreaterThan(
      MAX_COMMAND_RESULT_PAYLOAD_BYTES
    );
    expect(enforceCommandResultPayloadBound(above)).toEqual({
      ...base,
      status: "failed",
      error: {
        code: "COMMAND_RESULT_TOO_LARGE",
        message: "Command result exceeded the protocol payload limit.",
        retryable: false
      }
    });
  });

  it.each(allianceDiscoveryDriverCodes)(
    "keeps alliance discovery code %s inside its Node contract",
    async (code) => {
      driver.discoverShopContext.mockRejectedValueOnce(
        new AllianceRetiredDriverError(code)
      );
      const result = await executeRegisteredAdapterNode(
        "doudian.alliance.shops.discover",
        { maxShops: 100 },
        context
      );
      expect(result?.error?.code).toBe(code);
      expect(result?.error?.retryable).toBe(allianceRetryableCodes.has(code));
      expect(
        declaredNodeErrors("doudian.alliance.shops.discover.node.yaml")
      ).toContain(code);
    }
  );

  it.each(allianceScanDriverCodes)(
    "keeps alliance scan code %s inside its Node contract",
    async (code) => {
      driver.openPromotion.mockRejectedValueOnce(
        new AllianceRetiredDriverError(code)
      );
      const result = await executeRegisteredAdapterNode(
        "doudian.alliance.shop.retired-products.scan",
        { shop: targetShop, sourceShop },
        context
      );
      expect(result?.error?.code).toBe(code);
      expect(result?.error?.retryable).toBe(allianceRetryableCodes.has(code));
      expect(
        declaredNodeErrors(
          "doudian.alliance.shop.retired-products.scan.node.yaml"
        )
      ).toContain(code);
    }
  );

  it("maps a content response timeout to a non-retryable uncertain command result", async () => {
    driver.openPromotion.mockRejectedValueOnce(
      new AllianceRetiredDriverError("ALLIANCE_CONTENT_RESPONSE_TIMEOUT")
    );
    const response = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      { shop: targetShop, sourceShop },
      context
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
        retryable: false
      }
    });
    expect(adapterNodeCommandResultStatus(response!)).toBe("uncertain");
  });

  it("never promotes arbitrary alliance driver text to a Node error code", async () => {
    driver.discoverShopContext.mockRejectedValueOnce(
      new Error("secret discovery transport text")
    );
    driver.openPromotion.mockRejectedValueOnce(
      new Error("secret scan transport text")
    );

    const discovery = await executeRegisteredAdapterNode(
      "doudian.alliance.shops.discover",
      { maxShops: 100 },
      context
    );
    const scan = await executeRegisteredAdapterNode(
      "doudian.alliance.shop.retired-products.scan",
      { shop: targetShop, sourceShop },
      context
    );

    expect(discovery?.error).toMatchObject({
      code: "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
      message: "safe:DOUDIAN_ALLIANCE_DISCOVERY_FAILED"
    });
    expect(scan?.error).toMatchObject({
      code: "ALLIANCE_STAGE_FAILED",
      message: "safe:ALLIANCE_STAGE_FAILED"
    });
  });

  it("reports the ordinal of an unresolved discovery identity without exposing shop data", async () => {
    driver.discoverShopContext.mockResolvedValueOnce({
      currentShop: { id: "10001", name: "甲食品旗舰店" },
      shops: [
        {
          id: "10001",
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
    });

    const result = await executeRegisteredAdapterNode(
      "doudian.alliance.shops.discover",
      { maxShops: 100 },
      context
    );

    expect(result?.error).toEqual({
      code: "SHOP_IDENTITY_UNCERTAIN",
      message:
        "safe:SHOP_IDENTITY_UNCERTAIN " +
        "[phase=resolve-shop;shop_ordinal=2;switch_response=not-started;" +
        "navigation_identity=unavailable;restore_result=not-required]",
      retryable: false
    });
    expect(result?.error?.message).not.toContain("甲食品旗舰店");
    expect(result?.error?.message).not.toContain("乙食品专营店");
    expect(result?.error?.message).not.toContain("10001");
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
