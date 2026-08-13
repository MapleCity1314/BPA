import {
  collectBinanceManagementSnapshot,
  detectBinanceRiskSignals
} from "@bpa/adapter-binance";
import { firstBlockingRiskSignal } from "@bpa/node-runtime";
import {
  ContentActionRiskError,
  routeContentAction,
  type ContentActionHandlers,
  type ContentActionRequest
} from "../lib/content-action-router";
import {
  binanceDetailErrorPayload,
  executeBinanceDetailStage,
  type BinanceDetailStageRequest
} from "../lib/binance-detail-content";
import { probeObservedPage } from "../lib/page-observer-registry";

const runningStages = new Map<
  string,
  { readonly controller: AbortController; readonly completion: Promise<void> }
>();

const handlers: ContentActionHandlers = {
  async "binance.copy-trading.management.snapshot.read"(input, request) {
    const startedAt = Date.now();
    const riskSignals = detectBinanceRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(riskSignals)) {
      throw new ContentActionRiskError(riskSignals);
    }
    const output = await collectBinanceManagementSnapshot(
      document,
      location.href,
      {
        deadline: request.deadline!,
        ...(typeof input.projectId === "string"
          ? { projectId: input.projectId }
          : {})
      }
    );
    return {
      output: { ...output },
      riskSignals,
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms: 0
      }
    };
  },
  async "binance.copy-trading.project.detail.collect"() {
    throw new Error("BACKGROUND_ORCHESTRATION_REQUIRED");
  }
};

function announceReady(): void {
  void browser.runtime.sendMessage({
    type: "bpa.content.ready",
    href: location.href,
    observedAt: new Date().toISOString()
  });
}

export default defineContentScript({
  matches: [
    "https://www.binance.com/zh-CN/copy-trading/copy-management*"
  ],
  main() {
    announceReady();
    const notifyRouteChange = (): void => queueMicrotask(announceReady);
    addEventListener("popstate", notifyRouteChange);
    addEventListener("hashchange", notifyRouteChange);
    const originalPushState = history.pushState.bind(history);
    history.pushState = (data, unused, url) => {
      originalPushState(data, unused, url);
      notifyRouteChange();
    };
    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      originalReplaceState(data, unused, url);
      notifyRouteChange();
    };
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const changes = document.documentElement && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (observationTimer) clearTimeout(observationTimer);
          observationTimer = setTimeout(announceReady, 500);
        })
      : undefined;
    changes?.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });

    browser.runtime.onMessage.addListener((request: ContentActionRequest & {
      type: string;
      pageEpoch?: string;
      requestId?: unknown;
      request?: BinanceDetailStageRequest;
    }, _sender, sendResponse) => {
      if (request.type === "bpa.content.probe") {
        void probeObservedPage(document, location.href)
          .then((result) => sendResponse({
            pageEpoch: request.pageEpoch,
            observerCapabilityId: result.observerCapabilityId,
            authentication: result.authentication,
            observationState: result.observationState,
            ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
          }))
          .catch((error) => sendResponse({
            pageEpoch: request.pageEpoch,
            observerCapabilityId: "unknown.page",
            authentication: { state: "unknown" },
            observationState: "stale",
            reasonCode: error instanceof Error
              ? error.message
              : "PAGE_OBSERVER_FAILED"
          }));
        return true;
      }
      if (request.type === "bpa.risk.preflight") {
        sendResponse({
          riskSignals: detectBinanceRiskSignals(document, location.href)
        });
        return true;
      }
      if (request.type === "bpa.binance.detail.cancel-stage") {
        if (typeof request.requestId !== "string" || request.requestId.length < 1) {
          sendResponse({ ok: false, stopped: false });
          return false;
        }
        const running = runningStages.get(request.requestId);
        running?.controller.abort();
        void (running?.completion ?? Promise.resolve()).finally(() =>
          sendResponse({ ok: true, requestId: request.requestId, stopped: true })
        );
        return true;
      }
      if (request.type === "bpa.binance.detail.stage") {
        if (
          typeof request.requestId !== "string" ||
          request.requestId.length < 1 ||
          !request.request ||
          runningStages.has(request.requestId)
        ) {
          sendResponse({ ok: false, error: binanceDetailErrorPayload(undefined) });
          return false;
        }
        const requestId = request.requestId;
        const controller = new AbortController();
        const completion = executeBinanceDetailStage(
          request.request,
          document,
          location.href,
          () => controller.signal.aborted
        )
          .then((result) => sendResponse({ ok: true, requestId, result }))
          .catch((error) => sendResponse({
            ok: false,
            requestId,
            error: binanceDetailErrorPayload(error)
          }))
          .finally(() => runningStages.delete(requestId));
        runningStages.set(requestId, { controller, completion });
        return true;
      }
      if (request.type !== "bpa.execute") return undefined;
      const currentUrl = location.href;
      void routeContentAction({
        request,
        currentUrl,
        readCurrentUrl: () => location.href,
        handlers
      }).then((routed) => {
        if (routed.handled) sendResponse(routed.response);
      });
      return true;
    });
  }
});
