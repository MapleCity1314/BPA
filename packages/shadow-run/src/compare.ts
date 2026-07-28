import {
  SHADOW_COMPARATOR_VERSION,
  SHADOW_DIFF_SCHEMA_VERSION,
  type CompareShadowRunsInput,
  type NormalizedShadowFilter,
  type NormalizedShadowProduct,
  type NormalizedShadowRun,
  type ShadowComparableValue,
  type ShadowDiffCode,
  type ShadowDifference,
  type ShadowDiffKind,
  type ShadowDiffSeverity,
  type ShadowRunComparison,
  type ShadowRunSource
} from "./types.js";
import { normalizeShadowRun } from "./normalize.js";
import { canonicalJson, compareText, stableDigest, uniqueSorted } from "./stable.js";

type DifferenceInput = Omit<ShadowDifference, "expected" | "observed"> & {
  readonly expected?: ShadowComparableValue;
  readonly observed?: ShadowComparableValue;
};

function appendDifference(
  differences: ShadowDifference[],
  input: DifferenceInput
): void {
  differences.push({
    source: input.source,
    path: input.path,
    code: input.code,
    kind: input.kind,
    severity: input.severity,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.observed === undefined ? {} : { observed: input.observed })
  });
}

function appendChanged(
  differences: ShadowDifference[],
  input: {
    readonly source: ShadowRunSource | "comparison";
    readonly path: string;
    readonly code: ShadowDiffCode;
    readonly severity: ShadowDiffSeverity;
    readonly expected: ShadowComparableValue | undefined;
    readonly observed: ShadowComparableValue | undefined;
  }
): void {
  if (canonicalJson(input.expected) === canonicalJson(input.observed)) return;
  appendDifference(differences, {
    source: input.source,
    path: input.path,
    code: input.code,
    severity: input.severity,
    kind:
      input.observed === undefined
        ? "missing"
        : input.expected === undefined
          ? "unexpected"
          : "changed",
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.observed === undefined ? {} : { observed: input.observed })
  });
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function compareInternalConsistency(
  run: NormalizedShadowRun,
  differences: ShadowDifference[]
): void {
  if (run.counts.expected !== run.counts.observed) {
    appendDifference(differences, {
      source: run.source,
      path: "/counts/observed",
      code: "COUNT_EXPECTED_OBSERVED_MISMATCH",
      kind: "inconsistent",
      severity: "blocking",
      expected: run.counts.expected,
      observed: run.counts.observed
    });
  }
  if (run.products.length !== run.counts.observed) {
    appendDifference(differences, {
      source: run.source,
      path: "/products",
      code: "COUNT_PRODUCTS_OBSERVED_MISMATCH",
      kind: "inconsistent",
      severity: "blocking",
      expected: run.counts.observed,
      observed: run.products.length
    });
  }
  if (run.recovery.expected.page !== run.recovery.observed.page) {
    appendDifference(differences, {
      source: run.source,
      path: "/recovery/observed/page",
      code: "RECOVERY_PAGE_MISMATCH",
      kind: "inconsistent",
      severity: "blocking",
      expected: run.recovery.expected.page,
      observed: run.recovery.observed.page
    });
  }
  if (run.recovery.expected.scrollTop !== run.recovery.observed.scrollTop) {
    appendDifference(differences, {
      source: run.source,
      path: "/recovery/observed/scrollTop",
      code: "RECOVERY_SCROLL_MISMATCH",
      kind: "inconsistent",
      severity: "blocking",
      expected: run.recovery.expected.scrollTop,
      observed: run.recovery.observed.scrollTop
    });
  }
}

function compareFilters(
  legacy: readonly NormalizedShadowFilter[],
  bpa: readonly NormalizedShadowFilter[],
  differences: ShadowDifference[]
): void {
  const legacyByKey = new Map(legacy.map((filter) => [filter.key, filter]));
  const bpaByKey = new Map(bpa.map((filter) => [filter.key, filter]));
  const keys = uniqueSorted([...legacyByKey.keys(), ...bpaByKey.keys()]);
  for (const key of keys) {
    const expected = legacyByKey.get(key);
    const observed = bpaByKey.get(key);
    const path = `/scope/filters/${pointerSegment(key)}`;
    if (!observed && expected) {
      appendDifference(differences, {
        source: "comparison",
        path,
        code: "FILTER_MISSING",
        kind: "missing",
        severity: "blocking",
        expected: expected.values
      });
    } else if (!expected && observed) {
      appendDifference(differences, {
        source: "comparison",
        path,
        code: "FILTER_UNEXPECTED",
        kind: "unexpected",
        severity: "blocking",
        observed: observed.values
      });
    } else if (expected && observed) {
      appendChanged(differences, {
        source: "comparison",
        path,
        code: "FILTER_VALUES_CHANGED",
        severity: "blocking",
        expected: expected.values,
        observed: observed.values
      });
    }
  }
}

