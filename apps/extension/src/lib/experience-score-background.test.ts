import { beforeEach, describe, expect, it, vi } from "vitest";

const shopDriver = vi.hoisted(() => ({
  discoverShopContext: vi.fn(),
  switchShop: vi.fn(),
  cleanupShopTabs: vi.fn()
}));

vi.mock("./alliance-retired-background.js", () => ({
  AllianceRetiredDriverError: class AllianceRetiredDriverError extends Error {
    constructor(readonly code: string, readonly riskSignals = []) {
      super(code);
    }
  },
  createAllianceRetiredBrowserDriver: () => shopDriver
}));

import {
  createExperienceScoreBrowserDriver,
  ExperienceScoreDriverError
} from "./experience-score-background.js";

const sourceShop = {
  id: "12345678",
  name: "源食品旗舰店",
  status: "active" as const,
  statusText: "正常营业"
};
const targetShop = {
  id: "87654321",
  name: "目标食品旗舰店",
  status: "active" as const,
  statusText: "正常营业"
};

describe("experience-score single-tab browser driver", () => {
  const get = vi.fn();
  const update = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    shopDriver.switchShop.mockResolvedValue(undefined);
    shopDriver.cleanupShopTabs.mockResolvedValue(undefined);
    get
      .mockResolvedValueOnce({
        id: 42,
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      })
      .mockResolvedValue({ id: 42, status: "complete" });
    update.mockResolvedValue({ id: 42, status: "loading" });
    sendMessage
      .mockResolvedValueOnce({ riskSignals: [] })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          stage: "collect-snapshot",
          snapshot: {
            status: "no_score",
            observedAt: "2026-08-07T05:00:00.000Z",
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
              capturedAt: "2026-08-07T05:00:00.000Z",
              structuredSnapshotRef: "inline:test"
            },
            diagnostics: ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"],
            formMutations: 0
          }
        }
      });
    vi.stubGlobal("browser", {
      tabs: { get, update, sendMessage }
    });
  });

  it("navigates and restores one existing tab without opening Chrome or tabs", async () => {
    const driver = createExperienceScoreBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(driver.collectShop(targetShop, sourceShop)).resolves.toMatchObject({
      status: "no_score",
      shop: { id: targetShop.id }
    });
    expect(update).toHaveBeenNthCalledWith(1, 42, {
      url: "https://fxg.jinritemai.com/ffa/eco/experience-score"
    });
    expect(update).toHaveBeenNthCalledWith(2, 42, {
      url: "https://fxg.jinritemai.com/ffa/g/list"
    });
    expect(shopDriver.switchShop).toHaveBeenNthCalledWith(1, targetShop);
    expect(shopDriver.switchShop).toHaveBeenNthCalledWith(2, sourceShop);
    expect(shopDriver.cleanupShopTabs).toHaveBeenCalledOnce();
  });

  it("keeps incomplete-dimension context in detail without creating a dynamic code", async () => {
    sendMessage
      .mockReset()
      .mockResolvedValueOnce({ riskSignals: [] })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "EXPERIENCE_DIMENSION_INCOMPLETE",
          message: "体验分维度数据不完整：商品体验。",
          detail: { dimension: "goods" }
        }
      });
    const driver = createExperienceScoreBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(driver.collectShop(targetShop, sourceShop)).rejects.toMatchObject({
      code: "EXPERIENCE_DIMENSION_INCOMPLETE",
      detail: { dimension: "goods" }
    });
  });

  it.each([
    {
      label: "tabs update",
      prepare: () => update.mockRejectedValueOnce(new Error("raw tab failure"))
    },
    {
      label: "sendMessage",
      prepare: () =>
        sendMessage.mockReset().mockRejectedValueOnce(new Error("raw port failure"))
    }
  ])("maps $label failures to the declared browser code", async ({ prepare }) => {
    prepare();
    const driver = createExperienceScoreBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(driver.collectShop(targetShop, sourceShop)).rejects.toEqual(
      expect.objectContaining<Partial<ExperienceScoreDriverError>>({
        code: "BROWSER_DISCONNECTED",
        message: "浏览器标签页或内容脚本暂不可用。"
      })
    );
  });

  it("maps an unrecognized content response code to the fixed stage fallback", async () => {
    sendMessage
      .mockReset()
      .mockResolvedValueOnce({ riskSignals: [] })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "EXPERIENCE_DIMENSION_INCOMPLETE:goods",
          message: "raw content error"
        }
      });
    const driver = createExperienceScoreBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(driver.collectShop(targetShop, sourceShop)).rejects.toMatchObject({
      code: "EXPERIENCE_STAGE_FAILED",
      message: "体验分页面读取失败。"
    });
  });

  it("drops unrecognized dimension detail from a fixed dimension error", async () => {
    sendMessage
      .mockReset()
      .mockResolvedValueOnce({ riskSignals: [] })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "EXPERIENCE_DIMENSION_INCOMPLETE",
          message: "raw content error",
          detail: { dimension: "secret-dynamic-dimension" }
        }
      });
    const driver = createExperienceScoreBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });

    const failure = await driver.collectShop(targetShop, sourceShop).catch(
      (error: unknown) => error
    );
    expect(failure).toMatchObject({
      code: "EXPERIENCE_DIMENSION_INCOMPLETE",
      message: "体验分维度数据不完整。"
    });
    expect(failure).toHaveProperty("detail", undefined);
  });
});
