import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/analyze-macos-runtime-metrics.mjs");

function sample(sampledAt: string, pid: number, rssKiB: number) {
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
    }
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
    expect(result.conclusionGate.nodeAndChromeMeasurable).toBe(true);
    expect(result.sqlite.measurementBoundary).toBe("file_sizes_only");
    expect(result.sqlite.pageCache).toEqual({
      status: "not_measured",
      configuredBytes: null,
      actualBytes: null
    });
    expect(result.conclusionGate.phaseZeroResourceMeasurementComplete).toBe(false);
    expect(result.conclusionGate.blockers).toEqual([
      "sqlite_page_cache_not_measured"
    ]);
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
