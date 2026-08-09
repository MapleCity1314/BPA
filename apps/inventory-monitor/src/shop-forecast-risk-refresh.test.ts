import type { FactEnvelope, InventoryProductFact } from "@bpa/inventory-domain";
import { describe,expect,it,vi } from "vitest";
import {
  InventoryShopForecastRiskPartialCommitError,
  refreshShopForecastRisk
} from "./shop-forecast-risk-refresh.js";

const lease = {
  leaseKey:"inventory-production-cycle",holderId:"trigger-attempt:test",fencingToken:7
};
const effect = {
  effectId:`inventory-effect:sha256:${"a".repeat(64)}`,
  inputDigest:`sha256:${"b".repeat(64)}`,
  identityDigest:`sha256:${"c".repeat(64)}`,
  runId:"run:test",invocationId:"invocation:test",
  idempotencyKey:"idempotency:test",leaseRequestId:"lease-request:test"
};

function verified(productId:string,snapshotId:string) {
  const envelope:FactEnvelope<InventoryProductFact> = {
    schemaVersion:"inventory-product-fact/1.0.0",
    observedAt:"2026-08-10T00:00:00.000Z",
    asOf:"2026-08-10T00:00:00.000Z",
    scope:{ shopId:"10461048",productId },
    facts:{
      productId,title:`商品${productId}`,totalStock:10,
      skus:[{
        platformSkuId:`sku-${productId}`,merchantCode:`M-${productId}`,
        currentStock:10,occupiedStock:0,unoccupiedStock:10,channels:[]
      }]
    },
    quality:{ freshness:"fresh",completeness:1,mappingConfidence:"high",diagnostics:[] },
    source:{
      kind:"doudian.inventory.product.snapshot.read",
      datasetId:"inventory-snapshot:10461048",datasetVersion:"v1",digest:"sha256:snapshot"
    }
  };
  return { productId,snapshotId,envelope };
}

function receipt(productId:string,snapshotId:string) {
  return { itemKey:productId,output:{ productId,snapshotId } };
}

function forecastInput(productId:string) {
  return [{
    platformSkuId:`sku-${productId}`,merchantCode:`M-${productId}`,
    observations:[],channelPoints:[],
    sourceDataset:{ id:"sales-demand:10461048",version:"42:v1",digest:"sha256:orders" },
    demandQuality:{
      recentObservedAt:"2026-08-10T00:00:00.000Z",
      historicalCompleteThrough:"2026-08-10T00:00:00.000Z"
    },
    fallbackHourlyRate:0,fallbackReason:"published WDT demand is empty"
  }];
}

function input(repository:unknown) {
  return {
    shop:{ id:"10461048",name:"一号店" },
    attemptedSnapshots:2,persistedSnapshots:2,failedSnapshots:0,unresolvedSnapshots:0,
    snapshotReceipts:[receipt("p1","s1"),receipt("p2","s2")],
    lease,effect,repository:repository as never
  };
}

describe("shop forecast-risk refresh",() => {
  it("collects a zero-write deterministic product failure after a completed product",async () => {
    const repository = {
      beginInventoryEffect:vi.fn(async () => undefined),
      recordInventoryEffectItem:vi.fn(async () => undefined),
      completeForecastRiskEffect:vi.fn(async () => undefined),
      verifiedSnapshotFacts:vi.fn(async () => [verified("p1","s1"),verified("p2","s2")]),
      forecastInputs:vi.fn(async ({ productId }:{ productId:string }) => {
        if (productId === "p2") throw new Error("FORECAST_INPUT_INVALID");
        return forecastInput(productId);
      }),
      persistForecastRiskProduct:vi.fn(async () => ({ forecastIds:["forecast:1"],evaluationId:"evaluation:1",incidentsUpdated:0 }))
    };
    await expect(refreshShopForecastRisk(input(repository))).resolves.toEqual({
      status:"partial",attemptedProducts:2,completedProducts:1,partialProducts:0,failedProducts:1,
      forecastWrites:{ attempted:1,persisted:1 },riskWrites:{ attempted:1,persisted:1 },
      severities:{ normal:1,warning:0,critical:0,unknown:0 }
    });
    expect(repository.persistForecastRiskProduct).toHaveBeenCalledTimes(1);
  });

  it("keeps a missing exact persisted snapshot as a deterministic compact partial",async () => {
    const repository = {
      beginInventoryEffect:vi.fn(async () => undefined),
      recordInventoryEffectItem:vi.fn(async () => undefined),
      completeForecastRiskEffect:vi.fn(async () => undefined),
      verifiedSnapshotFacts:vi.fn(async () => [verified("p1","s1")]),
      forecastInputs:vi.fn(async ({ productId }:{ productId:string }) => forecastInput(productId)),
      persistForecastRiskProduct:vi.fn(async () => ({ forecastIds:["forecast:1"],evaluationId:"evaluation:1",incidentsUpdated:0 }))
    };
    await expect(refreshShopForecastRisk(input(repository))).resolves.toMatchObject({
      status:"partial",attemptedProducts:2,completedProducts:1,failedProducts:1
    });
    expect(repository.forecastInputs).toHaveBeenCalledTimes(1);
  });

  it("stops after an uncertain second product transaction",async () => {
    const repository = {
      beginInventoryEffect:vi.fn(async () => undefined),
      recordInventoryEffectItem:vi.fn(async () => undefined),
      completeForecastRiskEffect:vi.fn(async () => undefined),
      verifiedSnapshotFacts:vi.fn(async () => [verified("p1","s1"),verified("p2","s2")]),
      forecastInputs:vi.fn(async ({ productId }:{ productId:string }) => forecastInput(productId)),
      persistForecastRiskProduct:vi.fn()
        .mockResolvedValueOnce({ forecastIds:["forecast:1"],evaluationId:"evaluation:1",incidentsUpdated:0 })
        .mockRejectedValueOnce(Object.assign(new Error("connection timed out"),{ code:"ETIMEDOUT" }))
    };
    await expect(refreshShopForecastRisk(input(repository))).rejects.toBeInstanceOf(
      InventoryShopForecastRiskPartialCommitError
    );
    expect(repository.persistForecastRiskProduct).toHaveBeenCalledTimes(2);
  });

  it("rejects non-conserving compact snapshot receipts before repository access",async () => {
    const repository = { verifiedSnapshotFacts:vi.fn() };
    await expect(refreshShopForecastRisk({
      ...input(repository),persistedSnapshots:1
    })).rejects.toThrow("snapshot receipt counts do not conserve");
    expect(repository.verifiedSnapshotFacts).not.toHaveBeenCalled();
  });
});
