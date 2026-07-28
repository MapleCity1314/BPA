import { describe, expect, it } from "vitest";
import {
  MAX_ISSUES_PER_PRODUCT,
  normalizeShadowRun
} from "./index.js";

const issueA = `sha256:${"a".repeat(64)}`;
const issueB = `sha256:${"b".repeat(64)}`;

function input(
  source: "legacy_plugin" | "bpa",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "bpa.shadow-run/1",
    source,
    shop: { id: " shop-1 ", name: " 一号  店 " },
    scope: {
      key: " selling-products ",
      statusTab: { id: " selling ", label: " 出售中 " },
      filters: {
        featured: true,
        keyword: "",
        level: 2,
        nullable: null,
        品牌: [" B牌 ", "A牌", "A牌"],
        类目: " 休闲  食品 "
      }
    },
    counts: { expected: 2, observed: 2 },
    products: [
      {
        id: "product-2",
        title: " 全角Ａ  商品 ",
        issueFingerprints: [issueB, issueA, issueA],
        packagingMatchStatus: "unmatched"
      },
      {
        id: "product-1",
        title: "商品 一",
        issueFingerprints: [],
        packagingMatchStatus: "matched"
      }
    ],
    recovery: {
      expected: { page: 3, scrollTop: 420 },
      observed: { page: 3, scrollTop: 420 }
    },
    ...overrides
  };
}

describe("normalizeShadowRun", () => {
  it("canonicalizes redacted facts and excludes packaging match outcomes", () => {
    const normalized = normalizeShadowRun(
      input("legacy_plugin"),
      "legacy_plugin"
    );
    expect(normalized.shop).toEqual({ id: "shop-1", name: "一号 店" });
    expect(normalized.scope.filters).toEqual([
      { key: "featured", values: [true] },
      { key: "keyword", values: [""] },
      { key: "level", values: [2] },
      { key: "nullable", values: [null] },
      { key: "品牌", values: ["A牌", "B牌"] },
      { key: "类目", values: ["休闲 食品"] }
    ]);
    expect(normalized.products).toEqual([
      {
        id: "product-1",
        title: "商品 一",
        issueFingerprints: []
      },
      {
        id: "product-2",
        title: "全角A 商品",
        issueFingerprints: [issueA, issueB]
      }
    ]);
    expect(JSON.stringify(normalized)).not.toContain("packagingMatchStatus");
    expect(normalized.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("is stable across product, issue, and filter input order", () => {
    const first = normalizeShadowRun(
      input("legacy_plugin"),
      "legacy_plugin"
    );
    const reordered = input("legacy_plugin", {
      scope: {
        key: "selling-products",
        statusTab: { id: "selling", label: "出售中" },
        filters: {
          nullable: null,
          level: 2,
          keyword: "",
          featured: true,
          类目: ["休闲 食品"],
          品牌: ["B牌", "A牌"]
        }
      },
      products: [
        {
          id: "product-1",
          title: "商品 一",
          issueFingerprints: [],
          packagingMatchStatus: "ambiguous"
        },
        {
          id: "product-2",
          title: "全角A 商品",
          issueFingerprints: [issueA, issueB],
          packagingMatchStatus: "bound"
        }
      ]
    });
    const second = normalizeShadowRun(reordered, "legacy_plugin");
    expect(second).toEqual(first);
  });

  it("rejects duplicate products, invalid fingerprints, and unredacted fields", () => {
    expect(() =>
      normalizeShadowRun(
        input("legacy_plugin", {
          products: [
            {
              id: "same",
              title: "一",
              issueFingerprints: []
            },
            {
              id: " same ",
              title: "二",
              issueFingerprints: []
            }
          ]
        }),
        "legacy_plugin"
      )
    ).toThrow(/duplicate normalized product IDs/u);

    expect(() =>
      normalizeShadowRun(
        input("legacy_plugin", {
          products: [
            {
              id: "one",
              title: "一",
              issueFingerprints: ["packaging_unmatched"]
            }
          ]
        }),
        "legacy_plugin"
      )
    ).toThrow(/must be sha256/u);

    expect(() =>
      normalizeShadowRun(
        {
          ...input("legacy_plugin"),
          rawHtml: "<secret>"
        },
        "legacy_plugin"
      )
    ).toThrow(/non-redacted or unknown fields: rawHtml/u);
  });

  it("enforces source, finite integer, issue, and filter bounds", () => {
    expect(() =>
      normalizeShadowRun(input("bpa"), "legacy_plugin")
    ).toThrow(/source must be legacy_plugin/u);
    expect(() =>
      normalizeShadowRun(
        input("legacy_plugin", {
          counts: { expected: Number.NaN, observed: 2 }
        }),
        "legacy_plugin"
      )
    ).toThrow(/integer/u);
    expect(() =>
      normalizeShadowRun(
        input("legacy_plugin", {
          products: [
            {
              id: "one",
              title: "一",
              issueFingerprints: Array.from(
                { length: MAX_ISSUES_PER_PRODUCT + 1 },
                () => issueA
              )
            }
          ]
        }),
        "legacy_plugin"
      )
    ).toThrow(/at most/u);
    expect(() =>
      normalizeShadowRun(
        input("legacy_plugin", {
          recovery: {
            expected: { page: 0, scrollTop: 0 },
            observed: { page: 1, scrollTop: 0 }
          }
        }),
        "legacy_plugin"
      )
    ).toThrow(/page must be an integer >= 1/u);
  });
});
