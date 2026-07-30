import {
  collectDoudianProductScope,
  detectDoudianRiskSignals,
  inspectDoudianPriorityItems,
  legacyDoudianScopeCollectionResult,
  readDoudianShopContext,
  restoreDoudianProductScope,
  validateDoudianScopeRestoreTarget,
  verifyDoudianEditorOpen
} from "@bpa/adapter-doudian";
import {
  AdaptiveReadinessGate,
  firstBlockingRiskSignal
} from "@bpa/node-runtime";
import type { RiskSignal, TimingPolicy } from "@bpa/schemas";
import {
  ContentActionOutcomeError,
  ContentActionRiskError,
  routeContentAction,
  type ContentActionHandlers,
  type ContentActionRequest
} from "../lib/content-action-router";
import { captureSemanticSnapshot } from "../lib/semantic-snapshot";

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
      throw new ContentActionRiskError(signals);
    }
    let context: ReturnType<typeof readDoudianShopContext> | undefined;
    try {
      context = readDoudianShopContext(document, location.href);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PAGE_LOADING") {
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
        throw new ContentActionRiskError([
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
    if (state.state === "timed_out") throw new Error("PAGE_LOADING");
    await waitForPageChange(readiness.pollIntervalMs);
  }
}

const handlers: ContentActionHandlers = {
  async "browser.design.snapshot.capture"(input) {
    const snapshot = await captureSemanticSnapshot(document, {
      pageState: String(input.pageState)
    });
    return {
      output: {
        apiVersion: "bpa.authoring/v1alpha1",
        kind: "SemanticSnapshotCapture",
        authoringSessionId: String(input.authoringSessionId),
        designGrantId: String(input.designGrantId),
        profileId: String(input.profileId),
        ...snapshot
      }
    };
  },

  async "doudian.shop.context.read"(_input, request) {
    const ready = await readShopContextWhenReady(
      request.timingPolicy,
      request.deadline
    );
    return {
      output: { ...ready.context },
      riskSignals: ready.riskSignals,
      timingObservation: ready.timingObservation
    };
  },

  async "doudian.product.scope.collect"(_input, request) {
    const startedAt = Date.now();
    const ready = await readShopContextWhenReady(
      request.timingPolicy,
      request.deadline
    );
    const collected = await collectDoudianProductScope(document, {
      shop: ready.context.shop,
      deadline: request.deadline!,
      ...(request.timingPolicy?.readiness?.pollIntervalMs === undefined
        ? {}
        : {
            waitMs: request.timingPolicy.readiness.pollIntervalMs
          })
    });
    const riskSignals = detectDoudianRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(riskSignals)) {
      throw new ContentActionRiskError(riskSignals);
    }
    const output =
      request.node?.version === "1.0.0"
        ? legacyDoudianScopeCollectionResult(collected)
        : collected;
    return {
      output: { ...output },
      riskSignals,
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms:
          request.timingPolicy?.readiness?.stableForMs ??
          ready.timingObservation.stable_for_ms
      }
    };
  },

  async "doudian.product.scope.restore"(input, request) {
    const startedAt = Date.now();
    const target = validateDoudianScopeRestoreTarget(input, location.href);
    const ready = await readShopContextWhenReady(
      request.timingPolicy,
      request.deadline
    );
    if (
      ready.context.shop.id !== target.shopId ||
      ready.context.shop.name !== target.shopName
    ) {
      throw new Error("SCOPE_RESTORE_CONTEXT_MISMATCH");
    }
    const output = await restoreDoudianProductScope(document, input, {
      deadline: request.deadline!,
      ...(request.timingPolicy?.readiness?.pollIntervalMs === undefined
        ? {}
        : {
            waitMs: request.timingPolicy.readiness.pollIntervalMs
          })
    });
    const riskSignals = detectDoudianRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(riskSignals)) {
      throw new ContentActionRiskError(riskSignals);
    }
    return {
      output: { ...output },
      riskSignals,
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms:
          request.timingPolicy?.readiness?.stableForMs ??
          ready.timingObservation.stable_for_ms
      }
    };
  },

  async "doudian.product.editor.open"(input, request) {
    const startedAt = Date.now();
    const riskSignals = detectDoudianRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(riskSignals)) {
      throw new ContentActionRiskError(riskSignals);
    }
    const output = await verifyDoudianEditorOpen(document, input, {
      deadline: request.deadline!,
      ...(request.timingPolicy?.readiness?.pollIntervalMs === undefined
        ? {}
        : {
            waitMs: request.timingPolicy.readiness.pollIntervalMs
          })
    });
    return {
      output: { ...output },
      riskSignals,
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms:
          request.timingPolicy?.readiness?.stableForMs ?? 250
      }
    };
  },

  async "doudian.editor.priority-items.inspect"(input, request) {
    const startedAt = Date.now();
    const riskSignals = detectDoudianRiskSignals(document, location.href);
    if (firstBlockingRiskSignal(riskSignals)) {
      throw new ContentActionRiskError(riskSignals);
    }
    const output = await inspectDoudianPriorityItems(document, input, {
      deadline: request.deadline!,
      ...(request.timingPolicy?.readiness?.pollIntervalMs === undefined
        ? {}
        : {
            waitMs: request.timingPolicy.readiness.pollIntervalMs
          })
    });
    if (output.status === "retryable") {
      const anomaly = output.anomalies[0];
      throw new ContentActionOutcomeError(
        anomaly?.code ?? "PAGE_NOT_STABLE",
        anomaly?.message ?? "编辑页只读检查需要有限重试。",
        { ...output },
        anomaly?.retryable ?? true
      );
    }
    return {
      output: { ...output },
      riskSignals,
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms:
          request.timingPolicy?.readiness?.stableForMs ?? 250
      }
    };
  }
};

export default defineContentScript({
  matches: [
    "https://fxg.jinritemai.com/ffa/g/list*",
    "https://fxg.jinritemai.com/ffa/g/create*",
    "https://www.chanmama.com/*"
  ],
  main() {
    browser.runtime.onMessage.addListener(
      (
        request: ContentActionRequest,
        _sender,
        sendResponse
      ) => {
        if (request.type === "bpa.risk.preflight") {
          sendResponse({
            riskSignals: detectDoudianRiskSignals(document, location.href)
          });
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
      }
    );
  }
});
