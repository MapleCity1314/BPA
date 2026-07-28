import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactConflictError,
  RevisionConflictError,
  type AssistanceTaskRecord,
  type DatasetStagingRecord,
  type ExecutionEventRecord,
  type ExecutionScopeRecord,
  type IterationInstanceRecord,
  type NodeExecutionRecord,
  type RunPlanSnapshotRecord,
  type RunRecord,
  type StepInstanceRecord
} from "@bpa/persistence";
import {
  migrationChecksum,
  SqlitePersistence
} from "./index.js";
import { migrations } from "./migrations.js";

const timestamp = "2026-07-27T00:00:00.000Z";

function event(
  runId: string,
  sequence: number,
  type: string,
  nodeExecutionId?: string
): ExecutionEventRecord {
  return {
    id: randomUUID(),
    runId,
    ...(nodeExecutionId ? { nodeExecutionId } : {}),
    sequence,
    type,
    payload: {},
    occurredAt: timestamp
  };
}

function createRun(store: SqlitePersistence): RunRecord {
  const run: RunRecord = {
    id: randomUUID(),
    workflowId: "test.workflow",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:test",
    status: "running",
    revision: 0,
    input: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return store.createRun({
    run,
    event: event(run.id, 1, "RUN_CREATED")
  });
}

function planSnapshot(runId: string): RunPlanSnapshotRecord {
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
    createdAt: timestamp
  };
}

