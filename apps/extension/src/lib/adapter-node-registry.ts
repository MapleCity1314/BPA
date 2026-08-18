import type {
  AllianceShop,
  DoudianAllianceNodeErrorCode,
  RetiredProductsPage
} from "@bpa/adapter-doudian";
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

export function adapterNodeCommandResultStatus(
  response: AdapterNodeResponse
): "succeeded" | "failed" | "rejected" | "uncertain" {
  if (response.ok) return "succeeded";
  if (response.riskSignals?.some((signal) => signal.severity === "blocking")) {
    return "rejected";
  }
  return [
    "NAVIGATION_UNCERTAIN",
    "ALLIANCE_CONTENT_RESPONSE_TIMEOUT"
  ].includes(response.error?.code ?? "")
    ? "uncertain"
    : "failed";
}

export const MAX_COMMAND_RESULT_PAYLOAD_BYTES = 480 * 1024;

export function commandResultPayloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function enforceCommandResultPayloadBound<
  T extends Record<string, unknown>
>(payload: T): T {
  if (commandResultPayloadBytes(payload) <= MAX_COMMAND_RESULT_PAYLOAD_BYTES) {
    return payload;
  }
  const bounded = {
    command_seq: payload.command_seq,
    command_id: payload.command_id,
    node_execution_id: payload.node_execution_id,
    idempotency_key: payload.idempotency_key,
    fencing_token: payload.fencing_token,
    status: "failed",
    error: {
      code: "COMMAND_RESULT_TOO_LARGE",
      message: "Command result exceeded the protocol payload limit.",
      retryable: false
    },
    timing_observation: payload.timing_observation ?? {},
    evidence_refs: [],
    page_epoch: payload.page_epoch
  };
  return bounded as unknown as T;
}

interface AdapterNodeExecutionContext {
  readonly sourceTabId: number;
  readonly deadline: string;
  readonly isCancelled?: () => boolean;
  readonly reserveManagedTab?: () => boolean;
  readonly releaseManagedTabReservation?: () => void;
  readonly onAllianceStageStarted?: (stage: {
    readonly tabId: number;
    readonly requestId: string;
  }) => void;
  readonly onAllianceStageStopped?: (requestId: string) => void;
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
    throw new AllianceRetiredDriverError("SHOP_IDENTITY_UNCERTAIN");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    !["active", "blocked"].includes(String(candidate.status)) ||
    typeof candidate.statusText !== "string"
  ) {
    throw new AllianceRetiredDriverError("SHOP_IDENTITY_UNCERTAIN");
  }
  const id = typeof candidate.id === "string" ? candidate.id : undefined;
  if (
    (candidate.status === "active" && !NUMERIC_SHOP_ID.test(id ?? "")) ||
    (id !== undefined && !NUMERIC_SHOP_ID.test(id))
  ) {
    throw new AllianceRetiredDriverError("SHOP_IDENTITY_UNCERTAIN");
  }
  return {
    ...(id ? { id } : {}),
    name: candidate.name,
    status: candidate.status as AllianceShop["status"],
    statusText: candidate.statusText
  };
}

function shopOutput(shop: AllianceShop): Record<string, unknown> {
  const id = shop.id && NUMERIC_SHOP_ID.test(shop.id) ? shop.id : undefined;
  return {
    ...(id ? { id } : {}),
    key: id ? `id:${id}` : `name:${normalize(shop.name)}`,
    name: shop.name,
    status: shop.status,
    statusText: shop.statusText
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

const ALLIANCE_RETRYABLE_ERRORS = new Set<DoudianAllianceNodeErrorCode>([
  "PAGE_LOADING",
  "BROWSER_DISCONNECTED",
  "ALLIANCE_TAB_TIMEOUT"
]);

const ALLIANCE_DISCOVERY_ERRORS = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_RESULT_TOO_LARGE",
  "COMMAND_CANCELLED",
  "CURRENT_SHOP_NOT_IN_LIST",
  "DEADLINE_EXCEEDED",
  "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
  "DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_CONTEXT_RESTORE_FAILED",
  "SHOP_IDENTITY_DRIFT",
  "SHOP_IDENTITY_AMBIGUOUS",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_IDENTITY_UNCONFIRMED",
  "SHOP_LIMIT_EXCEEDED",
  "SHOP_LIST_EMPTY",
  "SHOP_LIST_INCOMPLETE",
  "SHOP_LIST_DUPLICATED",
  "SHOP_NOT_ACTIVE",
  "SHOP_SWITCH_DIALOG_AMBIGUOUS",
  "SHOP_SWITCH_DIALOG_CLOSE_AMBIGUOUS",
  "SHOP_SWITCH_DIALOG_TIMEOUT",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_SWITCH_SEARCH_AMBIGUOUS",
  "SHOP_SWITCH_TRIGGER_AMBIGUOUS",
  "SHOP_TARGET_AMBIGUOUS",
  "SHOP_TARGET_INVALID",
  "SHOP_TARGET_TIMEOUT"
]);

