import {
  monitorEventLoopDelay,
  type IntervalHistogram
} from "node:perf_hooks";

export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

export interface EventLoopLagSnapshot {
  resolutionMs: typeof EVENT_LOOP_DELAY_RESOLUTION_MS;
  sampleCount: number;
  minimumMs: number;
  maximumMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface EventLoopDelayHistogram {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  enable(): boolean;
  disable(): boolean;
  percentile(percentile: number): number;
  reset(): void;
}

function milliseconds(nanoseconds: number): number {
  return Number((nanoseconds / 1_000_000).toFixed(3));
}

export function snapshotEventLoopLag(
  histogram: Pick<
    EventLoopDelayHistogram,
    "count" | "min" | "max" | "mean" | "percentile"
  >
): EventLoopLagSnapshot {
  if (histogram.count === 0) {
    return {
      resolutionMs: EVENT_LOOP_DELAY_RESOLUTION_MS,
      sampleCount: 0,
      minimumMs: 0,
      maximumMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0
    };
  }
  return {
    resolutionMs: EVENT_LOOP_DELAY_RESOLUTION_MS,
    sampleCount: histogram.count,
    minimumMs: milliseconds(histogram.min),
    maximumMs: milliseconds(histogram.max),
    meanMs: milliseconds(histogram.mean),
    p50Ms: milliseconds(histogram.percentile(50)),
    p95Ms: milliseconds(histogram.percentile(95)),
    p99Ms: milliseconds(histogram.percentile(99))
  };
}

export class RuntimeEventLoopMonitor {
  readonly #histogram: EventLoopDelayHistogram;

  constructor(
    histogram: EventLoopDelayHistogram = monitorEventLoopDelay({
      resolution: EVENT_LOOP_DELAY_RESOLUTION_MS
    }) as IntervalHistogram
  ) {
    this.#histogram = histogram;
    this.#histogram.enable();
  }

  snapshot(): EventLoopLagSnapshot {
    return snapshotEventLoopLag(this.#histogram);
  }

  reset(): void {
    this.#histogram.reset();
  }

  close(): void {
    this.#histogram.disable();
  }
}
