import { createHash } from "node:crypto";

export const ISSUE_RECONCILIATION_VERSION = "1.0.0";
export const ISSUE_REPORT_VERSION = "1.0.0";
export const MAX_RECONCILE_PRODUCTS = 500;
export const MAX_RECONCILE_FINDINGS = 500;

const MAX_TEXT_LENGTH = 300;
const MAX_FINDINGS_PER_PRODUCT = 50;
const MAX_ANOMALIES_PER_PRODUCT = 20;

export const PACKAGING_MATCH_STATUSES = [
  "matched",
  "smart_matched",
  "bound",
  "ambiguous",
  "unmatched",
  "not_provided"
] as const;

export type PackagingMatchStatus =
  (typeof PACKAGING_MATCH_STATUSES)[number];

export type PriorityInspectionStatus =
  | "complete"
  | "retryable"
  | "structural_anomaly"
  | "blocked";

export interface ReconciledFieldRef {
  readonly key: string;
  readonly label: string;
  readonly section: string;
  readonly controlKind: string;
  readonly skuId?: string;
  readonly row?: number;
}

export interface ReconciledPageIssue {
  readonly category: "required_empty";
  readonly severity: "error" | "warning";
  readonly ruleId: string;
  readonly message: string;
  readonly evidence: string;
  readonly field?: ReconciledFieldRef;
}

export interface ReconciledPlatformReminder {
  readonly category: "platform_warning";
  readonly severity: "error" | "warning";
  readonly ruleId: string;
  readonly message: string;
  readonly evidence: string;
}

export interface ReconciledInspectionAnomaly {
  readonly code: string;
  readonly classification: string;
  readonly retryable: boolean;
  readonly message: string;
}

export interface ReconciledProductInspection {
  readonly productId: string;
  readonly inspectionStatus: PriorityInspectionStatus;
  readonly packagingMatchStatus: PackagingMatchStatus;
  readonly baselineInspectionPerformed: boolean;
  readonly pageIssues: readonly ReconciledPageIssue[];
  readonly platformReminders: readonly ReconciledPlatformReminder[];
  readonly inspectionAnomalies: readonly ReconciledInspectionAnomaly[];
}

export interface IssueReconciliationSummary {
  readonly totalProducts: number;
  readonly inspectedProducts: number;
  readonly affectedProducts: number;
  readonly pageIssueCount: number;
  readonly platformReminderCount: number;
  readonly inspectionAnomalyCount: number;
  readonly matchStatusCounts: Readonly<Record<PackagingMatchStatus, number>>;
}

export interface IssueReconciliationResult {
  readonly reconciliationVersion: typeof ISSUE_RECONCILIATION_VERSION;
  readonly products: readonly ReconciledProductInspection[];
  readonly summary: IssueReconciliationSummary;
}

export interface IssueReportContext {
  readonly runId?: string;
  readonly shopId?: string;
  readonly shopName?: string;
  readonly scopeLabel?: string;
}

export interface DeterministicIssueReport {
  readonly schemaVersion: "bpa.issue-report/1";
  readonly reportVersion: typeof ISSUE_REPORT_VERSION;
  readonly context?: IssueReportContext;
  readonly summary: IssueReconciliationSummary;
  readonly products: readonly ReconciledProductInspection[];
  /**
   * Covers only page findings, platform reminders, and inspection anomalies.
   * Match status is deliberately excluded from this problem fingerprint.
   */
  readonly issueFingerprint: string;
  readonly reportDigest: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(
  value: unknown,
  label: string,
  maximum: number
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array with at most ${maximum} items`);
  }
  return value;
}

function textValue(
  value: unknown,
  label: string,
  maximum = MAX_TEXT_LENGTH
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters`);
  }
  return normalized;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function fieldValue(value: unknown, label: string): ReconciledFieldRef {
  const field = objectValue(value, label);
  const row = field.row;
  if (
    row !== undefined &&
    (!Number.isSafeInteger(row) || (row as number) < 0)
  ) {
    throw new Error(`${label}.row must be a non-negative integer`);
  }
  const skuId =
    field.skuId === undefined
      ? undefined
      : textValue(field.skuId, `${label}.skuId`, 200);
  return {
    key: textValue(field.key, `${label}.key`, 200),
    label: textValue(field.label, `${label}.label`, 200),
    section: textValue(field.section, `${label}.section`, 200),
    controlKind: textValue(
      field.controlKind,
      `${label}.controlKind`,
      100
    ),
    ...(skuId === undefined ? {} : { skuId }),
    ...(row === undefined ? {} : { row: row as number })
  };
}

