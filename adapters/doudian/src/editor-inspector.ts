export const DOUDIAN_PRIORITY_INSPECTOR_VERSION = "1.0.0";

export interface PriorityProductRef {
  readonly id: string;
  readonly title: string;
  readonly editorUrl: string;
}

export interface RequiredFieldObservation {
  readonly key: string;
  readonly label: string;
  readonly section: string;
  readonly controlKind:
    | "text"
    | "number"
    | "textarea"
    | "combobox"
    | "radio"
    | "checkbox"
    | "rich_content"
    | "composite";
  readonly required: boolean;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly valueState: "filled" | "empty" | "unknown";
}

export interface SkuRequiredCellObservation {
  readonly skuId?: string;
  readonly row: number;
  readonly column: string;
  readonly required: boolean;
  readonly visible: boolean;
  readonly valueState: "filled" | "empty" | "unknown";
}

export interface EditorReadinessSignals {
  readonly signature: string;
  readonly hasMain: boolean;
  readonly visibleControls: number;
  readonly knownAnchors: number;
  readonly requiredMarkers: number;
  readonly loading: boolean;
}

export interface PlatformFillCheckObservation {
  readonly requested: boolean;
  readonly available: boolean;
  readonly completed: boolean;
  readonly warnings: readonly string[];
}

export interface EditorObservation {
  readonly url: string;
  readonly readiness: EditorReadinessSignals;
  readonly riskSignals?: readonly {
    readonly code: string;
    readonly severity: "info" | "warning" | "blocking";
  }[];
  readonly requiredFields: readonly RequiredFieldObservation[];
  readonly skuRequiredCells: readonly SkuRequiredCellObservation[];
  readonly platformFillCheck?: PlatformFillCheckObservation;
}

export interface PriorityItemsInspectionReplay {
  readonly product: PriorityProductRef;
  /**
   * Matching is optional business context. `unmatched` and `ambiguous` never
   * suppress the page's baseline required-field inspection.
   */
  readonly packagingMatch?: {
    readonly status: "matched" | "unmatched" | "ambiguous";
    readonly recordId?: string;
  };
  readonly observations: readonly EditorObservation[];
}

export type EditorStructureAnomalyCode =
  | "RISK_SIGNAL_BLOCKED"
  | "PRODUCT_ID_INVALID"
  | "EDITOR_URL_MISMATCH"
  | "PAGE_NOT_STABLE"
  | "REQUIRED_EVIDENCE_MISSING"
  | "FIELD_STRUCTURE_UNKNOWN"
  | "PLATFORM_CHECK_UNAVAILABLE";

export interface EditorStructureAnomaly {
  readonly code: EditorStructureAnomalyCode;
  readonly classification:
    | "risk"
    | "identity"
    | "readiness"
    | "structure"
    | "platform";
  readonly retryable: boolean;
  readonly message: string;
}

export interface PriorityItemIssue {
  readonly category: "required_empty" | "platform_warning";
  readonly severity: "error" | "warning";
  readonly ruleId: string;
  readonly message: string;
  readonly evidence: string;
  readonly field?: {
    readonly key: string;
    readonly label: string;
    readonly section: string;
    readonly controlKind: string;
    readonly skuId?: string;
    readonly row?: number;
  };
}

export interface PriorityItemsInspectionResult {
  readonly status: "complete" | "retryable" | "structural_anomaly" | "blocked";
  readonly inspectorVersion: typeof DOUDIAN_PRIORITY_INSPECTOR_VERSION;
  readonly productId: string;
  readonly packagingMatchStatus:
    | "matched"
    | "unmatched"
    | "ambiguous"
    | "not_provided";
  readonly baselineInspectionPerformed: boolean;
  readonly issues: readonly PriorityItemIssue[];
  readonly anomalies: readonly EditorStructureAnomaly[];
  readonly observedUrl?: string;
  readonly readiness?: {
    readonly stableSamples: number;
    readonly requiredMarkers: number;
    readonly visibleControls: number;
    readonly knownAnchors: number;
  };
  readonly domMutations: 0;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function productIdFromEditorUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://fxg.jinritemai.com" ||
      url.pathname !== "/ffa/g/create"
    ) {
      return undefined;
    }
    const productId = url.searchParams.get("product_id") ?? undefined;
    return productId && /^\d{5,30}$/u.test(productId)
      ? productId
      : undefined;
  } catch {
    return undefined;
  }
}

