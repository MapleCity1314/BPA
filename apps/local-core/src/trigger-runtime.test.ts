import { randomUUID } from "node:crypto";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import type {
  EngineCheckpointRecord,
  RunPlanSnapshotRecord,
  RunRecord,
  RunStatus,
  TriggerSpecDefinition
} from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import { TriggerRuntime } from "./trigger-runtime.js";

const base: TriggerSpecDefinition = {
  apiVersion: "bpa.trigger/v1alpha2",
  id: "inventory.manual",
  version: "1.0.0",
  appId: "inventory-monitor",
  kind: "manual",
  workflow: { id: "inventory.refresh", version: "1.0.0" },
  enabled: true,
  inputSchemaVersion: "inventory.refresh-input/1",
  input: { shopId: "10461048" },
  concurrencyKey: "inventory:10461048",
  idempotencyPolicy: "request_key",
  retryPolicy: "none"
};

function planSnapshot(run: RunRecord): RunPlanSnapshotRecord {
  return {
    runId: run.id,
    irVersion: "bpa.workflow-ir/2",
    planDigest: "sha256:plan",
    workflowSourceDigest: run.workflowDigest,
    artifactClosureDigest: "sha256:closure",
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: run.workflowId,
        version: run.workflowVersion,
        digest: run.workflowDigest
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
    createdAt: run.createdAt
  };
}

function checkpoint(run: RunRecord): EngineCheckpointRecord {
  return {
    runId: run.id,
    stateVersion: "bpa.engine-state/2",
    stateRevision: 1,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId: run.id,
      revision: 1,
      status: "waiting_runtime"
    },
    updatedAt: run.updatedAt
  };
}

