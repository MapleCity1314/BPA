import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRuntimeProcesses,
  collectUntilComplete
} from "../scripts/collect-macos-runtime-metrics.mjs";

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
          schema: "bpa.core-runtime-metrics/4",
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
          activity: {
            activeRunCount: 0,
            activeTriggerOccurrenceCount: 0,
            activeTriggerAttemptCount: 0,
            pendingEngineOutboxCount: 0,
            activeControlLeaseCount: 0,
            activeExternalDomainLeaseCount: 0,
            activeStagingLeaseCount: 0,
            activeRecoverySessionCount: 0,
            activeAttentionDeliveryCount: 0,
            terminalRunCount: 1,
            latestTerminalRunAt: "2026-08-06T11:30:00.000Z",
            ignored: "must not escape"
          },
          teamWorker: {
            state: "ready",
            pid: 99_999_998,
            pendingInvocationCount: 1,
            ignored: "must not escape"
          },
          browserGateway: {
            connectionCount: 1,
            readySessionCount: 1,
            pendingCancelRequestCount: 0,
            nativeHostPids: [99_999_999],
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

      expect(sample.schema).toBe("bpa.runtime-resource-sample/2");
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
        activity: {
          activeRunCount: 0,
          activeTriggerOccurrenceCount: 0,
          activeTriggerAttemptCount: 0,
          pendingEngineOutboxCount: 0,
          activeControlLeaseCount: 0,
          activeExternalDomainLeaseCount: 0,
          activeStagingLeaseCount: 0,
          activeRecoverySessionCount: 0,
          activeAttentionDeliveryCount: 0,
          terminalRunCount: 1,
          latestTerminalRunAt: "2026-08-06T11:30:00.000Z"
        },
        teamWorker: {
          state: "ready",
          pid: 99_999_998,
          pendingInvocationCount: 1
        },
        browserGateway: {
          connectionCount: 1,
          readySessionCount: 1,
          pendingCancelRequestCount: 0,
          nativeHostPids: [99_999_999],
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
      expect(sample.runtimeProcesses).toEqual({
        nativeHosts: {
          declaredPids: [99_999_999],
          missingPids: [99_999_999],
          processes: []
        },
        teamWorker: {
          state: "ready",
          declaredPid: 99_999_998,
          process: null
        },
        shortLivedNodeChildren: []
      });

      const futureTerminal = JSON.parse(readFileSync(metricsPath, "utf8"));
      futureTerminal.activity.latestTerminalRunAt =
        "2026-08-06T12:01:00.000Z";
      writeFileSync(metricsPath, `${JSON.stringify(futureTerminal)}\n`);
      const rejected = JSON.parse(
        execFileSync(
          process.execPath,
          [collector, "--core-metrics", metricsPath, "--label", "test.none"],
          { encoding: "utf8" }
        )
      );
      expect(rejected.coreMetrics).toEqual({ status: "invalid" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies declared roles and only Node descendants as short-lived", () => {
    const process = (
      pid: number,
      parentPid: number,
      command: string
    ) => ({
      pid,
      parentPid,
      cpuPercent: pid / 100,
      rssKiB: pid * 10,
      elapsed: "00:10",
      command
    });
    const processes = [
      process(10, 1, "/runtime/node core.js"),
      process(20, 1, "/runtime/node inventory.js"),
      process(30, 300, "/runtime/bpa-native-host"),
      process(40, 10, "/runtime/node team-worker.js"),
      process(50, 20, "/runtime/node refresh-risk.ts"),
      process(51, 50, "/runtime/node nested-task.ts"),
      process(60, 20, "/bin/sh helper.sh"),
      process(70, 1, "/runtime/node unrelated.js")
    ];
    const services = {
      "com.bpa.core": { pid: 10 },
      "com.bpa.inventory-monitor": { pid: 20 }
    };
    const metrics = {
      status: "available",
      teamWorker: { state: "ready", pid: 40, pendingInvocationCount: 0 },
      browserGateway: { nativeHostPids: [30] }
    };

    const classified = classifyRuntimeProcesses(processes, services, metrics);
    expect(classified).toEqual({
      nativeHosts: {
        declaredPids: [30],
        missingPids: [],
        processes: [
          {
            pid: 30,
            parentPid: 300,
            cpuPercent: 0.3,
            rssKiB: 300,
            elapsed: "00:10"
          }
        ]
      },
      teamWorker: {
        state: "ready",
        declaredPid: 40,
        process: {
          pid: 40,
          parentPid: 10,
          cpuPercent: 0.4,
          rssKiB: 400,
          elapsed: "00:10"
        }
      },
      shortLivedNodeChildren: [
        {
          pid: 50,
          parentPid: 20,
          cpuPercent: 0.5,
          rssKiB: 500,
          elapsed: "00:10"
        },
        {
          pid: 51,
          parentPid: 50,
          cpuPercent: 0.51,
          rssKiB: 510,
          elapsed: "00:10"
        }
      ]
    });
    expect(JSON.stringify(classified)).not.toContain("refresh-risk");
    expect(JSON.stringify(classified)).not.toContain("unrelated");

    expect(
      classifyRuntimeProcesses(processes, services, {
        status: "available",
        teamWorker: {
          state: "ready",
          pid: 70,
          pendingInvocationCount: 0
        },
        browserGateway: { nativeHostPids: [60] }
      })
    ).toMatchObject({
      nativeHosts: { declaredPids: [60], missingPids: [60], processes: [] },
      teamWorker: { state: "ready", declaredPid: 70, process: null }
    });
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
