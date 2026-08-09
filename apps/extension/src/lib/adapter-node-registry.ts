import type { AllianceShop, RetiredProductsPage } from "@bpa/adapter-doudian";
import type { RiskSignal } from "@bpa/schemas";
import {
  AllianceRetiredDriverError,
  createAllianceRetiredBrowserDriver
} from "./alliance-retired-background";
import {
  createExperienceScoreBrowserDriver,
  ExperienceScoreDriverError
} from "./experience-score-background";

export interface AdapterNodeResponse {
  readonly ok: boolean;
  readonly output?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly detail?: Readonly<Record<string, string>>;
  };
  readonly riskSignals?: RiskSignal[];
  readonly timingObservation?: {
    readonly readiness_wait_ms?: number;
    readonly stable_for_ms?: number;
  };
}

interface AdapterNodeExecutionContext {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
}

type AdapterNodeHandler = (
  input: Record<string, unknown>,
  context: AdapterNodeExecutionContext
) => Promise<AdapterNodeResponse>;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function allianceShop(value: unknown, label: string): AllianceShop {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DOUDIAN_ALLIANCE_${label}_INVALID`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    !["active", "blocked"].includes(String(candidate.status)) ||
    typeof candidate.statusText !== "string"
  ) {
    throw new Error(`DOUDIAN_ALLIANCE_${label}_INVALID`);
  }
  return {
    ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
    name: candidate.name,
    status: candidate.status as AllianceShop["status"],
    statusText: candidate.statusText
  };
}

function shopOutput(shop: AllianceShop): Record<string, unknown> {
  return {
    ...shop,
    key: shop.id ? `id:${shop.id}` : `name:${normalize(shop.name)}`
  };
}

const NUMERIC_SHOP_ID = /^\d{5,30}$/u;

function experienceShopOutput(shop: AllianceShop): Record<string, unknown> {
  const id = shop.id && NUMERIC_SHOP_ID.test(shop.id) ? shop.id : undefined;
  return {
    ...(id ? { id } : {}),
    key: id ? `id:${id}` : `name:${normalize(shop.name)}`,
    name: shop.name,
    status: shop.status,
    statusText: shop.statusText
  };
}

function blockingSignal(code: string): RiskSignal | undefined {
  if (
    ![
      "AUTH_REQUIRED",
      "CAPTCHA_REQUIRED",
      "PAGE_CONTEXT_CHANGED",
      "PROMOTION_DIALOG_UNRECOGNIZED",
      "RATE_LIMITED",
      "RISK_CONTROL",
      "SESSION_EXPIRED",
      "SHOP_IDENTITY_MISMATCH",
      "SHOP_CONTEXT_RESTORE_FAILED",
      "SHOP_SWITCH_NOT_CONFIRMED"
    ].includes(code)
  ) {
    return undefined;
  }
  return {
    code: [
      "AUTH_REQUIRED",
      "CAPTCHA_REQUIRED",
      "PAGE_CONTEXT_CHANGED",
      "RATE_LIMITED",
      "RISK_CONTROL",
      "SESSION_EXPIRED"
    ].includes(code)
      ? (code as RiskSignal["code"])
      : "RISK_CONTROL",
    category:
      code === "SESSION_EXPIRED" || code === "AUTH_REQUIRED"
        ? "session"
        : code === "PAGE_CONTEXT_CHANGED" ||
            code === "SHOP_CONTEXT_RESTORE_FAILED"
          ? "page_context"
          : "challenge",
    severity: "blocking",
    source: "adapter",
    detected_at: new Date().toISOString(),
    detail: `抖店联盟 Adapter 已停止执行：${code}`
  };
}

function errorResponse(error: unknown): AdapterNodeResponse {
  const code = error instanceof Error ? error.message : String(error);
  const riskSignals =
    error instanceof AllianceRetiredDriverError &&
    error.riskSignals.length > 0
      ? [...error.riskSignals]
      : (() => {
          const signal = blockingSignal(code);
          return signal ? [signal] : [];
        })();
  return {
    ok: false,
    error: { code, message: code, retryable: false },
    ...(riskSignals.length > 0 ? { riskSignals } : {})
  };
}

const EXPERIENCE_RETRYABLE_ERRORS = new Set([
  "BROWSER_DISCONNECTED",
  "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT",
  "EXPERIENCE_PAGE_TIMEOUT",
  "PAGE_LOADING"
]);

function experienceErrorResponse(
  error: unknown,
  fallbackCode: "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED" | "EXPERIENCE_STAGE_FAILED" =
    "EXPERIENCE_STAGE_FAILED"
): AdapterNodeResponse {
  const safeError =
    error instanceof ExperienceScoreDriverError
      ? error
      : new ExperienceScoreDriverError(fallbackCode);
  const riskSignals =
    safeError.riskSignals.length > 0
      ? [...safeError.riskSignals]
      : (() => {
          const signal = blockingSignal(safeError.code);
          return signal ? [signal] : [];
        })();
  return {
    ok: false,
    error: {
      code: safeError.code,
      message: safeError.message,
      retryable: EXPERIENCE_RETRYABLE_ERRORS.has(safeError.code),
      ...(safeError.detail ? { detail: safeError.detail } : {})
    },
    ...(riskSignals.length > 0 ? { riskSignals } : {})
  };
}

const discoverAllianceShops: AdapterNodeHandler = async (input, context) => {
  const startedAt = Date.now();
  const maxShops = Number(input.maxShops ?? 100);
  if (!Number.isSafeInteger(maxShops) || maxShops < 1 || maxShops > 100) {
    return errorResponse(new Error("DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID"));
  }
  const driver = createAllianceRetiredBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {})
  });
  try {
    const discovery = await driver.discoverShopContext();
    const shops = discovery.shops;
    if (shops.length === 0) throw new Error("SHOP_LIST_EMPTY");
    if (shops.length > maxShops) throw new Error("SHOP_LIMIT_EXCEEDED");
    const active = shops.filter((shop) => shop.status === "active");
    const sourceMatches = active.filter(
      (shop) => normalize(shop.name) === normalize(discovery.currentShopName)
    );
    if (sourceMatches.length !== 1) {
      throw new Error(
        sourceMatches.length === 0
          ? "SHOP_IDENTITY_UNCONFIRMED"
          : "SHOP_IDENTITY_AMBIGUOUS"
      );
    }
    const sourceShop = sourceMatches[0]!;
    return {
      ok: true,
      output: {
        shops: shops.map(shopOutput),
        sourceShop: shopOutput(sourceShop),
        discoveredShopCount: shops.length,
        activeShopCount: active.length,
        skippedShopCount: shops.length - active.length,
        observedAt: new Date().toISOString()
      },
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms: 300
      }
    };
  } catch (error) {
    return errorResponse(error);
  } finally {
    await driver.cleanupShopTabs().catch(() => undefined);
  }
};

const scanAllianceShop: AdapterNodeHandler = async (input, context) => {
  const startedAt = Date.now();
  const shop = allianceShop(input.shop, "SHOP");
  const sourceShop = allianceShop(input.sourceShop, "SOURCE_SHOP");
  if (shop.status !== "active") {
    return {
      ok: true,
      output: {
        shop: shopOutput(shop),
        status: "skipped",
        retiredCount: 0,
        products: [],
        error: { code: "SHOP_NOT_ACTIVE", message: shop.statusText }
      }
    };
  }
  const driver = createAllianceRetiredBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {})
  });
  let result: RetiredProductsPage | undefined;
  let primaryError: unknown;
  try {
    await driver.switchShop(shop);
    await driver.openPromotion(shop);
    await driver.openRetiredProducts(shop);
    result = await driver.collectRetiredProducts(shop);
    if (
      normalize(result.shop.name) !== normalize(shop.name) ||
      (shop.id && result.shop.id !== shop.id)
    ) {
      throw new Error("SHOP_IDENTITY_MISMATCH");
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await driver.cleanupShopTabs();
    await driver.switchShop(sourceShop);
  } catch {
    // A failed restore invalidates the browser context for every remaining
    // shop. It must take precedence over the original collection error so
    // the Workflow stops with the correct blocking recovery instruction.
    return errorResponse(new Error("SHOP_CONTEXT_RESTORE_FAILED"));
  }
  if (primaryError) return errorResponse(primaryError);
  if (!result) return errorResponse(new Error("RETIRED_PRODUCTS_MISSING"));
  return {
    ok: true,
    output: {
      shop: shopOutput(shop),
      status: "complete",
      retiredCount: result.products.length,
      products: result.products.map((product) => ({ ...product })),
      ...(result.updatedAt ? { updatedAt: result.updatedAt } : {})
    },
    timingObservation: {
      readiness_wait_ms: Date.now() - startedAt,
      stable_for_ms: 300
    }
  };
};

function shanghaiBusinessDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const aggregateAllianceScan: AdapterNodeHandler = async (input) => {
  const outcome = input.foreachOutcome as
    | {
        total?: number;
        succeeded?: { count?: number; items?: Array<{ output?: unknown }> };
        failed?: { count?: number; items?: unknown[] };
        unresolved?: { count?: number; items?: unknown[] };
      }
    | undefined;
  if (!outcome || !outcome.succeeded || !outcome.failed || !outcome.unresolved) {
    return errorResponse(new Error("DOUDIAN_ALLIANCE_OUTCOME_INVALID"));
  }
  const shops = (outcome.succeeded.items ?? []).flatMap((item) =>
    item.output && typeof item.output === "object" ? [item.output] : []
  ) as Array<Record<string, unknown>>;
  const failedCount = Number(outcome.failed.count ?? 0);
  const unresolvedCount = Number(outcome.unresolved.count ?? 0);
  const complete = failedCount === 0 && unresolvedCount === 0;
  const retiredProductCount = shops.reduce(
    (total, shop) => total + Number(shop.retiredCount ?? 0),
    0
  );
  const now = new Date();
  return {
    ok: true,
    output: {
      status: complete
        ? retiredProductCount > 0
          ? "complete_with_items"
          : "complete_empty"
        : "partial",
      businessDate: shanghaiBusinessDate(now),
      observedAt: now.toISOString(),
      discoveredShopCount: Number(outcome.total ?? 0),
      scannedShopCount: Number(outcome.succeeded.count ?? 0),
      failedShopCount: failedCount + unresolvedCount,
      affectedShopCount: shops.filter(
        (shop) => Number(shop.retiredCount ?? 0) > 0
      ).length,
      retiredProductCount,
      shops,
      foreachOutcome: outcome
    }
  };
};

const discoverExperienceShops: AdapterNodeHandler = async (input, context) => {
  const maxShops = Number(input.maxShops ?? 100);
  if (!Number.isSafeInteger(maxShops) || maxShops < 1 || maxShops > 100) {
    return experienceErrorResponse(
      new ExperienceScoreDriverError("DOUDIAN_EXPERIENCE_MAX_SHOPS_INVALID")
    );
  }
  const driver = createExperienceScoreBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {})
  });
  try {
    const discovery = await driver.discoverShopContext();
    if (discovery.shops.length < 1) {
      throw new ExperienceScoreDriverError("SHOP_LIST_EMPTY");
    }
    if (discovery.shops.length > maxShops) {
      throw new ExperienceScoreDriverError("SHOP_LIMIT_EXCEEDED");
    }
    if (
      discovery.shops.some(
        (shop) => shop.status === "active" && !NUMERIC_SHOP_ID.test(shop.id ?? "")
      )
    ) {
      throw new ExperienceScoreDriverError("SHOP_IDENTITY_UNCERTAIN");
    }
    const shops = discovery.shops.map(experienceShopOutput);
    const sourceMatches = discovery.shops.filter(
      (shop) => normalize(shop.name) === normalize(discovery.currentShopName)
    );
    if (sourceMatches.length !== 1) {
      throw new ExperienceScoreDriverError(
        sourceMatches.length === 0
          ? "SHOP_IDENTITY_UNCONFIRMED"
          : "SHOP_IDENTITY_AMBIGUOUS"
      );
    }
    return {
      ok: true,
      output: {
        status: "complete",
        shops,
        sourceShop: experienceShopOutput(sourceMatches[0]!),
        discoveredCount: shops.length,
        collectableCount: discovery.shops.filter(
          (shop) => shop.status === "active"
        ).length,
        observedAt: new Date().toISOString(),
        diagnostics: []
      }
    };
  } catch (error) {
    return experienceErrorResponse(error, "DOUDIAN_EXPERIENCE_DISCOVERY_FAILED");
  }
};

const readExperienceShop: AdapterNodeHandler = async (input, context) => {
  let shop: AllianceShop;
  let sourceShop: AllianceShop;
  try {
    shop = allianceShop(input.shop, "EXPERIENCE_SHOP");
    sourceShop = allianceShop(input.sourceShop, "EXPERIENCE_SOURCE_SHOP");
  } catch {
    return experienceErrorResponse(
      new ExperienceScoreDriverError("SHOP_IDENTITY_UNCERTAIN")
    );
  }
  if (shop.status !== "active") {
    return {
      ok: true,
      output: {
        shop: shopOutput(shop),
        status: "skipped",
        diagnostics: ["SHOP_NOT_ACTIVE"]
      }
    };
  }
  if (!NUMERIC_SHOP_ID.test(shop.id ?? "")) {
    return experienceErrorResponse(
      new ExperienceScoreDriverError("SHOP_IDENTITY_UNCERTAIN")
    );
  }
  const driver = createExperienceScoreBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {})
  });
  try {
    const snapshot = await driver.collectShop(shop, sourceShop);
    return { ok: true, output: { ...snapshot } };
  } catch (error) {
    return experienceErrorResponse(error);
  }
};

const handlers = new Map<string, AdapterNodeHandler>([
  ["doudian.alliance.shops.discover", discoverAllianceShops],
  ["doudian.alliance.shop.retired-products.scan", scanAllianceShop],
  ["doudian.alliance.retired-products.aggregate", aggregateAllianceScan],
  ["doudian.experience.shops.discover", discoverExperienceShops],
  ["doudian.experience.shop.snapshot.read", readExperienceShop]
]);

export async function executeRegisteredAdapterNode(
  nodeId: string,
  input: Record<string, unknown>,
  context: AdapterNodeExecutionContext
): Promise<AdapterNodeResponse | undefined> {
  const handler = handlers.get(nodeId);
  return handler ? handler(input, context) : undefined;
}
