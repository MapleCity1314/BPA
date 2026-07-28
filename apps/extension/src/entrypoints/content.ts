import {
  detectDoudianRiskSignals,
  readDoudianShopContext
} from "@bpa/adapter-doudian";
import {
  AdaptiveReadinessGate,
  firstBlockingRiskSignal
} from "@bpa/node-runtime";
import type { RiskSignal, TimingPolicy } from "@bpa/schemas";

class AdapterRiskError extends Error {
  constructor(readonly riskSignals: RiskSignal[]) {
    super(firstBlockingRiskSignal(riskSignals)?.code ?? "RISK_CONTROL");
  }
}

function waitForPageChange(maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer =
      document.documentElement && typeof MutationObserver !== "undefined"
        ? new MutationObserver(finish)
        : undefined;
    observer?.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    const timer = setTimeout(finish, maxWaitMs);
  });
}

async function readShopContextWhenReady(
  timingPolicy?: TimingPolicy,
  commandDeadline?: string
): Promise<{
  context: ReturnType<typeof readDoudianShopContext>;
  riskSignals: RiskSignal[];
  timingObservation: {
    readiness_wait_ms: number;
    stable_for_ms: number;
  };
}> {
  const readiness = timingPolicy?.readiness ?? {
    timeoutMs: 5_000,
    stableForMs: 250,
    pollIntervalMs: 250
  };
  const startedAt = Date.now();
  const deadlineBudgetMs =
    commandDeadline == null
      ? readiness.timeoutMs
      : Math.max(1, Date.parse(commandDeadline) - startedAt);
  const startingUrl = location.href;
  const gate = new AdaptiveReadinessGate({
    startedAt,
    timeoutMs: Math.min(readiness.timeoutMs, deadlineBudgetMs),
    stableForMs: readiness.stableForMs
  });
  while (true) {
    const signals = detectDoudianRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(signals)) {
      throw new AdapterRiskError(signals);
    }
    let context: ReturnType<typeof readDoudianShopContext> | undefined;
    try {
      context = readDoudianShopContext(document, location.href);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PAGE_LOADING"
      ) {
        throw error;
      }
    }
    const state = gate.observe({
      at: Date.now(),
      ready: Boolean(context),
      ...(context
        ? {
            signature: `${context.shop.id}:${context.shop.name}:${context.url}`
          }
        : {})
    });
    if (state.state === "ready" && context) {
      if (location.href !== startingUrl) {
        throw new AdapterRiskError([
          {
            code: "PAGE_CONTEXT_CHANGED",
            category: "page_context",
            severity: "blocking",
            source: "bridge",
            detected_at: new Date().toISOString(),
            detail: "等待页面稳定期间活动页面发生了导航。"
          }
        ]);
      }
      return {
        context,
        riskSignals: signals,
        timingObservation: {
          readiness_wait_ms: Date.now() - startedAt,
          stable_for_ms: readiness.stableForMs
        }
      };
    }
    if (state.state === "timed_out") {
      throw new Error("PAGE_LOADING");
    }
    await waitForPageChange(readiness.pollIntervalMs);
  }
}

export default defineContentScript({
  matches: ["https://fxg.jinritemai.com/ffa/g/list*"],
  main() {
    browser.runtime.onMessage.addListener(
      (
        request: {
          type?: string;
          node?: { id?: string; version?: string };
          pageEpoch?: string;
          timingPolicy?: TimingPolicy;
          deadline?: string;
        },
        _sender,
        sendResponse
      ) => {
        if (
          request.type !== "bpa.execute" ||
          request.node?.id !== "doudian.shop.context.read" ||
          !["1.0.0", "1.1.0", "1.2.0"].includes(
            request.node.version ?? ""
          )
        ) {
          return undefined;
        }
        void readShopContextWhenReady(
          request.timingPolicy,
          request.deadline
        )
          .then(({ context, riskSignals, timingObservation }) => {
            sendResponse({
              ok: true,
              output: {
                ...context,
                page_epoch: request.pageEpoch
              },
              riskSignals,
              timingObservation
            });
          })
          .catch((error: unknown) => {
            const code =
              error instanceof Error ? error.message : "ADAPTER_FAILED";
            sendResponse({
              ok: false,
              ...(error instanceof AdapterRiskError
                ? { riskSignals: error.riskSignals }
                : {}),
              error: {
                code,
                message:
                  code === "PAGE_LOADING"
                    ? `店铺信息尚未加载完成（ready=${document.readyState}, headerCandidates=${document.querySelectorAll("[class*='headerShopName']").length}, path=${location.pathname}）。`
                    : error instanceof AdapterRiskError
                      ? "平台风险信号或页面上下文变化阻止了自动执行，需要人工检查。"
                      : "当前页面不是受支持的抖店商品列表页。",
                retryable: code === "PAGE_LOADING"
              }
            });
          });
        return true;
      }
    );
  }
});