function canonicalTask(
  runId: string,
  status: AssistanceTaskRecord["task"]["status"] = "queued",
  revision = 0,
  fencingToken?: number
): AssistanceTaskRecord {
  const leaseBearing = status === "claimed" || status === "processing";
  return {
    task: {
      apiVersion: "bpa.assistance/v1alpha1",
      taskId: "task-1",
      runId,
      stepInstanceId: "step-1",
      profile: {
        id: "profile-1",
        version: "1.0.0",
        digest: "sha256:profile"
      },
      mode: "ai_review",
      riskLevel: "R1",
      status,
      revision,
      input: {},
      outputSchema: {},
      policySnapshot: {
        autoContinue: true,
        r1ProfileApproved: true,
        durableDecision: false,
        onUnavailable: "continue_unresolved"
      },
      contextRefs: [],
      ...(!leaseBearing || fencingToken === undefined
        ? {}
        : {
            lease: {
              ownerId: "worker-1",
              fencingToken,
              expiresAt: "2026-07-27T01:00:00.000Z"
            }
          }),
      ...(status === "completed"
        ? {
            resolution: {
              resolverType: "ai" as const,
              resolverId: "worker-1",
              output: { choice: "record-1" },
              submittedAt: timestamp
            }
          }
        : {}),
      deadline: "2026-07-28T00:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    fencingCounter: fencingToken ?? 0,
    privateState:
      !leaseBearing || fencingToken === undefined
        ? { fencingCounter: fencingToken ?? 0 }
        : {
            leaseId: "lease-1",
            claimedAt: timestamp,
            heartbeatAt: timestamp,
            ownerType: "ai",
            fencingCounter: fencingToken
          }
  };
}

describe("sqlite persistence", () => {
  it("keeps a published version immutable", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const base = {
      assetType: "workflow" as const,
      assetId: "test.workflow",
      version: "1.0.0",
      digest: "sha256:first",
      content: { version: 1 },
      actor: "test"
    };
    expect(store.publish(base).digest).toBe("sha256:first");
    expect(store.publish(base).digest).toBe("sha256:first");
    expect(() =>
      store.publish({
        ...base,
        digest: "sha256:changed",
        content: { version: 2 }
      })
    ).toThrow(ArtifactConflictError);
    store.close();
  });

  it("atomically advances node state with event, idempotency and outbox", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const node: NodeExecutionRecord = {
      id: randomUUID(),
      runId: run.id,
      nodeKey: "observe",
      nodeId: "browser.observe",
      nodeVersion: "1.0.0",
      status: "scheduled",
      revision: 0,
      attempt: 1,
      idempotencyKey: "idem-1",
      fencingToken: 1,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.createNodeExecution(node, event(run.id, 2, "NODE_SCHEDULED", node.id));
    const updated = store.commitNodeTransition({
      nodeExecutionId: node.id,
      expectedRevision: 0,
      nextStatus: "succeeded",
      output: { ok: true },
      event: event(run.id, 3, "NODE_SUCCEEDED", node.id),
      idempotencyResult: {
        key: node.idempotencyKey,
        status: "succeeded",
        result: { ok: true }
      },
      outbox: {
        id: randomUUID(),
        topic: "node.completed",
        aggregateId: node.id,
        payload: { ok: true },
        createdAt: timestamp
      }
    });
    expect(updated.revision).toBe(1);
    expect(updated.output).toEqual({ ok: true });
    expect(store.listEvents(run.id)).toHaveLength(3);
    expect(() =>
      store.commitNodeTransition({
        nodeExecutionId: node.id,
        expectedRevision: 0,
        nextStatus: "failed",
        event: event(run.id, 4, "NODE_FAILED", node.id)
      })
    ).toThrow(RevisionConflictError);
    expect(store.listEvents(run.id)).toHaveLength(3);
    store.close();
  });

  it("deduplicates gateway results and audits stale fencing tokens", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    store.enqueueCommand(
      {
        id: "command-1",
        nodeExecutionId: "node-1",
        commandSeq: 1,
        idempotencyKey: "idem-1",
        fencingToken: 2,
        state: "queued",
        payload: {},
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "outbox-1",
        topic: "command.dispatch",
        aggregateId: "command-1",
        payload: {},
        createdAt: timestamp
      }
    );
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 1,
        result: {},
        inboxMessageId: "message-stale",
        receivedAt: timestamp
      })
    ).toBe("stale");
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 2,
        result: { ok: true },
        inboxMessageId: "message-1",
        receivedAt: timestamp
      })
    ).toBe("accepted");
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 2,
        result: { ok: true },
        inboxMessageId: "message-1",
        receivedAt: timestamp
      })
    ).toBe("duplicate");
    store.close();
  });

  it("keeps a future delayed outbox durable across a process restart", () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "bpa-pacing-test-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      vi.setSystemTime(new Date(timestamp));
      let store = new SqlitePersistence({ path: databasePath });
      const run = createRun(store);
      const node: NodeExecutionRecord = {
        id: randomUUID(),
        runId: run.id,
        nodeKey: "observe",
        nodeId: "browser.observe",
        nodeVersion: "1.0.0",
        status: "scheduled",
        revision: 0,
        attempt: 1,
        idempotencyKey: "delayed-idem",
        fencingToken: 1,
        input: {},
        createdAt: timestamp,
        updatedAt: timestamp
      };
      store.createNodeExecution(
        node,
        event(run.id, 2, "NODE_SCHEDULED", node.id)
      );
      store.commitNodeTransition({
        nodeExecutionId: node.id,
        expectedRevision: 0,
        nextStatus: "dispatched",
        event: event(run.id, 3, "NODE_DISPATCHED", node.id),
        outbox: {
          id: "delayed-outbox",
          topic: "browser.command.requested",
          aggregateId: node.id,
          payload: {},
          createdAt: "2026-07-27T00:00:01.000Z"
        }
      });
      expect(store.listPendingEngineOutbox()).toEqual([]);
      store.close();

      store = new SqlitePersistence({ path: databasePath });
      expect(store.listPendingEngineOutbox()).toEqual([]);
      vi.setSystemTime(new Date("2026-07-27T00:00:01.000Z"));
      expect(store.listPendingEngineOutbox()).toMatchObject([
        { id: "delayed-outbox", aggregateId: node.id }
      ]);
      store.close();
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("recoverable execution persistence", () => {
  it("atomically freezes a plan snapshot with its run and initial event", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run: RunRecord = {
      id: "run-plan",
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: "created",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const snapshot = planSnapshot(run.id);
    store.createRecoverableRun({
      run,
      planSnapshot: snapshot,
      event: event(run.id, 1, "RUN_CREATED")
    });
    expect(store.getRunPlanSnapshot(run.id)).toEqual(snapshot);
    expect(store.listEvents(run.id)).toHaveLength(1);
    store.close();
  });

  it("rolls back run, plan and event together on an injected crash", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (point === "create_run.after_run") throw new Error("crash");
      }
    });
    const run: RunRecord = {
      id: "run-crash",
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: "created",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    expect(() =>
      store.createRecoverableRun({
        run,
        planSnapshot: planSnapshot(run.id),
        event: event(run.id, 1, "RUN_CREATED")
      })
    ).toThrow("crash");
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getRunPlanSnapshot(run.id)).toBeUndefined();
    expect(store.listEvents(run.id)).toEqual([]);
    store.close();
  });

  it("restores scope, iteration and step identity after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-recovery-test-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      let store = new SqlitePersistence({ path: databasePath });
      const run = createRun(store);
      const scope: ExecutionScopeRecord = {
        scopeId: "scope-1",
        runId: run.id,
        scopePath: [
          { foreachStepKey: "products", itemKey: "product-1" }
        ],
        scopeKind: "foreach",
        createdAt: timestamp
      };
      const iteration: IterationInstanceRecord = {
        iterationId: "iteration-1",
        runId: run.id,
        scopeId: scope.scopeId,
        iterationKey: "product-1",
        ordinal: 0,
        status: "running",
        input: { id: "product-1" },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const step: StepInstanceRecord = {
        stepInstanceId: "step-1",
        runId: run.id,
        scopeId: scope.scopeId,
        iterationId: iteration.iterationId,
        stepKey: "inspect",
        attempt: 1,
        executionIdentity: `${run.id}:products/product-1:product-1:inspect:1`,
        status: "scheduled",
        revision: 0,
        input: {},
        createdAt: timestamp,
        updatedAt: timestamp
      };
      store.putExecutionScope(scope);
      store.putIterationInstance(iteration);
      store.putStepInstance(step);
      store.close();

      store = new SqlitePersistence({ path: databasePath });
      expect(store.getExecutionScope(scope.scopeId)).toEqual(scope);
      expect(store.getIterationInstance(iteration.iterationId)).toEqual(
        iteration
      );
      expect(store.getStepInstance(step.stepInstanceId)).toEqual(step);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("assistance unit of work", () => {
  it("atomically pauses a run for a blocking task", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const task = canonicalTask(run.id);
    const result = store.createBlockingTaskAndPauseRun({
      task,
      runId: run.id,
      expectedRunRevision: 0,
      waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
      outbox: {
        id: "outbox-task",
        topic: "assistance.requested",
        aggregateId: task.task.taskId,
        payload: {},
        createdAt: timestamp
      }
    });
    expect(result.run).toMatchObject({
      status: "waiting_assistance",
      revision: 1
    });
    expect(store.getAssistanceTask(task.task.taskId)).toEqual(task);
    expect(store.listPendingEngineOutbox()).toMatchObject([
      { id: "outbox-task" }
    ]);
    store.close();
  });

  it("rolls back task, run, event and outbox on a blocking-task crash", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (point === "blocking_task.after_task") throw new Error("crash");
      }
    });
    const run = createRun(store);
    const task = canonicalTask(run.id);
    expect(() =>
      store.createBlockingTaskAndPauseRun({
        task,
        runId: run.id,
        expectedRunRevision: 0,
        waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
        outbox: {
          id: "outbox-task",
          topic: "assistance.requested",
          aggregateId: task.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      })
    ).toThrow("crash");
    expect(store.getAssistanceTask(task.task.taskId)).toBeUndefined();
    expect(store.getRun(run.id)).toMatchObject({
      status: "running",
      revision: 0
    });
    expect(store.listEvents(run.id)).toHaveLength(1);
    expect(store.listPendingEngineOutbox()).toEqual([]);
    store.close();
  });

  it("enforces task CAS and fencing for claim updates", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const queued = canonicalTask(run.id);
    store.createBlockingTaskAndPauseRun({
      task: queued,
      runId: run.id,
      expectedRunRevision: 0,
      waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
      outbox: {
        id: "outbox-task",
        topic: "assistance.requested",
        aggregateId: queued.task.taskId,
        payload: {},
        createdAt: timestamp
      }
    });
    const claim = canonicalTask(run.id, "claimed", 1, 1);
    expect(
      store.commitAssistanceTask({
        task: claim,
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("accepted");
    expect(
      store.commitAssistanceTask({
        task: claim,
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("stale");
    expect(
      store.commitAssistanceTask({
        task: { ...claim, task: { ...claim.task, revision: 2 } },
        expectedRevision: 1,
        expectedFencingCounter: 0
      }).status
    ).toBe("stale");
    store.close();
  });

  it("rejects a concurrent CAS writer and recovers the winning lease", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-assistance-cas-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const first = new SqlitePersistence({ path: databasePath });
      const run = createRun(first);
      const queued = canonicalTask(run.id);
      first.createBlockingTaskAndPauseRun({
        task: queued,
        runId: run.id,
        expectedRunRevision: 0,
        waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
        outbox: {
          id: "outbox-task",
          topic: "assistance.requested",
          aggregateId: queued.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      });
      const second = new SqlitePersistence({ path: databasePath });
      const claim = canonicalTask(run.id, "claimed", 1, 1);
      expect(
        first.commitAssistanceTask({
          task: claim,
          expectedRevision: 0,
          expectedFencingCounter: 0
        }).status
      ).toBe("accepted");
      expect(
        second.commitAssistanceTask({
          task: {
            ...claim,
            privateState: {
              ...claim.privateState,
              leaseId: "losing-lease"
            }
          },
          expectedRevision: 0,
          expectedFencingCounter: 0
        }).status
      ).toBe("stale");
      first.close();
      expect(second.getAssistanceTask("task-1")).toEqual(claim);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates Inbox and atomically wakes a waiting run", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const queued = canonicalTask(run.id);
    store.createBlockingTaskAndPauseRun({
      task: queued,
      runId: run.id,
      expectedRunRevision: 0,
      waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
      outbox: {
        id: "outbox-task",
        topic: "assistance.requested",
        aggregateId: queued.task.taskId,
        payload: {},
        createdAt: timestamp
      }
    });
    const claim = canonicalTask(run.id, "claimed", 1, 1);
    store.commitAssistanceTask({
      task: claim,
      expectedRevision: 0,
      expectedFencingCounter: 0
    });
    const completed = canonicalTask(run.id, "completed", 2, 1);
    const submission = {
      task: completed,
      expectedTaskRevision: 1,
      expectedFencingToken: 1,
      expectedRunRevision: 1,
      inbox: {
        id: "inbox-1",
        topic: "assistance.submitted",
        aggregateId: completed.task.taskId,
        payload: {},
        receivedAt: timestamp
      },
      wakeEvent: event(run.id, 3, "ASSISTANCE_RESOLVED")
    };
    expect(store.submitTaskAndWakeRun(submission)).toMatchObject({
      status: "accepted",
      run: { status: "running", revision: 2 }
    });
    expect(store.getInboxMessage("inbox-1")).toMatchObject({
      id: "inbox-1",
      appliedAt: timestamp
    });
    expect(store.submitTaskAndWakeRun(submission)).toEqual({
      status: "duplicate"
    });
    expect(
      store.submitTaskAndWakeRun({
        ...submission,
        inbox: { ...submission.inbox, id: "inbox-stale" },
        expectedFencingToken: 0
      })
    ).toEqual({ status: "stale" });
    expect(store.listEvents(run.id)).toHaveLength(3);
    store.close();
  });

  it("rolls back Inbox, task, run and event on submit crash", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "submit_task.after_inbox") {
          throw new Error("crash");
        }
      }
    });
    const run = createRun(store);
    const queued = canonicalTask(run.id);
    store.createBlockingTaskAndPauseRun({
      task: queued,
      runId: run.id,
      expectedRunRevision: 0,
      waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
      outbox: {
        id: "outbox-task",
        topic: "assistance.requested",
        aggregateId: queued.task.taskId,
        payload: {},
        createdAt: timestamp
      }
    });
    const claim = canonicalTask(run.id, "claimed", 1, 1);
    store.commitAssistanceTask({
      task: claim,
      expectedRevision: 0,
      expectedFencingCounter: 0
    });
    crash = true;
    expect(() =>
      store.submitTaskAndWakeRun({
        task: canonicalTask(run.id, "completed", 2, 1),
        expectedTaskRevision: 1,
        expectedFencingToken: 1,
        expectedRunRevision: 1,
        inbox: {
          id: "inbox-crash",
          topic: "assistance.submitted",
          aggregateId: "task-1",
          payload: {},
          receivedAt: timestamp
        },
        wakeEvent: event(run.id, 3, "ASSISTANCE_RESOLVED")
      })
    ).toThrow("crash");
    expect(store.getInboxMessage("inbox-crash")).toBeUndefined();
    expect(store.getAssistanceTask("task-1")).toEqual(claim);
    expect(store.getRun(run.id)).toMatchObject({
      status: "waiting_assistance",
      revision: 1
    });
    expect(store.listEvents(run.id)).toHaveLength(2);
    store.close();
  });
});