function stableTail(observations: readonly EditorObservation[]): number {
  const signature = observations.at(-1)?.readiness.signature;
  if (!signature) return 0;
  let samples = 0;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (observations[index]?.readiness.signature !== signature) break;
    samples += 1;
  }
  return samples;
}

function baseResult(
  replay: PriorityItemsInspectionReplay
): Omit<
  PriorityItemsInspectionResult,
  "status" | "issues" | "anomalies" | "baselineInspectionPerformed"
> {
  return {
    inspectorVersion: DOUDIAN_PRIORITY_INSPECTOR_VERSION,
    productId: replay.product.id,
    packagingMatchStatus: replay.packagingMatch?.status ?? "not_provided",
    domMutations: 0
  };
}

function stopped(
  replay: PriorityItemsInspectionReplay,
  status: "retryable" | "structural_anomaly" | "blocked",
  anomaly: EditorStructureAnomaly,
  observation?: EditorObservation,
  stableSamples = 0
): PriorityItemsInspectionResult {
  return {
    ...baseResult(replay),
    status,
    baselineInspectionPerformed: false,
    issues: [],
    anomalies: [anomaly],
    ...(observation
      ? {
          observedUrl: observation.url,
          readiness: {
            stableSamples,
            requiredMarkers: observation.readiness.requiredMarkers,
            visibleControls: observation.readiness.visibleControls,
            knownAnchors: observation.readiness.knownAnchors
          }
        }
      : {})
  };
}

/**
 * Pure inspection reducer. It consumes read-only DOM observations and never
 * clicks, types, saves, publishes, or otherwise mutates the page.
 */
