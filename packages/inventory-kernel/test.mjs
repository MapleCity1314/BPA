import assert from "node:assert/strict";
import test from "node:test";
import { forecastDemand } from "../inventory-domain/src/index.ts";
import { forecastSeriesBatch } from "./index.js";

const asOf = "2026-08-02T12:00:00.000Z";

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function observations(series) {
  const end = Date.parse(asOf);
  return series.slice(0, -1).map((quantity, index) => ({
    at: new Date(end - (series.length - 1 - index) * 3_600_000).toISOString(),
    quantity
  }));
}

function publicForecast(kernel, fallbackReason) {
  const diagnostics = [];
  if (kernel.usedFallback) {
    diagnostics.push("SKU history is sparse; hierarchical fallback was used.");
    if (fallbackReason) diagnostics.push(fallbackReason);
  } else if (kernel.recentAcceleration > 1.25) {
    diagnostics.push("Recent demand acceleration increased the forecast.");
  }
  const horizons = [2, 6, 24].map((hours) => {
    const p50 = kernel.hourlyP50 * kernel.recentAcceleration * hours;
    const p90 = p50 + kernel.hourlyResidualP90 * Math.sqrt(hours);
    return { hours, p50:round(p50), p90:round(Math.max(p50, p90)) };
  });
  return {
    algorithmVersion:"inventory-demand-ensemble-conformal/1.0.0",
    asOf,
    selectedModel:kernel.selectedModel,
    dailyP50:horizons[2].p50,
    dailyP90:horizons[2].p90,
    horizons,
    confidence:kernel.confidence,
    recentAcceleration:round(kernel.recentAcceleration),
    trainingHours:kernel.trainingHours,
    diagnostics
  };
}

test("matches the TypeScript forecast for dense and sparse series",() => {
  const dense = Array.from({ length:35 * 24 + 1 },(_,index) =>
    index % 24 >= 8 && index % 24 <= 20 ? 2 : 0
  );
  const sparse = [1,0];
  const flat = new Float64Array([...dense,...sparse]);
  const offsets = new Uint32Array([0,dense.length,dense.length+sparse.length]);
  const results = forecastSeriesBatch(flat,offsets,new Float64Array([0,0.5]));

  assert.deepEqual(
    publicForecast(results[0]),
    forecastDemand({ asOf,observations:observations(dense) })
  );
  assert.deepEqual(
    publicForecast(results[1],"category fallback"),
    forecastDemand({
      asOf,observations:observations(sparse),
      fallbackHourlyRate:0.5,fallbackReason:"category fallback"
    })
  );
});

test("rejects malformed batch offsets",() => {
  assert.throws(
    () => forecastSeriesBatch(
      new Float64Array([1]),new Uint32Array([0,2]),new Float64Array([0])
    ),
    /final offset/u
  );
});