function runtime(store: SqlitePersistence, now: () => Date): TriggerRuntime {
  return new TriggerRuntime(
    store,
    (trigger, input, triggerAttemptId) => {
      const timestamp = now().toISOString();
      const run: RunRecord = {
        id: `run:${randomUUID()}`,
        workflowId: trigger.spec.workflow.id,
        workflowVersion: trigger.spec.workflow.version,
        workflowDigest: "sha256:test",
        status: "running",
        revision: 0,
        input,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      return store.createRecoverableRun({
        run,
        planSnapshot: planSnapshot(run),
        checkpoint: checkpoint(run),
        triggerAttemptId,
        event: {
          id: randomUUID(),
          runId: run.id,
          sequence: 1,
          type: "RUN_CREATED",
          payload: {},
          occurredAt: timestamp
        }
      });
    },
    now
  );
}

function finishRun(
  store: SqlitePersistence,
  run: RunRecord,
  status: Extract<RunStatus, "succeeded" | "rejected" | "uncertain" | "cancelled" | "failed">,
  occurredAt: string
): void {
  const event = {
    id: randomUUID(),
    runId: run.id,
    sequence: 2,
    type: `RUN_${status.toUpperCase()}`,
    payload: {},
    occurredAt
  };
  const attention =
    status === "succeeded" || status === "cancelled"
      ? undefined
      : projectTerminalRunAttention({
          id: run.id,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          status,
          updatedAt: occurredAt,
          events: [event]
        });
  store.commitRunTransition({
    runId: run.id,
    expectedRevision: run.revision,
    nextStatus: status,
    ...(attention
      ? {
          attention: { item: attention, state: "open" as const, revision: 0 },
          attentionDelivery: createTerminalAttentionDelivery({
            attention,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion
          })
        }
      : {}),
    event
  });
}

function schedule(
  id: string,
  options: Partial<TriggerSpecDefinition> = {}
): TriggerSpecDefinition {
  return {
    ...base,
    id,
    kind: "schedule",
    idempotencyPolicy: "occurrence",
    missedRunPolicy: "run_once",
    schedule: {
      type: "daily",
      timezone: "Asia/Shanghai",
      localTime: "08:00",
      onTimeWindowSeconds: 300
    },
    ...options
  };
}

describe("deterministic Trigger Runtime", () => {
  it("deduplicates one Manual request and atomically reconciles its terminal Run", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const trigger = store.putTriggerSpec({
      spec: base,
      actor: "operator",
      occurredAt: "2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store, () => new Date("2026-08-05T00:00:00.000Z"));
    const first = engine.fire({ trigger, occurrenceKey: "manual:req-1" });
    expect(first).toMatchObject({
      occurrence: { status: "running", attemptCount: 1 },
      attempt: { status: "running", attemptNumber: 1 }
    });
    const run = store.getRun(first.attempt!.workflowRunId!)!;
    expect(run.input).toEqual(base.input);
    const duplicate = engine.fire({ trigger, occurrenceKey: "manual:req-1" });
    expect(duplicate.occurrence.occurrenceId).toBe(first.occurrence.occurrenceId);
    expect(duplicate.attempt?.attemptId).toBe(first.attempt?.attemptId);

    finishRun(store, run, "succeeded", "2026-08-05T00:00:01.000Z");
    engine.tick();
    expect(store.getTriggerOccurrence(first.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "complete"
    });
    expect(store.getTriggerAttempt(first.attempt!.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "complete"
    });
    store.close();
  });

  it("materializes fixed-anchor intervals once and applies run_once catch-up", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const spec = schedule("inventory.schedule", {
      schedule: {
        type: "interval",
        anchorAt: "2026-08-05T00:00:00.000Z",
        intervalSeconds: 300,
        onTimeWindowSeconds: 60
      }
    });
    store.putTriggerSpec({
      spec,
      actor: "operator",
      occurredAt: "2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store, () => new Date("2026-08-05T00:10:00.000Z"));
    engine.tick();
    engine.tick();
    expect(store.listTriggerOccurrences(spec.id)).toMatchObject([
      { scheduledAt: "2026-08-05T00:10:00.000Z", status: "running" },
      {
        scheduledAt: "2026-08-05T00:05:00.000Z",
        status: "terminal",
        terminalOutcome: "missed"
      }
    ]);
    store.close();
  });

  it("drains an interval backlog larger than one calendar page", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const spec = schedule("inventory.large-backlog", {
      schedule: {
        type: "interval",
        anchorAt: "2026-08-05T00:00:00.000Z",
        intervalSeconds: 60,
        onTimeWindowSeconds: 60
      }
    });
    store.putTriggerSpec({
      spec,
      actor: "operator",
      occurredAt: "2026-08-05T00:00:00.000Z"
    });
    const at = new Date("2026-08-05T16:45:00.000Z");
    const engine = runtime(store, () => at);
    expect(() => engine.tick()).not.toThrow();
    expect(store.listActiveTriggerOccurrences(spec.id)).toMatchObject([
      { scheduledAt: "2026-08-05T16:40:00.000Z", status: "pending" }
    ]);
    expect(() => engine.tick()).not.toThrow();
    expect(
      store.getTriggerScheduleState(spec.id, spec.version)
    ).toMatchObject({ cursorAt: at.toISOString() });
    expect(store.listActiveTriggerOccurrences(spec.id)).toMatchObject([
      { scheduledAt: "2026-08-05T16:45:00.000Z", status: "running" }
    ]);
    store.close();
  });

  it("advances valid Triggers when one Trigger tick fails", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const failed: TriggerSpecDefinition = {
      ...base,
      id: "a.failed-dataset",
      kind: "dataset",
      dataset: { id: "broken-dataset" },
      idempotencyPolicy: "dataset_version"
    };
    const valid = schedule("z.valid-schedule");
    store.putTriggerSpec({
      spec: failed,
      actor: "operator",
      occurredAt: "2026-08-04T23:59:00.000Z"
    });
    store.putTriggerSpec({
      spec: valid,
      actor: "operator",
      occurredAt: "2026-08-04T23:59:00.000Z"
    });
    vi.spyOn(store, "latestDatasetVersion").mockImplementation((datasetId) => {
      if (datasetId === "broken-dataset") throw new Error("broken source");
      return undefined;
    });

    expect(() =>
      runtime(store, () => new Date("2026-08-05T00:00:00.000Z")).tick()
    ).toThrow("One or more Trigger ticks failed");
    expect(store.listActiveTriggerOccurrences(valid.id)).toMatchObject([
      { status: "running" }
    ]);
    expect(store.listTriggerOccurrences(failed.id)).toEqual([]);
    store.close();
  });

  it("executes skip and bounded catch-up as distinct persisted policies", () => {
    const scenarios = [
      {
        id: "inventory.skip",
        policy: "skip" as const,
        expected: ["running", "skipped", "skipped"]
      },
      {
        id: "inventory.bounded",
        policy: "bounded_catch_up" as const,
        expected: ["deferred", "running", "missed"]
      }
    ];
    for (const scenario of scenarios) {
      const store = new SqlitePersistence({ path: ":memory:" });
      const spec = schedule(scenario.id, {
        missedRunPolicy: scenario.policy,
        ...(scenario.policy === "bounded_catch_up"
          ? { maxCatchUpOccurrences: 2 }
          : {}),
        schedule: {
          type: "interval",
          anchorAt: "2026-08-05T00:00:00.000Z",
          intervalSeconds: 300,
          onTimeWindowSeconds: 60
        }
      });
      store.putTriggerSpec({
        spec,
        actor: "operator",
        occurredAt: "2026-08-05T00:00:00.000Z"
      });
      runtime(store, () => new Date("2026-08-05T00:15:00.000Z")).tick();
      expect(
        store.listTriggerOccurrences(spec.id).map((item) =>
          item.status === "terminal" ? item.terminalOutcome : item.status
        )
      ).toEqual(scenario.expected);
      store.close();
    }
  });

  it("resumes a deferred occurrence after a Core restart", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-04T23:59:00.000Z");
    const spec = schedule("inventory.restart", {
      browserInstanceId: "doudian-company-main"
    });
    store.putTriggerSpec({
      spec,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const externalLease = store.acquireBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "external-controller",
      now: current.toISOString(),
      ttlSeconds: 300
    })!;

    current = new Date("2026-08-05T00:00:00.000Z");
    runtime(store, () => current).tick();
    const deferred = store.listTriggerOccurrences(spec.id)[0]!;
    expect(deferred).toMatchObject({
      status: "deferred",
      attemptCount: 0,
      nextAttemptAt: "2026-08-05T00:01:00.000Z"
    });
    store.releaseBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "external-controller",
      fencingToken: externalLease.fencingToken,
      releasedAt: "2026-08-05T00:00:30.000Z"
    });

    current = new Date("2026-08-05T00:01:01.000Z");
    runtime(store, () => current).tick();
    expect(store.getTriggerOccurrence(deferred.occurrenceId)).toMatchObject({
      status: "running",
      attemptCount: 1
    });
    store.close();
  });

  it("sweeps leases left behind after an Attempt becomes terminal", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const at = "2026-08-05T00:00:00.000Z";
    store.putTriggerSpec({ spec: base, actor: "operator", occurredAt: at });
    store.claimTriggerOccurrence({
      occurrenceId: "occurrence-terminal-lease",
      triggerId: base.id,
      triggerVersion: base.version,
      occurrenceKey: "manual:terminal-lease",
      scheduledAt: at,
      status: "pending",
      attemptCount: 0,
      revision: 0,
      createdAt: at,
      updatedAt: at
    });
    store.createTriggerAttempt({
      attemptId: "trigger-attempt:terminal-lease",
      occurrenceId: "occurrence-terminal-lease",
      expectedOccurrenceRevision: 0,
      createdAt: at
    });
    store.acquireTriggerLease({
      concurrencyKey: "orphaned-trigger",
      ownerId: "trigger-attempt:terminal-lease",
      now: at,
      ttlSeconds: 300
    });
    store.acquireBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "trigger-attempt:terminal-lease",
      now: at,
      ttlSeconds: 300
    });
    store.acquireBrowserControlLease({
      resourceId: "browser-instance:recovery",
      ownerId: "recovery-session:active",
      now: at,
      ttlSeconds: 300
    });
    store.finishTriggerAttempt({
      attemptId: "trigger-attempt:terminal-lease",
      expectedAttemptRevision: 0,
      occurrenceId: "occurrence-terminal-lease",
      expectedOccurrenceRevision: 1,
      outcome: "failed",
      updatedAt: at
    });

    const engine = runtime(store, () => new Date(at));
    engine.tick();
    engine.tick();
    expect(store.listTriggerLeases(at)).toEqual([]);
    expect(store.listBrowserControlLeases(at)).toMatchObject([
      {
        resourceId: "browser-instance:recovery",
        ownerId: "recovery-session:active"
      }
    ]);
    store.close();
  });

  it("does not sweep a lease whose Attempt is not yet persisted", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const at = "2026-08-05T00:00:00.000Z";
    store.acquireTriggerLease({
      concurrencyKey: "claim-in-progress",
      ownerId: "trigger-attempt:not-yet-persisted",
      now: at,
      ttlSeconds: 300
    });
    store.acquireBrowserControlLease({
      resourceId: "browser-instance:claim-in-progress",
      ownerId: "trigger-attempt:not-yet-persisted",
      now: at,
      ttlSeconds: 300
    });

    runtime(store, () => new Date(at)).tick();
    expect(store.listTriggerLeases(at)).toHaveLength(1);
    expect(store.listBrowserControlLeases(at)).toHaveLength(1);
    store.close();
  });

  it("defers simultaneous Mac workflows instead of dropping them", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-04T23:59:00.000Z");
    const specifications = [
      ["inventory.schedule", "inventory-monitor", "inventory.refresh", "inventory:cycle"],
      ["retired.schedule", "retired-monitor", "retired-products.scan", "retired:cycle"],
      ["experience.schedule", "experience-monitor", "experience-score.collect", "experience:cycle"]
    ] as const;
    for (const [id, appId, workflowId, concurrencyKey] of specifications) {
      store.putTriggerSpec({
        spec: schedule(id, {
          appId,
          workflow: { id: workflowId, version: "1.0.0" },
          concurrencyKey,
          browserInstanceId: "doudian-company-main"
        }),
        actor: "operator",
        occurredAt: current.toISOString()
      });
    }
    const engine = runtime(store, () => current);
    current = new Date("2026-08-05T00:00:00.000Z");
    engine.tick();

    const firstPass = specifications.map(([id]) =>
      store.listTriggerOccurrences(id)[0]!
    );
    expect(firstPass.filter((item) => item.status === "running")).toHaveLength(1);
    expect(firstPass.filter((item) => item.status === "deferred")).toHaveLength(2);
    expect(firstPass.filter((item) => item.status === "deferred")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptCount: 0,
          nextAttemptAt: "2026-08-05T00:01:00.000Z"
        })
      ])
    );

    const runningOccurrence = firstPass.find((item) => item.status === "running")!;
    const runningAttempt = store.listActiveTriggerAttempts(
      runningOccurrence.triggerId
    )[0]!;
    const runningRun = store.getRun(runningAttempt.workflowRunId!)!;
    current = new Date("2026-08-05T00:01:01.000Z");
    finishRun(store, runningRun, "succeeded", current.toISOString());
    engine.tick();

    const secondPass = specifications.map(([id]) =>
      store.listTriggerOccurrences(id)[0]!
    );
    expect(secondPass.filter((item) => item.status === "terminal")).toEqual([
      expect.objectContaining({ terminalOutcome: "complete" })
    ]);
    expect(secondPass.filter((item) => item.status === "running")).toHaveLength(1);
    expect(secondPass.filter((item) => item.status === "deferred")).toEqual([
      expect.objectContaining({
        attemptCount: 0,
        nextAttemptAt: "2026-08-05T00:02:01.000Z"
      })
    ]);
    store.close();
  });

  it("fails closed when a browser lease is fenced by another controller", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: { ...base, browserInstanceId: "doudian-company-main" },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const engine = runtime(store, () => current);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:fenced" });
    const attempt = fired.attempt!;
    expect(attempt.browserFencingToken).toBe(1);

    current = new Date("2026-08-05T00:00:01.000Z");
    expect(
      store.releaseBrowserControlLease({
        resourceId: "browser-instance:doudian-company-main",
        ownerId: attempt.attemptId,
        fencingToken: attempt.browserFencingToken!,
        releasedAt: current.toISOString()
      })
    ).toBe(true);
    expect(
      store.acquireBrowserControlLease({
        resourceId: "browser-instance:doudian-company-main",
        ownerId: "recovery-session:successor",
        now: current.toISOString(),
        ttlSeconds: 300
      })?.fencingToken
    ).toBe(2);

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "failed",
      diagnostic: "Browser instance lease was lost."
    });
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([
      expect.objectContaining({ ownerId: "recovery-session:successor", fencingToken: 2 })
    ]);
    store.close();
  });

  it("recovers a crash between lease acquisition and Workflow creation", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const now = "2026-08-05T00:00:00.000Z";
    store.putTriggerSpec({
      spec: { ...base, browserInstanceId: "doudian-company-main" },
      actor: "operator",
      occurredAt: now
    });
    const occurrenceId = "trigger-occurrence:interrupted-start";
    store.claimTriggerOccurrence({
      occurrenceId,
      triggerId: base.id,
      triggerVersion: base.version,
      occurrenceKey: "manual:interrupted-start",
      scheduledAt: now,
      status: "pending",
      attemptCount: 0,
      revision: 0,
      createdAt: now,
      updatedAt: now
    });
    const attemptId = "trigger-attempt:interrupted-start";
    const claimed = store.createTriggerAttempt({
      attemptId,
      occurrenceId,
      expectedOccurrenceRevision: 0,
      createdAt: now
    });
    const triggerLease = store.acquireTriggerLease({
      concurrencyKey: base.concurrencyKey,
      ownerId: attemptId,
      now,
      ttlSeconds: 300
    })!;
    const browserLease = store.acquireBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: attemptId,
      now,
      ttlSeconds: 300
    })!;
    store.updateTriggerAttempt({
      attemptId,
      expectedRevision: claimed.attempt.revision,
      status: "running",
      fencingToken: triggerLease.fencingToken,
      browserFencingToken: browserLease.fencingToken,
      updatedAt: now
    });

    runtime(store, () => new Date("2026-08-05T00:00:01.000Z")).tick();
    expect(store.getTriggerOccurrence(occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "failed",
      diagnostic: "Workflow Run was not created before reconciliation."
    });
    expect(store.listBrowserControlLeases("2026-08-05T00:00:01.000Z")).toEqual([]);
    store.close();
  });

  it("reconciles an active Run with its pinned TriggerSpec version", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const trigger = store.putTriggerSpec({
      spec: base,
      actor: "operator",
      occurredAt: "2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store, () => new Date("2026-08-05T00:00:00.000Z"));
    const fired = engine.fire({ trigger, occurrenceKey: "manual:req-pinned" });
    store.putTriggerSpec({
      spec: {
        ...base,
        version: "2.0.0",
        workflow: { id: "inventory.refresh", version: "2.0.0" },
        concurrencyKey: "inventory:replacement"
      },
      actor: "operator",
      occurredAt: "2026-08-05T00:00:01.000Z"
    });
    const run = store.getRun(fired.attempt!.workflowRunId!)!;
    finishRun(store, run, "succeeded", "2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      triggerVersion: "1.0.0",
      status: "terminal",
      terminalOutcome: "complete"
    });
    store.close();
  });

  it("starts a deferred occurrence with its pinned version after publication advances", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: { ...base, browserInstanceId: "doudian-company-main" },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const external = store.acquireBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "external-controller",
      now: current.toISOString(),
      ttlSeconds: 300
    })!;
    const engine = runtime(store, () => current);
    const deferred = engine.fire({
      trigger,
      occurrenceKey: "manual:pinned-deferred"
    });
    expect(deferred.occurrence.status).toBe("deferred");
    store.putTriggerSpec({
      spec: {
        ...base,
        version: "2.0.0",
        workflow: { id: "inventory.refresh", version: "2.0.0" }
      },
      actor: "operator",
      occurredAt: "2026-08-05T00:00:30.000Z"
    });
    store.releaseBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "external-controller",
      fencingToken: external.fencingToken,
      releasedAt: "2026-08-05T00:00:30.000Z"
    });

    current = new Date("2026-08-05T00:01:01.000Z");
    engine.tick();
    const attempt = store.listTriggerAttempts(
      deferred.occurrence.occurrenceId
    )[0]!;
    expect(store.getRun(attempt.workflowRunId!)).toMatchObject({
      workflowId: "inventory.refresh",
      workflowVersion: "1.0.0"
    });
    store.close();
  });

  it.each(["rejected", "uncertain", "cancelled", "failed"] as const)(
    "preserves the %s Workflow terminal outcome",
    (terminalStatus) => {
      const store = new SqlitePersistence({ path: ":memory:" });
      const trigger = store.putTriggerSpec({
        spec: base,
        actor: "operator",
        occurredAt: "2026-08-05T00:00:00.000Z"
      });
      const engine = runtime(store, () => new Date("2026-08-05T00:00:00.000Z"));
      const fired = engine.fire({
        trigger,
        occurrenceKey: `manual:req-${terminalStatus}`
      });
      const run = store.getRun(fired.attempt!.workflowRunId!)!;
      finishRun(store, run, terminalStatus, "2026-08-05T00:00:01.000Z");
      engine.tick();
      expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
        status: "terminal",
        terminalOutcome: terminalStatus
      });
      store.close();
    }
  );
});
