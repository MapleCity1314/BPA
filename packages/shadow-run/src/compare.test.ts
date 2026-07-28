import { describe, expect, it } from "vitest";
import { compareShadowRuns } from "./index.js";

const issueA = `sha256:${"a".repeat(64)}`;
const issueB = `sha256:${"b".repeat(64)}`;

function run(
  source: "legacy_plugin" | "bpa",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "bpa.shadow-run/1",
    source,
    shop: { id: "shop-1", name: "一号店" },
    scope: {
      key: "selling-products",
      statusTab: { id: "selling", label: "出售中" },
      filters: {
        category: ["snack"],
        status: "active"
      }
    },
    counts: { expected: 2, observed: 2 },
    products: [
      {
        id: "product-1",
        title: "商品一",
        issueFingerprints: [issueA],
        packagingMatchStatus: "unmatched"
      },
      {
        id: "product-2",
        title: "商品二",
        issueFingerprints: [],
        packagingMatchStatus: "matched"
      }
    ],
    recovery: {
      expected: { page: 2, scrollTop: 360 },
      observed: { page: 2, scrollTop: 360 }
    },
    ...overrides
  };
}

describe("compareShadowRuns", () => {
  it("advances identical read-only facts regardless of packaging match status", () => {
    const legacyPlugin = run("legacy_plugin");
    const bpa = run("bpa", {
      products: [
        {
          id: "product-1",
          title: "商品一",
          issueFingerprints: [issueA],
          packagingMatchStatus: "bound"
        },
        {
          id: "product-2",
          title: "商品二",
          issueFingerprints: [],
          packagingMatchStatus: "ambiguous"
        }
      ]
    });
    const result = compareShadowRuns({ legacyPlugin, bpa });
    expect(result).toMatchObject({
      schemaVersion: "bpa.shadow-diff/1",
      comparatorVersion: "1.0.0",
      differences: [],
      summary: {
        total: 0,
        blocking: 0,
        warnings: 0,
        blockingCodes: []
      },
      severity: "none",
      canAdvanceMigration: true,
      decision: "advance"
    });
    expect(result.comparisonDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("emits stable blocking diffs for the complete migration acceptance surface", () => {
    const result = compareShadowRuns({
      legacyPlugin: run("legacy_plugin"),
      bpa: run("bpa", {
        shop: { id: "shop-2", name: "二号店" },
        scope: {
          key: "all-products",
          statusTab: { id: "all", label: "全部" },
          filters: {
            category: ["drink"],
            owner: "self"
          }
        },
        counts: { expected: 2, observed: 2 },
        products: [
          {
            id: "product-1",
            title: "商品一（新版）",
            issueFingerprints: [issueB]
          },
          {
            id: "product-3",
            title: "商品三",
            issueFingerprints: []
          }
        ],
        recovery: {
          expected: { page: 3, scrollTop: 400 },
          observed: { page: 3, scrollTop: 400 }
        }
      })
    });
    expect(result.canAdvanceMigration).toBe(false);
    expect(result.decision).toBe("hold");
    expect(result.severity).toBe("blocking");
    expect(result.summary.blockingCodes).toEqual(
      expect.arrayContaining([
        "SHOP_ID_CHANGED",
        "SCOPE_KEY_CHANGED",
        "STATUS_TAB_ID_CHANGED",
        "FILTER_VALUES_CHANGED",
        "FILTER_MISSING",
        "FILTER_UNEXPECTED",
        "PRODUCT_MISSING",
        "PRODUCT_UNEXPECTED",
        "PRODUCT_TITLE_CHANGED",
        "ISSUE_FINGERPRINTS_CHANGED",
        "RECOVERY_EXPECTED_PAGE_CHANGED",
        "RECOVERY_EXPECTED_SCROLL_CHANGED",
        "RECOVERY_OBSERVED_PAGE_CHANGED",
        "RECOVERY_OBSERVED_SCROLL_CHANGED"
      ])
    );
    expect(result.summary.warnings).toBe(2);
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        code: "STATUS_TAB_LABEL_CHANGED",
        severity: "warning"
      })
    );
    expect(result.differences).toEqual(
      [...result.differences].sort((left, right) => {
        const leftKey = `${left.source}\0${left.path}\0${left.code}`;
        const rightKey = `${right.source}\0${right.path}\0${right.code}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
    );
  });

  it("holds when either run is internally incomplete or fails restoration", () => {
    const result = compareShadowRuns({
      legacyPlugin: run("legacy_plugin"),
      bpa: run("bpa", {
        counts: { expected: 3, observed: 2 },
        products: [
          {
            id: "product-1",
            title: "商品一",
            issueFingerprints: [issueA]
          }
        ],
        recovery: {
          expected: { page: 2, scrollTop: 360 },
          observed: { page: 1, scrollTop: 0 }
        }
      })
    });
    const bpaCodes = result.differences
      .filter((difference) => difference.source === "bpa")
      .map((difference) => difference.code);
    expect(bpaCodes).toEqual([
      "COUNT_EXPECTED_OBSERVED_MISMATCH",
      "COUNT_PRODUCTS_OBSERVED_MISMATCH",
      "RECOVERY_PAGE_MISMATCH",
      "RECOVERY_SCROLL_MISMATCH"
    ]);
    expect(result.canAdvanceMigration).toBe(false);
  });

  it("allows a shop display-name warning when authoritative facts match", () => {
    const result = compareShadowRuns({
      legacyPlugin: run("legacy_plugin"),
      bpa: run("bpa", {
        shop: { id: "shop-1", name: "一号店（新展示名）" }
      })
    });
    expect(result.differences).toEqual([
      expect.objectContaining({
        code: "SHOP_NAME_CHANGED",
        severity: "warning",
        kind: "changed"
      })
    ]);
    expect(result).toMatchObject({
      canAdvanceMigration: true,
      decision: "advance",
      severity: "warning",
      summary: { blocking: 0, warnings: 1 }
    });
  });

  it("produces an identical machine result for reordered equivalent input", () => {
    const first = compareShadowRuns({
      legacyPlugin: run("legacy_plugin"),
      bpa: run("bpa")
    });
    const second = compareShadowRuns({
      legacyPlugin: run("legacy_plugin", {
        scope: {
          key: "selling-products",
          statusTab: { id: "selling", label: "出售中" },
          filters: { status: ["active"], category: "snack" }
        },
        products: [
          {
            id: "product-2",
            title: "商品二",
            issueFingerprints: [],
            packagingMatchStatus: "not_provided"
          },
          {
            id: "product-1",
            title: "商品一",
            issueFingerprints: [issueA, issueA],
            packagingMatchStatus: "smart_matched"
          }
        ]
      }),
      bpa: run("bpa", {
        products: [...(run("bpa").products as readonly unknown[])].reverse()
      })
    });
    expect(second).toEqual(first);
  });
});