const ALLIANCE_SCAN_ERRORS = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "ALLIANCE_SOURCE_TAB_MISSING",
  "ALLIANCE_STAGE_FAILED",
  "ALLIANCE_TAB_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "BROWSER_TAB_CAPACITY_EXCEEDED",
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
]);

const INVENTORY_SHOP_ACTIVATION_ERRORS = new Set<DoudianAllianceNodeErrorCode>([
  "ALLIANCE_CONTENT_RESPONSE_TIMEOUT",
  "AUTH_REQUIRED",
  "BROWSER_DISCONNECTED",
  "CAPTCHA_REQUIRED",
  "COMMAND_CANCELLED",
  "DEADLINE_EXCEEDED",
  "PAGE_LOADING",
  "PAGE_MISMATCH",
  "PAGE_URL_INVALID",
  "RATE_LIMITED",
  "RISK_CONTROL",
  "SESSION_EXPIRED",
  "SHOP_IDENTITY_MISMATCH",
  "SHOP_IDENTITY_UNCERTAIN",
  "SHOP_LIST_INCOMPLETE",
  "SHOP_SWITCH_NOT_CONFIRMED",
  "SHOP_TARGET_INVALID"
]);

function allianceErrorResponse(
  error: unknown,
  fallbackCode: DoudianAllianceNodeErrorCode,
  allowedCodes: ReadonlySet<DoudianAllianceNodeErrorCode>
): AdapterNodeResponse {
  const safeError =
    error instanceof AllianceRetiredDriverError && allowedCodes.has(error.code)
      ? error
      : new AllianceRetiredDriverError(fallbackCode);
  const code = safeError.code;
  const riskSignals =
    safeError.riskSignals.length > 0
      ? [...safeError.riskSignals]
      : (() => {
          const signal = blockingSignal(code);
          return signal ? [signal] : [];
        })();
  return {
    ok: false,
    error: {
      code,
      message: safeError.message,
      retryable: ALLIANCE_RETRYABLE_ERRORS.has(code)
    },
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
    return allianceErrorResponse(
      new AllianceRetiredDriverError("DOUDIAN_ALLIANCE_MAX_SHOPS_INVALID"),
      "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
      ALLIANCE_DISCOVERY_ERRORS
    );
  }
  const driver = createAllianceRetiredBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {}),
    ...(context.reserveManagedTab
      ? { reserveManagedTab: context.reserveManagedTab }
      : {}),
    ...(context.releaseManagedTabReservation
      ? {
          releaseManagedTabReservation:
            context.releaseManagedTabReservation
        }
      : {}),
    ...(context.onAllianceStageStarted
      ? { onStageStarted: context.onAllianceStageStarted }
      : {}),
    ...(context.onAllianceStageStopped
      ? { onStageStopped: context.onAllianceStageStopped }
      : {})
  });
  try {
    const discovery = await driver.discoverShopContext();
    const shops = discovery.shops;
    if (shops.length === 0) {
      throw new AllianceRetiredDriverError("SHOP_LIST_EMPTY");
    }
    if (shops.length > maxShops) {
      throw new AllianceRetiredDriverError("SHOP_LIMIT_EXCEEDED");
    }
    const active = shops.filter((shop) => shop.status === "active");
    const invalidIdentityIndex = shops.findIndex(
      (shop) =>
        shop.status === "active" &&
        !NUMERIC_SHOP_ID.test(shop.id ?? "")
    );
    if (invalidIdentityIndex >= 0) {
      throw new AllianceRetiredDriverError(
        "SHOP_IDENTITY_UNCERTAIN",
        [],
        {
          phase: "resolve-shop",
          shopOrdinal: invalidIdentityIndex + 1,
          switchResponse: "not-started",
          navigationIdentity: "unavailable",
          restoreResult: "not-required"
        }
      );
    }
    const sourceMatches = active.filter(
      (shop) =>
        shop.id === discovery.currentShop.id &&
        normalize(shop.name) === normalize(discovery.currentShop.name)
    );
    if (sourceMatches.length !== 1) {
      throw new AllianceRetiredDriverError(
        sourceMatches.length === 0
          ? "SHOP_IDENTITY_UNCONFIRMED"
          : "SHOP_IDENTITY_AMBIGUOUS"
      );
    }
    const sourceShop = sourceMatches[0]!;
    return {
      ok: true,
      output: {
        status: "complete",
        shops: shops.map(shopOutput),
        sourceShop: shopOutput(sourceShop),
        discoveredCount: shops.length,
        collectableCount: active.length,
        observedAt: new Date().toISOString(),
        diagnostics: []
      },
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms: 300
      }
    };
  } catch (error) {
    return allianceErrorResponse(
      error,
      "DOUDIAN_ALLIANCE_DISCOVERY_FAILED",
      ALLIANCE_DISCOVERY_ERRORS
    );
  } finally {
    await driver.cleanupShopTabs().catch(() => undefined);
  }
};

