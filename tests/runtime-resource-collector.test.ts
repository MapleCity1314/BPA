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
          schema: "bpa.core-runtime-metrics/2",
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
          eventLoop: {
            resolutionMs: 20,
            sampleCount: 59,
            minimumMs: 19.8,
            maximumMs: 44.2,
            meanMs: 20.4,
            p50Ms: 20.1,
            p95Ms: 21.5,
            p99Ms: 30.2,
            ignored: "must not escape"
          },
          browserGateway: {
            connectionCount: 1,
            readySessionCount: 1,
            pendingCancelRequestCount: 0,
            queue: {
              pendingBrowserOutbox: 1,
              queuedCommands: 2,
              inFlightCommands: 1,
              terminalResultsPendingApplication: 0,
              totalPending: 4,
              ignored: "must not escape"
            },
            pageProbes: {
              active: 2,
              capacity: 32,
              ttlMs: 10_000,
              ignored: "must not escape"
            },
            extension: {
              activeCommands: 1,
              activeTabCommands: 1,
              activeAllianceStages: 0,
              cancellationRequests: 0,
              cancellationStopBarriers: 0,
              observedTabs: 2,
              observationCapacity: 64,
              profileTabs: 3,
              managedTabs: 0,
              managedTabReservations: 0,
              managedTabCapacity: 8,
              pacingReservations: {
                active: 1,
                capacity: 64,
                ttlMs: 120_000,
                ignored: "must not escape"
              },
              probes: {
                active: 1,
                capacity: 32,
                ttlMs: 30_000,
                ignored: "must not escape"
              },
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
        eventLoop: {
          resolutionMs: 20,
          sampleCount: 59,
          minimumMs: 19.8,
          maximumMs: 44.2,
          meanMs: 20.4,
          p50Ms: 20.1,
          p95Ms: 21.5,
          p99Ms: 30.2
        },
        browserGateway: {
          connectionCount: 1,
          readySessionCount: 1,
          pendingCancelRequestCount: 0,
          queue: {
            pendingBrowserOutbox: 1,
            queuedCommands: 2,
            inFlightCommands: 1,
            terminalResultsPendingApplication: 0,
            totalPending: 4
          },
          pageProbes: {
            active: 2,
            capacity: 32,
            ttlMs: 10_000
          },
          extension: {
            activeCommands: 1,
            activeTabCommands: 1,
            activeAllianceStages: 0,
            cancellationRequests: 0,
            cancellationStopBarriers: 0,
            observedTabs: 2,
            observationCapacity: 64,
            profileTabs: 3,
            managedTabs: 0,
            managedTabReservations: 0,
            managedTabCapacity: 8,
            pacingReservations: {
              active: 1,
              capacity: 64,
              ttlMs: 120_000
            },
            probes: { active: 1, capacity: 32, ttlMs: 30_000 }
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
