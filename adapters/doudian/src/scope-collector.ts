export const DOUDIAN_SCOPE_COLLECTOR_VERSION = "1.0.0";
export const MAX_SCOPE_RECONCILIATION_ROUNDS = 3;

export interface ScopeFingerprintInput {
  readonly shopId: string;
  readonly shopName: string;
  readonly filters: Readonly<Record<string, string | number | boolean | null>>;
  readonly statusTab: {
    readonly id: string;
    readonly label: string;
  };
}

export interface ScopeFingerprint extends ScopeFingerprintInput {
  readonly digest: string;
}

export interface ProductCandidate {
  readonly id: string;
  readonly title: string;
  readonly editorUrl?: string;
}

export interface ScopeVirtualView {
  readonly scrollTop: number;
  readonly products: readonly ProductCandidate[];
}

export interface ScopePageReplay {
  readonly page: number;
  readonly totalPages: number;
  readonly views: readonly ScopeVirtualView[];
}

export interface ScopeRiskSignal {
  readonly code: string;
  readonly severity: "info" | "warning" | "blocking";
}

export interface ScopeCollectionRound {
  readonly fingerprint: ScopeFingerprint;
  readonly topTotal: number;
  readonly bottomTotal: number;
  readonly pages: readonly ScopePageReplay[];
  readonly riskSignals?: readonly ScopeRiskSignal[];
}

export interface ScopeCollectionReplay {
  readonly initialLocation: {
    readonly page: number;
    readonly scrollTop: number;
  };
  readonly rounds: readonly ScopeCollectionRound[];
}

export type ScopeCollectionErrorCode =
  | "ROUND_LIMIT_EXCEEDED"
  | "NO_COLLECTION_ROUND"
  | "PAGE_CONTEXT_CHANGED"
  | "RISK_SIGNAL_BLOCKED"
  | "TOTAL_INVALID"
  | "TOTAL_CHANGED_DURING_ROUND"
  | "PAGINATION_INCOMPLETE"
  | "PRODUCT_ID_INVALID"
  | "PRODUCT_TITLE_INVALID"
  | "PRODUCT_CONFLICT"
  | "COUNT_MISMATCH";

export interface ScopeRoundDiagnostic {
  readonly round: number;
  readonly topTotal: number;
  readonly bottomTotal: number;
  readonly collected: number;
  readonly totalsStable: boolean;
  readonly paginationComplete: boolean;
  readonly productsValid: boolean;
  readonly reconciled: boolean;
}

export interface ScopeCollectionResult {
  readonly status: "complete" | "inconsistent" | "blocked";
  readonly collectorVersion: typeof DOUDIAN_SCOPE_COLLECTOR_VERSION;
  readonly fingerprint?: ScopeFingerprint;
  readonly expectedCount?: number;
  readonly scanRounds: number;
  readonly products: readonly ProductCandidate[];
  readonly inspectionQueue: readonly ProductCandidate[];
  readonly restore: {
    readonly page: number;
    readonly scrollTop: number;
    readonly required: true;
  };
  readonly diagnostics: readonly ScopeRoundDiagnostic[];
  readonly error?: {
    readonly code: ScopeCollectionErrorCode;
    readonly message: string;
  };
}

interface EvaluatedRound {
  readonly products: readonly ProductCandidate[];
  readonly diagnostic: ScopeRoundDiagnostic;
  readonly error?: ScopeCollectionResult["error"];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalFilters(
  filters: ScopeFingerprintInput["filters"]
): string {
  return Object.entries(filters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("&");
}

export function createScopeFingerprint(
  input: ScopeFingerprintInput
): ScopeFingerprint {
  const normalized: ScopeFingerprintInput = {
    shopId: normalizeText(input.shopId),
    shopName: normalizeText(input.shopName),
    filters: Object.fromEntries(
      Object.entries(input.filters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          normalizeText(key),
          typeof value === "string" ? normalizeText(value) : value
        ])
    ),
    statusTab: {
      id: normalizeText(input.statusTab.id),
      label: normalizeText(input.statusTab.label)
    }
  };
  return {
    ...normalized,
    digest: stableHash(
      [
        normalized.shopId,
        normalized.shopName,
        normalized.statusTab.id,
        normalized.statusTab.label,
        canonicalFilters(normalized.filters)
      ].join("|")
    )
  };
}

function validProductId(value: string): boolean {
  return /^\d{5,30}$/u.test(value);
}

function validProductTitle(value: string, productId: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.length >= 2 &&
    normalized.length <= 500 &&
    normalized !== productId &&
    !/^(?:-+|暂无|无|商品图片|图片|未命名|加载中)$/u.test(normalized)
  );
}