const scanAllianceShop: AdapterNodeHandler = async (input, context) => {
  const startedAt = Date.now();
  let shop: AllianceShop;
  let sourceShop: AllianceShop;
  try {
    shop = allianceShop(input.shop, "SHOP");
    sourceShop = allianceShop(input.sourceShop, "SOURCE_SHOP");
  } catch (error) {
    return allianceErrorResponse(
      error,
      "SHOP_IDENTITY_UNCERTAIN",
      ALLIANCE_SCAN_ERRORS
    );
  }
  if (shop.status !== "active") {
    return {
      ok: true,
      output: {
        shop: shopOutput(shop),
        status: "skipped",
        retiredCount: 0,
        products: [],
        diagnostics: ["SHOP_NOT_ACTIVE"]
      }
    };
  }
  const driver = createAllianceRetiredBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {}),
    ...(context.reserveManagedTab
      ? { reserveManagedTab: context.reserveManagedTab }
      : {}),
    ...(context.releaseManagedTabReservation
      ? {
          releaseManagedTabReservation:
            context.releaseManagedTabReservation
        }
      : {}),
    ...(context.onAllianceStageStarted
      ? { onStageStarted: context.onAllianceStageStarted }
      : {}),
    ...(context.onAllianceStageStopped
      ? { onStageStopped: context.onAllianceStageStopped }
      : {})
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
      throw new AllianceRetiredDriverError("SHOP_IDENTITY_MISMATCH");
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
    return allianceErrorResponse(
      new AllianceRetiredDriverError("SHOP_CONTEXT_RESTORE_FAILED"),
      "ALLIANCE_STAGE_FAILED",
      ALLIANCE_SCAN_ERRORS
    );
  }
  if (primaryError) {
    return allianceErrorResponse(
      primaryError,
      "ALLIANCE_STAGE_FAILED",
      ALLIANCE_SCAN_ERRORS
    );
  }
  if (!result) {
    return allianceErrorResponse(
      new AllianceRetiredDriverError("RETIRED_PRODUCTS_MISSING"),
      "ALLIANCE_STAGE_FAILED",
      ALLIANCE_SCAN_ERRORS
    );
  }
  if (result.products.length > 50) {
    return allianceErrorResponse(
      new AllianceRetiredDriverError("RETIRED_PRODUCT_LIMIT_EXCEEDED"),
      "ALLIANCE_STAGE_FAILED",
      ALLIANCE_SCAN_ERRORS
    );
  }
  if (
    (result.updatedAt !== undefined &&
      Array.from(result.updatedAt).length > 100) ||
    result.products.some(
      (product) =>
        Array.from(product.treatmentId).length < 1 ||
        Array.from(product.treatmentId).length > 100 ||
        (product.productId !== undefined &&
          !/^\d{5,30}$/u.test(product.productId)) ||
        Array.from(product.title).length < 1 ||
        Array.from(product.title).length > 500 ||
        Array.from(product.status).length < 1 ||
        Array.from(product.status).length > 100 ||
        Array.from(product.processedAt).length < 1 ||
        Array.from(product.processedAt).length > 100 ||
        Array.from(product.reason).length > 1000
    )
  ) {
    return allianceErrorResponse(
      new AllianceRetiredDriverError("RETIRED_PRODUCT_ROW_CHANGED"),
      "ALLIANCE_STAGE_FAILED",
      ALLIANCE_SCAN_ERRORS
    );
  }
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    output: {
      shop: shopOutput(shop),
      status: "complete",
      retiredCount: result.products.length,
      products: result.products.map((product) => ({ ...product })),
      updatedAt: result.updatedAt ?? null,
      observedAt,
      evidence: {
        pageUrl: "https://buyin.jinritemai.com/dashboard/regulation/clear-out",
        capturedAt: observedAt
      },
      diagnostics: []
    },
    timingObservation: {
      readiness_wait_ms: Date.now() - startedAt,
      stable_for_ms: 300
    }
  };
};

