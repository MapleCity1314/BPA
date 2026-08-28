import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import type {
  BrowserControlLeaseRecord,
  BrowserPageObservationRecord,
  BrowserSessionRecord
} from "@bpa/persistence";
import {
  evaluateInventoryProductionReadiness,
  type InventoryProductionSnapshot
} from "./production-readiness.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function launchdPids(): ReadonlyMap<string, number> {
  const output = execFileSync("launchctl", ["list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const pids = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+[-\d]+\s+(\S+)\s*$/u);
    const pid = match?.[1];
    const label = match?.[2];
    if (pid && label) pids.set(label, Number(pid));
  }
  return pids;
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

async function statusFile(runtimeRoot: string): Promise<{
  state: string;
  updatedAt: string;
} | null> {
  try {
    const parsed = JSON.parse(
      await readFile(
        resolve(runtimeRoot, "run/inventory-multishop-recovery.status.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const state = String(parsed.state ?? "");
    const updatedAt = String(parsed.updatedAt ?? "");
    if (!state || !Number.isFinite(Date.parse(updatedAt))) {
      throw new Error("Inventory recovery status file is invalid");
    }
    return { state, updatedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface CountRow {
  readonly count: string;
}

interface LatestCollectionRow {
  readonly status: string;
  readonly completed_at: Date | string | null;
}

async function databaseSnapshot(connectionString: string) {
  const pool = createAppPostgresPool({
    connectionString,
    applicationName: "bpa-inventory-production-readiness",
    maximumConnections: 1,
    statementTimeoutMs: 10_000
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const [clock, leases, schedules, collections, latest] = await Promise.all([
      client.query<{ database_now: Date | string }>(
        "SELECT clock_timestamp() AS database_now"
      ),
      client.query<CountRow>(
        "SELECT count(*)::text AS count FROM ops.lease WHERE expires_at > clock_timestamp()"
      ),
      client.query<CountRow>(
        "SELECT count(*)::text AS count FROM ops.schedule_run WHERE status='running'"
      ),
      client.query<CountRow>(
        "SELECT count(*)::text AS count FROM ops.collection_run WHERE status='running'"
      ),
      client.query<LatestCollectionRow>(
        `SELECT status,completed_at FROM ops.collection_run
         ORDER BY started_at DESC LIMIT 1`
      )
    ]);
    await client.query("COMMIT");
    const databaseNow = clock.rows[0]?.database_now;
    if (databaseNow === undefined) throw new Error("Database clock is unavailable");
    const latestRow = latest.rows[0];
    return {
      databaseNow: new Date(databaseNow).toISOString(),
      activeLeaseCount: count(leases.rows[0]?.count, "active lease count"),
      runningScheduleRunCount: count(
        schedules.rows[0]?.count,
        "running schedule count"
      ),
      runningCollectionRunCount: count(
        collections.rows[0]?.count,
        "running collection count"
      ),
      latestCollectionStatus: latestRow?.status ?? null,
      latestCollectionCompletedAt: latestRow?.completed_at
        ? new Date(latestRow.completed_at).toISOString()
        : null
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function coreSnapshot(browserInstanceId: string) {
  const client = new ControlClient(
    new UnixSocketControlTransport(resolveControlSocketPath(), {
      runtime: { name: "bpa-inventory-production-readiness", version: "1.0.0" },
      features: ["resource_bindings", "browser_control_leases"]
    }),
    { timeoutMs: 10_000 }
  );
  try {
    const [doctor, leases, sessions, pages] = await Promise.all([
      client.request<{
        status: string;
        browser: { connected?: boolean; ready?: boolean };
      }>("doctor"),
      client.request<BrowserControlLeaseRecord[]>("browser.control-lease.list"),
      client.request<BrowserSessionRecord[]>("browser.session.list", { limit: 200 }),
      client.request<BrowserPageObservationRecord[]>(
        "browser.page-observation.list",
        { browserInstanceId, limit: 200 }
      )
    ]);
    const matchingSessions = sessions.filter(
      (session) =>
        session.browserInstanceId === browserInstanceId && !session.disconnectedAt
    );
    return {
      reachable: doctor.status === "ok",
      browserReady: doctor.browser.connected === true && doctor.browser.ready === true,
      activeBrowserControlLeaseCount: leases.length,
      connectedInventorySessionCount: matchingSessions.length,
      readyAuthenticatedPageCount: pages.filter(
        (page) =>
          page.observationState === "ready" &&
          page.authentication === "authenticated"
      ).length,
      blockedPageCount: pages.filter((page) =>
        ["auth_required", "challenge", "stale"].includes(page.observationState)
      ).length
    };
  } catch {
    return {
      reachable: false,
      browserReady: false,
      activeBrowserControlLeaseCount: null,
      connectedInventorySessionCount: null,
      readyAuthenticatedPageCount: null,
      blockedPageCount: null
    };
  }
}

async function main(): Promise<void> {
  const databaseUrl = required("BPA_APP_DATABASE_URL");
  const runtimeRoot = required("BPA_RUNTIME_ROOT");
  const browserInstanceId = required("BPA_INVENTORY_BROWSER_INSTANCE_ID");
  const observedAt = new Date().toISOString();
  const [database, core, recoveryStatus] = await Promise.all([
    databaseSnapshot(databaseUrl),
    coreSnapshot(browserInstanceId),
    statusFile(runtimeRoot)
  ]);
  const pids = launchdPids();
  const snapshot: InventoryProductionSnapshot = {
    observedAt,
    databaseClockOffsetSeconds:
      (Date.parse(database.databaseNow) - Date.parse(observedAt)) / 1_000,
    launchd: {
      corePid: pids.get("com.bpa.core") ?? null,
      servicePid: pids.get("com.bpa.inventory-service") ?? null,
      recoveryPid: pids.get("com.bpa.inventory-multishop-recovery") ?? null
    },
    statusFile: recoveryStatus,
    database: {
      activeLeaseCount: database.activeLeaseCount,
      runningScheduleRunCount: database.runningScheduleRunCount,
      runningCollectionRunCount: database.runningCollectionRunCount,
      latestCollectionStatus: database.latestCollectionStatus,
      latestCollectionCompletedAt: database.latestCollectionCompletedAt
    },
    core
  };
  process.stdout.write(
    `${JSON.stringify(evaluateInventoryProductionReadiness(snapshot), null, 2)}\n`
  );
}

await main().catch(() => {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "bpa.inventory-production-readiness/1",
        observedAt: new Date().toISOString(),
        mode: "observe_only",
        eligibleForCoreCutover: false,
        eligibleForOneRecoveryTrigger: false,
        blockers: ["READINESS_EVIDENCE_UNAVAILABLE"],
        evidence: null
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 75;
});
