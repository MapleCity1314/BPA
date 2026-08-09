import { describe, expect, it } from "vitest";
import {
  buildDiscoveryCategorySpace,
  buildDiscoveryComparablePool,
  buildDiscoveryReferencePack,
  evaluateDiscoveryEvidence,
  mergeMarketplaceProbes,
  normalizeProductIntent
} from "./index.js";

const intent = normalizeProductIntent({
  intentId: "intent-jianbing-smoke",
  platform: "抖音电商、淘宝、京东",
  seedQuery: "预包装煎饼",
  researchGoal: "发现可比较商品和远程主图候选",
  workingBoundary: {
    productForm: "独立预包装、开袋即食煎饼",
    targetPeople: ["早餐人群"],
    usageScenes: ["早餐", "家庭囤货"],
    confidence: "MEDIUM"
  }
});

const probe = (platform: string, id: string, title: string) => ({
  schemaVersion: "marketplace-probe/v0.1",
  platform,
  query: "预包装煎饼",
  observedAt: "2026-08-02T10:00:00.000Z",
  pageUrl: `https://example.test/${platform}`,
  queryConfirmed: true,
  status: "PARTIAL",
  items: [
    {
      productId: id,
      title,
      productUrl: `https://example.test/item/${id}`,
      mainImageUrl: `https://img.example/${id}.jpg`,
      priceText: "¥19.90",
      position: 1
    }
  ],
  warnings: ["VISIBLE_SALES_TEXT_INCOMPLETE"]
});

describe("cross-platform discovery evidence chain", () => {
  it("keeps discovery facts at E1 and builds provisional assets", () => {
    const discovery = mergeMarketplaceProbes({
      intent,
      probes: [
        probe("DOUYIN", "d1", "杂粮软煎饼独立包装开袋即食"),
        probe("TAOBAO", "t1", "东北杂粮煎饼家庭装"),
        probe("JD", "j1", "煎饼制作机家用")
      ]
    });
    const categorySpace = buildDiscoveryCategorySpace({ intent, discovery });
    const comparablePool = buildDiscoveryComparablePool({
      poolId: "pool-jianbing-smoke",
      categorySpace,
      discovery,
      rules: {
        coreTerms: ["煎饼"],
        packagingTerms: ["独立包装", "即食", "开袋"],
        excludeTerms: ["制作机", "煎饼粉"]
      }
    });
    const evidence = evaluateDiscoveryEvidence({
      observedAt: "2026-08-02T10:00:00.000Z",
      discovery,
      comparablePool
    });
    const pack = buildDiscoveryReferencePack({
      packId: "pack-jianbing-smoke",
      discovery,
      comparablePool,
      evidence
    });
    expect(categorySpace).toMatchObject({ officialCategoryStatus: "UNCONFIRMED" });
    expect(comparablePool).toMatchObject({
      tiers: [
        { tier: "DIRECT_COMPETITOR", products: [expect.objectContaining({ discoveryId: "DOUYIN:d1" })] },
        { tier: "SUBSTITUTE_AND_CONTENT_REFERENCE", products: [expect.objectContaining({ discoveryId: "TAOBAO:t1" })] }
      ],
      rejectedProducts: [expect.objectContaining({ discoveryId: "JD:j1" })]
    });
    expect(evidence).toMatchObject({ maximumEstablishedLevel: "E1" });
    expect(pack).toMatchObject({
      schemaVersion: "reference-asset-pack/v0.4",
      status: "PROVISIONAL_REMOTE_ASSETS"
    });
    expect(pack).not.toHaveProperty("sourceRunId");
  });

  it("rejects a parser-empty probe that is not an explicit platform empty state", () => {
    expect(() => mergeMarketplaceProbes({
      intent,
      probes: [
        { ...probe("DOUYIN", "d1", "商品"), status: "EMPTY", items: [] },
        probe("TAOBAO", "t1", "商品一"),
        probe("JD", "j1", "商品二")
      ]
    })).toThrow("unsupported status");
  });
});
