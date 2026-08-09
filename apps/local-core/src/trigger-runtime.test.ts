import { randomUUID } from "node:crypto";
import {
  projectTerminalRunAttention,
  projectTerminalTriggerOccurrenceAttention
} from "@bpa/attention-core";
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
import { LocalCoreService } from "./control.js";
import { TriggerRuntime } from "./trigger-runtime.js";
import {
  ExternalDomainLeaseCoordinator,
  externalLeaseAllowsRunEffects
} from "./external-domain-lease-coordinator.js";
import {
  ExternalDomainLeaseProviderError,
  type ExternalDomainLeaseGrant,
  type ExternalDomainLeaseProvider
} from "./inventory-domain-lease-client.js";

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

function cancelTestRun(
  store: SqlitePersistence,
  now: () => Date,
  runId: string
): RunRecord {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (
    ["succeeded", "rejected", "failed", "cancelled", "uncertain"].includes(
      run.status
    )
  ) {
    return run;
  }
  return store.commitRunTransition({
    runId,
    expectedRevision: run.revision,
    nextStatus: "cancelled",
    event: {
      id: randomUUID(),
      runId,
      sequence: store.listEvents(runId).length + 1,
      type: "RUN_CANCELLED_AFTER_TRIGGER_CONTROL_LOSS",
      payload: {},
      occurredAt: now().toISOString()
    }
  });
}