const activateInventoryShop: AdapterNodeHandler = async (input, context) => {
  const startedAt = Date.now();
  let target: AllianceShop;
  try {
    const candidate = input.targetShop;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new AllianceRetiredDriverError("SHOP_TARGET_INVALID");
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["id", "name"].includes(key)) ||
      typeof record.id !== "string" ||
      !NUMERIC_SHOP_ID.test(record.id) ||
      typeof record.name !== "string" ||
      record.name.trim().length < 2 ||
      record.name.length > 200
    ) {
      throw new AllianceRetiredDriverError("SHOP_TARGET_INVALID");
    }
    target = {
      id: record.id,
      name: record.name.trim(),
      status: "active",
      statusText: "active"
    };
  } catch (error) {
    return allianceErrorResponse(
      error,
      "SHOP_TARGET_INVALID",
      INVENTORY_SHOP_ACTIVATION_ERRORS
    );
  }
  const driver = createAllianceRetiredBrowserDriver({
    sourceTabId: context.sourceTabId,
    deadline: context.deadline,
    restoreProductListAfterSwitch: true,
    ...(context.isCancelled ? { isCancelled: context.isCancelled } : {}),
    ...(context.reserveManagedTab
      ? { reserveManagedTab: context.reserveManagedTab }
      : {}),
    ...(context.releaseManagedTabReservation
      ? {
          releaseManagedTabReservation:
            context.releaseManagedTabReservation
        }
      : {}),
    ...(context.onAllianceStageStarted
      ? { onStageStarted: context.onAllianceStageStarted }
      : {}),
    ...(context.onAllianceStageStopped
      ? { onStageStopped: context.onAllianceStageStopped }
      : {})
  });
  try {
    await driver.switchShop(target);
    const observedAt = new Date().toISOString();
    return {
      ok: true,
      output: {
        status: "complete",
        currentShop: { id: target.id, name: target.name },
        observedAt
      },
      timingObservation: {
        readiness_wait_ms: Date.now() - startedAt,
        stable_for_ms: 300
      }
    };
  } catch (error) {
    return allianceErrorResponse(
      error,
      "SHOP_SWITCH_NOT_CONFIRMED",
      INVENTORY_SHOP_ACTIVATION_ERRORS
    );
  } finally {
    await driver.cleanupShopTabs().catch(() => undefined);
  }
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
  ["doudian.inventory.shop.activate", activateInventoryShop],
  ["doudian.alliance.shops.discover", discoverAllianceShops],
  ["doudian.alliance.shop.retired-products.scan", scanAllianceShop],
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