export function inspectPriorityItems(
  replay: PriorityItemsInspectionReplay
): PriorityItemsInspectionResult {
  const expectedId = normalizeText(replay.product.id);
  if (!/^\d{5,30}$/u.test(expectedId)) {
    return stopped(replay, "structural_anomaly", {
      code: "PRODUCT_ID_INVALID",
      classification: "identity",
      retryable: false,
      message: "待检查商品 ID 无效。"
    });
  }

  const latest = replay.observations.at(-1);
  const stableSamples = stableTail(replay.observations);
  if (!latest) {
    return stopped(replay, "retryable", {
      code: "PAGE_NOT_STABLE",
      classification: "readiness",
      retryable: true,
      message: "没有可用的编辑页观察快照。"
    });
  }
  const blockingRisk = latest.riskSignals?.find(
    (signal) => signal.severity === "blocking"
  );
  if (blockingRisk) {
    return stopped(
      replay,
      "blocked",
      {
        code: "RISK_SIGNAL_BLOCKED",
        classification: "risk",
        retryable: false,
        message: `平台风险信号阻断检查：${blockingRisk.code}`
      },
      latest,
      stableSamples
    );
  }

  const configuredId = productIdFromEditorUrl(replay.product.editorUrl);
  const observedId = productIdFromEditorUrl(latest.url);
  if (configuredId !== expectedId || observedId !== expectedId) {
    return stopped(
      replay,
      "structural_anomaly",
      {
        code: "EDITOR_URL_MISMATCH",
        classification: "identity",
        retryable: false,
        message: `编辑页商品 ID 与队列商品 ${expectedId} 不一致。`
      },
      latest,
      stableSamples
    );
  }

  const ready =
    latest.readiness.hasMain &&
    latest.readiness.visibleControls > 0 &&
    (latest.readiness.knownAnchors > 0 ||
      latest.readiness.requiredMarkers > 0) &&
    !latest.readiness.loading &&
    stableSamples >= 3;
  if (!ready) {
    return stopped(
      replay,
      "retryable",
      {
        code: "PAGE_NOT_STABLE",
        classification: "readiness",
        retryable: true,
        message: "编辑页主表单、控件和锚点尚未连续稳定。"
      },
      latest,
      stableSamples
    );
  }
  if (latest.readiness.requiredMarkers === 0) {
    return stopped(
      replay,
      "retryable",
      {
        code: "REQUIRED_EVIDENCE_MISSING",
        classification: "structure",
        retryable: true,
        message: "页面稳定，但没有识别到必填字段证据。"
      },
      latest,
      stableSamples
    );
  }

  const anomalies: EditorStructureAnomaly[] = [];
  const issues: PriorityItemIssue[] = [];
  const fieldKeys = new Set<string>();
  for (const field of latest.requiredFields) {
    if (!field.required || !field.visible || field.disabled) continue;
    const key = normalizeText(field.key);
    if (!key || fieldKeys.has(key) || field.valueState === "unknown") {
      anomalies.push({
        code: "FIELD_STRUCTURE_UNKNOWN",
        classification: "structure",
        retryable: false,
        message: !key
          ? "必填字段缺少稳定键。"
          : fieldKeys.has(key)
            ? `必填字段键重复：${key}`
            : `无法确定必填字段 ${field.label} 的值状态。`
      });
      continue;
    }
    fieldKeys.add(key);
    if (field.valueState !== "empty") continue;
    issues.push({
      category: "required_empty",
      severity: "error",
      ruleId: `required.${field.controlKind}.empty`,
      message: `${normalizeText(field.label)}为必填项，但当前为空`,
      evidence: "来自只读字段值观察",
      field: {
        key,
        label: normalizeText(field.label),
        section: normalizeText(field.section),
        controlKind: field.controlKind
      }
    });
  }

  for (const cell of latest.skuRequiredCells) {
    if (!cell.required || !cell.visible) continue;
    if (cell.valueState === "unknown") {
      anomalies.push({
        code: "FIELD_STRUCTURE_UNKNOWN",
        classification: "structure",
        retryable: false,
        message: `无法确定 SKU 第 ${cell.row} 行 ${cell.column} 的值状态。`
      });
      continue;
    }
    if (cell.valueState !== "empty") continue;
    const column = normalizeText(cell.column);
    issues.push({
      category: "required_empty",
      severity: "error",
      ruleId: "required.sku_cell.empty",
      message: `${column}为空${cell.skuId ? `（SKU ${cell.skuId}）` : ""}`,
      evidence: "SKU 必填列未检测到值",
      field: {
        key: `sku:${cell.skuId ?? cell.row}:${column}`,
        label: column,
        section: "价格库存",
        controlKind: "sku_cell",
        ...(cell.skuId ? { skuId: cell.skuId } : {}),
        row: cell.row
      }
    });
  }

  const platform = latest.platformFillCheck;
  if (platform?.requested && (!platform.available || !platform.completed)) {
    anomalies.push({
      code: "PLATFORM_CHECK_UNAVAILABLE",
      classification: "platform",
      retryable: true,
      message: platform.available
        ? "抖店填写检查未在限定时间内完成。"
        : "当前页面未找到唯一的抖店填写检查入口。"
    });
  }
  if (platform?.completed) {
    for (const warning of new Set(
      platform.warnings.map(normalizeText).filter(Boolean)
    )) {
      issues.push({
        category: "platform_warning",
        severity: "warning",
        ruleId: "platform.fill_check",
        message: warning,
        evidence: "来自抖店填写检查"
      });
    }
  }

  return {
    ...baseResult(replay),
    status: anomalies.some((anomaly) => !anomaly.retryable)
      ? "structural_anomaly"
      : anomalies.length > 0
        ? "retryable"
        : "complete",
    baselineInspectionPerformed: true,
    issues,
    anomalies,
    observedUrl: latest.url,
    readiness: {
      stableSamples,
      requiredMarkers: latest.readiness.requiredMarkers,
      visibleControls: latest.readiness.visibleControls,
      knownAnchors: latest.readiness.knownAnchors
    }
  };
}
