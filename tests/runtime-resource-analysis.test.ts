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
    expect(result.sqlite.pageCache.runtimeIdentities).toEqual(["0.6.0-test"]);
    expect(result.conclusionGate).toMatchObject({
      windowComplete: true,
      continuityComplete: true,
      corePidStable: true,
      coreRuntimeIdentityStable: true,
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