function compareProducts(
  legacy: readonly NormalizedShadowProduct[],
  bpa: readonly NormalizedShadowProduct[],
  differences: ShadowDifference[]
): void {
  const legacyById = new Map(legacy.map((product) => [product.id, product]));
  const bpaById = new Map(bpa.map((product) => [product.id, product]));
  const ids = uniqueSorted([...legacyById.keys(), ...bpaById.keys()]);
  for (const id of ids) {
    const expected = legacyById.get(id);
    const observed = bpaById.get(id);
    const path = `/products/${pointerSegment(id)}`;
    if (!observed && expected) {
      appendDifference(differences, {
        source: "comparison",
        path,
        code: "PRODUCT_MISSING",
        kind: "missing",
        severity: "blocking",
        expected: id
      });
    } else if (!expected && observed) {
      appendDifference(differences, {
        source: "comparison",
        path,
        code: "PRODUCT_UNEXPECTED",
        kind: "unexpected",
        severity: "blocking",
        observed: id
      });
    } else if (expected && observed) {
      appendChanged(differences, {
        source: "comparison",
        path: `${path}/title`,
        code: "PRODUCT_TITLE_CHANGED",
        severity: "blocking",
        expected: expected.title,
        observed: observed.title
      });
      appendChanged(differences, {
        source: "comparison",
        path: `${path}/issueFingerprints`,
        code: "ISSUE_FINGERPRINTS_CHANGED",
        severity: "blocking",
        expected: expected.issueFingerprints,
        observed: observed.issueFingerprints
      });
    }
  }
}

function compareCrossRun(
  legacy: NormalizedShadowRun,
  bpa: NormalizedShadowRun,
  differences: ShadowDifference[]
): void {
  appendChanged(differences, {
    source: "comparison",
    path: "/shop/id",
    code: "SHOP_ID_CHANGED",
    severity: "blocking",
    expected: legacy.shop.id,
    observed: bpa.shop.id
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/shop/name",
    code: "SHOP_NAME_CHANGED",
    severity: "warning",
    expected: legacy.shop.name,
    observed: bpa.shop.name
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/scope/key",
    code: "SCOPE_KEY_CHANGED",
    severity: "blocking",
    expected: legacy.scope.key,
    observed: bpa.scope.key
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/scope/statusTab/id",
    code: "STATUS_TAB_ID_CHANGED",
    severity: "blocking",
    expected: legacy.scope.statusTab.id,
    observed: bpa.scope.statusTab.id
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/scope/statusTab/label",
    code: "STATUS_TAB_LABEL_CHANGED",
    severity: "warning",
    expected: legacy.scope.statusTab.label,
    observed: bpa.scope.statusTab.label
  });
  compareFilters(legacy.scope.filters, bpa.scope.filters, differences);
  appendChanged(differences, {
    source: "comparison",
    path: "/counts/expected",
    code: "EXPECTED_COUNT_CHANGED",
    severity: "blocking",
    expected: legacy.counts.expected,
    observed: bpa.counts.expected
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/counts/observed",
    code: "OBSERVED_COUNT_CHANGED",
    severity: "blocking",
    expected: legacy.counts.observed,
    observed: bpa.counts.observed
  });
  compareProducts(legacy.products, bpa.products, differences);
  appendChanged(differences, {
    source: "comparison",
    path: "/recovery/expected/page",
    code: "RECOVERY_EXPECTED_PAGE_CHANGED",
    severity: "blocking",
    expected: legacy.recovery.expected.page,
    observed: bpa.recovery.expected.page
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/recovery/expected/scrollTop",
    code: "RECOVERY_EXPECTED_SCROLL_CHANGED",
    severity: "blocking",
    expected: legacy.recovery.expected.scrollTop,
    observed: bpa.recovery.expected.scrollTop
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/recovery/observed/page",
    code: "RECOVERY_OBSERVED_PAGE_CHANGED",
    severity: "blocking",
    expected: legacy.recovery.observed.page,
    observed: bpa.recovery.observed.page
  });
  appendChanged(differences, {
    source: "comparison",
    path: "/recovery/observed/scrollTop",
    code: "RECOVERY_OBSERVED_SCROLL_CHANGED",
    severity: "blocking",
    expected: legacy.recovery.observed.scrollTop,
    observed: bpa.recovery.observed.scrollTop
  });
}

function differenceOrder(left: ShadowDifference, right: ShadowDifference): number {
  return (
    compareText(left.source, right.source) ||
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(canonicalJson(left), canonicalJson(right))
  );
}

export function compareShadowRuns(
  input: CompareShadowRunsInput
): ShadowRunComparison {
  const legacy = normalizeShadowRun(input.legacyPlugin, "legacy_plugin");
  const bpa = normalizeShadowRun(input.bpa, "bpa");
  const differences: ShadowDifference[] = [];
  compareInternalConsistency(legacy, differences);
  compareInternalConsistency(bpa, differences);
  compareCrossRun(legacy, bpa, differences);
  differences.sort(differenceOrder);
  const blocking = differences.filter(
    (difference) => difference.severity === "blocking"
  );
  const warnings = differences.filter(
    (difference) => difference.severity === "warning"
  );
  const summary = {
    total: differences.length,
    blocking: blocking.length,
    warnings: warnings.length,
    blockingCodes: uniqueSorted(
      blocking.map((difference) => difference.code)
    ) as readonly ShadowDiffCode[]
  };
  const canAdvanceMigration = blocking.length === 0;
  const severity =
    blocking.length > 0
      ? ("blocking" as const)
      : warnings.length > 0
        ? ("warning" as const)
        : ("none" as const);
  const base = {
    schemaVersion: SHADOW_DIFF_SCHEMA_VERSION,
    comparatorVersion: SHADOW_COMPARATOR_VERSION,
    legacyDigest: legacy.digest,
    bpaDigest: bpa.digest,
    differences,
    summary,
    severity,
    canAdvanceMigration,
    decision: canAdvanceMigration ? ("advance" as const) : ("hold" as const)
  };
  return {
    ...base,
    comparisonDigest: stableDigest(base)
  };
}