function runtime(
  store: SqlitePersistence,
  now: () => Date,
  cancelWorkflow: (runId: string, reason: string) => RunRecord = (runId) =>
    cancelTestRun(store, now, runId),
  externalDomainLeases?: ExternalDomainLeaseCoordinator,
  markWorkflowUncertain?: (runId: string, diagnostic: string) => RunRecord
): TriggerRuntime {
  return new TriggerRuntime(
    store,
    (trigger, input, triggerAttemptId, externalDomainLeaseRequestId) => {
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
        ...(externalDomainLeaseRequestId
          ? { externalDomainLeaseRequestId }
          : {}),
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
    cancelWorkflow,
    now,
    externalDomainLeases,
    markWorkflowUncertain
  );
}

class TestExternalDomainLeaseProvider implements ExternalDomainLeaseProvider {
  readonly id = "inventory-postgres";
  readonly requests: string[] = [];
  active: ExternalDomainLeaseGrant | undefined;
  acquireError: Error | undefined;

  async acquire(input: {
    readonly requestId: string;
    readonly domainKey: string;
    readonly ownerId: string;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant> {
    this.requests.push(input.requestId);
    if (this.acquireError) {
      const error = this.acquireError;
      this.acquireError = undefined;
      throw error;
    }
    this.active = {
      domainKey: input.domainKey,
      ownerId: input.ownerId,
      fencingToken: 17,
      serverNow: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T00:05:00.000Z",
      active: true
    };
    return this.active;
  }

  async renew(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
    readonly ttlSeconds: number;
  }): Promise<ExternalDomainLeaseGrant> {
    this.active = {
      domainKey: input.domainKey,
      ownerId: input.ownerId,
      fencingToken: input.fencingToken,
      serverNow: "2026-08-05T00:04:00.000Z",
      expiresAt: "2026-08-05T00:09:00.000Z",
      active: true
    };
    return this.active;
  }

  async release(input: {
    readonly domainKey: string;
    readonly ownerId: string;
    readonly fencingToken: number;
  }): Promise<ExternalDomainLeaseGrant> {
    this.active = {
      domainKey: input.domainKey,
      ownerId: input.ownerId,
      fencingToken: input.fencingToken,
      serverNow: "2026-08-05T00:00:01.000Z",
      expiresAt: "2026-08-05T00:00:01.000Z",
      active: false
    };
    return this.active;
  }

  async read(): Promise<ExternalDomainLeaseGrant | undefined> {
    return this.active;
  }
}

const externalBase: TriggerSpecDefinition = {
  ...base,
  externalDomainLease: {
    providerId: "inventory-postgres",
    resourceId: "inventory-production-cycle",
    ttlSeconds: 300
  }
};

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
          attention: {
            sourceRef: { kind: "workflow-run" as const, runId: run.id },
            deliveryPolicy: "operator-notification" as const,
            item: attention,
            state: "open" as const,
            revision: 0
          },
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
  it("scopes pre-Run failures and triggered post-Run failure or partial attention by app", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const inventory = store.putTriggerSpec({
      spec: base,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    store.putTriggerSpec({
      spec: {
        ...base,
        version: "2.0.0",
        appId: "inventory-monitor-next",
        workflow: { id: "inventory.refresh", version: "2.0.0" }
      },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const other = store.putTriggerSpec({
      spec: {
        ...base,
        id: "other-app.manual",
        appId: "other-app",
        concurrencyKey: "other-app:manual"
      },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    store.claimTriggerOccurrence({
      occurrenceId: "occurrence:inventory-pre-run-failed",
      triggerId: base.id,
      triggerVersion: base.version,
      occurrenceKey: "manual:pre-run-failed",
      scheduledAt: current.toISOString(),
      status: "pending",
      attemptCount: 0,
      revision: 0,
      createdAt: current.toISOString(),
      updatedAt: current.toISOString()
    });
    store.finishTriggerOccurrenceWithAttention({
      occurrenceId: "occurrence:inventory-pre-run-failed",
      expectedRevision: 0,
      outcome: "failed",
      updatedAt: current.toISOString(),
      attention: {
        sourceRef: {
          kind: "trigger-occurrence",
          occurrenceId: "occurrence:inventory-pre-run-failed"
        },
        deliveryPolicy: "dashboard-only",
        item: projectTerminalTriggerOccurrenceAttention({
          occurrenceId: "occurrence:inventory-pre-run-failed",
          outcome: "failed",
          updatedAt: current.toISOString()
        }),
        state: "open",
        revision: 0
      }
    });

    const engine = runtime(store, () => current);
    const terminalizeTriggeredRun = (
      trigger: typeof inventory,
      requestKey: string,
      status: "failed" | "uncertain"
    ): string => {
      current = new Date(current.getTime() + 1_000);
      const fired = engine.fire({
        trigger,
        occurrenceKey: `manual:${requestKey}`
      });
      const run = store.getRun(fired.attempt!.workflowRunId!)!;
      current = new Date(current.getTime() + 1_000);
      finishRun(store, run, status, current.toISOString());
      engine.tick();
      return `run-terminal:${run.id}`;
    };
    const failedId = terminalizeTriggeredRun(
      inventory,
      "inventory-run-failed",
      "failed"
    );
    const partialId = terminalizeTriggeredRun(
      inventory,
      "inventory-run-partial",
      "uncertain"
    );
    const otherId = terminalizeTriggeredRun(other, "other-run-failed", "failed");

    current = new Date(current.getTime() + 1_000);
    const standaloneRun: RunRecord = {
      id: "run:standalone-failed",
      workflowId: base.workflow.id,
      workflowVersion: base.workflow.version,
      workflowDigest: "sha256:test",
      status: "running",
      revision: 0,
      input: {},
      createdAt: current.toISOString(),
      updatedAt: current.toISOString()
    };
    store.createRun({
      run: standaloneRun,
      event: {
        id: randomUUID(),
        runId: standaloneRun.id,
        sequence: 1,
        type: "RUN_CREATED",
        payload: {},
        occurredAt: current.toISOString()
      }
    });
    current = new Date(current.getTime() + 1_000);
    finishRun(store, standaloneRun, "failed", current.toISOString());

    const inventoryAttention = store.queryAttention({
      appIds: ["inventory-monitor"],
      limit: 20
    });
    expect(inventoryAttention).toMatchObject({ total: 3, truncated: false });
    expect(inventoryAttention.records.map((record) => record.item.id)).toEqual(
      expect.arrayContaining([
        "trigger-occurrence-terminal:occurrence:inventory-pre-run-failed",
        failedId,
        partialId
      ])
    );
    expect(inventoryAttention.records.map((record) => record.item.id)).not.toEqual(
      expect.arrayContaining([otherId, "run-terminal:run:standalone-failed"])
    );
    expect(store.queryAttention({
      sourceKinds: ["workflow-run"],
      appIds: ["inventory-monitor"],
      limit: 20
    })).toMatchObject({
      total: 2,
      records: expect.arrayContaining([
        expect.objectContaining({ item: expect.objectContaining({ id: failedId }) }),
        expect.objectContaining({ item: expect.objectContaining({ id: partialId }) })
      ])
    });
    expect(store.queryAttention({
      appIds: ["other-app"],
      limit: 20
    })).toMatchObject({
      total: 1,
      records: [expect.objectContaining({
        item: expect.objectContaining({ id: otherId })
      })]
    });
    const service = new LocalCoreService(store);
    const controlResponse = service.handle({
      id: "inventory-attention",
      method: "attention.list",
      params: { states: ["open"], appIds: ["inventory-monitor"], limit: 20 }
    });
    expect(controlResponse).toMatchObject({
      ok: true,
      result: {
        total: 3,
        truncated: false
      }
    });
    const controlItems = (controlResponse.result as { items: unknown[] }).items;
    expect(controlItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "trigger-occurrence-terminal:occurrence:inventory-pre-run-failed",
        sourceRef: expect.objectContaining({ kind: "trigger-occurrence" })
      }),
      expect.objectContaining({
        id: failedId,
        sourceRef: expect.objectContaining({ kind: "workflow-run" }),
        runStatus: "failed"
      }),
      expect.objectContaining({
        id: partialId,
        sourceRef: expect.objectContaining({ kind: "workflow-run" }),
        runStatus: "uncertain"
      })
    ]));
    store.close();
  });

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
    expect(
      store.queryAttention({
        sourceKinds: ["trigger-occurrence"],
        appIds: ["inventory-monitor"],
        limit: 20
      })
    ).toMatchObject({
      total: 1,
      truncated: false,
      records: [
        expect.objectContaining({ deliveryPolicy: "dashboard-only" })
      ]
    });
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
      expect(
        store.queryAttention({
          sourceKinds: ["trigger-occurrence"],
          appIds: ["inventory-monitor"],
          limit: 20
        }).total
      ).toBe(
        scenario.expected.filter(
          (value) => value === "missed" || value === "skipped"
        ).length
      );
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
      updatedAt: at,
      attention: {
        sourceRef: {
          kind: "trigger-occurrence",
          occurrenceId: "occurrence-terminal-lease"
        },
        deliveryPolicy: "dashboard-only",
        item: projectTerminalTriggerOccurrenceAttention({
          occurrenceId: "occurrence-terminal-lease",
          outcome: "failed",
          updatedAt: at
        }),
        state: "open",
        revision: 0
      }
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

    const secondRunningOccurrence = secondPass.find(
      (item) => item.status === "running"
    )!;
    const secondRunningAttempt = store.listActiveTriggerAttempts(
      secondRunningOccurrence.triggerId
    )[0]!;
    const secondRunningRun = store.getRun(secondRunningAttempt.workflowRunId!)!;
    current = new Date("2026-08-05T00:02:02.000Z");
    finishRun(store, secondRunningRun, "succeeded", current.toISOString());
    engine.tick();

    const thirdPass = specifications.map(([id]) =>
      store.listTriggerOccurrences(id)[0]!
    );
    expect(thirdPass.filter((item) => item.status === "terminal")).toHaveLength(2);
    expect(thirdPass.filter((item) => item.status === "running")).toHaveLength(1);
    expect(thirdPass.filter((item) => item.status === "deferred")).toEqual([]);

    const thirdRunningOccurrence = thirdPass.find(
      (item) => item.status === "running"
    )!;
    const thirdRunningAttempt = store.listActiveTriggerAttempts(
      thirdRunningOccurrence.triggerId
    )[0]!;
    const thirdRunningRun = store.getRun(thirdRunningAttempt.workflowRunId!)!;
    current = new Date("2026-08-05T00:03:03.000Z");
    finishRun(store, thirdRunningRun, "succeeded", current.toISOString());
    engine.tick();

    expect(
      specifications.map(([id]) => store.listTriggerOccurrences(id)[0])
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "terminal", terminalOutcome: "complete" }),
        expect.objectContaining({ status: "terminal", terminalOutcome: "complete" }),
        expect.objectContaining({ status: "terminal", terminalOutcome: "complete" })
      ])
    );
    expect(store.listTriggerLeases(current.toISOString())).toEqual([]);
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([]);
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
    const cancelWorkflow = vi.fn((runId: string) =>
      cancelTestRun(store, () => current, runId)
    );
    const engine = runtime(store, () => current, cancelWorkflow);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:fenced" });
    const attempt = fired.attempt!;
    const runId = attempt.workflowRunId!;
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
    expect(cancelWorkflow).toHaveBeenCalledWith(
      runId,
      "Browser instance lease was lost."
    );
    expect(store.getRun(runId)).toMatchObject({ status: "cancelled" });
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled",
      diagnostic: "Browser instance lease was lost."
    });
    expect(
      store.queryAttention({
        sourceKinds: ["trigger-occurrence"],
        appIds: ["inventory-monitor"],
        limit: 20
      }).total
    ).toBe(0);
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([
      expect.objectContaining({ ownerId: "recovery-session:successor", fencingToken: 2 })
    ]);
    store.close();
  });

  it("retries durable Workflow cancellation before terminalizing a fenced attempt", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: { ...base, browserInstanceId: "doudian-company-main" },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    let cancellationCalls = 0;
    const cancelWorkflow = vi.fn((runId: string) => {
      cancellationCalls += 1;
      if (cancellationCalls === 1) throw new Error("simulated cancellation crash");
      return cancelTestRun(store, () => current, runId);
    });
    const engine = runtime(store, () => current, cancelWorkflow);
    const fired = engine.fire({
      trigger,
      occurrenceKey: "manual:trigger-lease-fenced"
    });
    const attempt = fired.attempt!;
    const runId = attempt.workflowRunId!;

    current = new Date("2026-08-05T00:00:01.000Z");
    expect(
      store.releaseTriggerLease({
        concurrencyKey: base.concurrencyKey,
        ownerId: attempt.attemptId,
        fencingToken: attempt.fencingToken!,
        releasedAt: current.toISOString()
      })
    ).toBe(true);
    expect(
      store.acquireTriggerLease({
        concurrencyKey: base.concurrencyKey,
        ownerId: "successor",
        now: current.toISOString(),
        ttlSeconds: 300
      })?.fencingToken
    ).toBe(2);

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(store.getRun(runId)).toMatchObject({ status: "running" });
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "running"
    });
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "running"
    });
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([
      expect.objectContaining({
        resourceId: "browser-instance:doudian-company-main",
        ownerId: attempt.attemptId,
        fencingToken: attempt.browserFencingToken
      })
    ]);

    current = new Date("2026-08-05T00:00:03.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledTimes(2);
    expect(store.getRun(runId)).toMatchObject({ status: "cancelled" });
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled",
      diagnostic: "Trigger concurrency lease was lost."
    });
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled",
      diagnostic: "Trigger concurrency lease was lost."
    });
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([]);
    store.close();
  });

  it("retains the surviving concurrency lease until a browser-fenced Run is durably cancelled", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const oldTrigger = store.putTriggerSpec({
      spec: {
        ...base,
        id: "inventory.browser-fenced-old",
        browserInstanceId: "doudian-company-main"
      },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const successorTrigger = store.putTriggerSpec({
      spec: {
        ...base,
        id: "inventory.concurrency-successor"
      },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    let cancellationCalls = 0;
    const cancelWorkflow = vi.fn((runId: string) => {
      cancellationCalls += 1;
      if (cancellationCalls === 1) {
        return { ...store.getRun(runId)!, status: "cancelled" as const };
      }
      return cancelTestRun(store, () => current, runId);
    });
    const engine = runtime(store, () => current, cancelWorkflow);
    const old = engine.fire({
      trigger: oldTrigger,
      occurrenceKey: "manual:browser-fenced-old"
    });
    const oldAttempt = old.attempt!;
    const oldRunId = oldAttempt.workflowRunId!;

    current = new Date("2026-08-05T00:00:01.000Z");
    expect(store.releaseBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: oldAttempt.attemptId,
      fencingToken: oldAttempt.browserFencingToken!,
      releasedAt: current.toISOString()
    })).toBe(true);
    expect(store.acquireBrowserControlLease({
      resourceId: "browser-instance:doudian-company-main",
      ownerId: "recovery-session:successor",
      now: current.toISOString(),
      ttlSeconds: 300
    })?.fencingToken).toBe(2);

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(store.getRun(oldRunId)).toMatchObject({ status: "running" });
    expect(store.listTriggerLeases(current.toISOString())).toEqual([
      expect.objectContaining({
        resourceId: base.concurrencyKey,
        ownerId: oldAttempt.attemptId,
        fencingToken: oldAttempt.fencingToken
      })
    ]);

    const successor = engine.fire({
      trigger: successorTrigger,
      occurrenceKey: "manual:concurrency-successor"
    });
    expect(successor).toMatchObject({
      occurrence: {
        status: "deferred",
        attemptCount: 0,
        nextAttemptAt: "2026-08-05T00:01:02.000Z"
      }
    });
    expect(successor.attempt).toBeUndefined();
    expect(store.getRun(oldRunId)).toMatchObject({ status: "running" });

    current = new Date("2026-08-05T00:00:03.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledTimes(2);
    expect(store.getRun(oldRunId)).toMatchObject({ status: "cancelled" });
    expect(store.getTriggerAttempt(oldAttempt.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled"
    });
    expect(store.listTriggerLeases(current.toISOString())).toEqual([]);

    current = new Date("2026-08-05T00:01:03.000Z");
    engine.tick();
    expect(
      store.getTriggerOccurrence(successor.occurrence.occurrenceId)
    ).toMatchObject({ status: "running", attemptCount: 1 });
    expect(store.listActiveTriggerAttempts(successorTrigger.spec.id)).toEqual([
      expect.objectContaining({ status: "running", fencingToken: 2 })
    ]);
    store.close();
  });

  it("cancels an active browser Run before terminalizing an Attempt whose pinned TriggerSpec vanished", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: {
        ...base,
        id: "inventory.missing-pinned-spec",
        browserInstanceId: "doudian-company-main"
      },
      actor: "operator",
      occurredAt: current.toISOString()
    });
    let cancellationCalls = 0;
    const cancelWorkflow = vi.fn((runId: string) => {
      cancellationCalls += 1;
      if (cancellationCalls === 1) {
        throw new Error("simulated cancellation outage");
      }
      return cancelTestRun(store, () => current, runId);
    });
    const engine = runtime(store, () => current, cancelWorkflow);
    const fired = engine.fire({
      trigger,
      occurrenceKey: "manual:missing-pinned-spec"
    });
    const attempt = fired.attempt!;
    const runId = attempt.workflowRunId!;
    const getPinned = store.getTriggerSpecVersion.bind(store);
    vi.spyOn(store, "getTriggerSpecVersion").mockImplementation((id, version) =>
      id === trigger.spec.id && version === trigger.spec.version
        ? undefined
        : getPinned(id, version)
    );

    current = new Date("2026-08-05T00:00:01.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledWith(
      runId,
      "Pinned TriggerSpec version is missing."
    );
    expect(store.getRun(runId)).toMatchObject({ status: "running" });
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "running"
    });
    expect(store.listTriggerLeases(current.toISOString())).toHaveLength(1);
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([
      expect.objectContaining({
        ownerId: attempt.attemptId,
        fencingToken: attempt.browserFencingToken
      })
    ]);

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledTimes(2);
    expect(store.getRun(runId)).toMatchObject({ status: "cancelled" });
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled",
      diagnostic: "Pinned TriggerSpec version is missing."
    });
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled"
    });
    expect(store.listTriggerLeases(current.toISOString())).toEqual([]);
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([]);
    store.close();
  });

  it("finishes a fenced attempt from an already-terminal Workflow without cancelling it", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: base,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const cancelWorkflow = vi.fn((runId: string) =>
      cancelTestRun(store, () => current, runId)
    );
    const engine = runtime(store, () => current, cancelWorkflow);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:terminal-race" });
    const attempt = fired.attempt!;
    const run = store.getRun(attempt.workflowRunId!)!;

    current = new Date("2026-08-05T00:00:01.000Z");
    store.releaseTriggerLease({
      concurrencyKey: base.concurrencyKey,
      ownerId: attempt.attemptId,
      fencingToken: attempt.fencingToken!,
      releasedAt: current.toISOString()
    });
    store.acquireTriggerLease({
      concurrencyKey: base.concurrencyKey,
      ownerId: "successor",
      now: current.toISOString(),
      ttlSeconds: 300
    });
    finishRun(store, run, "succeeded", current.toISOString());

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "complete"
    });
    store.close();
  });

  it("recovers after Workflow cancellation commits before the Trigger Attempt finishes", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: base,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    let crashed = false;
    const cancelWorkflow = vi.fn((runId: string) => {
      const cancelled = cancelTestRun(store, () => current, runId);
      if (!crashed) {
        crashed = true;
        throw new Error("simulated crash after cancellation commit");
      }
      return cancelled;
    });
    const engine = runtime(store, () => current, cancelWorkflow);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:cancel-crash" });
    const attempt = fired.attempt!;

    current = new Date("2026-08-05T00:00:01.000Z");
    store.releaseTriggerLease({
      concurrencyKey: base.concurrencyKey,
      ownerId: attempt.attemptId,
      fencingToken: attempt.fencingToken!,
      releasedAt: current.toISOString()
    });
    store.acquireTriggerLease({
      concurrencyKey: base.concurrencyKey,
      ownerId: "successor",
      now: current.toISOString(),
      ttlSeconds: 300
    });

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();
    expect(store.getRun(attempt.workflowRunId!)).toMatchObject({
      status: "cancelled"
    });
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "running"
    });

    current = new Date("2026-08-05T00:00:03.000Z");
    engine.tick();
    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "cancelled",
      diagnostic: "Trigger concurrency lease was lost."
    });
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
    expect(
      store.queryAttention({
        sourceKinds: ["trigger-occurrence"],
        appIds: ["inventory-monitor"],
        limit: 20
      }).total
    ).toBe(1);
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
      expect(
        store.queryAttention({
          sourceKinds: ["trigger-occurrence"],
          appIds: ["inventory-monitor"],
          limit: 20
        }).total
      ).toBe(0);
      store.close();
    }
  );
});