function findingValue(
  value: unknown,
  label: string
): ReconciledPageIssue | ReconciledPlatformReminder {
  const finding = objectValue(value, label);
  const category = enumValue(
    finding.category,
    ["required_empty", "platform_warning"] as const,
    `${label}.category`
  );
  const base = {
    category,
    severity: enumValue(
      finding.severity,
      ["error", "warning"] as const,
      `${label}.severity`
    ),
    ruleId: textValue(finding.ruleId, `${label}.ruleId`, 200),
    message: textValue(finding.message, `${label}.message`),
    evidence: textValue(finding.evidence, `${label}.evidence`)
  };
  if (category === "platform_warning") {
    return { ...base, category };
  }
  return {
    ...base,
    category,
    ...(finding.field === undefined
      ? {}
      : { field: fieldValue(finding.field, `${label}.field`) })
  };
}

function anomalyValue(
  value: unknown,
  label: string
): ReconciledInspectionAnomaly {
  const anomaly = objectValue(value, label);
  return {
    code: textValue(anomaly.code, `${label}.code`, 200),
    classification: textValue(
      anomaly.classification,
      `${label}.classification`,
      100
    ),
    retryable: booleanValue(anomaly.retryable, `${label}.retryable`),
    message: textValue(anomaly.message, `${label}.message`)
  };
}

function compareStable(left: unknown, right: unknown): number {
  return compareText(canonicalJson(left), canonicalJson(right));
}

function uniqueSorted<T>(values: readonly T[]): readonly T[] {
  return [
    ...new Map(
      values.map((value) => [canonicalJson(value), value])
    ).values()
  ].sort(compareStable);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function emptyMatchCounts(): Record<PackagingMatchStatus, number> {
  return {
    matched: 0,
    smart_matched: 0,
    bound: 0,
    ambiguous: 0,
    unmatched: 0,
    not_provided: 0
  };
}

/**
 * Reconciles only observations produced by the read-only editor inspector.
 * Packaging match state remains metadata and can never be converted into a
 * page issue or platform reminder.
 */
export function reconcilePriorityInspectionResults(
  input: unknown
): IssueReconciliationResult {
  const root = objectValue(input, "reconcile input");
  const inspections = arrayValue(
    root.inspections,
    "inspections",
    MAX_RECONCILE_PRODUCTS
  );
  const products: ReconciledProductInspection[] = [];
  const productIds = new Set<string>();
  let findingCount = 0;

  for (const [index, value] of inspections.entries()) {
    const label = `inspections[${index}]`;
    const inspection = objectValue(value, label);
    const productId = textValue(
      inspection.productId,
      `${label}.productId`,
      200
    );
    if (productIds.has(productId)) {
      throw new Error(`Duplicate inspection productId: ${productId}`);
    }
    productIds.add(productId);
    const findings = arrayValue(
      inspection.issues,
      `${label}.issues`,
      MAX_FINDINGS_PER_PRODUCT
    ).map((finding, findingIndex) =>
      findingValue(finding, `${label}.issues[${findingIndex}]`)
    );
    const pageIssues = uniqueSorted(
      findings.filter(
        (finding): finding is ReconciledPageIssue =>
          finding.category === "required_empty"
      )
    );
    const platformReminders = uniqueSorted(
      findings.filter(
        (finding): finding is ReconciledPlatformReminder =>
          finding.category === "platform_warning"
      )
    );
    const inspectionAnomalies = uniqueSorted(
      arrayValue(
        inspection.anomalies,
        `${label}.anomalies`,
        MAX_ANOMALIES_PER_PRODUCT
      ).map((anomaly, anomalyIndex) =>
        anomalyValue(anomaly, `${label}.anomalies[${anomalyIndex}]`)
      )
    );
    findingCount +=
      pageIssues.length +
      platformReminders.length +
      inspectionAnomalies.length;
    if (findingCount > MAX_RECONCILE_FINDINGS) {
      throw new Error(
        `Reconciliation exceeds ${MAX_RECONCILE_FINDINGS} total findings`
      );
    }
    products.push({
      productId,
      inspectionStatus: enumValue(
        inspection.status,
        [
          "complete",
          "retryable",
          "structural_anomaly",
          "blocked"
        ] as const,
        `${label}.status`
      ),
      packagingMatchStatus: enumValue(
        inspection.packagingMatchStatus,
        PACKAGING_MATCH_STATUSES,
        `${label}.packagingMatchStatus`
      ),
      baselineInspectionPerformed: booleanValue(
        inspection.baselineInspectionPerformed,
        `${label}.baselineInspectionPerformed`
      ),
      pageIssues,
      platformReminders,
      inspectionAnomalies
    });
  }
  products.sort((left, right) =>
    compareText(left.productId, right.productId)
  );
  const matchStatusCounts = emptyMatchCounts();
  for (const product of products) {
    matchStatusCounts[product.packagingMatchStatus] += 1;
  }
  const pageIssueCount = products.reduce(
    (sum, product) => sum + product.pageIssues.length,
    0
  );
  const platformReminderCount = products.reduce(
    (sum, product) => sum + product.platformReminders.length,
    0
  );
  const inspectionAnomalyCount = products.reduce(
    (sum, product) => sum + product.inspectionAnomalies.length,
    0
  );
  return {
    reconciliationVersion: ISSUE_RECONCILIATION_VERSION,
    products,
    summary: {
      totalProducts: products.length,
      inspectedProducts: products.filter(
        (product) => product.baselineInspectionPerformed
      ).length,
      affectedProducts: products.filter(
        (product) =>
          product.pageIssues.length > 0 ||
          product.platformReminders.length > 0 ||
          product.inspectionAnomalies.length > 0
      ).length,
      pageIssueCount,
      platformReminderCount,
      inspectionAnomalyCount,
      matchStatusCounts
    }
  };
}

function reportContext(value: unknown): IssueReportContext | undefined {
  if (value === undefined) return undefined;
  const context = objectValue(value, "report context");
  const bounded = (key: keyof IssueReportContext): string | undefined =>
    context[key] === undefined
      ? undefined
      : textValue(context[key], `report context.${key}`, 200);
  const runId = bounded("runId");
  const shopId = bounded("shopId");
  const shopName = bounded("shopName");
  const scopeLabel = bounded("scopeLabel");
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(shopId === undefined ? {} : { shopId }),
    ...(shopName === undefined ? {} : { shopName }),
    ...(scopeLabel === undefined ? {} : { scopeLabel })
  };
}