function defaultEditorUrl(productId: string): string {
  return `https://fxg.jinritemai.com/ffa/g/create?product_id=${productId}&entrance=edit`;
}

function errorResult(
  replay: ScopeCollectionReplay,
  diagnostics: readonly ScopeRoundDiagnostic[],
  scanRounds: number,
  status: ScopeCollectionResult["status"],
  code: ScopeCollectionErrorCode,
  message: string,
  fingerprint?: ScopeFingerprint
): ScopeCollectionResult {
  return {
    status,
    collectorVersion: DOUDIAN_SCOPE_COLLECTOR_VERSION,
    ...(fingerprint ? { fingerprint } : {}),
    scanRounds,
    products: [],
    inspectionQueue: [],
    restore: {
      ...replay.initialLocation,
      required: true
    },
    diagnostics,
    error: { code, message }
  };
}

function evaluateRound(
  round: ScopeCollectionRound,
  roundIndex: number
): EvaluatedRound {
  const totalsValid =
    Number.isSafeInteger(round.topTotal) &&
    round.topTotal >= 0 &&
    Number.isSafeInteger(round.bottomTotal) &&
    round.bottomTotal >= 0;
  const totalsStable =
    totalsValid && round.topTotal === round.bottomTotal;
  const declaredPages = new Set(round.pages.map((page) => page.totalPages));
  const totalPages = declaredPages.size === 1 ? [...declaredPages][0] : undefined;
  const actualPages = [...new Set(round.pages.map((page) => page.page))].sort(
    (left, right) => left - right
  );
  const paginationComplete =
    totalPages !== undefined &&
    Number.isSafeInteger(totalPages) &&
    totalPages >= 1 &&
    actualPages.length === totalPages &&
    actualPages.every((page, index) => page === index + 1) &&
    round.pages.every(
      (page) =>
        Number.isSafeInteger(page.page) &&
        page.page >= 1 &&
        page.views.length > 0 &&
        page.views.every(
          (view) => Number.isFinite(view.scrollTop) && view.scrollTop >= 0
        )
    );

  const products = new Map<string, ProductCandidate>();
  let productError: ScopeCollectionResult["error"];
  for (const page of [...round.pages].sort((left, right) => left.page - right.page)) {
    for (const view of [...page.views].sort(
      (left, right) => left.scrollTop - right.scrollTop
    )) {
      for (const candidate of view.products) {
        const id = normalizeText(candidate.id);
        const title = normalizeText(candidate.title);
        if (!validProductId(id)) {
          productError ??= {
            code: "PRODUCT_ID_INVALID",
            message: `商品 ID 无效：${id || "空"}`
          };
          continue;
        }
        if (!validProductTitle(title, id)) {
          productError ??= {
            code: "PRODUCT_TITLE_INVALID",
            message: `商品 ${id} 的标题无效。`
          };
          continue;
        }
        const normalized: ProductCandidate = {
          id,
          title,
          editorUrl: candidate.editorUrl ?? defaultEditorUrl(id)
        };
        const existing = products.get(id);
        if (
          existing &&
          (existing.title !== normalized.title ||
            existing.editorUrl !== normalized.editorUrl)
        ) {
          productError ??= {
            code: "PRODUCT_CONFLICT",
            message: `商品 ${id} 在分页或虚拟滚动快照中出现冲突。`
          };
          continue;
        }
        products.set(id, normalized);
      }
    }
  }

  const collected = products.size;
  const productsValid = productError === undefined;
  const reconciled =
    totalsStable &&
    paginationComplete &&
    productsValid &&
    collected === round.bottomTotal;
  const diagnostic: ScopeRoundDiagnostic = {
    round: roundIndex + 1,
    topTotal: round.topTotal,
    bottomTotal: round.bottomTotal,
    collected,
    totalsStable,
    paginationComplete,
    productsValid,
    reconciled
  };

  if (!totalsValid) {
    return {
      products: [...products.values()],
      diagnostic,
      error: { code: "TOTAL_INVALID", message: "分页商品总数无效。" }
    };
  }
  if (!totalsStable) {
    return {
      products: [...products.values()],
      diagnostic,
      error: {
        code: "TOTAL_CHANGED_DURING_ROUND",
        message: `本轮采集期间商品总数由 ${round.topTotal} 变为 ${round.bottomTotal}。`
      }
    };
  }
  if (!paginationComplete) {
    return {
      products: [...products.values()],
      diagnostic,
      error: {
        code: "PAGINATION_INCOMPLETE",
        message: "分页或虚拟滚动快照不完整。"
      }
    };
  }
  if (productError) {
    return { products: [...products.values()], diagnostic, error: productError };
  }
  if (collected !== round.bottomTotal) {
    return {
      products: [...products.values()],
      diagnostic,
      error: {
        code: "COUNT_MISMATCH",
        message: `页面显示 ${round.bottomTotal} 件，实际采集 ${collected} 件。`
      }
    };
  }
  return { products: [...products.values()], diagnostic };
}

