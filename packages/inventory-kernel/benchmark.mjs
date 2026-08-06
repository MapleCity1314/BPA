import { performance } from "node:perf_hooks";
import { forecastDemand } from "../inventory-domain/src/index.ts";
import { forecastSeriesBatch } from "./index.js";

const skuCount = 777;
const asOf = "2026-08-06T00:00:00.000Z";
const asOfMs = Date.parse(asOf);
const values = Array.from({ length:90 * 24 + 1 },(_,index) =>
  index % 29 === 0 ? 3 : index % 11 === 0 ? 1 : 0
);
const observations = values.slice(0,-1).map((quantity,index) => ({
  at:new Date(asOfMs - (values.length - 1 - index) * 3_600_000).toISOString(),
  quantity
}));
const flattened = new Float64Array(values.length * skuCount);
const offsets = new Uint32Array(skuCount + 1);
const fallbackRates = new Float64Array(skuCount);
for (let index=0;index<skuCount;index+=1) {
  flattened.set(values,index * values.length);
  offsets[index]=index * values.length;
}
offsets[skuCount]=flattened.length;

for (let index=0;index<5;index+=1) {
  forecastDemand({ asOf,observations });
  forecastSeriesBatch(flattened,offsets,fallbackRates);
}
const tsStarted = performance.now();
for (let index=0;index<skuCount;index+=1) {
  forecastDemand({ asOf,observations });
}
const tsElapsed = performance.now()-tsStarted;
const rustStarted = performance.now();
const results = forecastSeriesBatch(flattened,offsets,fallbackRates);
const rustElapsed = performance.now()-rustStarted;
process.stdout.write(`${JSON.stringify({
  skuCount,
  historyHours:values.length,
  outputs:results.length,
  typescriptMs:Number(tsElapsed.toFixed(2)),
  rustBatchMs:Number(rustElapsed.toFixed(2)),
  speedup:Number((tsElapsed/rustElapsed).toFixed(2))
})}\n`);
