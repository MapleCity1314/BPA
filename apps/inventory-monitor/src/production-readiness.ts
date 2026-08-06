export interface InventoryProductionSnapshot {
  readonly observedAt: string;
  readonly databaseClockOffsetSeconds: number | null;
  readonly launchd: {
    readonly corePid: number | null;
    readonly monitorPid: number | null;
    readonly recoveryPid: number | null;
  };
  readonly statusFile: {
    readonly state: string;
    readonly updatedAt: string;
  } | null;
  readonly database: {
    readonly activeLeaseCount: number;
    readonly runningScheduleRunCount: number;
    readonly runningCollectionRunCount: number;
    readonly latestCollectionStatus: string | null;
    readonly latestCollectionCompletedAt: string | null;
  };
  readonly core: {
    readonly reachable: boolean;
    readonly browserReady: boolean;
    readonly activeBrowserControlLeaseCount: number | null;
    readonly connectedInventorySessionCount: number | null;
    readonly readyAuthenticatedPageCount: number | null;
    readonly blockedPageCount: number | null;
  };
}

export interface InventoryProductionReadiness {
  readonly schema: "bpa.inventory-production-readiness/1";
  readonly observedAt: string;
  readonly mode: "observe_only" | "idle_ready";
  readonly eligibleForCoreCutover: boolean;
  readonly eligibleForOneRecoveryTrigger: boolean;
  readonly blockers: readonly string[];
  readonly evidence: InventoryProductionSnapshot;
}

const ACTIVE_STATUS_STATES = new Set(["running", "starting", "triggered"]);
const TERMINAL_STATUS_FILE_STATES = new Set([
  "succeeded",
  "partial",
  "blocked",
  "degraded",
  "failed",
  "skipped",
  "auth_required"
]);
const TERMINAL_COLLECTION_STATES = new Set([
  "succeeded",
  "partial",
  "blocked",
  "degraded",
  "failed",
  "skipped"
]);

export function evaluateInventoryProductionReadiness(
  snapshot: InventoryProductionSnapshot
): InventoryProductionReadiness {
  const blockers: string[] = [];
  if (
    snapshot.databaseClockOffsetSeconds === null ||
    Math.abs(snapshot.databaseClockOffsetSeconds) > 5
  ) {
    blockers.push("CLOCK_ALIGNMENT_UNKNOWN_OR_EXCESSIVE");
  }
  if (snapshot.launchd.recoveryPid !== null) {
    blockers.push("RECOVERY_PROCESS_RUNNING");
  }
  if (snapshot.statusFile === null) {
    blockers.push("RECOVERY_STATUS_UNAVAILABLE");
  } else if (ACTIVE_STATUS_STATES.has(snapshot.statusFile.state)) {
    blockers.push("RECOVERY_STATUS_ACTIVE");
  } else if (!TERMINAL_STATUS_FILE_STATES.has(snapshot.statusFile.state)) {
    blockers.push("RECOVERY_STATUS_UNKNOWN");
  }
  if (snapshot.database.activeLeaseCount > 0) {
    blockers.push("POSTGRES_LEASE_ACTIVE");
  }
  if (snapshot.database.runningScheduleRunCount > 0) {
    blockers.push("SCHEDULE_RUN_ACTIVE");
  }
  if (snapshot.database.runningCollectionRunCount > 0) {
    blockers.push("COLLECTION_RUN_ACTIVE");
  }
  if (
    snapshot.database.latestCollectionStatus !== null &&
    !TERMINAL_COLLECTION_STATES.has(snapshot.database.latestCollectionStatus)
  ) {
    blockers.push("LATEST_COLLECTION_NOT_TERMINAL");
  } else if (
    snapshot.database.latestCollectionStatus !== null &&
    snapshot.database.latestCollectionCompletedAt === null
  ) {
    blockers.push("LATEST_COLLECTION_COMPLETION_UNKNOWN");
  }
  if (!snapshot.core.reachable || snapshot.launchd.corePid === null) {
    blockers.push("CORE_UNAVAILABLE");
  }
  if (snapshot.core.activeBrowserControlLeaseCount === null) {
    blockers.push("BROWSER_CONTROL_LEASE_STATE_UNKNOWN");
  } else if (snapshot.core.activeBrowserControlLeaseCount > 0) {
    blockers.push("BROWSER_CONTROL_LEASE_ACTIVE");
  }

  const eligibleForCoreCutover = blockers.length === 0;
  const triggerBlockers = [...blockers];
  if (!snapshot.core.browserReady) {
    triggerBlockers.push("BROWSER_BRIDGE_NOT_READY");
  }
  if (
    snapshot.core.connectedInventorySessionCount === null ||
    snapshot.core.connectedInventorySessionCount < 1
  ) {
    triggerBlockers.push("INVENTORY_BROWSER_SESSION_NOT_CONNECTED");
  }
  if (
    snapshot.core.readyAuthenticatedPageCount === null ||
    snapshot.core.readyAuthenticatedPageCount < 2
  ) {
    triggerBlockers.push("INVENTORY_READY_PAGE_COUNT_INSUFFICIENT");
  }
  if (
    snapshot.core.blockedPageCount === null ||
    snapshot.core.blockedPageCount > 0
  ) {
    triggerBlockers.push("INVENTORY_PAGE_BLOCKED_OR_UNKNOWN");
  }
  const allBlockers = [...new Set(triggerBlockers)];
  return {
    schema: "bpa.inventory-production-readiness/1",
    observedAt: snapshot.observedAt,
    mode: eligibleForCoreCutover ? "idle_ready" : "observe_only",
    eligibleForCoreCutover,
    eligibleForOneRecoveryTrigger: allBlockers.length === 0,
    blockers: allBlockers,
    evidence: snapshot
  };
}
