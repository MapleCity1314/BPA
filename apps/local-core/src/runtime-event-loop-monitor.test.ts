import { describe, expect, it, vi } from "vitest";
import {
  RuntimeEventLoopMonitor,
  snapshotEventLoopLag
} from "./runtime-event-loop-monitor.js";

describe("Runtime event-loop monitor", () => {
  it("projects a bounded percentile snapshot in milliseconds", () => {
    expect(
      snapshotEventLoopLag({
        count: 4,
        min: 1_000_000,
        max: 9_876_543,
        mean: 4_500_000,
        percentile: (value) => value * 100_000
      })
    ).toEqual({
      resolutionMs: 20,
      sampleCount: 4,
      minimumMs: 1,
      maximumMs: 9.877,
      meanMs: 4.5,
      p50Ms: 5,
      p95Ms: 9.5,
      p99Ms: 9.9
    });
  });

  it("uses a zero snapshot before the first histogram observation", () => {
    expect(
      snapshotEventLoopLag({
        count: 0,
        min: Number.MAX_SAFE_INTEGER,
        max: 0,
        mean: Number.NaN,
        percentile: () => 511
      })
    ).toEqual({
      resolutionMs: 20,
      sampleCount: 0,
      minimumMs: 0,
      maximumMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0
    });
  });

  it("enables, resets and disables the resident histogram explicitly", () => {
    const histogram = {
      count: 1,
      min: 1_000_000,
      max: 2_000_000,
      mean: 1_500_000,
      enable: vi.fn(() => true),
      disable: vi.fn(() => true),
      percentile: vi.fn(() => 1_500_000),
      reset: vi.fn()
    };
    const monitor = new RuntimeEventLoopMonitor(histogram);
    expect(histogram.enable).toHaveBeenCalledOnce();
    expect(monitor.snapshot().sampleCount).toBe(1);
    monitor.reset();
    monitor.close();
    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(histogram.disable).toHaveBeenCalledOnce();
  });
});