/**
 * Deterministic collection reducer. It performs no DOM or browser operations:
 * a browser handler supplies replayable rounds and applies the returned restore
 * instruction in a finally block.
 */
export function reconcileProductScope(
  replay: ScopeCollectionReplay
): ScopeCollectionResult {
  if (replay.rounds.length === 0) {
    return errorResult(
      replay,
      [],
      0,
      "inconsistent",
      "NO_COLLECTION_ROUND",
      "没有可对账的商品采集轮次。"
    );
  }
  if (replay.rounds.length > MAX_SCOPE_RECONCILIATION_ROUNDS) {
    return errorResult(
      replay,
      [],
      MAX_SCOPE_RECONCILIATION_ROUNDS,
      "inconsistent",
      "ROUND_LIMIT_EXCEEDED",
      `商品范围最多允许 ${MAX_SCOPE_RECONCILIATION_ROUNDS} 轮对账。`
    );
  }

  const first = replay.rounds[0]!;
  const baseline = createScopeFingerprint(first.fingerprint);
  const diagnostics: ScopeRoundDiagnostic[] = [];
  let latestProducts: readonly ProductCandidate[] = [];
  let latestError: ScopeCollectionResult["error"];

  for (const [roundIndex, round] of replay.rounds.entries()) {
    const observed = createScopeFingerprint(round.fingerprint);
    if (
      observed.digest !== round.fingerprint.digest ||
      observed.digest !== baseline.digest
    ) {
      return errorResult(
        replay,
        diagnostics,
        roundIndex + 1,
        "blocked",
        "PAGE_CONTEXT_CHANGED",
        "店铺、筛选条件或状态页签在采集期间发生变化。",
        baseline
      );
    }
    const blockingRisk = round.riskSignals?.find(
      (signal) => signal.severity === "blocking"
    );
    if (blockingRisk) {
      return errorResult(
        replay,
        diagnostics,
        roundIndex + 1,
        "blocked",
        "RISK_SIGNAL_BLOCKED",
        `平台风险信号阻断采集：${blockingRisk.code}`,
        baseline
      );
    }

    const evaluated = evaluateRound(round, roundIndex);
    diagnostics.push(evaluated.diagnostic);
    latestProducts = evaluated.products;
    latestError = evaluated.error;
  }

  const lastRound = replay.rounds.at(-1)!;
  if (latestError) {
    return errorResult(
      replay,
      diagnostics,
      replay.rounds.length,
      "inconsistent",
      latestError.code,
      latestError.message,
      baseline
    );
  }
  return {
    status: "complete",
    collectorVersion: DOUDIAN_SCOPE_COLLECTOR_VERSION,
    fingerprint: baseline,
    expectedCount: lastRound.bottomTotal,
    scanRounds: replay.rounds.length,
    products: latestProducts,
    inspectionQueue: latestProducts,
    restore: {
      ...replay.initialLocation,
      required: true
    },
    diagnostics
  };
}
