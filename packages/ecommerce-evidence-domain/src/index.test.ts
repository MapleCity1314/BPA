import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCategorySpace,
  buildComparablePool,
  buildReferencePack,
  evaluateViralEvidence,
  normalizeProductIntent,
  type EcommerceEvidenceObject
} from "./index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/prepackaged-jianbing.input.json",
      import.meta.url
    ),
    "utf8"
  )
) as EcommerceEvidenceObject;

function replay(): EcommerceEvidenceObject {
  const productIntent = normalizeProductIntent(fixture.intent);
  const categorySpace = buildCategorySpace({
    intent: productIntent,
    products: fixture.products,
    exclusionRules: fixture.exclusionRules
  });
  const comparablePool = buildComparablePool({
    poolId: fixture.poolId,
    categorySpace,
    products: fixture.products
  });
  const evidenceClaims = evaluateViralEvidence({
    observedAt: fixture.observedAt,
    comparablePool,
    products: fixture.products
  });
  const referencePack = buildReferencePack({
    packId: fixture.packId,
    sourceRunId: fixture.sourceRunId,
    comparablePool,
    evidence: evidenceClaims,
    products: fixture.products
  });
  return {
    productIntent,
    categorySpace,
    comparablePool,
    evidenceClaims,
    referencePack
  };
}

describe("ecommerce evidence domain", () => {
  it("preserves the frozen prepackaged-jianbing decisions", () => {
    const output = replay();
    expect(output.productIntent).toMatchObject({
      schemaVersion: "product-intent/v0.2",
      intentId: "intent-prepackaged-jianbing-01"
    });
    expect(output.categorySpace).toMatchObject({
      schemaVersion: "category-space/v0.2",
      primaryCategory:
        "食品饮料/粮油调味/速食冻品/方便速食/冷藏食品/方便面/拉面/面皮/面饼"
    });
    expect(output.comparablePool).toMatchObject({
      tiers: [
        {
          tier: "DIRECT_COMPETITOR",
          products: ["heda", "chubei"]
        },
        {
          tier: "SUBSTITUTE_AND_CONTENT_REFERENCE",
          products: ["viji"]
        }
      ]
    });
    const claims = (
      output.evidenceClaims as EcommerceEvidenceObject
    ).claims as EcommerceEvidenceObject[];
    expect(
      claims.find((claim) => claim.id === "STRONGEST-OBSERVED-SALES")
    ).toMatchObject({
      level: "E2",
      subjectProducts: ["viji"]
    });
    expect(
      claims.find((claim) => claim.id === "NEW-PRODUCT-SAMPLE")
    ).toMatchObject({
      level: "E2",
      subjectProducts: ["chubei"]
    });
    expect(output.referencePack).toMatchObject({
      status: "READY_WITH_E1_E2_LIMIT",
      summary: {
        productCount: 3,
        directCompetitorCount: 2,
        carouselCount: 15,
        detailSliceCount: 21
      }
    });
  });

  it("is deterministic for the same frozen product snapshots", () => {
    expect(replay()).toEqual(replay());
  });

  it("rejects malformed product asset digests", () => {
    const products = structuredClone(fixture.products) as Array<
      Record<string, unknown>
    >;
    (
      (products[0]!.assets as Record<string, unknown>)
        .selectedMain as Record<string, unknown>
    ).sha256 = "not-a-digest";
    expect(() =>
      buildCategorySpace({
        intent: normalizeProductIntent(fixture.intent),
        products,
        exclusionRules: fixture.exclusionRules
      })
    ).toThrow("selectedMain.sha256 is invalid");
  });

  it("does not manufacture E3 or E4 claims from external observations", () => {
    const claims = (
      replay().evidenceClaims as EcommerceEvidenceObject
    ).claims as EcommerceEvidenceObject[];
    expect(claims.every((claim) => claim.level === "E1" || claim.level === "E2"))
      .toBe(true);
  });
});
