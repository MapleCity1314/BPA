import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/analyze-macos-runtime-metrics.mjs");

interface RuntimeSampleFixture {
  services: Record<
    string,
    {
      pid: number;
      parentPid: number;
      cpuPercent: number;
      rssKiB: number;
      elapsed: string;
    } | null
  >;
  coreMetrics?: {
    runtimeIdentity: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function sample(
  sampledAt: string,
  pid: number,
  rssKiB: number,
  cacheUsedBytes?: number,
  metricsSampledAt = sampledAt
): RuntimeSampleFixture {
  return {
    schema: "bpa.runtime-resource-sample/1",
    sampledAt,
    services: {
      "com.bpa.core": {
        pid,
        parentPid: 1,
        cpuPercent: 1,
        rssKiB,
        elapsed: "01:00"
      },
      "com.bpa.inventory-monitor": {
        pid: 20,
        parentPid: 1,
        cpuPercent: 0.5,
        rssKiB: Math.round(rssKiB * 0.75),
        elapsed: "01:00"
      }
    },
    chromeProfile: {
      processCount: 8,
      cpuPercent: 2,
      rssKiB: rssKiB * 2
    },
    sqlite: {
      databaseBytes: 1024,
      walBytes: 128,
      shmBytes: 32
    },
    ...(cacheUsedBytes === undefined
      ? {}
      : {
          coreMetrics: {
            status: "available",
            sampledAt: metricsSampledAt,
            pid,
            runtimeIdentity: "0.6.0-test",
            process: {
              rssBytes: rssKiB * 1024,
              heapTotalBytes: 80_000,
              heapUsedBytes: cacheUsedBytes,
              externalBytes: 10_000,
              arrayBuffersBytes: 5_000
            },
            browserGateway: {
              connectionCount: 1,
              readySessionCount: 1,
              pendingCancelRequestCount: 0,
              pageProbes: {
                active: 0,
                capacity: 32,
                ttlMs: 10_000
              },
              extension: {
                activeCommands: 0,
                activeTabCommands: 0,
                activeAllianceStages: 0,
                cancellationRequests: 0,
                cancellationStopBarriers: 0,
                observedTabs: 1,
                observationCapacity: 64,
                managedTabs: 0,
                pacingReservations: {
                  active: 0,
                  capacity: 64,
                  ttlMs: 120_000
                },
                probes: { active: 0, capacity: 32, ttlMs: 30_000 }
              }
            },
            sqlite: {
              measurement: "same_connection_db_status64",
              configuredCacheBytes: 16_384_000,
              pageSizeBytes: 4096,
              cacheSizeSetting: -16000,
              cacheUsedBytes,
              schemaUsedBytes: 1024,
              statementUsedBytes: 2048
            }
          }
        })
  };
}

function sevenDaySamples(
  rssForHour: (hour: number) => number,
  pidForHour: (hour: number) => number = () => 10
): RuntimeSampleFixture[] {
  const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
  return Array.from({ length:169 },(_,hour) => {
    const sampledAt = new Date(startedAt + hour * 60 * 60 * 1_000).toISOString();
    return sample(
      sampledAt,
      pidForHour(hour),
      rssForHour(hour),
      4_096 + (hour % 4) * 128
    );
  });
}

describe("runtime resource analysis", () => {
  it("keeps file size evidence separate from SQLite page-cache evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(sample("2026-08-05T00:00:00.000Z", 10, 100))}\n${JSON.stringify(
        sample("2026-08-06T00:00:00.000Z", 11, 220)
      )}\n`
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.source.durationHours).toBe(24);
    expect(result.services["com.bpa.core"].uniquePids).toEqual([10, 11]);
    expect(result.services["com.bpa.core"].pidChanges).toBe(1);
    expect(result.services["com.bpa.core"].rssKiB.change).toBe(120);
    expect(result.conclusionGate.nodeAndChromeMeasurable).toBe(false);
    expect(result.sqlite.measurementBoundary).toBe("file_sizes_only");
    expect(result.sqlite.pageCache).toEqual({
      status: "not_measured",
      measuredSamples: 0,
      missingSamples: 2,
      configuredBytes: null,
      actualBytes: null,
      schemaBytes: null,
      statementBytes: null,
      runtimeIdentities: []
    });
    expect(result.conclusionGate.phaseZeroResourceMeasurementComplete).toBe(false);
    expect(result.conclusionGate.blockers).toEqual([
      "core_pid_changed",
      "sqlite_page_cache_not_measured"
    ]);
  });

  it("keeps a stable legacy file-size window measurable for Node and Chrome", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(sample("2026-08-05T00:00:00.000Z", 10, 100))}\n${JSON.stringify(
        sample("2026-08-06T00:00:00.000Z", 10, 120)
      )}\n`
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.coreIdentity).toMatchObject({
      pidStable: true,
      runtimeIdentityExpected: false,
      runtimeIdentityStable: false
    });
    expect(result.conclusionGate).toMatchObject({
      nodeAndChromeMeasurable: true,
      sqlitePageCacheMeasurable: false,
      phaseZeroResourceMeasurementComplete: false
    });
    expect(result.conclusionGate.blockers).toEqual([
      "sqlite_page_cache_not_measured"
    ]);
  });

  it("closes the phase-zero gate with fresh same-connection cache metrics", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(
        sample("2026-08-05T00:00:00.000Z", 10, 100, 4096)
      )}\n${JSON.stringify(
        sample("2026-08-06T00:00:00.000Z", 10, 120, 8192)
      )}\n`
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.sqlite.measurementBoundary).toBe(
      "same_connection_db_status64"
    );
    expect(result.sqlite.pageCache.status).toBe("measured");
    expect(result.sqlite.pageCache.actualBytes.change).toBe(4096);
    expect(result.coreResident).toMatchObject({
      status: "measured",
      measuredSamples: 2,
      missingSamples: 0,
      browserGateway: {
        pageProbeCapacity: [32],
        pageProbeTtlMs: [10_000],
        extension: {
          observationCapacity: [64],
          pacingCapacity: [64],
          pacingTtlMs: [120_000],
          probeCapacity: [32],
          probeTtlMs: [30_000]
        }
      }
    });
    expect(result.coreResident.process.heapUsedBytes.change).toBe(4096);
    expect(result.sqlite.pageCache.runtimeIdentities).toEqual(["0.6.0-test"]);
    expect(result.conclusionGate).toMatchObject({
      windowComplete: true,
      continuityComplete: true,
      corePidStable: true,
      coreRuntimeIdentityStable: true,
      inventoryMonitorComplete: true,
      inventoryMonitorPidStable: true,
      chromeProfileComplete: true,
      nodeAndChromeMeasurable: true,
      sqlitePageCacheMeasurable: true,
      phaseZeroResourceMeasurementComplete: true,
      blockers: []
    });
    expect(result.coreIdentity).toEqual({
      missingPidSamples: 0,
      uniquePids: [10],
      pidStable: true,
      missingRuntimeIdentitySamples: 0,
      runtimeIdentities: ["0.6.0-test"],
      runtimeIdentityExpected: true,
      runtimeIdentityStable: true
    });
  });

  it("fails closed when Chrome profile samples are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    const first = sample("2026-08-05T00:00:00.000Z", 10, 100, 4096);
    const last = sample("2026-08-06T00:00:00.000Z", 10, 120, 8192);
    first.chromeProfile = null;
    last.chromeProfile = null;
    writeFileSync(
      input,
      `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`
    );

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.chromeProfile).toMatchObject({
      availableSamples: 0,
      missingSamples: 2,
      rssKiB: null
    });
    expect(result.conclusionGate).toMatchObject({
      chromeProfileComplete: false,
      nodeAndChromeMeasurable: false,
      phaseZeroResourceMeasurementComplete: false
    });
    expect(result.conclusionGate.blockers).toEqual([
      "chrome_profile_samples_missing"
    ]);
  });

  it("fails closed when inventory monitor samples are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    const first = sample("2026-08-05T00:00:00.000Z", 10, 100, 4096);
    const last = sample("2026-08-06T00:00:00.000Z", 10, 120, 8192);
    first.services["com.bpa.inventory-monitor"] = null;
    last.services["com.bpa.inventory-monitor"] = null;
    writeFileSync(
      input,
      `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--input",
        input,
        "--expected-interval-seconds",
        "43200",
        "--require-complete"
      ],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("inventory_monitor_samples_missing");
    expect(JSON.parse(result.stdout).conclusionGate).toMatchObject({
      inventoryMonitorComplete: false,
      inventoryMonitorPidStable: false,
      nodeAndChromeMeasurable: false,
      phaseZeroResourceMeasurementComplete: false,
      blockers: ["inventory_monitor_samples_missing"]
    });
  });

  it("fails closed when an inventory monitor sample is missing mid-window", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    const first = sample("2026-08-05T00:00:00.000Z", 10, 100, 4096);
    const middle = sample("2026-08-05T12:00:00.000Z", 10, 110, 6144);
    const last = sample("2026-08-06T00:00:00.000Z", 10, 120, 8192);
    middle.services["com.bpa.inventory-monitor"] = null;
    writeFileSync(
      input,
      `${JSON.stringify(first)}\n${JSON.stringify(middle)}\n${JSON.stringify(last)}\n`
    );

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.services["com.bpa.inventory-monitor"]).toMatchObject({
      availableSamples: 2,
      missingSamples: 1
    });
    expect(result.conclusionGate).toMatchObject({
      inventoryMonitorComplete: false,
      inventoryMonitorPidStable: false,
      nodeAndChromeMeasurable: false,
      phaseZeroResourceMeasurementComplete: false,
      blockers: ["inventory_monitor_samples_missing"]
    });
  });

  it("fails closed when the inventory monitor PID changes", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    const first = sample("2026-08-05T00:00:00.000Z", 10, 100, 4096);
    const last = sample("2026-08-06T00:00:00.000Z", 10, 120, 8192);
    last.services["com.bpa.inventory-monitor"]!.pid = 21;
    writeFileSync(
      input,
      `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`
    );

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.services["com.bpa.inventory-monitor"]).toMatchObject({
      missingSamples: 0,
      uniquePids: [20, 21],
      pidChanges: 1
    });
    expect(result.conclusionGate).toMatchObject({
      inventoryMonitorComplete: true,
      inventoryMonitorPidStable: false,
      nodeAndChromeMeasurable: false,
      phaseZeroResourceMeasurementComplete: false,
      blockers: ["inventory_monitor_pid_changed"]
    });
  });

  it("can enforce the conclusion gate with a non-zero exit status", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(
        sample("2026-08-05T00:00:00.000Z", 10, 100, 4096)
      )}\n${JSON.stringify(
        sample("2026-08-05T12:00:00.000Z", 10, 120, 8192)
      )}\n`
    );

    const result = spawnSync(
      process.execPath,
      [script, "--input", input, "--require-complete"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("minimum_duration_not_reached");
    expect(JSON.parse(result.stdout).conclusionGate).toMatchObject({
      windowComplete: false,
      phaseZeroResourceMeasurementComplete: false
    });
  });

  it("blocks conclusions when Core PID or Runtime identity is missing or changes", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    const first = sample("2026-08-05T00:00:00.000Z", 10, 100, 4096);
    const middle = sample("2026-08-05T12:00:00.000Z", 10, 110, 6144);
    middle.services["com.bpa.core"] = null;
    middle.coreMetrics!.runtimeIdentity = null;
    const last = sample("2026-08-06T00:00:00.000Z", 11, 120, 8192);
    last.coreMetrics!.runtimeIdentity = "0.6.1-test";
    writeFileSync(
      input,
      `${JSON.stringify(first)}\n${JSON.stringify(middle)}\n${JSON.stringify(last)}\n`
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--input",
          input,
          "--expected-interval-seconds",
          "43200"
        ],
        { encoding: "utf8" }
      )
    );

    expect(result.coreIdentity).toEqual({
      missingPidSamples: 1,
      uniquePids: [10, 11],
      pidStable: false,
      missingRuntimeIdentitySamples: 1,
      runtimeIdentities: ["0.6.0-test", "0.6.1-test"],
      runtimeIdentityExpected: true,
      runtimeIdentityStable: false
    });
    expect(result.conclusionGate).toMatchObject({
      corePidStable: false,
      coreRuntimeIdentityStable: false,
      nodeAndChromeMeasurable: false,
      sqlitePageCacheMeasurable: false,
      phaseZeroResourceMeasurementComplete: false
    });
    expect(result.conclusionGate.blockers).toEqual([
      "core_pid_missing",
      "core_pid_changed",
      "core_runtime_identity_missing",
      "core_runtime_identity_changed",
      "sqlite_page_cache_not_measured"
    ]);
  });

  it("rejects stale Core metrics instead of replaying them as measurements", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(
        sample(
          "2026-08-05T00:00:00.000Z",
          10,
          100,
          4096,
          "2026-08-04T23:00:00.000Z"
        )
      )}\n${JSON.stringify(
        sample(
          "2026-08-06T00:00:00.000Z",
          10,
          120,
          8192,
          "2026-08-05T23:00:00.000Z"
        )
      )}\n`
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [script, "--input", input, "--expected-interval-seconds", "60"],
        { encoding: "utf8" }
      )
    );

    expect(result.sqlite.pageCache.status).toBe("not_measured");
    expect(result.sqlite.pageCache.measuredSamples).toBe(0);
    expect(result.conclusionGate.sqlitePageCacheMeasurable).toBe(false);
    expect(result.conclusionGate.blockers).toContain(
      "sqlite_page_cache_not_measured"
    );
  });

  it("closes the seven-day Core stability gate for bounded RSS oscillation",() => {
    const root = mkdtempSync(join(tmpdir(),"bpa-runtime-stability-"));
    const input = join(root,"samples.jsonl");
    writeFileSync(
      input,
      `${sevenDaySamples((hour) => 100_000 + (hour % 6) * 128)
        .map((value) => JSON.stringify(value)).join("\n")}\n`
    );

    const result = JSON.parse(execFileSync(
      process.execPath,
      [script,"--input",input,"--expected-interval-seconds","3600","--require-stable"],
      { encoding:"utf8" }
    ));

    expect(result.stabilityGate).toMatchObject({
      windowComplete:true,
      continuityComplete:true,
      corePidStable:true,
      coreRuntimeIdentityStable:true,
      rssComplete:true,
      hourlyMedianBuckets:169,
      persistentMonotonicGrowth:false,
      growthWithinLimit:true,
      trendWithinLimit:true,
      coreSevenDayStable:true,
      blockers:[]
    });
    expect(result.stabilityGate.policy).toEqual({
      minimumDurationHours:168,
      baselineWindowHours:24,
      absoluteGrowthLimitKiB:8192,
      relativeGrowthLimit:0.1,
      monotonicIncreaseRatioLimit:0.8,
      monotonicGrowthFloorKiB:4096
    });
  });

  it("fails the seven-day gate for persistent monotonic Core RSS growth",() => {
    const root = mkdtempSync(join(tmpdir(),"bpa-runtime-stability-"));
    const input = join(root,"samples.jsonl");
    writeFileSync(
      input,
      `${sevenDaySamples((hour) => 100_000 + hour * 1024)
        .map((value) => JSON.stringify(value)).join("\n")}\n`
    );

    const result = spawnSync(
      process.execPath,
      [script,"--input",input,"--expected-interval-seconds","3600","--require-stable"],
      { encoding:"utf8" }
    );
    const analysis = JSON.parse(result.stdout);

    expect(result.status).toBe(3);
    expect(analysis.stabilityGate).toMatchObject({
      windowComplete:true,
      persistentMonotonicGrowth:true,
      growthWithinLimit:false,
      trendWithinLimit:false,
      coreSevenDayStable:false
    });
    expect(analysis.stabilityGate.blockers).toEqual([
      "core_rss_growth_exceeds_limit",
      "core_rss_trend_exceeds_limit",
      "core_rss_monotonic_growth"
    ]);
    expect(result.stderr).toContain("core_rss_monotonic_growth");
  });

  it("fails the seven-day gate when the observed Core process changes",() => {
    const root = mkdtempSync(join(tmpdir(),"bpa-runtime-stability-"));
    const input = join(root,"samples.jsonl");
    writeFileSync(
      input,
      `${sevenDaySamples(
        (hour) => 100_000 + (hour % 6) * 128,
        (hour) => hour < 84 ? 10 : 11
      ).map((value) => JSON.stringify(value)).join("\n")}\n`
    );

    const result = spawnSync(
      process.execPath,
      [script,"--input",input,"--expected-interval-seconds","3600","--require-stable"],
      { encoding:"utf8" }
    );
    const stability = JSON.parse(result.stdout).stabilityGate;

    expect(result.status).toBe(3);
    expect(stability).toMatchObject({
      windowComplete:true,
      corePidStable:false,
      coreRuntimeIdentityStable:true,
      coreSevenDayStable:false
    });
    expect(stability.blockers).toContain("core_pid_changed");
  });

  it("does not infer seven-day stability from a complete 24-hour window",() => {
    const root = mkdtempSync(join(tmpdir(),"bpa-runtime-stability-"));
    const input = join(root,"samples.jsonl");
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const samples = Array.from({ length:25 },(_,hour) => {
      const sampledAt = new Date(startedAt + hour * 60 * 60 * 1_000).toISOString();
      return sample(sampledAt,10,100_000 + (hour % 4) * 64,4096);
    });
    writeFileSync(
      input,
      `${samples.map((value) => JSON.stringify(value)).join("\n")}\n`
    );

    const result = spawnSync(
      process.execPath,
      [script,"--input",input,"--expected-interval-seconds","3600","--require-stable"],
      { encoding:"utf8" }
    );

    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).stabilityGate).toMatchObject({
      windowComplete:false,
      coreSevenDayStable:false,
      blockers:["seven_day_window_not_reached"]
    });
  });

  it("fails closed on a non-chronological sample stream", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-analysis-"));
    const input = join(root, "samples.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify(sample("2026-08-06T00:00:00.000Z", 10, 100))}\n${JSON.stringify(
        sample("2026-08-05T00:00:00.000Z", 10, 100)
      )}\n`
    );
    const result = spawnSync(process.execPath, [script, "--input", input], {
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not chronological");
  });
});