describe("dataset and decision persistence", () => {
  it("publishes immutable normalized records from validated staging", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const staging: DatasetStagingRecord = {
      stagingId: "staging-1",
      profileId: "profile-1",
      profileVersion: "1.0.0",
      sourceDigest: "sha256:source",
      state: "staged",
      validationReport: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.stageDataset(staging);
    store.transitionDatasetStaging({
      stagingId: staging.stagingId,
      expectedState: "staged",
      nextState: "validated",
      validationReport: { valid: true },
      updatedAt: timestamp
    });
    const dataset = {
      apiVersion: "bpa.data/v1alpha1" as const,
      kind: "DatasetVersion" as const,
      metadata: { id: "dataset-1", version: "1.0.0", title: "Dataset" },
      profile: { id: "profile-1", version: "1.0.0" },
      source: {
        fileName: "source.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 100,
        digest: "sha256:source"
      },
      recordSchema: {},
      recordCount: 3,
      recordsDigest: "sha256:records"
    };
    store.publishDataset({
      stagingId: staging.stagingId,
      expectedState: "validated",
      dataset,
      normalizedRecords: [{ id: 1 }, { id: 2 }, { id: 3 }],
      event: event(run.id, 2, "DATASET_PUBLISHED")
    });
    expect(store.getDataset("dataset-1", "1.0.0")).toEqual(dataset);
    expect(
      store.readDatasetRecords({
        id: "dataset-1",
        version: "1.0.0",
        limit: 2
      })
    ).toEqual({
      records: [{ id: 1 }, { id: 2 }],
      nextRecordKey: "000000000001"
    });
    expect(
      store.readDatasetRecords({
        id: "dataset-1",
        version: "1.0.0",
        afterRecordKey: "000000000001",
        limit: 2
      })
    ).toEqual({ records: [{ id: 3 }] });
    expect(store.getDatasetStaging(staging.stagingId)?.state).toBe(
      "published"
    );
    store.close();
  });

  it("rolls back dataset version, index, staging and event on crash", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "publish_dataset.after_version") {
          throw new Error("crash");
        }
      }
    });
    const run = createRun(store);
    const staging: DatasetStagingRecord = {
      stagingId: "staging-crash",
      profileId: "profile-1",
      profileVersion: "1.0.0",
      sourceDigest: "sha256:source",
      state: "validated",
      validationReport: { valid: true },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.stageDataset(staging);
    crash = true;
    expect(() =>
      store.publishDataset({
        stagingId: staging.stagingId,
        expectedState: "validated",
        dataset: {
          apiVersion: "bpa.data/v1alpha1",
          kind: "DatasetVersion",
          metadata: {
            id: "dataset-crash",
            version: "1.0.0",
            title: "Dataset"
          },
          profile: { id: "profile-1", version: "1.0.0" },
          source: {
            fileName: "source.bin",
            mediaType: "application/octet-stream",
            size: 1,
            digest: "sha256:source"
          },
          recordSchema: {},
          recordCount: 1,
          recordsDigest: "sha256:records"
        },
        normalizedRecords: [{ id: 1 }],
        event: event(run.id, 2, "DATASET_PUBLISHED")
      })
    ).toThrow("crash");
    expect(store.getDataset("dataset-crash", "1.0.0")).toBeUndefined();
    expect(store.getDatasetStaging(staging.stagingId)?.state).toBe(
      "validated"
    );
    expect(store.listEvents(run.id)).toHaveLength(1);
    store.close();
  });

  it("stores only exact active decisions and persists revoke/supersede", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const first = {
      apiVersion: "bpa.decision/v1alpha1" as const,
      decisionId: "decision-1",
      decisionType: "binding",
      status: "active" as const,
      scope: { tenant: "tenant-1", object: "object-1" },
      preconditions: { subject: "sha256:subject", target: "sha256:target" },
      value: { target: "record-1" },
      confirmedBy: "human-1",
      confirmedAt: timestamp
    };
    store.putDecision(first);
    expect(
      store.getActiveDecision(
        first.decisionType,
        first.scope,
        first.preconditions
      )
    ).toEqual(first);
    expect(
      store.getActiveDecision(first.decisionType, first.scope, {
        ...first.preconditions,
        target: "changed"
      })
    ).toBeUndefined();
    const replacement = {
      ...first,
      decisionId: "decision-2",
      value: { target: "record-2" },
      supersedes: first.decisionId
    };
    const superseded = store.supersedeDecision({
      decisionId: first.decisionId,
      expectedStatus: "active",
      replacement
    });
    expect(superseded.superseded.status).toBe("superseded");
    expect(
      store.getActiveDecision(
        first.decisionType,
        first.scope,
        first.preconditions
      )
    ).toEqual(replacement);
    const revoked = store.revokeDecision({
      decisionId: replacement.decisionId,
      expectedStatus: "active",
      revokedBy: "human-2",
      revokedAt: timestamp
    });
    expect(revoked.status).toBe("revoked");
    expect(
      store.getActiveDecision(
        first.decisionType,
        first.scope,
        first.preconditions
      )
    ).toBeUndefined();
    store.close();
  });
});

describe("append-only migrations", () => {
  it("recovers cleanly when migration v3 is interrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-crash-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      expect(
        () =>
          new SqlitePersistence({
            path: databasePath,
            failureInjector(point) {
              if (point === "migration.3.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const store = new SqlitePersistence({ path: databasePath });
      expect(store.health().schemaVersion).toBe(3);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a changed checksum for an applied migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-checksum-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const store = new SqlitePersistence({ path: databasePath });
      expect(store.health().schemaVersion).toBe(3);
      store.close();
      const raw = new Database(databasePath);
      raw
        .prepare(
          "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1"
        )
        .run();
      raw.close();
      expect(() => new SqlitePersistence({ path: databasePath })).toThrow(
        /checksum mismatch/
      );
      expect(migrationChecksum(migrations[0]!)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
