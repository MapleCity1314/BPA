import { createHash } from "node:crypto";

export const INVENTORY_FACT_SCHEMA_VERSION = "bpa.inventory-fact/1";
export const INVENTORY_FORECAST_ALGORITHM_VERSION =
  "inventory-demand-ensemble-conformal/1.0.0";
export const INVENTORY_RISK_POLICY_VERSION =
  "inventory-balanced-shadow/1.0.0";
export const INVENTORY_DATA_VALIDITY_MINUTES = 120;
export const RECENT_ORDER_DATA_VALIDITY_MINUTES = 120;

export type MappingConfidence = "high" | "medium" | "low" | "unknown";
export type RiskSeverity = "normal" | "warning" | "critical" | "unknown";

export interface InventoryScope {
  readonly shopId: string;
  readonly productId?: string;
  readonly platformSkuId?: string;
  readonly merchantCode?: string;
  readonly channelGoodsId?: string;
}

export interface FactEnvelope<T> {
  readonly schemaVersion: string;
  readonly observedAt: string;
  readonly asOf: string;
  readonly scope: InventoryScope;
  readonly facts: T;
  readonly quality: {
    readonly freshness: "fresh" | "stale";
    readonly completeness: number;
    readonly mappingConfidence: MappingConfidence;
    readonly diagnostics: readonly string[];
  };
  readonly source: {
    readonly kind: string;
    readonly datasetId: string;
    readonly datasetVersion: string;
    readonly digest: string;
  };
}

export interface DemandObservation {
  readonly at: string;
  readonly quantity: number;
}

export interface ForecastHorizon {
  readonly hours: 2 | 6 | 24;
  readonly p50: number;
  readonly p90: number;
}

export interface DemandForecast {
  readonly algorithmVersion: typeof INVENTORY_FORECAST_ALGORITHM_VERSION;
  readonly asOf: string;
  readonly selectedModel:
    | "seasonal_naive"
    | "weighted_mean"
    | "croston_sba"
    | "hierarchical_fallback";
  readonly dailyP50: number;
  readonly dailyP90: number;
  readonly horizons: readonly ForecastHorizon[];
  readonly confidence: Exclude<MappingConfidence, "unknown">;
  readonly recentAcceleration: number;
  readonly trainingHours: number;
  readonly diagnostics: readonly string[];
}

export interface ChannelStockPoint {
  readonly at: string;
  readonly channelGoodsId: string;
  readonly stock: number;
}

export interface ChannelShareEstimate {
  readonly status: "ready" | "unknown";
  readonly observedHours: number;
  readonly completeness: number;
  readonly consistencyRatio?: number;
  readonly shares: Readonly<Record<string, number>>;
  readonly diagnostics: readonly string[];
}

export interface InventoryChannelFact {
  readonly channelGoodsId: string;
  readonly stock: number;
}

export interface InventorySkuFact {
  readonly platformSkuId: string;
  readonly merchantCode: string;
  readonly currentStock: number;
  readonly occupiedStock: number;
  readonly unoccupiedStock: number;
  readonly channels: readonly InventoryChannelFact[];
}

export interface InventoryProductFact {
  readonly productId: string;
  readonly title: string;
  readonly totalStock: number;
  readonly skus: readonly InventorySkuFact[];
}

export interface RiskFinding {
  readonly scope: InventoryScope;
  readonly kind: "sku" | "channel" | "reserve" | "data_quality";
  readonly severity: RiskSeverity;
  readonly availableStock?: number;
  readonly requiredP90?: number;
  readonly horizonHours?: 2 | 6 | 24;
  readonly legacyBelow200: boolean;
  readonly reason: string;
}

export interface InventoryRiskEvaluation {
  readonly policyVersion: typeof INVENTORY_RISK_POLICY_VERSION;
  readonly evaluatedAt: string;
  readonly severity: RiskSeverity;
  readonly findings: readonly RiskFinding[];
  readonly diagnostics: readonly string[];
}

export interface DemandDataQuality {
  readonly recentObservedAt?: string;
  readonly historicalCompleteThrough?: string;
}