/**
 * Rebuilds reconciliation from product facts instead of trusting supplied
 * counters. This makes it impossible for unmatched/ambiguous counts to leak
 * into issue statistics.
 */
export function buildDeterministicIssueReport(
  input: unknown
): DeterministicIssueReport {
  const root = objectValue(input, "report input");
  const supplied = objectValue(root.reconciliation, "reconciliation");
  const suppliedProducts = arrayValue(
    supplied.products,
    "reconciliation.products",
    MAX_RECONCILE_PRODUCTS
  );
  const reconciliation = reconcilePriorityInspectionResults({
    inspections: suppliedProducts.map((value, index) => {
      const product = objectValue(
        value,
        `reconciliation.products[${index}]`
      );
      return {
        productId: product.productId,
        status: product.inspectionStatus,
        packagingMatchStatus: product.packagingMatchStatus,
        baselineInspectionPerformed: product.baselineInspectionPerformed,
        issues: [
          ...arrayValue(
            product.pageIssues,
            `reconciliation.products[${index}].pageIssues`,
            MAX_FINDINGS_PER_PRODUCT
          ),
          ...arrayValue(
            product.platformReminders,
            `reconciliation.products[${index}].platformReminders`,
            MAX_FINDINGS_PER_PRODUCT
          )
        ],
        anomalies: product.inspectionAnomalies
      };
    })
  });
  const context = reportContext(root.context);
  const issueFacts = reconciliation.products.map((product) => ({
    productId: product.productId,
    pageIssues: product.pageIssues,
    platformReminders: product.platformReminders,
    inspectionAnomalies: product.inspectionAnomalies
  }));
  const base: Omit<DeterministicIssueReport, "reportDigest"> = {
    schemaVersion: "bpa.issue-report/1" as const,
    reportVersion: ISSUE_REPORT_VERSION,
    ...(context === undefined ? {} : { context }),
    summary: reconciliation.summary,
    products: reconciliation.products,
    issueFingerprint: stableDigest(issueFacts)
  };
  return {
    ...base,
    reportDigest: stableDigest(base)
  };
}
