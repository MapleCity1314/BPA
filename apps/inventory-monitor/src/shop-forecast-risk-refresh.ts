import {
  estimateChannelShares,
  evaluateInventoryRisk,
  forecastDemand,
  type ChannelShareEstimate,
  type DemandForecast
} from "@bpa/inventory-domain";
import type {
  InventoryEffectIdentity,
  InventoryRepository,
  LeaseFence
} from "./repository.js";

export class InventoryShopForecastRiskPartialCommitError extends Error {
  readonly code = "INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT";

  constructor() {
    super("INVENTORY_SHOP_FORECAST_RISK_PARTIAL_COMMIT");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} keys are invalid`);
  }
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`);
  return value.trim();
}

function count(value: unknown, label: string, maximum = 250): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new Error(`${label} is invalid`);
  return number;
}

function errorCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.message.split(/[:\s]/u)[0]
      : "INVENTORY_PRODUCT_REFRESH_FAILED";
  return candidate && /^[A-Z][A-Z0-9_]{1,99}$/u.test(candidate)
    ? candidate
    : "INVENTORY_PRODUCT_REFRESH_FAILED";
}

function uncertainTransaction(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "SCHEDULER_LEASE_LOST" || /^[A-Z0-9]{5}$/u.test(code)) return true;
  if (new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR"]).has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /timed?\s*out|timeout|connection\s+(?:lost|reset|terminated)|socket\s+hang\s+up/iu.test(message);
}

