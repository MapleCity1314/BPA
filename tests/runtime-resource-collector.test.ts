import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectUntilComplete } from "../scripts/collect-macos-runtime-metrics.mjs";

const collector = resolve("scripts/collect-macos-runtime-metrics.mjs");

describe("runtime resource collector", () => {
  it("records a final sample at or beyond the requested duration", async () => {
    let clock = Date.parse("2026-08-06T00:00:00.000Z");
    const sampledAt: string[] = [];
    await collectUntilComplete(
      { durationSeconds: 120, intervalSeconds: 60 },
      {
        now: () => clock,
        sleep: async (milliseconds: number) => {
          clock += milliseconds;
        },
        collect: () => {
          clock += 5_000;
          return { sampledAt: new Date(clock).toISOString() };
        },
        write: (sample: { sampledAt: string }) => {
          sampledAt.push(sample.sampledAt);
        }
      }
    );

    expect(sampledAt).toHaveLength(3);
    expect(Date.parse(sampledAt.at(-1)!) - Date.parse(sampledAt[0]!))
      .toBeGreaterThanOrEqual(120_000);
  });

  it("copies only validated Core metrics fields into the sample", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-collector-"));
    try {
      const metricsPath = join(root, "core-runtime-metrics.json");
      writeFileSync(
        metricsPath,
        `${JSON.stringify({
          schema: "bpa.core-runtime-metrics/1",
          sampledAt: "2026-08-06T12:00:00.000Z",
          pid: 42,
          runtimeIdentity: "0.6.0-test",
          ignored: "must not escape",
          process: {
            rssBytes: 100_000,
            heapTotalBytes: 80_000,
            heapUsedBytes: 40_000,
            externalBytes: 10_000,
            arrayBuffersBytes: 5_000,
            ignored: "must not escape"
          },
          browserGateway: {
            connectionCount: 1,
            readySessionCount: 1,
            pendingCancelRequestCount: 0,
            pageProbes: {
              active: 2,
              capacity: 32,
              ttlMs: 10_000,
              ignored: "must not escape"
            },
            ignored: "must not escape"
          },
          sqlite: {
            measurement: "same_connection_db_status64",
            configuredCacheBytes: 16_384_000,
            pageSizeBytes: 4096,
            cacheSizeSetting: -16000,
            cacheUsedBytes: 8192,
            schemaUsedBytes: 1024,
            statementUsedBytes: 2048,
            ignored: "must not escape"
          }
        })}\n`
      );
      const sample = JSON.parse(
        execFileSync(
          process.execPath,
          [collector, "--core-metrics", metricsPath, "--label", "test.none"],
          { encoding: "utf8" }
        )
      );

      expect(sample.coreMetrics).toEqual({
        status: "available",
        sampledAt: "2026-08-06T12:00:00.000Z",
        pid: 42,
        runtimeIdentity: "0.6.0-test",
        process: {
          rssBytes: 100_000,
          heapTotalBytes: 80_000,
          heapUsedBytes: 40_000,
          externalBytes: 10_000,
          arrayBuffersBytes: 5_000
        },
        browserGateway: {
          connectionCount: 1,
          readySessionCount: 1,
          pendingCancelRequestCount: 0,
          pageProbes: {
            active: 2,
            capacity: 32,
            ttlMs: 10_000
          }
        },
        sqlite: {
          measurement: "same_connection_db_status64",
          configuredCacheBytes: 16_384_000,
          pageSizeBytes: 4096,
          cacheSizeSetting: -16000,
          cacheUsedBytes: 8192,
          schemaUsedBytes: 1024,
          statementUsedBytes: 2048
        }
      });
      expect(JSON.stringify(sample)).not.toContain("must not escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks malformed metrics invalid without copying their contents", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-collector-"));
    try {
      const metricsPath = join(root, "core-runtime-metrics.json");
      writeFileSync(metricsPath, "not-json secret-value\n");
      const sample = JSON.parse(
        execFileSync(
          process.execPath,
          [collector, "--core-metrics", metricsPath, "--label", "test.none"],
          { encoding: "utf8" }
        )
      );
      expect(sample.coreMetrics).toEqual({ status: "invalid" });
      expect(JSON.stringify(sample)).not.toContain("secret-value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
