import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EngineCheckpointRecord,
  ExecutionEventRecord,
  RunPlanSnapshotRecord,
  RunRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const startedAt = "2026-08-10T00:00:00.000Z";
const terminalAt = "2026-08-10T00:01:00.000Z";

function event(
  runId: string,
  sequence: number,
  type: string,
  occurredAt = startedAt
): ExecutionEventRecord {
  return {
    id: `event-${runId}-${sequence}`,
    runId,
    sequence,
    type,
    payload: {},
    occurredAt
  };
}

function run(runId: string): RunRecord {
  return {
    id: runId,
    workflowId: "test.workflow",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:workflow",
    status: "running",
    revision: 0,
    input: {},
    createdAt: startedAt,
    updatedAt: startedAt
  };
}

function plan(runId: string): RunPlanSnapshotRecord {
  return {
    runId,
    irVersion: "bpa.workflow-ir/2",
    planDigest: "sha256:plan",
    workflowSourceDigest: "sha256:workflow",
    artifactClosureDigest: "sha256:closure",
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.workflow",
        version: "1.0.0",
        digest: "sha256:workflow"
      },
      artifactClosure: { entries: [] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 1 },
      entry: "done",
      steps: {
        done: { key: "done", kind: "terminal", status: "succeeded" }
      }
    },
    riskSnapshot: [],
    createdAt: startedAt
  };
}

function checkpoint(runId: string): EngineCheckpointRecord {
  return {
    runId,
    stateVersion: "bpa.engine-state/2",
    stateRevision: 1,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId,
      revision: 1,
      status: "waiting_runtime"
    },
    updatedAt: startedAt
  };
}

afterEach(() => vi.useRealTimers());

describe("runtime activity metrics", () => {
  it("counts active work and preserves the latest terminal Run timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt));
    const store = new SqlitePersistence({ path: ":memory:" });
    try {
      const current = run("run-activity");
      store.createRecoverableRun({
        run: current,
        planSnapshot: plan(current.id),
        checkpoint: checkpoint(current.id),
        outbox: [
          {
            id: "runtime-invocation",
            topic: "runtime.invoke",
            aggregateId: current.id,
            payload: {},
            createdAt: startedAt
          }
        ],
        event: event(current.id, 1, "RUN_CREATED")
      });
      store.acquireTriggerLease({
        concurrencyKey: "test:trigger",
        ownerId: "owner-1",
        now: startedAt,
        ttlSeconds: 300
      });
      store.acquireBrowserControlLease({
        resourceId: "browser-instance:test",
        ownerId: "owner-1",
        now: startedAt,
        ttlSeconds: 300
      });

      expect(store.readRuntimeActivityMetrics(startedAt)).toEqual({
        activeRunCount: 1,
        activeTriggerOccurrenceCount: 0,
        activeTriggerAttemptCount: 0,
        pendingEngineOutboxCount: 1,
        activeControlLeaseCount: 2,
        activeExternalDomainLeaseCount: 0,
        activeStagingLeaseCount: 0,
        activeRecoverySessionCount: 0,
        activeAttentionDeliveryCount: 0,
        terminalRunCount: 0,
        latestTerminalRunAt: null
      });

      vi.setSystemTime(new Date(terminalAt));
      store.commitRunTransition({
        runId: current.id,
        expectedRevision: 0,
        nextStatus: "succeeded",
        output: {},
        event: event(current.id, 2, "RUN_SUCCEEDED", terminalAt)
      });
      expect(store.readRuntimeActivityMetrics(terminalAt)).toMatchObject({
        activeRunCount: 0,
        pendingEngineOutboxCount: 1,
        activeControlLeaseCount: 2,
        terminalRunCount: 1,
        latestTerminalRunAt: terminalAt
      });
      expect(
        store.readRuntimeActivityMetrics("2026-08-10T00:06:00.000Z")
      ).toMatchObject({
        activeControlLeaseCount: 0,
        latestTerminalRunAt: terminalAt
      });
    } finally {
      store.close();
    }
  });

  it("rejects an invalid observation timestamp", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    try {
      expect(() => store.readRuntimeActivityMetrics("invalid")).toThrow(
        "observedAt must be a timestamp"
      );
    } finally {
      store.close();
    }
  });
});