export async function refreshShopForecastRisk(input: {
  readonly shop: { readonly id: string; readonly name: string };
  readonly attemptedSnapshots: number;
  readonly persistedSnapshots: number;
  readonly failedSnapshots: number;
  readonly unresolvedSnapshots: number;
  readonly snapshotReceipts: readonly unknown[];
  readonly lease: LeaseFence;
  readonly effect:InventoryEffectIdentity;
  readonly repository: InventoryRepository;
}): Promise<Record<string, unknown>> {
  const attemptedSnapshots = count(input.attemptedSnapshots,"attemptedSnapshots");
  const persistedSnapshots = count(input.persistedSnapshots,"persistedSnapshots");
  const failedSnapshots = count(input.failedSnapshots,"failedSnapshots");
  const unresolvedSnapshots = count(input.unresolvedSnapshots,"unresolvedSnapshots");
  if (input.snapshotReceipts.length > 250) throw new Error("snapshotReceipts is invalid");
  const succeeded = input.snapshotReceipts.map((value,index) => {
    const receipt = record(value,`snapshotReceipts[${index}]`);
    exactKeys(receipt,["itemKey","output"],`snapshotReceipts[${index}]`);
    const output = record(receipt.output,`snapshotReceipts[${index}].output`);
    exactKeys(output,["productId","snapshotId"],`snapshotReceipts[${index}].output`);
    const itemKey = text(receipt.itemKey,`snapshotReceipts[${index}].itemKey`,200);
    const productId = text(output.productId,`snapshotReceipts[${index}].output.productId`,200);
    if (itemKey !== productId) throw new Error("snapshot receipt itemKey does not match productId");
    return {
      productId,
      snapshotId:text(output.snapshotId,`snapshotReceipts[${index}].output.snapshotId`,500)
    };
  });
  if (persistedSnapshots !== succeeded.length ||
    attemptedSnapshots !== persistedSnapshots + failedSnapshots + unresolvedSnapshots) {
    throw new Error("snapshot receipt counts do not conserve");
  }
  if (new Set(succeeded.map(({ productId }) => productId)).size !== succeeded.length ||
    new Set(succeeded.map(({ snapshotId }) => snapshotId)).size !== succeeded.length) {
    throw new Error("snapshots receipts must be unique");
  }
  let failedProducts = 0;
  let forecastAttempted = 0;
  let forecastPersisted = 0;
  let riskAttempted = 0;
  let riskPersisted = 0;
  const severities = { normal:0,warning:0,critical:0,unknown:0 };
  const progress = () => ({
    attemptedProducts:succeeded.length,
    completedProducts:riskPersisted,
    partialProducts:0,
    failedProducts,
    forecastWrites:{ attempted:forecastAttempted,persisted:forecastPersisted },
    riskWrites:{ attempted:riskAttempted,persisted:riskPersisted },
    severities
  });
  const replay = await input.repository.beginInventoryEffect(
    input.effect,"inventory.shop.forecast-risk.refresh",{
      ...progress()
    },input.lease
  );
  if (replay) return replay;
  const verified = await input.repository.verifiedSnapshotFacts({
    shopId:input.shop.id,
    receipts:succeeded
  });
  const verifiedByReceipt = new Map(verified.map((entry) => [
    `${entry.productId}\u0000${entry.snapshotId}`,
    entry
  ]));
  for (const { productId,snapshotId } of succeeded) {
    const verifiedSnapshot = verifiedByReceipt.get(`${productId}\u0000${snapshotId}`);
    if (!verifiedSnapshot) {
      failedProducts += 1;
      await input.repository.recordInventoryEffectItem(
        input.effect,{
          productId,snapshotId,status:"failed",code:"SNAPSHOT_RECEIPT_NOT_FOUND",
          forecastAttempted:0,riskAttempted:0
        },
        input.lease
      );
      continue;
    }
    const envelope = verifiedSnapshot.envelope;
    let productForecastAttempted = 0;
    let productRiskAttempted = 0;
    try {
      const forecastInputs = await input.repository.forecastInputs({
        shopId: input.shop.id,
        productId,
        asOf: envelope.asOf
      });
      const forecasts: Record<string, DemandForecast> = {};
      const channelEstimates: Record<string, ChannelShareEstimate> = {};
      const persistableForecasts = forecastInputs.map((forecastInput) => {
        const forecast = forecastDemand({
          asOf: envelope.asOf,
          observations: forecastInput.observations,
          ...(forecastInput.fallbackHourlyRate === undefined ? {} : { fallbackHourlyRate: forecastInput.fallbackHourlyRate }),
          ...(forecastInput.fallbackReason === undefined ? {} : { fallbackReason: forecastInput.fallbackReason })
        });
        const cutoff = Date.parse(forecast.asOf) - 3 * 24 * 60 * 60 * 1000;
        const observedSkuDemand = forecastInput.observations.reduce(
          (sum, point) => Date.parse(point.at) >= cutoff ? sum + point.quantity : sum,
          0
        );
        forecasts[forecastInput.platformSkuId] = forecast;
        channelEstimates[forecastInput.platformSkuId] = estimateChannelShares({
          asOf: forecast.asOf,
          points: forecastInput.channelPoints,
          observedSkuDemand
        });
        return {
          shopId: input.shop.id,
          productId,
          platformSkuId: forecastInput.platformSkuId,
          merchantCode: forecastInput.merchantCode,
          sourceDataset: {
            id: forecastInput.sourceDataset.id,
            version: forecastInput.sourceDataset.version
          },
          forecast
        };
      });
      const demandQuality = forecastInputs[0]?.demandQuality;
      const evaluation = evaluateInventoryRisk({
        evaluatedAt: envelope.asOf,
        envelope,
        forecasts,
        channelEstimates,
        ...(demandQuality === undefined ? {} : { demandQuality })
      });
      productForecastAttempted = persistableForecasts.length;
      forecastAttempted += productForecastAttempted;
      riskAttempted += 1;
      productRiskAttempted = 1;
      const persisted = await input.repository.persistForecastRiskProduct({
        forecasts: persistableForecasts,
        risk: { snapshotId,shopId:input.shop.id,productId,evaluation },
        effect:input.effect
      },input.lease);
      forecastPersisted += persisted.forecastIds.length;
      riskPersisted += 1;
      severities[evaluation.severity] += 1;
    } catch (error) {
      if (uncertainTransaction(error)) throw new InventoryShopForecastRiskPartialCommitError();
      failedProducts += 1;
      await input.repository.recordInventoryEffectItem(
        input.effect,{
          productId,snapshotId,status:"failed",code:errorCode(error),
          forecastAttempted:productForecastAttempted,riskAttempted:productRiskAttempted
        },
        input.lease
      );
    }
  }
  const completedProducts = riskPersisted;
  const result = {
    status: failedProducts === 0 ? "complete" : "partial",
    attemptedProducts:succeeded.length,
    completedProducts,
    partialProducts:0,
    failedProducts,
    forecastWrites:{ attempted:forecastAttempted,persisted:forecastPersisted },
    riskWrites:{ attempted:riskAttempted,persisted:riskPersisted },
    severities
  };
  await input.repository.completeForecastRiskEffect(
    input.effect,result,input.lease
  );
  return result;
}
