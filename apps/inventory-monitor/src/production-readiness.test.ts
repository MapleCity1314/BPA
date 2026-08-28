import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateInventoryProductionReadiness,
  type InventoryProductionSnapshot
} from "./production-readiness.js";

function idleSnapshot(): InventoryProductionSnapshot {
  return {
    observedAt: "2026-08-06T12:00:00.000Z",
    databaseClockOffsetSeconds: 0.2,
    launchd: { corePid: 100, servicePid: 101, recoveryPid: null },
    statusFile: {
      state: "succeeded",
      updatedAt: "2026-08-06T11:30:00.000Z"
    },
    database: {
      activeLeaseCount: 0,
      runningScheduleRunCount: 0,
      runningCollectionRunCount: 0,
      latestCollectionStatus: "succeeded",
      latestCollectionCompletedAt: "2026-08-06T11:30:00.000Z"
    },
    core: {
      reachable: true,
      browserReady: true,
      activeBrowserControlLeaseCount: 0,
      connectedInventorySessionCount: 1,
      readyAuthenticatedPageCount: 2,
      blockedPageCount: 0
    }
  };
}

describe("inventory production readiness", () => {
  it("permits one controlled recovery only when all independent evidence agrees", () => {
    expect(evaluateInventoryProductionReadiness(idleSnapshot())).toMatchObject({
      mode: "idle_ready",
      eligibleForCoreCutover: true,
      eligibleForOneRecoveryTrigger: true,
      blockers: []
    });
  });

  it("fails closed when database, process, lease, and browser evidence conflicts", () => {
    const snapshot = idleSnapshot();
    const result = evaluateInventoryProductionReadiness({
      ...snapshot,
      launchd: { ...snapshot.launchd, recoveryPid: 999 },
      statusFile: { ...snapshot.statusFile!, state: "running" },
      database: {
        ...snapshot.database,
        activeLeaseCount: 1,
        runningScheduleRunCount: 2,
        runningCollectionRunCount: 1
      },
      core: {
        ...snapshot.core,
        activeBrowserControlLeaseCount: 1,
        readyAuthenticatedPageCount: 1,
        blockedPageCount: 1
      }
    });

    expect(result.mode).toBe("observe_only");
    expect(result.eligibleForCoreCutover).toBe(false);
    expect(result.eligibleForOneRecoveryTrigger).toBe(false);
    expect(result.blockers).toEqual([
      "RECOVERY_PROCESS_RUNNING",
      "RECOVERY_STATUS_ACTIVE",
      "POSTGRES_LEASE_ACTIVE",
      "SCHEDULE_RUN_ACTIVE",
      "COLLECTION_RUN_ACTIVE",
      "BROWSER_CONTROL_LEASE_ACTIVE",
      "INVENTORY_READY_PAGE_COUNT_INSUFFICIENT",
      "INVENTORY_PAGE_BLOCKED_OR_UNKNOWN"
    ]);
  });

  it("does not treat unavailable control-plane evidence as idle", () => {
    const snapshot = idleSnapshot();
    const result = evaluateInventoryProductionReadiness({
      ...snapshot,
      databaseClockOffsetSeconds: null,
      statusFile: null,
      core: {
        reachable: false,
        browserReady: false,
        activeBrowserControlLeaseCount: null,
        connectedInventorySessionCount: null,
        readyAuthenticatedPageCount: null,
        blockedPageCount: null
      }
    });

    expect(result.mode).toBe("observe_only");
    expect(result.blockers).toContain("CLOCK_ALIGNMENT_UNKNOWN_OR_EXCESSIVE");
    expect(result.blockers).toContain("RECOVERY_STATUS_UNAVAILABLE");
    expect(result.blockers).toContain("CORE_UNAVAILABLE");
    expect(result.blockers).toContain("BROWSER_CONTROL_LEASE_STATE_UNKNOWN");
    expect(result.blockers).toContain("INVENTORY_PAGE_BLOCKED_OR_UNKNOWN");
  });

  it("separates idle Core-cutover eligibility from browser trigger readiness", () => {
    const snapshot = idleSnapshot();
    const result = evaluateInventoryProductionReadiness({
      ...snapshot,
      core: {
        ...snapshot.core,
        browserReady: false,
        connectedInventorySessionCount: 0,
        readyAuthenticatedPageCount: 0
      }
    });

    expect(result.mode).toBe("idle_ready");
    expect(result.eligibleForCoreCutover).toBe(true);
    expect(result.eligibleForOneRecoveryTrigger).toBe(false);
    expect(result.blockers).toContain("BROWSER_BRIDGE_NOT_READY");
  });

  it("blocks a recovery trigger when the headless inventory service is absent", () => {
    const snapshot = idleSnapshot();
    const result = evaluateInventoryProductionReadiness({
      ...snapshot,
      launchd: { ...snapshot.launchd, servicePid: null }
    });

    expect(result.mode).toBe("idle_ready");
    expect(result.eligibleForCoreCutover).toBe(true);
    expect(result.eligibleForOneRecoveryTrigger).toBe(false);
    expect(result.blockers).toContain("INVENTORY_SERVICE_UNAVAILABLE");
  });

  it("rejects an unrecognized status-file state", () => {
    const snapshot = idleSnapshot();
    const result = evaluateInventoryProductionReadiness({
      ...snapshot,
      statusFile: { ...snapshot.statusFile!, state: "unexpected" }
    });

    expect(result.mode).toBe("observe_only");
    expect(result.blockers).toContain("RECOVERY_STATUS_UNKNOWN");
  });

  it("returns a bounded observe-only result when evidence cannot be loaded", () => {
    const environment = { ...process.env };
    delete environment.BPA_APP_DATABASE_URL;
    delete environment.BPA_RUNTIME_ROOT;
    delete environment.BPA_INVENTORY_BROWSER_INSTANCE_ID;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./production-readiness-main.ts",import.meta.url))
      ],
      { encoding: "utf8", env: environment }
    );

    expect(result.status).toBe(75);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "observe_only",
      eligibleForCoreCutover: false,
      eligibleForOneRecoveryTrigger: false,
      blockers: ["READINESS_EVIDENCE_UNAVAILABLE"],
      evidence: null
    });
  });
});
