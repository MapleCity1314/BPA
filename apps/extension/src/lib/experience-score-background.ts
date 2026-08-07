import type {
  ExperienceShop,
  ExperienceSnapshot
} from "@bpa/adapter-doudian";
import type { RiskSignal } from "@bpa/schemas";
import {
  AllianceRetiredDriverError,
  createAllianceRetiredBrowserDriver
} from "./alliance-retired-background";
import type {
  ExperienceScoreStageRequest,
  ExperienceScoreStageResult
} from "./experience-score-content";

const EXPERIENCE_URL =
  "https://fxg.jinritemai.com/ffa/eco/experience-score";

interface StageResponse {
  readonly ok: boolean;
  readonly result?: ExperienceScoreStageResult;
  readonly error?: { readonly code: string; readonly message: string };
}

interface PreflightResponse {
  readonly riskSignals?: readonly RiskSignal[];
}

export interface ExperienceScoreBrowserDriver {
  discoverShopContext(): Promise<{
    readonly shops: readonly ExperienceShop[];
    readonly currentShopName: string;
  }>;
  collectShop(
    shop: ExperienceShop,
    sourceShop: ExperienceShop
  ): Promise<ExperienceSnapshot>;
}

export function createExperienceScoreBrowserDriver(input: {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly stageResponseTimeoutMs?: number;
}): ExperienceScoreBrowserDriver {
  const shopDriver = createAllianceRetiredBrowserDriver(input);

  const assertActive = (): void => {
    if (input.isCancelled?.()) {
      throw new AllianceRetiredDriverError("COMMAND_CANCELLED");
    }
    if (
      !Number.isFinite(Date.parse(input.deadline)) ||
      Date.now() >= Date.parse(input.deadline)
    ) {
      throw new AllianceRetiredDriverError("DEADLINE_EXCEEDED");
    }
  };

  const waitForComplete = async (tabId: number): Promise<void> => {
    while (Date.now() < Date.parse(input.deadline)) {
      assertActive();
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (tab?.status === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new AllianceRetiredDriverError("EXPERIENCE_PAGE_TIMEOUT");
  };

  const navigate = async (url: string): Promise<void> => {
    assertActive();
    await browser.tabs.update(input.sourceTabId, { url });
    await waitForComplete(input.sourceTabId);
  };

  const preflight = async (): Promise<void> => {
    const response = (await browser.tabs.sendMessage(input.sourceTabId, {
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

  const collect = async (shop: ExperienceShop): Promise<ExperienceSnapshot> => {
    await preflight();
    const request: ExperienceScoreStageRequest = {
      stage: "collect-snapshot",
      expectedShop: shop
    };
    const remaining = Date.parse(input.deadline) - Date.now();
    const timeoutMs = Math.max(
      1,
      Math.min(input.stageResponseTimeoutMs ?? 75_000, remaining)
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = (await Promise.race([
        browser.tabs.sendMessage(input.sourceTabId, {
          type: "bpa.doudian.experience.stage",
          request
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("EXPERIENCE_CONTENT_RESPONSE_TIMEOUT")),
            timeoutMs
          );
        })
      ])) as StageResponse;
      if (!response?.ok || response.result?.stage !== "collect-snapshot") {
        throw new AllianceRetiredDriverError(
          response?.error?.code ?? "EXPERIENCE_STAGE_FAILED"
        );
      }
      return response.result.snapshot;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    async discoverShopContext() {
      return shopDriver.discoverShopContext();
    },
    async collectShop(shop, sourceShop) {
      const sourceTab = await browser.tabs.get(input.sourceTabId);
      const sourceUrl = sourceTab.url;
      if (!sourceUrl) throw new AllianceRetiredDriverError("PAGE_URL_INVALID");
      let snapshot: ExperienceSnapshot | undefined;
      let primaryError: unknown;
      try {
        await shopDriver.switchShop(shop);
        await navigate(EXPERIENCE_URL);
        snapshot = await collect(shop);
      } catch (error) {
        primaryError = error;
      }
      try {
        await navigate(sourceUrl);
        await shopDriver.switchShop(sourceShop);
        await shopDriver.cleanupShopTabs();
      } catch {
        throw new AllianceRetiredDriverError("SHOP_CONTEXT_RESTORE_FAILED");
      }
      if (primaryError) throw primaryError;
      if (!snapshot) {
        throw new AllianceRetiredDriverError("EXPERIENCE_SNAPSHOT_MISSING");
      }
      return snapshot;
    }
  };
}
