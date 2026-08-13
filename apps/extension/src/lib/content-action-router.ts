import type { RiskSignal, TimingPolicy } from "@bpa/schemas";
import {
  validateDoudianEditorTarget,
  validateDoudianInventorySnapshotInput,
  validateDoudianScopeRestoreTarget
} from "@bpa/adapter-doudian";
import { validateMarketplaceProbeInput } from "@bpa/adapter-marketplace";
import {
  validPageEpoch,
  validateCapabilityRoute
} from "./capability-manifest";

export interface ContentActionRequest {
  readonly type?: string;
  readonly node?: {
    readonly id?: string;
    readonly version?: string;
  };
  readonly input?: unknown;
  readonly pageEpoch?: unknown;
  readonly grantedPermissions?: unknown;
  readonly timingPolicy?: TimingPolicy;
  readonly deadline?: string;
}

export interface ContentActionResult {
  readonly output: Record<string, unknown>;
  readonly riskSignals?: RiskSignal[];
  readonly timingObservation?: {
    readonly readiness_wait_ms?: number;
    readonly stable_for_ms?: number;
  };
}

export interface ContentActionHandlers {
  readonly "binance.copy-trading.management.snapshot.read"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "binance.copy-trading.project.detail.collect"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "ecommerce.marketplace.search-results.read"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "browser.design.snapshot.capture"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.shop.context.read"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.product.scope.collect"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.product.scope.restore"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.inventory.product.snapshot.read"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.product.editor.open"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
  readonly "doudian.editor.priority-items.inspect"?: (
    input: Readonly<Record<string, unknown>>,
    request: ContentActionRequest
  ) => Promise<ContentActionResult>;
}

export type ContentActionResponse =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly response:
        | {
            readonly ok: true;
            readonly output: Record<string, unknown>;
            readonly pageEpoch: string;
            readonly riskSignals?: RiskSignal[];
            readonly timingObservation?: ContentActionResult["timingObservation"];
          }
        | {
            readonly ok: false;
            readonly pageEpoch?: string;
            readonly output?: Record<string, unknown>;
            readonly error: {
              readonly code: string;
              readonly message: string;
              readonly retryable: boolean;
            };
            readonly riskSignals?: RiskSignal[];
          };
    };

export class ContentActionOutcomeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly output: Record<string, unknown>,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ContentActionOutcomeError";
  }
}

function failure(
  code: string,
  message: string,
  pageEpoch?: string
): ContentActionResponse {
  return {
    handled: true,
    response: {
      ok: false,
      ...(pageEpoch ? { pageEpoch } : {}),
      error: { code, message, retryable: false }
    }
  };
}