describe("external inventory domain lease Trigger lifecycle", () => {
  it("does not create an Attempt until the same durable request is bound", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    const coordinator = new ExternalDomainLeaseCoordinator(
      store,
      [provider],
      () => current
    );
    const engine = runtime(store, () => current, undefined, coordinator);

    const fired = engine.fire({ trigger, occurrenceKey: "manual:lease" });
    expect(fired.attempt).toBeUndefined();
    const intent = store.listExternalDomainLeases()[0]!;
    expect(intent).toMatchObject({
      occurrenceId: fired.occurrence.occurrenceId,
      state: "acquiring"
    });
    expect(store.listTriggerAttempts(fired.occurrence.occurrenceId)).toEqual([]);

    await coordinator.tick();
    expect(store.getExternalDomainLease(intent.requestId)).toMatchObject({
      state: "bound",
      fencingToken: 17
    });
    engine.tick();
    const attempt = store.listTriggerAttempts(fired.occurrence.occurrenceId)[0]!;
    expect(attempt).toMatchObject({
      attemptId: intent.ownerId,
      status: "running"
    });
    expect(store.getExternalDomainLease(intent.requestId)).toMatchObject({
      triggerAttemptId: attempt.attemptId,
      runId: attempt.workflowRunId
    });
    expect(
      externalLeaseAllowsRunEffects(
        store,
        attempt.workflowRunId!,
        current.toISOString(),
        (requestId) => coordinator.canStart(requestId)
      )
    ).toBe(true);
    expect(
      externalLeaseAllowsRunEffects(
        store,
        attempt.workflowRunId!,
        current.toISOString(),
        () => false
      )
    ).toBe(false);
    store.close();
  });

  it.each([
    ["ahead", "2026-08-06T00:00:00.000Z"],
    ["behind", "2026-08-04T00:00:00.000Z"]
  ])("uses the provider duration when the Core clock is %s", async (_label, localNow) => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const current = new Date(localNow);
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    const coordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const engine = runtime(store, () => current, undefined, coordinator);
    const fired = engine.fire({ trigger, occurrenceKey: `manual:clock:${_label}` });

    await coordinator.tick();
    engine.tick();
    const attempt = store.listTriggerAttempts(fired.occurrence.occurrenceId)[0]!;
    expect(attempt.status).toBe("running");
    expect(
      externalLeaseAllowsRunEffects(
        store,
        attempt.workflowRunId!,
        current.toISOString(),
        (requestId) => coordinator.canStart(requestId)
      )
    ).toBe(true);
    store.close();
  });

  it("retries an uncertain acquisition with the same request id", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    provider.acquireError = new ExternalDomainLeaseProviderError(
      "INVENTORY_SERVICE_UNAVAILABLE",
      "socket closed",
      true
    );
    const coordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const engine = runtime(store, () => current, undefined, coordinator);
    engine.fire({ trigger, occurrenceKey: "manual:uncertain" });
    const requestId = store.listExternalDomainLeases()[0]!.requestId;

    await coordinator.tick();
    expect(store.getExternalDomainLease(requestId)?.state).toBe("acquiring");
    await coordinator.tick();
    expect(provider.requests).toEqual([requestId, requestId]);
    expect(store.getExternalDomainLease(requestId)?.state).toBe("bound");
    store.close();
  });

  it("requires a fresh remote verification after Core restart before creating the Attempt", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    const firstCoordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const firstRuntime = runtime(store, () => current, undefined, firstCoordinator);
    const fired = firstRuntime.fire({ trigger, occurrenceKey: "manual:restart" });
    await firstCoordinator.tick();
    const requestId = store.listExternalDomainLeases()[0]!.requestId;
    expect(firstCoordinator.canStart(requestId)).toBe(true);

    const restartedCoordinator = new ExternalDomainLeaseCoordinator(
      store,
      [provider],
      () => current
    );
    const restartedRuntime = runtime(
      store,
      () => current,
      undefined,
      restartedCoordinator
    );
    restartedRuntime.tick();
    expect(store.listTriggerAttempts(fired.occurrence.occurrenceId)).toEqual([]);
    await restartedCoordinator.tick();
    expect(restartedCoordinator.canStart(requestId)).toBe(true);
    restartedRuntime.tick();
    expect(store.listTriggerAttempts(fired.occurrence.occurrenceId)).toHaveLength(1);
    store.close();
  });

  it("releases a busy intent and defers without creating an Attempt", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    provider.acquireError = new ExternalDomainLeaseProviderError(
      "DOMAIN_LEASE_BUSY",
      "busy"
    );
    const coordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const engine = runtime(store, () => current, undefined, coordinator);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:busy" });

    await coordinator.tick();
    expect(store.listExternalDomainLeases()[0]?.state).toBe("released");
    expect(store.getTriggerOccurrence(fired.occurrence.occurrenceId)).toMatchObject({
      status: "deferred",
      diagnostic: "The external inventory lease is busy."
    });
    expect(store.listTriggerAttempts(fired.occurrence.occurrenceId)).toEqual([]);

    current = new Date("2026-08-05T00:01:01.000Z");
    engine.tick();
    expect(store.listExternalDomainLeases()).toHaveLength(2);
    expect(store.listExternalDomainLeases()[1]?.requestId).not.toBe(
      store.listExternalDomainLeases()[0]?.requestId
    );
    store.close();
  });

  it("keeps the Attempt active until a terminal Run fence is remotely and locally released", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    const coordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const engine = runtime(store, () => current, undefined, coordinator);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:terminal" });
    await coordinator.tick();
    engine.tick();
    const attempt = store.listTriggerAttempts(fired.occurrence.occurrenceId)[0]!;
    const run = store.getRun(attempt.workflowRunId!)!;
    current = new Date("2026-08-05T00:00:01.000Z");
    finishRun(store, run, "succeeded", current.toISOString());

    engine.tick();
    expect(store.getTriggerAttempt(attempt.attemptId)?.status).toBe("running");
    expect(store.listExternalDomainLeases()[0]?.state).toBe("bound");
    await coordinator.tick();
    expect(store.listExternalDomainLeases()[0]?.state).toBe("released");
    engine.tick();
    expect(store.getTriggerAttempt(attempt.attemptId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "complete"
    });
    store.close();
  });

  it("marks an active Run uncertain and blocks the Attempt until business reconciliation", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const provider = new TestExternalDomainLeaseProvider();
    const coordinator = new ExternalDomainLeaseCoordinator(store, [provider], () => current);
    const markUncertain = (runId: string): RunRecord => {
      const run = store.getRun(runId)!;
      finishRun(store, run, "uncertain", current.toISOString());
      return store.getRun(runId)!;
    };
    const engine = runtime(
      store,
      () => current,
      undefined,
      coordinator,
      markUncertain
    );
    const fired = engine.fire({ trigger, occurrenceKey: "manual:lost" });
    await coordinator.tick();
    engine.tick();
    const lease = store.listExternalDomainLeases()[0]!;
    const attempt = store.listTriggerAttempts(fired.occurrence.occurrenceId)[0]!;
    coordinator.markReconciliationRequired(lease.requestId, "lease lost");
    current = new Date("2026-08-05T00:00:01.000Z");

    await coordinator.tick();
    expect(store.getExternalDomainLease(lease.requestId)?.state).toBe(
      "reconciliation_required"
    );
    engine.tick();
    expect(store.getRun(attempt.workflowRunId!)?.status).toBe("uncertain");
    expect(store.getTriggerAttempt(attempt.attemptId)?.status).toBe("running");
    await coordinator.tick();
    expect(store.getExternalDomainLease(lease.requestId)?.state).toBe(
      "reconciliation_required"
    );
    engine.tick();
    expect(store.getTriggerAttempt(attempt.attemptId)?.status).toBe("running");
    store.close();
  });

  it("fails closed before intent creation when the provider is missing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec: externalBase,
      actor: "operator",
      occurredAt: current.toISOString()
    });
    const coordinator = new ExternalDomainLeaseCoordinator(store, [], () => current);
    const engine = runtime(store, () => current, undefined, coordinator);
    const fired = engine.fire({ trigger, occurrenceKey: "manual:missing" });

    expect(fired.occurrence).toMatchObject({
      status: "terminal",
      terminalOutcome: "blocked"
    });
    expect(store.listExternalDomainLeases()).toEqual([]);
    expect(store.listTriggerAttempts(fired.occurrence.occurrenceId)).toEqual([]);
    expect(
      store.queryAttention({ sourceKinds: ["trigger-occurrence"], limit: 20 })
        .total
    ).toBe(1);
    store.close();
  });
});
