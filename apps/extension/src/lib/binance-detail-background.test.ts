import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BinanceDetailDriverError,
  createBinanceDetailBrowserDriver
} from "./binance-detail-background.js";

const managementUrl = "https://www.binance.com/zh-CN/copy-trading/copy-management";
const target = {
  projectId: "project_1001",
  projectStatus: "ongoing" as const,
  managementUrl
};
const snapshot = {
  schemaVersion: "binance-copy-trading/v0.1" as const,
  status: "complete" as const,
  projectId: target.projectId,
  observedAt: "2026-08-12T10:00:00.000Z",
  pageUrl: managementUrl,
  tabs: [],
  formMutations: 0 as const
};

describe("Binance same-page detail browser driver", () => {
  const get = vi.fn();
  const update = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ id: 42, status: "complete", url: managementUrl });
    sendMessage.mockResolvedValue({ riskSignals: [] });
    vi.stubGlobal("browser", { tabs: { get, update, sendMessage } });
  });

  it("collects in the bound management tab without navigation", async () => {
    sendMessage.mockImplementationOnce(async () => ({ riskSignals: [] }));
    sendMessage.mockImplementationOnce(async (_tabId, message) => ({
      ok: true,
      requestId: message.requestId,
      result: { stage: "collect-project", snapshot }
    }));
    const driver = createBinanceDetailBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(driver.collectProject(target)).resolves.toEqual(snapshot);
    expect(update).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("fails closed before content actions when the bound page changed", async () => {
    get.mockResolvedValue({ id: 42, status: "complete", url: "https://www.binance.com/zh-CN/login" });
    const driver = createBinanceDetailBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(driver.collectProject(target)).rejects.toEqual(
      expect.objectContaining<Partial<BinanceDetailDriverError>>({ code: "PAGE_CONTEXT_CHANGED" })
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("stops on blocking preflight without starting project collection", async () => {
    sendMessage.mockReset().mockResolvedValueOnce({
      riskSignals: [{
        code: "CAPTCHA_REQUIRED",
        category: "challenge",
        severity: "blocking",
        source: "page",
        detected_at: "2026-08-12T10:00:00.000Z",
        detail: "manual verification required"
      }]
    });
    const driver = createBinanceDetailBrowserDriver({
      sourceTabId: 42,
      deadline: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(driver.collectProject(target)).rejects.toEqual(
      expect.objectContaining<Partial<BinanceDetailDriverError>>({ code: "CAPTCHA_REQUIRED" })
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});
