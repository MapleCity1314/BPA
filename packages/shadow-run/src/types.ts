export const SHADOW_RUN_SCHEMA_VERSION = "bpa.shadow-run/1" as const;
export const SHADOW_DIFF_SCHEMA_VERSION = "bpa.shadow-diff/1" as const;
export const SHADOW_COMPARATOR_VERSION = "1.0.0" as const;

export const SHADOW_RUN_SOURCES = ["legacy_plugin", "bpa"] as const;
export type ShadowRunSource = (typeof SHADOW_RUN_SOURCES)[number];

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

export interface ShadowShopInput {
  readonly id: string;
  readonly name?: string;
}

export interface ShadowScopeInput {
  readonly key: string;
  readonly statusTab: {
    readonly id: string;
    readonly label: string;
  };
  readonly filters: Readonly<
    Record<
      string,
      ShadowFilterValue | readonly ShadowFilterValue[]
    >
  >;
}

export type ShadowFilterValue = string | number | boolean | null;

export interface ShadowCountInput {
  readonly expected: number;
  readonly observed: number;
}

export interface ShadowProductInput {
  readonly id: string;
  readonly title: string;
  /**
   * Business issue fingerprints only: real page issues and platform
   * reminders. Packaging match outcomes are represented separately below.
   */
  readonly issueFingerprints: readonly string[];
  readonly packagingMatchStatus?: PackagingMatchStatus;
}

export interface ShadowRecoveryPositionInput {
  readonly page: number;
  readonly scrollTop: number;
}

export interface ShadowRecoveryInput {
  readonly expected: ShadowRecoveryPositionInput;
  readonly observed: ShadowRecoveryPositionInput;
}

export interface ShadowRunInput {
  readonly schemaVersion: typeof SHADOW_RUN_SCHEMA_VERSION;
  readonly source: ShadowRunSource;
  readonly shop: ShadowShopInput;
  readonly scope: ShadowScopeInput;
  readonly counts: ShadowCountInput;
  readonly products: readonly ShadowProductInput[];
  readonly recovery: ShadowRecoveryInput;
}

export interface NormalizedShadowFilter {
  readonly key: string;
  readonly values: readonly ShadowFilterValue[];
}

export interface NormalizedShadowProduct {
  readonly id: string;
  readonly title: string;
  readonly issueFingerprints: readonly string[];
}

export interface NormalizedShadowRun {
  readonly schemaVersion: typeof SHADOW_RUN_SCHEMA_VERSION;
  readonly source: ShadowRunSource;
  readonly shop: {
    readonly id: string;
    readonly name?: string;
  };
  readonly scope: {
    readonly key: string;
    readonly statusTab: {
      readonly id: string;
      readonly label: string;
    };
    readonly filters: readonly NormalizedShadowFilter[];
  };
  readonly counts: ShadowCountInput;
  readonly products: readonly NormalizedShadowProduct[];
  readonly recovery: ShadowRecoveryInput;
  readonly digest: string;
}

export const SHADOW_DIFF_SEVERITIES = ["blocking", "warning"] as const;
export type ShadowDiffSeverity =
  (typeof SHADOW_DIFF_SEVERITIES)[number];

export const SHADOW_DIFF_KINDS = [
  "changed",
  "missing",
  "unexpected",
  "inconsistent"
] as const;
export type ShadowDiffKind = (typeof SHADOW_DIFF_KINDS)[number];

export const SHADOW_DIFF_CODES = [
  "SHOP_ID_CHANGED",
  "SHOP_NAME_CHANGED",
  "SCOPE_KEY_CHANGED",
  "STATUS_TAB_ID_CHANGED",
  "STATUS_TAB_LABEL_CHANGED",
  "FILTER_MISSING",
  "FILTER_UNEXPECTED",
  "FILTER_VALUES_CHANGED",
  "EXPECTED_COUNT_CHANGED",
  "OBSERVED_COUNT_CHANGED",
  "COUNT_EXPECTED_OBSERVED_MISMATCH",
  "COUNT_PRODUCTS_OBSERVED_MISMATCH",
  "PRODUCT_MISSING",
  "PRODUCT_UNEXPECTED",
  "PRODUCT_TITLE_CHANGED",
  "ISSUE_FINGERPRINTS_CHANGED",
  "RECOVERY_EXPECTED_PAGE_CHANGED",
  "RECOVERY_EXPECTED_SCROLL_CHANGED",
  "RECOVERY_OBSERVED_PAGE_CHANGED",
  "RECOVERY_OBSERVED_SCROLL_CHANGED",
  "RECOVERY_PAGE_MISMATCH",
  "RECOVERY_SCROLL_MISMATCH"
] as const;
export type ShadowDiffCode = (typeof SHADOW_DIFF_CODES)[number];

export type ShadowComparableValue =
  | string
  | number
  | boolean
  | null
  | readonly ShadowFilterValue[];

export interface ShadowDifference {
  readonly source: ShadowRunSource | "comparison";
  readonly path: string;
  readonly code: ShadowDiffCode;
  readonly kind: ShadowDiffKind;
  readonly severity: ShadowDiffSeverity;
  readonly expected?: ShadowComparableValue;
  readonly observed?: ShadowComparableValue;
}

export interface ShadowDiffSummary {
  readonly total: number;
  readonly blocking: number;
  readonly warnings: number;
  readonly blockingCodes: readonly ShadowDiffCode[];
}

export interface ShadowRunComparison {
  readonly schemaVersion: typeof SHADOW_DIFF_SCHEMA_VERSION;
  readonly comparatorVersion: typeof SHADOW_COMPARATOR_VERSION;
  readonly legacyDigest: string;
  readonly bpaDigest: string;
  readonly differences: readonly ShadowDifference[];
  readonly summary: ShadowDiffSummary;
  readonly severity: "none" | ShadowDiffSeverity;
  readonly canAdvanceMigration: boolean;
  readonly decision: "advance" | "hold";
  readonly comparisonDigest: string;
}

export interface CompareShadowRunsInput {
  readonly legacyPlugin: unknown;
  readonly bpa: unknown;
}