export interface IncidentProjection {
  readonly state: "pending" | "open" | "resolved";
  readonly severity: RiskSeverity;
  readonly warningStreak: number;
  readonly healthyStreak: number;
  readonly revision: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MODEL_NAMES = [
  "seasonal_naive",
  "weighted_mean",
  "croston_sba"
] as const;
type ForecastModel = (typeof MODEL_NAMES)[number];

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function parsedTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be ISO-8601`);
  return parsed;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

function pinball(actual: number, predicted: number, probability: number): number {
  const error = actual - predicted;
  return error >= 0 ? probability * error : (probability - 1) * error;
}

function hourlySeries(
  observations: readonly DemandObservation[],
  asOfMs: number,
  maximumDays = 90
): number[] {
  const start = asOfMs - maximumDays * DAY_MS;
  const buckets = new Map<number, number>();
  for (const observation of observations) {
    const at = parsedTime(observation.at, "observation.at");
    const quantity = finiteNonNegative(
      observation.quantity,
      "observation.quantity"
    );
    if (at > asOfMs || at < start) continue;
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    buckets.set(hour, (buckets.get(hour) ?? 0) + quantity);
  }
  if (buckets.size === 0) return [];
  const first = Math.min(...buckets.keys());
  const end = Math.floor(asOfMs / HOUR_MS) * HOUR_MS;
  const series: number[] = [];
  for (let at = first; at <= end; at += HOUR_MS) {
    series.push(buckets.get(at) ?? 0);
  }
  return series;
}

function weightedHourlyMean(series: readonly number[]): number {
  if (series.length === 0) return 0;
  const windows = [7 * 24, 14 * 24, 28 * 24] as const;
  const weights = [0.55, 0.3, 0.15] as const;
  let weighted = 0;
  let weight = 0;
  for (let index = 0; index < windows.length; index += 1) {
    const window = Math.min(windows[index]!, series.length);
    if (window === 0) continue;
    const mean =
      series.slice(-window).reduce((sum, value) => sum + value, 0) / window;
    weighted += mean * weights[index]!;
    weight += weights[index]!;
  }
  return weight === 0 ? 0 : weighted / weight;
}

function crostonSba(series: readonly number[], alpha = 0.1): number {
  const firstIndex = series.findIndex((value) => value > 0);
  if (firstIndex < 0) return 0;
  let demand = series[firstIndex]!;
  let interval = firstIndex + 1;
  let gap = 1;
  for (let index = firstIndex + 1; index < series.length; index += 1) {
    const value = series[index]!;
    if (value > 0) {
      demand += alpha * (value - demand);
      interval += alpha * (gap - interval);
      gap = 1;
    } else {
      gap += 1;
    }
  }
  return interval <= 0 ? 0 : (1 - alpha / 2) * (demand / interval);
}

function modelPrediction(
  model: ForecastModel,
  training: readonly number[],
  horizonIndex = 0
): number {
  if (training.length === 0) return 0;
  if (model === "weighted_mean") return weightedHourlyMean(training);
  if (model === "croston_sba") return crostonSba(training);
  const seasonalIndex = training.length - 168 + (horizonIndex % 168);
  if (seasonalIndex >= 0 && training[seasonalIndex] !== undefined) {
    return training[seasonalIndex]!;
  }
  return weightedHourlyMean(training);
}

function selectModel(series: readonly number[]): {
  readonly model: ForecastModel;
  readonly residuals: readonly number[];
} {
  const validationHours = Math.min(14 * 24, Math.floor(series.length * 0.25));
  const start = Math.max(24, series.length - validationHours);
  const ranked = MODEL_NAMES.map((model) => {
    const residuals: number[] = [];
    let loss = 0;
    let samples = 0;
    for (let index = start; index < series.length; index += 1) {
      const training = series.slice(0, index);
      const predicted = modelPrediction(model, training, 0);
      const actual = series[index] ?? 0;
      residuals.push(Math.max(0, actual - predicted));
      loss += pinball(actual, predicted, 0.5);
      samples += 1;
    }
    return {
      model,
      residuals,
      loss: samples === 0 ? Number.POSITIVE_INFINITY : loss / samples
    };
  }).sort((left, right) => left.loss - right.loss || left.model.localeCompare(right.model));
  return ranked[0] ?? { model: "weighted_mean", residuals: [] };
}

function recentAcceleration(series: readonly number[], baseline: number): number {
  if (baseline <= 0 || series.length < 6) return 1;
  const recent = series.slice(-6).reduce((sum, value) => sum + value, 0) / 6;
  if (recent === 0) return 1;
  return Math.min(3, Math.max(0.75, recent / baseline));
}

export function forecastDemand(input: {
  readonly asOf: string;
  readonly observations: readonly DemandObservation[];
  readonly fallbackHourlyRate?: number;
  readonly fallbackReason?: string;
}): DemandForecast {
  const asOfMs = parsedTime(input.asOf, "asOf");
  const series = hourlySeries(input.observations, asOfMs);
  const diagnostics: string[] = [];
  const fallback = finiteNonNegative(
    input.fallbackHourlyRate ?? 0,
    "fallbackHourlyRate"
  );
  if (series.length < 7 * 24 || series.reduce((sum, value) => sum + value, 0) < 5) {
    diagnostics.push("SKU history is sparse; hierarchical fallback was used.");
    if (input.fallbackReason) diagnostics.push(input.fallbackReason.slice(0,500));
    const rate = series.length > 0 ? Math.max(weightedHourlyMean(series), fallback) : fallback;
    return buildForecast({
      asOf: input.asOf,
      model: "hierarchical_fallback",
      hourlyP50: rate,
      hourlyResidualP90: Math.max(rate, 0.25),
      acceleration: 1,
      trainingHours: series.length,
      confidence: series.length >= 72 ? "medium" : "low",
      diagnostics
    });
  }
  const selected = selectModel(series);
  const hourly = modelPrediction(selected.model, series);
  const acceleration = recentAcceleration(series, Math.max(hourly, 0.0001));
  if (acceleration > 1.25) diagnostics.push("Recent demand acceleration increased the forecast.");
  return buildForecast({
    asOf: input.asOf,
    model: selected.model,
    hourlyP50: hourly,
    hourlyResidualP90: quantile(selected.residuals, 0.9),
    acceleration,
    trainingHours: series.length,
    confidence: series.length >= 28 * 24 ? "high" : "medium",
    diagnostics
  });
}

function buildForecast(input: {
  readonly asOf: string;
  readonly model: DemandForecast["selectedModel"];
  readonly hourlyP50: number;
  readonly hourlyResidualP90: number;
  readonly acceleration: number;
  readonly trainingHours: number;
  readonly confidence: DemandForecast["confidence"];
  readonly diagnostics: readonly string[];
}): DemandForecast {
  const horizons = ([2, 6, 24] as const).map((hours) => {
    const p50 = input.hourlyP50 * input.acceleration * hours;
    const p90 = p50 + input.hourlyResidualP90 * Math.sqrt(hours);
    return { hours, p50: round(p50), p90: round(Math.max(p50, p90)) };
  });
  const daily = horizons[2]!;
  return {
    algorithmVersion: INVENTORY_FORECAST_ALGORITHM_VERSION,
    asOf: input.asOf,
    selectedModel: input.model,
    dailyP50: daily.p50,
    dailyP90: daily.p90,
    horizons,
    confidence: input.confidence,
    recentAcceleration: round(input.acceleration),
    trainingHours: input.trainingHours,
    diagnostics: input.diagnostics
  };
}

export function estimateChannelShares(input: {
  readonly asOf: string;
  readonly points: readonly ChannelStockPoint[];
  readonly intervalMinutes?: number;
  readonly minimumDays?: number;
  readonly minimumCompleteness?: number;
  readonly observedSkuDemand?: number;
}): ChannelShareEstimate {
  const asOfMs = parsedTime(input.asOf, "asOf");
  const intervalMinutes = input.intervalMinutes ?? 30;
  const minimumDays = input.minimumDays ?? 3;
  const minimumCompleteness = input.minimumCompleteness ?? 0.8;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error("intervalMinutes must be positive");
  }
  const since = asOfMs - minimumDays * DAY_MS;
  const byChannel = new Map<string, ChannelStockPoint[]>();
  for (const point of input.points) {
    finiteNonNegative(point.stock, "channel stock");
    const at = parsedTime(point.at, "channel point.at");
    if (at < since || at > asOfMs || point.channelGoodsId.trim().length === 0) continue;
    const points = byChannel.get(point.channelGoodsId) ?? [];
    points.push(point);
    byChannel.set(point.channelGoodsId, points);
  }
  const expected = Math.floor((minimumDays * 24 * 60) / intervalMinutes) + 1;
  const uniqueSlots = new Set(
    [...byChannel.values()].flat().map((point) =>
      Math.floor(parsedTime(point.at, "channel point.at") / (intervalMinutes * 60_000))
    )
  );
  const completeness = Math.min(1, uniqueSlots.size / expected);
  const observedHours = (uniqueSlots.size * intervalMinutes) / 60;
  const diagnostics: string[] = [];
  if (completeness < minimumCompleteness || observedHours < minimumDays * 24 * minimumCompleteness) {
    diagnostics.push("Channel history has not reached the cold-start coverage gate.");
    return { status: "unknown", observedHours: round(observedHours), completeness: round(completeness), shares: {}, diagnostics };
  }
  const consumption = new Map<string, number>();
  for (const [channelGoodsId, points] of byChannel) {
    const ordered = [...points].sort((left, right) =>
      parsedTime(left.at, "channel point.at") - parsedTime(right.at, "channel point.at")
    );
    let total = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      const delta = ordered[index - 1]!.stock - ordered[index]!.stock;
      if (delta > 0) total += delta;
    }
    consumption.set(channelGoodsId, total);
  }
  const total = [...consumption.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    diagnostics.push("No channel depletion was observed during the cold-start window.");
    return { status: "unknown", observedHours: round(observedHours), completeness: round(completeness), shares: {}, diagnostics };
  }
  const observedSkuDemand = input.observedSkuDemand;
  const consistencyRatio =
    observedSkuDemand === undefined || observedSkuDemand <= 0
      ? undefined
      : Math.min(total, observedSkuDemand) / Math.max(total, observedSkuDemand);
  if (consistencyRatio !== undefined && consistencyRatio < 0.5) {
    diagnostics.push("Channel depletion is inconsistent with observed SKU demand.");
    return {
      status: "unknown",
      observedHours: round(observedHours),
      completeness: round(completeness),
      consistencyRatio: round(consistencyRatio),
      shares: {},
      diagnostics
    };
  }
  return {
    status: "ready",
    observedHours: round(observedHours),
    completeness: round(completeness),
    ...(consistencyRatio === undefined ? {} : { consistencyRatio: round(consistencyRatio) }),
    shares: Object.fromEntries(
      [...consumption.entries()].map(([channelGoodsId, value]) => [channelGoodsId, round(value / total, 6)])
    ),
    diagnostics
  };
}

function horizon(forecast: DemandForecast, hours: 2 | 6 | 24): ForecastHorizon {
  const result = forecast.horizons.find((candidate) => candidate.hours === hours);
  if (!result) throw new Error(`Forecast is missing the ${hours} hour horizon`);
  return result;
}

function maximumSeverity(findings: readonly RiskFinding[]): RiskSeverity {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  if (findings.some((finding) => finding.severity === "unknown")) return "unknown";
  return "normal";
}

export function evaluateInventoryRisk(input: {
  readonly evaluatedAt: string;
  readonly envelope: FactEnvelope<InventoryProductFact>;
  readonly forecasts: Readonly<Record<string, DemandForecast>>;
  readonly channelEstimates: Readonly<Record<string, ChannelShareEstimate>>;
  readonly demandQuality?: DemandDataQuality;
  readonly maximumInventoryAgeMinutes?: number;
}): InventoryRiskEvaluation {
  const evaluatedAt = parsedTime(input.evaluatedAt, "evaluatedAt");
  const observedAt = parsedTime(input.envelope.observedAt, "envelope.observedAt");
  const maximumAge =
    (input.maximumInventoryAgeMinutes ?? INVENTORY_DATA_VALIDITY_MINUTES) * 60_000;
  const findings: RiskFinding[] = [];
  const diagnostics = [...input.envelope.quality.diagnostics];
  const stale =
    input.envelope.quality.freshness === "stale" ||
    evaluatedAt - observedAt > maximumAge ||
    input.envelope.quality.completeness < 1 ||
    input.envelope.quality.mappingConfidence !== "high";
  if (stale) {
    findings.push({
      scope: input.envelope.scope,
      kind: "data_quality",
      severity: "unknown",
      legacyBelow200: false,
      reason: "Inventory data is stale or incomplete; deterministic risk was suppressed."
    });
    return {
      policyVersion: INVENTORY_RISK_POLICY_VERSION,
      evaluatedAt: input.evaluatedAt,
      severity: "unknown",
      findings,
      diagnostics
    };
  }
  const recentObservedAt = input.demandQuality?.recentObservedAt
    ? parsedTime(input.demandQuality.recentObservedAt,"demandQuality.recentObservedAt")
    : undefined;
  const historicalCompleteThrough = input.demandQuality?.historicalCompleteThrough
    ? parsedTime(input.demandQuality.historicalCompleteThrough,"demandQuality.historicalCompleteThrough")
    : undefined;
  if (
    recentObservedAt === undefined ||
    evaluatedAt - recentObservedAt > RECENT_ORDER_DATA_VALIDITY_MINUTES * 60_000 ||
    historicalCompleteThrough === undefined || evaluatedAt - historicalCompleteThrough > 36 * 60 * 60_000
  ) {
    findings.push({
      scope: input.envelope.scope,
      kind: "data_quality",
      severity: "unknown",
      legacyBelow200: false,
      reason: "Recent orders exceed 120 minutes or the latest complete historical order day exceeds 36 hours; deterministic risk was suppressed."
    });
    return {
      policyVersion: INVENTORY_RISK_POLICY_VERSION,
      evaluatedAt: input.evaluatedAt,
      severity: "unknown",
      findings,
      diagnostics
    };
  }
  for (const sku of input.envelope.facts.skus) {
    const scope: InventoryScope = {
      shopId: input.envelope.scope.shopId,
      productId: input.envelope.facts.productId,
      platformSkuId: sku.platformSkuId,
      merchantCode: sku.merchantCode
    };
    const forecast = input.forecasts[sku.platformSkuId];
    if (!forecast) {
      findings.push({ scope, kind: "data_quality", severity: "unknown", legacyBelow200: false, reason: "SKU forecast is missing." });
      continue;
    }
    const demand2 = horizon(forecast, 2).p90;
    const demand6 = horizon(forecast, 6).p90;
    const skuSeverity = sku.currentStock <= demand2 ? "critical" : sku.currentStock <= demand6 ? "warning" : "normal";
    findings.push({
      scope,
      kind: "sku",
      severity: skuSeverity,
      availableStock: sku.currentStock,
      requiredP90: skuSeverity === "critical" ? demand2 : demand6,
      horizonHours: skuSeverity === "critical" ? 2 : 6,
      legacyBelow200: sku.currentStock < 200,
      reason: skuSeverity === "normal" ? "SKU stock covers the six-hour P90 demand." : `SKU stock does not cover the ${skuSeverity === "critical" ? 2 : 6}-hour P90 demand.`
    });
    const estimate = input.channelEstimates[sku.platformSkuId];
    if (!estimate || estimate.status !== "ready") {
      for (const channel of sku.channels) {
        findings.push({
          scope: { ...scope, channelGoodsId: channel.channelGoodsId },
          kind: "channel",
          severity: "unknown",
          availableStock: channel.stock,
          legacyBelow200: channel.stock < 200,
          reason: estimate?.diagnostics[0] ?? "Channel consumption estimate is unavailable."
        });
      }
      continue;
    }
    for (const channel of sku.channels) {
      const share = estimate.shares[channel.channelGoodsId];
      if (share === undefined) {
        findings.push({
          scope: { ...scope, channelGoodsId: channel.channelGoodsId },
          kind: "channel",
          severity: "unknown",
          availableStock: channel.stock,
          legacyBelow200: channel.stock < 200,
          reason: "Channel mapping exists but no reliable consumption share is available."
        });
        continue;
      }
      const channel2 = demand2 * share;
      const channel6 = demand6 * share;
      const severity = channel.stock <= channel2 ? "critical" : channel.stock <= channel6 ? "warning" : "normal";
      findings.push({
        scope: { ...scope, channelGoodsId: channel.channelGoodsId },
        kind: "channel",
        severity,
        availableStock: channel.stock,
        requiredP90: round(severity === "critical" ? channel2 : channel6),
        horizonHours: severity === "critical" ? 2 : 6,
        legacyBelow200: channel.stock < 200,
        reason: severity === "normal" ? "Channel stock covers the six-hour allocated P90 demand." : `Channel stock does not cover the ${severity === "critical" ? 2 : 6}-hour allocated P90 demand.`
      });
    }
    const reserveRequired = (hours: 6 | 24): number => {
      const demand = horizon(forecast, hours).p90;
      return sku.channels.reduce((sum, channel) => {
        const share = estimate.shares[channel.channelGoodsId] ?? 0;
        return sum + Math.max(0, demand * share - channel.stock);
      }, 0);
    };
    const reserve6 = reserveRequired(6);
    const reserve24 = reserveRequired(24);
    const reserveSeverity = sku.unoccupiedStock < reserve6 ? "critical" : sku.unoccupiedStock < reserve24 ? "warning" : "normal";
    findings.push({
      scope,
      kind: "reserve",
      severity: reserveSeverity,
      availableStock: sku.unoccupiedStock,
      requiredP90: round(reserveSeverity === "critical" ? reserve6 : reserve24),
      horizonHours: reserveSeverity === "critical" ? 6 : 24,
      legacyBelow200: sku.unoccupiedStock < 200,
      reason: reserveSeverity === "normal" ? "Unoccupied reserve can cover all channel top-up deficits for 24 hours." : `Unoccupied reserve cannot cover all channel top-up deficits for ${reserveSeverity === "critical" ? 6 : 24} hours.`
    });
  }
  return {
    policyVersion: INVENTORY_RISK_POLICY_VERSION,
    evaluatedAt: input.evaluatedAt,
    severity: maximumSeverity(findings),
    findings,
    diagnostics
  };
}

export function transitionIncident(
  current: IncidentProjection | undefined,
  severity: RiskSeverity
): IncidentProjection {
  const base = current ?? {
    state: "resolved" as const,
    severity: "normal" as const,
    warningStreak: 0,
    healthyStreak: 0,
    revision: 0
  };
  if (severity === "unknown") {
    return {
      // Unknown is an evidence-quality outcome, not a deterministic inventory
      // risk. Keep it in the immutable evaluation trail without presenting it
      // as an open operational incident.
      state: "resolved",
      severity,
      warningStreak: 0,
      healthyStreak: 0,
      revision: base.revision + 1
    };
  }
  if (severity === "critical") {
    return { state: "open", severity, warningStreak: 0, healthyStreak: 0, revision: base.revision + 1 };
  }
  if (severity === "warning") {
    const warningStreak = base.severity === "warning" ? base.warningStreak + 1 : 1;
    return {
      state: base.state === "open" || warningStreak >= 2 ? "open" : "pending",
      severity,
      warningStreak,
      healthyStreak: 0,
      revision: base.revision + 1
    };
  }
  const healthyStreak = base.severity === "normal" ? base.healthyStreak + 1 : 1;
  return {
    state: base.state === "open" && healthyStreak < 2 ? "open" : "resolved",
    severity,
    warningStreak: 0,
    healthyStreak,
    revision: base.revision + 1
  };
}

export function factDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
