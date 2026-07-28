import {
  PACKAGING_MATCH_STATUSES,
  SHADOW_RUN_SCHEMA_VERSION,
  type NormalizedShadowFilter,
  type NormalizedShadowProduct,
  type NormalizedShadowRun,
  type ShadowFilterValue,
  type ShadowRecoveryPositionInput,
  type ShadowRunSource
} from "./types.js";
import {
  canonicalJson,
  compareText,
  stableDigest,
  uniqueSorted
} from "./stable.js";

export const MAX_SHADOW_PRODUCTS = 10_000;
export const MAX_ISSUES_PER_PRODUCT = 100;
export const MAX_SHADOW_FILTERS = 100;
export const MAX_FILTER_VALUES = 100;

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function objectValue(
  value: unknown,
  label: string,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const unknownKeys = Object.keys(object).filter(
    (key) => !allowedKeys.includes(key)
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} contains non-redacted or unknown fields: ${unknownKeys
        .sort(compareText)
        .join(", ")}`
    );
  }
  return object;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizedText(
  value: unknown,
  label: string,
  maximum = MAX_TEXT_LENGTH
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters`);
  }
  return normalized;
}

function integerValue(
  value: unknown,
  label: string,
  minimum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value as number;
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

function sourceValue(value: unknown, expected: ShadowRunSource): ShadowRunSource {
  if (value !== expected) {
    throw new Error(`shadow run source must be ${expected}`);
  }
  return expected;
}

function normalizedFilterValues(
  value: unknown,
  label: string
): readonly ShadowFilterValue[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_FILTER_VALUES) {
    throw new Error(
      `${label} must contain at most ${MAX_FILTER_VALUES} values`
    );
  }
  const normalized = values.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (typeof entry === "string") {
      return entry.normalize("NFKC").replace(/\s+/gu, " ").trim();
    }
    if (
      entry === null ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return entry;
    }
    throw new Error(
      `${entryLabel} must be a string, finite number, boolean, or null`
    );
  });
  return [
    ...new Map(
      normalized.map((entry) => [canonicalJson(entry), entry])
    ).values()
  ].sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right))
  );
}

function normalizedFilters(value: unknown): readonly NormalizedShadowFilter[] {
  const filters = recordValue(value, "scope.filters");
  const entries = Object.entries(filters);
  if (entries.length > MAX_SHADOW_FILTERS) {
    throw new Error(
      `scope.filters must contain at most ${MAX_SHADOW_FILTERS} filters`
    );
  }
  const normalized = entries.map(([rawKey, rawValues]) => ({
    key: normalizedText(rawKey, "scope filter key", MAX_ID_LENGTH),
    values: normalizedFilterValues(
      rawValues,
      `scope.filters.${rawKey}`
    )
  }));
  normalized.sort((left, right) => compareText(left.key, right.key));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.key === normalized[index]?.key) {
      throw new Error(`scope.filters contains duplicate normalized keys`);
    }
  }
  return normalized;
}

function recoveryPosition(
  value: unknown,
  label: string
): ShadowRecoveryPositionInput {
  const position = objectValue(value, label, ["page", "scrollTop"]);
  return {
    page: integerValue(position.page, `${label}.page`, 1),
    scrollTop: integerValue(position.scrollTop, `${label}.scrollTop`, 0)
  };
}

function normalizedProduct(
  value: unknown,
  index: number
): NormalizedShadowProduct {
  const label = `products[${index}]`;
  const product = objectValue(value, label, [
    "id",
    "title",
    "issueFingerprints",
    "packagingMatchStatus"
  ]);
  if (
    product.packagingMatchStatus !== undefined &&
    !PACKAGING_MATCH_STATUSES.includes(
      product.packagingMatchStatus as (typeof PACKAGING_MATCH_STATUSES)[number]
    )
  ) {
    throw new Error(`${label}.packagingMatchStatus is invalid`);
  }
  const issueFingerprints = uniqueSorted(
    arrayValue(
      product.issueFingerprints,
      `${label}.issueFingerprints`,
      MAX_ISSUES_PER_PRODUCT
    ).map((fingerprint, fingerprintIndex) => {
      const normalized = normalizedText(
        fingerprint,
        `${label}.issueFingerprints[${fingerprintIndex}]`,
        71
      );
      if (!DIGEST_PATTERN.test(normalized)) {
        throw new Error(
          `${label}.issueFingerprints[${fingerprintIndex}] must be sha256`
        );
      }
      return normalized;
    })
  );
  return {
    id: normalizedText(product.id, `${label}.id`, MAX_ID_LENGTH),
    title: normalizedText(product.title, `${label}.title`),
    issueFingerprints
  };
}

/**
 * Validates and canonicalizes a deliberately redacted shadow-run result.
 * Packaging match status is validated but intentionally absent from the
 * normalized output and digest.
 */
export function normalizeShadowRun(
  input: unknown,
  expectedSource: ShadowRunSource
): NormalizedShadowRun {
  const root = objectValue(input, "shadow run", [
    "schemaVersion",
    "source",
    "shop",
    "scope",
    "counts",
    "products",
    "recovery"
  ]);
  if (root.schemaVersion !== SHADOW_RUN_SCHEMA_VERSION) {
    throw new Error(
      `shadow run schemaVersion must be ${SHADOW_RUN_SCHEMA_VERSION}`
    );
  }
  const shop = objectValue(root.shop, "shop", ["id", "name"]);
  const scope = objectValue(root.scope, "scope", [
    "key",
    "statusTab",
    "filters"
  ]);
  const statusTab = objectValue(scope.statusTab, "scope.statusTab", [
    "id",
    "label"
  ]);
  const counts = objectValue(root.counts, "counts", [
    "expected",
    "observed"
  ]);
  const recovery = objectValue(root.recovery, "recovery", [
    "expected",
    "observed"
  ]);
  const products = arrayValue(
    root.products,
    "products",
    MAX_SHADOW_PRODUCTS
  ).map(normalizedProduct);
  products.sort((left, right) => compareText(left.id, right.id));
  for (let index = 1; index < products.length; index += 1) {
    if (products[index - 1]?.id === products[index]?.id) {
      throw new Error(`products contains duplicate normalized product IDs`);
    }
  }
  const shopName =
    shop.name === undefined
      ? undefined
      : normalizedText(shop.name, "shop.name");
  const base = {
    schemaVersion: SHADOW_RUN_SCHEMA_VERSION,
    source: sourceValue(root.source, expectedSource),
    shop: {
      id: normalizedText(shop.id, "shop.id", MAX_ID_LENGTH),
      ...(shopName === undefined ? {} : { name: shopName })
    },
    scope: {
      key: normalizedText(scope.key, "scope.key", MAX_ID_LENGTH),
      statusTab: {
        id: normalizedText(
          statusTab.id,
          "scope.statusTab.id",
          MAX_ID_LENGTH
        ),
        label: normalizedText(
          statusTab.label,
          "scope.statusTab.label"
        )
      },
      filters: normalizedFilters(scope.filters)
    },
    counts: {
      expected: integerValue(counts.expected, "counts.expected", 0),
      observed: integerValue(counts.observed, "counts.observed", 0)
    },
    products,
    recovery: {
      expected: recoveryPosition(recovery.expected, "recovery.expected"),
      observed: recoveryPosition(recovery.observed, "recovery.observed")
    }
  } as const;
  return {
    ...base,
    digest: stableDigest(base)
  };
}