function recordInput(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function editorIdentityMatches(
  input: Readonly<Record<string, unknown>>,
  currentUrl: URL
): boolean {
  if (
    Object.keys(input).some(
      (key) =>
        key !== "product" &&
        key !== "packagingMatch" &&
        key !== "platformFillCheck"
    )
  ) {
    return false;
  }
  const product = recordInput(input.product);
  if (!product) return false;
  const id = product.id;
  const editorUrl = product.editorUrl;
  if (
    typeof id !== "string" ||
    !/^\d{5,30}$/u.test(id) ||
    typeof editorUrl !== "string"
  ) {
    return false;
  }
  try {
    const configured = new URL(editorUrl);
    return (
      configured.origin === currentUrl.origin &&
      configured.pathname === currentUrl.pathname &&
      configured.searchParams.get("product_id") === id &&
      currentUrl.searchParams.get("product_id") === id
    );
  } catch {
    return false;
  }
}

function editorOpenIdentityMatches(
  input: Readonly<Record<string, unknown>>,
  currentUrl: URL
): boolean {
  try {
    const target = validateDoudianEditorTarget(input);
    return target.editUrl === currentUrl.href;
  } catch {
    return false;
  }
}

function scopeRestoreIdentityMatches(
  input: Readonly<Record<string, unknown>>,
  currentUrl: URL
): boolean {
  try {
    return (
      validateDoudianScopeRestoreTarget(input, currentUrl.href).listUrl ===
      currentUrl.href
    );
  } catch {
    return false;
  }
}

function designCaptureInputValid(
  input: Readonly<Record<string, unknown>>,
  requestPageEpoch: string
): boolean {
  const allowed = new Set([
    "authoringSessionId",
    "designGrantId",
    "pageState",
    "profileId",
    "pageEpoch"
  ]);
  return (
    Object.keys(input).every((key) => allowed.has(key)) &&
    ["authoringSessionId", "designGrantId", "pageState"].every(
      (key) =>
        typeof input[key] === "string" &&
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(
          input[key] as string
        )
    ) &&
    typeof input.profileId === "string" &&
    input.profileId.length > 0 &&
    input.profileId.length <= 300 &&
    typeof input.pageEpoch === "string" &&
    validPageEpoch(input.pageEpoch) &&
    input.pageEpoch === requestPageEpoch
  );
}

function marketplaceInputMatchesOrigin(
  input: Readonly<Record<string, unknown>>,
  currentUrl: URL
): boolean {
  try {
    const validated = validateMarketplaceProbeInput(input);
    const expectedOrigin = {
      DOUYIN: "https://www.douyin.com",
      TAOBAO: "https://s.taobao.com",
      JD: "https://search.jd.com"
    }[validated.platform];
    return currentUrl.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export async function routeContentAction(input: {
  readonly request: ContentActionRequest;
  readonly currentUrl: string;
  readonly readCurrentUrl?: () => string;
  readonly handlers: ContentActionHandlers;
  readonly now?: number;
}): Promise<ContentActionResponse> {
  const request = input.request;
  if (request.type !== "bpa.execute") return { handled: false };
  const nodeId = request.node?.id ?? "";
  const nodeVersion = request.node?.version ?? "";
  const grantedPermissions = Array.isArray(request.grantedPermissions)
    ? request.grantedPermissions.filter(
        (permission): permission is string => typeof permission === "string"
      )
    : [];
  const route = validateCapabilityRoute({
    nodeId,
    nodeVersion,
    currentUrl: input.currentUrl,
    grantedPermissions
  });
  if (!route.valid) {
    return failure(
      route.reason,
      `只读页面动作被拒绝：${route.reason}`,
      validPageEpoch(request.pageEpoch) ? request.pageEpoch : undefined
    );
  }
  if (!validPageEpoch(request.pageEpoch)) {
    return failure("PAGE_EPOCH_INVALID", "页面执行纪元无效。");
  }
  if (
    typeof request.deadline !== "string" ||
    !Number.isFinite(Date.parse(request.deadline)) ||
    Date.parse(request.deadline) <= (input.now ?? Date.now())
  ) {
    return failure(
      "DEADLINE_EXCEEDED",
      "页面动作已经超过执行期限。",
      request.pageEpoch
    );
  }
  const actionInput = recordInput(request.input);
  if (!actionInput) {
    return failure(
      "INPUT_INVALID",
      "页面动作输入必须是对象。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId !==
      "doudian.editor.priority-items.inspect" &&
    route.capability.nodeId !== "doudian.product.editor.open" &&
    route.capability.nodeId !== "doudian.product.scope.restore" &&
    route.capability.nodeId !== "doudian.inventory.product.snapshot.read" &&
    route.capability.nodeId !== "ecommerce.marketplace.search-results.read" &&
    route.capability.nodeId !== "browser.design.snapshot.capture" &&
    Object.keys(actionInput).length > 0
  ) {
    return failure(
      "INPUT_INVALID",
      "该只读页面动作不接受额外输入。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId === "ecommerce.marketplace.search-results.read" &&
    !marketplaceInputMatchesOrigin(actionInput, route.url)
  ) {
    return failure(
      "MARKETPLACE_INPUT_INVALID",
      "平台、关键词或数量与当前探查页不匹配。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId === "doudian.inventory.product.snapshot.read"
  ) {
    try {
      validateDoudianInventorySnapshotInput(actionInput);
    } catch {
      return failure(
        "INVENTORY_INPUT_INVALID",
        "库存快照目标与店铺身份无效。",
        request.pageEpoch
      );
    }
  }
  if (
    route.capability.nodeId === "browser.design.snapshot.capture" &&
    !designCaptureInputValid(actionInput, request.pageEpoch)
  ) {
    return failure(
      "DESIGN_CAPTURE_INPUT_INVALID",
      "Design Mode 捕获输入与授权身份不完整。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId === "doudian.product.editor.open" &&
    !editorOpenIdentityMatches(actionInput, route.url)
  ) {
    return failure(
      "EDITOR_TARGET_INVALID",
      "编辑页导航目标与当前页面不一致。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId === "doudian.product.scope.restore" &&
    !scopeRestoreIdentityMatches(actionInput, route.url)
  ) {
    return failure(
      "SCOPE_RESTORE_TARGET_INVALID",
      "商品列表恢复目标与当前页面不一致。",
      request.pageEpoch
    );
  }
  if (
    route.capability.nodeId ===
      "doudian.editor.priority-items.inspect" &&
    !editorIdentityMatches(actionInput, route.url)
  ) {
    return failure(
      "EDITOR_URL_MISMATCH",
      "编辑页、商品 ID 与任务输入不一致。",
      request.pageEpoch
    );
  }

  if (route.capability.executionTarget === "background") {
    return failure(
      "BACKGROUND_ORCHESTRATION_REQUIRED",
      "该跨标签页能力只能由受信任的扩展后台编排。",
      request.pageEpoch
    );
  }
  const handler = input.handlers[
    route.capability.nodeId as keyof ContentActionHandlers
  ] as ((
    actionInput: Readonly<Record<string, unknown>>,
    actionRequest: ContentActionRequest
  ) => Promise<ContentActionResult>) | undefined;
  if (!handler) {
    return failure(
      "ADAPTER_HANDLER_UNAVAILABLE",
      "当前页面未加载该平台的 Adapter。",
      request.pageEpoch
    );
  }
  try {
    const result = await handler(actionInput, request);
    if (
      input.readCurrentUrl &&
      input.readCurrentUrl() !== input.currentUrl
    ) {
      return failure(
        "PAGE_CONTEXT_CHANGED",
        "页面动作执行期间 URL 发生变化。",
        request.pageEpoch
      );
    }
    return {
      handled: true,
      response: {
        ok: true,
        output: result.output,
        pageEpoch: request.pageEpoch,
        ...(result.riskSignals?.length
          ? { riskSignals: result.riskSignals }
          : {}),
        ...(result.timingObservation
          ? { timingObservation: result.timingObservation }
          : {})
      }
    };
  } catch (error) {
    const code =
      error instanceof ContentActionOutcomeError
        ? error.code
        : error instanceof Error
          ? error.message
          : "ADAPTER_FAILED";
    const riskSignals =
      error instanceof ContentActionRiskError ? error.riskSignals : undefined;
    return {
      handled: true,
      response: {
        ok: false,
        pageEpoch: request.pageEpoch,
        ...(error instanceof ContentActionOutcomeError
          ? { output: error.output }
          : {}),
        error: {
          code,
          message:
            error instanceof Error ? error.message : "只读页面动作执行失败。",
          retryable:
            error instanceof ContentActionOutcomeError
              ? error.retryable
              : code === "PAGE_LOADING" ||
                code === "PAGE_NOT_STABLE" ||
                code === "REQUIRED_EVIDENCE_MISSING" ||
                code === "SCOPE_RESTORE_PAGE_UNAVAILABLE"
        },
        ...(riskSignals?.length ? { riskSignals } : {})
      }
    };
  }
}

export class ContentActionRiskError extends Error {
  constructor(readonly riskSignals: RiskSignal[]) {
    super(
      riskSignals.find((signal) => signal.severity === "blocking")?.code ??
        "RISK_CONTROL"
    );
  }
}
