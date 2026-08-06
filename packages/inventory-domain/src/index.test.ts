import {
  estimateChannelShares,
  evaluateInventoryRisk,
  factDigest,
  forecastDemand,
  INVENTORY_FACT_SCHEMA_VERSION,
  transitionIncident,
  type FactEnvelope,
  type InventoryProductFact
} from "./index.js";
import { describe, expect, it } from "vitest";

function observations(days: number, quantityForHour: (hour: number) => number) {
  const end = Date.parse("2026-08-02T12:00:00Z");
  return Array.from({ length: days * 24 }, (_, index) => ({
    at: new Date(end - (days * 24 - index) * 3_600_000).toISOString(),
    quantity: quantityForHour(index)
  }));
}

describe("inventory demand forecasting", () => {
  it("produces deterministic 2/6/24 hour quantiles", () => {
    const result = forecastDemand({
      asOf: "2026-08-02T12:00:00Z",
      observations: observations(35, (hour) => (hour % 24 >= 8 && hour % 24 <= 20 ? 2 : 0))
    });
    expect(result.horizons.map((item) => item.hours)).toEqual([2, 6, 24]);
    expect(result.dailyP90).toBeGreaterThanOrEqual(result.dailyP50);
    expect(result.trainingHours).toBeGreaterThanOrEqual(28 * 24);
    expect(result.confidence).toBe("high");
  });

  it("uses a bounded hierarchical fallback for sparse SKUs", () => {
    const result = forecastDemand({
      asOf: "2026-08-02T12:00:00Z",
      observations: [{ at: "2026-08-01T12:00:00Z", quantity: 1 }],
      fallbackHourlyRate: 0.5
    });
    expect(result.selectedModel).toBe("hierarchical_fallback");
    expect(result.dailyP50).toBe(12);
    expect(result.confidence).toBe("low");
  });
});

describe("channel consumption estimation", () => {
  it("requires three days and 80 percent coverage", () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      at: new Date(Date.parse("2026-08-02T12:00:00Z") - index * 30 * 60_000).toISOString(),
      channelGoodsId: "channel-a",
      stock: 1_000 - index
    }));
    expect(estimateChannelShares({ asOf: "2026-08-02T12:00:00Z", points }).status).toBe("unknown");
  });

  it("ignores replenishment increases and estimates normalized shares", () => {
    const end = Date.parse("2026-08-02T12:00:00Z");
    const points = ["channel-a", "channel-b"].flatMap((channelGoodsId, channelIndex) =>
      Array.from({ length: 145 }, (_, index) => ({
        at: new Date(end - (144 - index) * 30 * 60_000).toISOString(),
        channelGoodsId,
        stock: index === 80 ? 1_500 : 2_000 - index * (channelIndex + 1)
      }))
    );
    const result = estimateChannelShares({ asOf: "2026-08-02T12:00:00Z", points });
    expect(result.status).toBe("ready");
    expect(Object.values(result.shares).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    expect(result.shares["channel-b"]!).toBeGreaterThan(result.shares["channel-a"]!);
  });
});

describe("balanced inventory risk", () => {
  const envelope: FactEnvelope<InventoryProductFact> = {
    schemaVersion: INVENTORY_FACT_SCHEMA_VERSION,
    observedAt: "2026-08-02T11:50:00Z",
    asOf: "2026-08-02T11:50:00Z",
    scope: { shopId: "shop-1", productId: "product-1" },
    facts: {
      productId: "product-1",
      title: "测试商品",
      totalStock: 75,
      skus: [{
        platformSkuId: "sku-1",
        merchantCode: "merchant-1",
        currentStock: 75,
        occupiedStock: 15,
        unoccupiedStock: 60,
        channels: [{ channelGoodsId: "channel-1", stock: 15 }]
      }]
    },
    quality: { freshness: "fresh", completeness: 1, mappingConfidence: "high", diagnostics: [] },
    source: { kind: "doudian", datasetId: "inventory", datasetVersion: "v1", digest: factDigest("inventory") }
  };

  it("uses P90 coverage and keeps the fixed 200 rule diagnostic-only", () => {
    const forecast = forecastDemand({
      asOf: "2026-08-02T12:00:00Z",
      observations: observations(35, () => 10)
    });
    const result = evaluateInventoryRisk({
      evaluatedAt: "2026-08-02T12:00:00Z",
      envelope,
      forecasts: { "sku-1": forecast },
      channelEstimates: {
        "sku-1": { status: "ready", observedHours: 72, completeness: 1, shares: { "channel-1": 1 }, diagnostics: [] }
      },
      demandQuality: {
        recentObservedAt: "2026-08-02T12:00:00Z",
        historicalCompleteThrough: "2026-08-02T00:00:00Z"
      }
    });
    expect(result.severity).toBe("critical");
    expect(result.findings.some((finding) => finding.legacyBelow200)).toBe(true);
  });

  it("suppresses deterministic risk for stale inventory", () => {
    const result = evaluateInventoryRisk({
      evaluatedAt: "2026-08-02T14:01:00Z",
      envelope,
      forecasts: {},
      channelEstimates: {}
    });
    expect(result.severity).toBe("unknown");
    expect(result.findings).toHaveLength(1);
  });

  it("suppresses deterministic risk when recent or complete historical orders are stale",() => {
    const result = evaluateInventoryRisk({
      evaluatedAt:"2026-08-02T12:00:00Z",envelope,forecasts:{},channelEstimates:{},
      demandQuality:{
        recentObservedAt:"2026-08-02T09:59:00Z",
        historicalCompleteThrough:"2026-08-01T00:00:00Z"
      }
    });
    expect(result).toMatchObject({ severity:"unknown",findings:[{ kind:"data_quality" }] });
    expect(result.findings[0]?.reason).toContain("120 minutes");
  });
});

describe("incident hysteresis", () => {
  it("opens warnings after two scans, critical immediately, and resolves after two healthy scans", () => {
    const first = transitionIncident(undefined, "warning");
    const second = transitionIncident(first, "warning");
    expect(first.state).toBe("pending");
    expect(second.state).toBe("open");
    const critical = transitionIncident(undefined, "critical");
    expect(critical.state).toBe("open");
    const healthyOne = transitionIncident(critical, "normal");
    const healthyTwo = transitionIncident(healthyOne, "normal");
    expect(healthyOne.state).toBe("open");
    expect(healthyTwo.state).toBe("resolved");
    expect(transitionIncident(undefined, "unknown").state).toBe("resolved");
    expect(transitionIncident(critical, "unknown").state).toBe("resolved");
  });
});
