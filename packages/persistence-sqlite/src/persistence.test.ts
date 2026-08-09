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
  type AuditRecord,
  type DatasetStagingRecord,
  type EngineCheckpointRecord,
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

function audit(target: string): AuditRecord {
  return {
    id: randomUUID(),
    action: "dataset.published",
    actor: "test",
    target,
    detail: {},
    occurredAt: timestamp
  };
}

function checkpoint(
  runId: string,
  stateRevision = 1
): EngineCheckpointRecord {
  return {
    runId,
    stateVersion: "bpa.engine-state/2",
    stateRevision,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId,
      revision: stateRevision,
      status: "waiting_runtime"
    },
    updatedAt: timestamp
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
  fencingToken?: number,
  options: {
    taskId?: string;
    mode?: AssistanceTaskRecord["task"]["mode"];
    ownerType?: "ai" | "human";
    createdAt?: string;
    blocking?: boolean;
  } = {}
): AssistanceTaskRecord {
  const leaseBearing = status === "claimed" || status === "processing";
  const taskId = options.taskId ?? "task-1";
  const createdAt = options.createdAt ?? timestamp;
  return {
    task: {
      apiVersion: "bpa.assistance/v1alpha1",
      taskId,
      runId,
      stepInstanceId: "step-1",
      profile: {
        id: "profile-1",
        version: "1.0.0",
        digest: "sha256:profile"
      },
      mode: options.mode ?? "ai_review",
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
      createdAt,
      updatedAt: timestamp
    },
    fencingCounter: fencingToken ?? 0,
    privateState:
      !leaseBearing || fencingToken === undefined
        ? {
            fencingCounter: fencingToken ?? 0,
            ...(options.blocking === undefined
              ? {}
              : { blocking: options.blocking })
          }
        : {
            leaseId: "lease-1",
            claimedAt: timestamp,
            heartbeatAt: timestamp,
            ownerType: options.ownerType ?? "ai",
            fencingCounter: fencingToken,
            ...(options.blocking === undefined
              ? {}
              : { blocking: options.blocking })
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
    const detachedTask = canonicalTask(run.id);
    store.createRecoverableRun({
      run,
      planSnapshot: snapshot,
      checkpoint: checkpoint(run.id),
      assistanceTasks: [detachedTask],
      outbox: [
        {
          id: "initial-runtime-effect",
          topic: "runtime.invoke",
          aggregateId: run.id,
          payload: {},
          createdAt: timestamp
        }
      ],
      event: event(run.id, 1, "RUN_CREATED")
    });
    expect(store.getRunPlanSnapshot(run.id)).toEqual(snapshot);
    expect(store.getEngineCheckpoint(run.id)).toEqual(checkpoint(run.id));
    expect(store.getAssistanceTask(detachedTask.task.taskId)).toEqual(
      detachedTask
    );
    expect(store.listPendingEngineOutbox()).toMatchObject([
      { id: "initial-runtime-effect" }
    ]);
    expect(store.listEvents(run.id)).toHaveLength(1);
    store.close();
  });

  it("rolls back run, plan and event together on an injected crash", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (point === "recoverable_run.after_run") throw new Error("crash");
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
        checkpoint: checkpoint(run.id),
        event: event(run.id, 1, "RUN_CREATED")
      })
    ).toThrow("crash");
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getRunPlanSnapshot(run.id)).toBeUndefined();
    expect(store.getEngineCheckpoint(run.id)).toBeUndefined();
    expect(store.listEvents(run.id)).toEqual([]);
    store.close();
  });

  it("atomically advances a Run checkpoint, effects and event with CAS", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "recoverable_transition.after_state") {
          throw new Error("crash");
        }
      }
    });
    const run: RunRecord = {
      id: "run-checkpoint",
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.createRecoverableRun({
      run,
      planSnapshot: planSnapshot(run.id),
      checkpoint: checkpoint(run.id),
      outbox: [
        {
          id: "previous-runtime-effect",
          topic: "runtime.invoke",
          aggregateId: run.id,
          payload: {},
          createdAt: timestamp
        }
      ],
      event: event(run.id, 1, "RUN_CREATED")
    });
    const next = checkpoint(run.id, 4);
    crash = true;
    expect(() =>
      store.commitRecoverableTransition({
        runId: run.id,
        expectedRevision: 0,
        nextStatus: "running",
        checkpoint: next,
        expectedCheckpointRevision: 1,
        acknowledgeOutboxIds: ["previous-runtime-effect"],
        inbox: [
          {
            id: "runtime-result-1",
            topic: "runtime.result",
            aggregateId: run.id,
            payload: {},
            receivedAt: timestamp,
            appliedAt: timestamp
          }
        ],
        outbox: [
          {
            id: "checkpoint-effect",
            topic: "runtime.invoke",
            aggregateId: run.id,
            payload: {},
            createdAt: timestamp
          }
        ],
        event: event(run.id, 2, "ENGINE_ADVANCED")
      })
    ).toThrow("crash");
    expect(store.getRun(run.id)?.revision).toBe(0);
    expect(store.getEngineCheckpoint(run.id)?.stateRevision).toBe(1);
    expect(store.listPendingEngineOutbox()).toMatchObject([
      { id: "previous-runtime-effect" }
    ]);
    expect(store.getInboxMessage("runtime-result-1")).toBeUndefined();
    expect(store.listEvents(run.id)).toHaveLength(1);

    crash = false;
    expect(
      store.commitRecoverableTransition({
        runId: run.id,
        expectedRevision: 0,
        nextStatus: "running",
        checkpoint: next,
        expectedCheckpointRevision: 1,
        acknowledgeOutboxIds: ["previous-runtime-effect"],
        inbox: [
          {
            id: "runtime-result-1",
            topic: "runtime.result",
            aggregateId: run.id,
            payload: {},
            receivedAt: timestamp,
            appliedAt: timestamp
          }
        ],
        outbox: [
          {
            id: "checkpoint-effect",
            topic: "runtime.invoke",
            aggregateId: run.id,
            payload: {},
            createdAt: timestamp
          }
        ],
        event: event(run.id, 2, "ENGINE_ADVANCED")
      })
    ).toMatchObject({ revision: 1 });
    expect(store.getEngineCheckpoint(run.id)).toEqual(next);
    expect(store.listPendingEngineOutbox()).toMatchObject([
      { id: "checkpoint-effect" }
    ]);
    expect(store.getInboxMessage("runtime-result-1")).toMatchObject({
      appliedAt: timestamp
    });
    expect(() =>
      store.commitRecoverableTransition({
        runId: run.id,
        expectedRevision: 0,
        nextStatus: "running",
        checkpoint: checkpoint(run.id, 5),
        expectedCheckpointRevision: 1,
        event: event(run.id, 3, "STALE")
      })
    ).toThrow(RevisionConflictError);
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

  it("persists the exact first request result for duplicate claims and heartbeats", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const queued = canonicalTask(run.id);
    store.createBlockingTaskAndPauseRun({
      task: queued,
      runId: run.id,
      expectedRunRevision: 0,
      waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
      outbox: {
        id: "outbox-task-request-dedup",
        topic: "assistance.requested",
        aggregateId: queued.task.taskId,
        payload: {},
        createdAt: timestamp
      }
    });

    const claim = canonicalTask(run.id, "claimed", 1, 1);
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "claim-request-1",
        task: claim,
        expectedRevision: 0,
        expectedFencingCounter: 0,
        recordedAt: timestamp
      })
    ).toEqual({ status: "accepted", task: claim });

    const alteredDuplicate = {
      ...claim,
      task: {
        ...claim.task,
        revision: 99,
        updatedAt: "2026-07-27T00:00:05.000Z"
      },
      privateState: {
        ...claim.privateState,
        leaseId: "must-not-replace-the-first-result"
      }
    };
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "claim-request-1",
        task: alteredDuplicate,
        expectedRevision: 98,
        expectedFencingCounter: 1,
        recordedAt: "2026-07-27T00:00:05.000Z"
      })
    ).toEqual({ status: "duplicate", task: claim });
    expect(store.getAssistanceRequestResult("claim-request-1")).toEqual(claim);

    const heartbeat = canonicalTask(run.id, "processing", 2, 1);
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "heartbeat-request-1",
        task: heartbeat,
        expectedRevision: 1,
        expectedFencingCounter: 1,
        recordedAt: "2026-07-27T00:00:10.000Z"
      })
    ).toEqual({ status: "accepted", task: heartbeat });
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "heartbeat-request-1",
        task: {
          ...heartbeat,
          privateState: {
            ...heartbeat.privateState,
            heartbeatAt: "2026-07-27T00:00:20.000Z"
          }
        },
        expectedRevision: 1,
        expectedFencingCounter: 1,
        recordedAt: "2026-07-27T00:00:20.000Z"
      })
    ).toEqual({ status: "duplicate", task: heartbeat });
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "heartbeat-request-2",
        task: heartbeat,
        expectedRevision: 1,
        expectedFencingCounter: 1,
        recordedAt: "2026-07-27T00:00:20.000Z"
      })
    ).toEqual({ status: "stale" });
    expect(
      store.commitAssistanceTaskRequest({
        requestId: "stale-fencing-request",
        task: canonicalTask(run.id, "processing", 3, 0),
        expectedRevision: 2,
        expectedFencingCounter: 0,
        recordedAt: "2026-07-27T00:00:30.000Z"
      })
    ).toEqual({ status: "stale" });
    expect(store.getAssistanceTask(queued.task.taskId)).toEqual(heartbeat);
    store.close();
  });

  it("rejects concurrent request CAS writers and replays the durable winner", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-assistance-request-cas-"));
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
          id: "outbox-task-request-cas",
          topic: "assistance.requested",
          aggregateId: queued.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      });
      const second = new SqlitePersistence({ path: databasePath });
      const winner = canonicalTask(run.id, "claimed", 1, 1);
      const loser = {
        ...winner,
        privateState: {
          ...winner.privateState,
          leaseId: "losing-lease"
        }
      };

      expect(
        first.commitAssistanceTaskRequest({
          requestId: "concurrent-claim-winner",
          task: winner,
          expectedRevision: 0,
          expectedFencingCounter: 0,
          recordedAt: timestamp
        })
      ).toEqual({ status: "accepted", task: winner });
      expect(
        second.commitAssistanceTaskRequest({
          requestId: "concurrent-claim-loser",
          task: loser,
          expectedRevision: 0,
          expectedFencingCounter: 0,
          recordedAt: timestamp
        })
      ).toEqual({ status: "stale" });
      expect(
        second.commitAssistanceTaskRequest({
          requestId: "concurrent-claim-winner",
          task: loser,
          expectedRevision: 0,
          expectedFencingCounter: 0,
          recordedAt: timestamp
        })
      ).toEqual({ status: "duplicate", task: winner });
      expect(
        second.getAssistanceRequestResult("concurrent-claim-winner")
      ).toEqual(winner);
      expect(second.getAssistanceTask(queued.task.taskId)).toEqual(winner);
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "assistance_request.after_task",
    "assistance_request.after_result"
  ] as const)(
    "rolls back the task update and request result after a crash at %s",
    (failurePoint) => {
      let crash = false;
      const store = new SqlitePersistence({
        path: ":memory:",
        failureInjector(point) {
          if (crash && point === failurePoint) {
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
          id: "outbox-task-request-crash",
          topic: "assistance.requested",
          aggregateId: queued.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      });
      const claim = canonicalTask(run.id, "claimed", 1, 1);
      crash = true;
      expect(() =>
        store.commitAssistanceTaskRequest({
          requestId: "claim-crash-request",
          task: claim,
          expectedRevision: 0,
          expectedFencingCounter: 0,
          recordedAt: timestamp
        })
      ).toThrow("crash");
      expect(store.getAssistanceTask(queued.task.taskId)).toEqual(queued);
      expect(
        store.getAssistanceRequestResult("claim-crash-request")
      ).toBeUndefined();

      crash = false;
      expect(
        store.commitAssistanceTaskRequest({
          requestId: "claim-crash-request",
          task: claim,
          expectedRevision: 0,
          expectedFencingCounter: 0,
          recordedAt: timestamp
        })
      ).toEqual({ status: "accepted", task: claim });
      store.close();
    }
  );

  it("filters assistance tasks by status, mode and lease owner type", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const definitions = [
      {
        taskId: "task-a",
        mode: "ai_review" as const,
        ownerType: undefined
      },
      {
        taskId: "task-b",
        mode: "ai_review" as const,
        ownerType: "ai" as const
      },
      {
        taskId: "task-c",
        mode: "human_confirm" as const,
        ownerType: "human" as const
      }
    ];

    for (const definition of definitions) {
      const run = createRun(store);
      const queued = canonicalTask(run.id, "queued", 0, undefined, {
        taskId: definition.taskId,
        mode: definition.mode
      });
      store.createBlockingTaskAndPauseRun({
        task: queued,
        runId: run.id,
        expectedRunRevision: 0,
        waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
        outbox: {
          id: `outbox-${definition.taskId}`,
          topic: "assistance.requested",
          aggregateId: definition.taskId,
          payload: {},
          createdAt: timestamp
        }
      });
      if (definition.ownerType) {
        const claimed = canonicalTask(run.id, "claimed", 1, 1, {
          taskId: definition.taskId,
          mode: definition.mode,
          ownerType: definition.ownerType
        });
        expect(
          store.commitAssistanceTaskRequest({
            requestId: `claim-${definition.taskId}`,
            task: claimed,
            expectedRevision: 0,
            expectedFencingCounter: 0,
            recordedAt: timestamp
          }).status
        ).toBe("accepted");
      }
    }

    expect(store.listAssistanceTasks({ limit: 2 }).map(({ task }) => task.taskId))
      .toEqual(["task-a", "task-b"]);
    expect(
      store
        .listAssistanceTasks({ statuses: ["claimed"], limit: 10 })
        .map(({ task }) => task.taskId)
    ).toEqual(["task-b", "task-c"]);
    expect(
      store
        .listAssistanceTasks({ modes: ["human_confirm"], limit: 10 })
        .map(({ task }) => task.taskId)
    ).toEqual(["task-c"]);
    expect(
      store
        .listAssistanceTasks({ ownerType: "ai", limit: 10 })
        .map(({ task }) => task.taskId)
    ).toEqual(["task-b"]);
    expect(
      store
        .listAssistanceTasks({
          statuses: ["claimed"],
          modes: ["ai_review"],
          ownerType: "ai",
          limit: 10
        })
        .map(({ task }) => task.taskId)
    ).toEqual(["task-b"]);
    expect(store.listAssistanceTasks({ statuses: [], limit: 10 })).toEqual([]);
    expect(store.listAssistanceTasks({}).map(({ task }) => task.taskId)).toEqual(
      ["task-a", "task-b", "task-c"]
    );
    expect(() => store.listAssistanceTasks({ limit: 0 })).toThrow(
      /between 1 and 1000/
    );
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

  it.each(["running", "succeeded"] as const)(
    "atomically records a detached result without changing a %s Run",
    (runStatus) => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run: RunRecord = {
      id: `run-detached-result-${runStatus}`,
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: runStatus,
      revision: 4,
      input: {},
      output: { completed: true },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const terminalCheckpoint: EngineCheckpointRecord = {
      ...checkpoint(run.id, 9),
      state: {
        stateVersion: "bpa.engine-state/2",
        runId: run.id,
        revision: 9,
        status: runStatus === "running" ? "waiting_runtime" : "succeeded"
      }
    };
    const claimed = canonicalTask(
      run.id,
      "claimed",
      1,
      1,
      runStatus === "running" ? { blocking: false } : {}
    );
    store.createRecoverableRun({
      run,
      planSnapshot: planSnapshot(run.id),
      checkpoint: terminalCheckpoint,
      assistanceTasks: [claimed],
      outbox: [
        {
          id: `effect:${claimed.task.taskId}`,
          topic: "assistance.requested",
          aggregateId: claimed.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      ],
      event: event(run.id, 1, `RUN_${runStatus.toUpperCase()}`)
    });
    const completed = canonicalTask(run.id, "completed", 2, 1, {
      blocking: false
    });
    const detachedEvent = event(
      run.id,
      999,
      "ASSISTANCE_DETACHED_RESULT_RECORDED"
    );
    const { sequence: _ignored, ...eventWithoutSequence } = detachedEvent;
    const submission = {
      requestId: "submit-detached-1",
      task: completed,
      expectedRevision: 1,
      expectedFencingCounter: 1,
      inbox: {
        id: "submit-detached-1",
        topic: "assistance.detached.result",
        aggregateId: completed.task.taskId,
        payload: {},
        receivedAt: timestamp,
        appliedAt: timestamp
      },
      event: eventWithoutSequence,
      acknowledgeOutboxIds: [`effect:${completed.task.taskId}`]
    };

    expect(store.completeDetachedAssistanceTask(submission)).toEqual({
      status: "accepted",
      task: completed
    });
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.getEngineCheckpoint(run.id)).toEqual(terminalCheckpoint);
    expect(store.getInboxMessage("submit-detached-1")).toMatchObject({
      appliedAt: timestamp
    });
    expect(store.listEvents(run.id)).toMatchObject([
      { sequence: 1, type: `RUN_${runStatus.toUpperCase()}` },
      { sequence: 2, type: "ASSISTANCE_DETACHED_RESULT_RECORDED" }
    ]);
    expect(store.listPendingEngineOutbox()).toEqual([]);
    expect(store.completeDetachedAssistanceTask(submission)).toEqual({
      status: "duplicate",
      task: completed
    });
    expect(
      store.completeDetachedAssistanceTask({
        ...submission,
        requestId: "submit-detached-stale-lease",
        inbox: {
          ...submission.inbox,
          id: "submit-detached-stale-lease"
        },
        expectedFencingCounter: 0,
        task: {
          ...completed,
          fencingCounter: 0,
          privateState: {
            ...completed.privateState,
            fencingCounter: 0
          }
        }
      })
    ).toEqual({ status: "stale" });
    expect(store.listEvents(run.id)).toHaveLength(2);
    store.close();
    }
  );

  it("rolls back every detached-result record on an injected crash", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "detached_assistance.after_task") {
          throw new Error("detached crash");
        }
      }
    });
    const run: RunRecord = {
      id: "run-detached-crash",
      workflowId: "test.workflow",
      workflowVersion: "1.0.0",
      workflowDigest: "sha256:workflow",
      status: "succeeded",
      revision: 1,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const claimed = canonicalTask(run.id, "claimed", 1, 1, {
      blocking: false
    });
    store.createRecoverableRun({
      run,
      planSnapshot: planSnapshot(run.id),
      checkpoint: checkpoint(run.id),
      assistanceTasks: [claimed],
      outbox: [
        {
          id: `effect:${claimed.task.taskId}`,
          topic: "assistance.requested",
          aggregateId: claimed.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      ],
      event: event(run.id, 1, "RUN_SUCCEEDED")
    });
    const completed = canonicalTask(run.id, "completed", 2, 1, {
      blocking: false
    });
    const detachedEvent = event(
      run.id,
      2,
      "ASSISTANCE_DETACHED_RESULT_RECORDED"
    );
    const { sequence: _ignored, ...eventWithoutSequence } = detachedEvent;
    crash = true;
    expect(() =>
      store.completeDetachedAssistanceTask({
        requestId: "submit-detached-crash",
        task: completed,
        expectedRevision: 1,
        expectedFencingCounter: 1,
        inbox: {
          id: "submit-detached-crash",
          topic: "assistance.detached.result",
          aggregateId: completed.task.taskId,
          payload: {},
          receivedAt: timestamp,
          appliedAt: timestamp
        },
        event: eventWithoutSequence,
        acknowledgeOutboxIds: [`effect:${completed.task.taskId}`]
      })
    ).toThrow("detached crash");
    expect(store.getAssistanceTask(claimed.task.taskId)).toEqual(claimed);
    expect(store.getInboxMessage("submit-detached-crash")).toBeUndefined();
    expect(
      store.getAssistanceRequestResult("submit-detached-crash")
    ).toBeUndefined();
    expect(store.listEvents(run.id)).toHaveLength(1);
    expect(store.listPendingEngineOutbox()).toHaveLength(1);
    expect(store.getRun(run.id)).toEqual(run);
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
      audit: audit("dataset:dataset-1@1.0.0")
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
      nextRecordKey: "id:2"
    });
    expect(
      store.readDatasetRecords({
        id: "dataset-1",
        version: "1.0.0",
        afterRecordKey: "id:2",
        limit: 2
      })
    ).toEqual({ records: [{ id: 3 }] });
    expect(store.getDatasetStaging(staging.stagingId)?.state).toBe(
      "published"
    );
    expect(store.listAudit("dataset:dataset-1@1.0.0")).toHaveLength(1);
    store.close();
  });

  it("rolls back dataset version, index, staging and audit on crash", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "publish_dataset.after_version") {
          throw new Error("crash");
        }
      }
    });
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
        audit: audit("dataset:dataset-crash@1.0.0")
      })
    ).toThrow("crash");
    expect(store.getDataset("dataset-crash", "1.0.0")).toBeUndefined();
    expect(store.getDatasetStaging(staging.stagingId)?.state).toBe(
      "validated"
    );
    expect(store.listAudit("dataset:dataset-crash@1.0.0")).toHaveLength(0);
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
  it("indexes the Core hot polling queries", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-hot-poll-indexes-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const store = new SqlitePersistence({ path: databasePath });
      store.close();
      const raw = new Database(databasePath, { readonly: true });
      const queryPlan = (sql: string, ...params: unknown[]) =>
        raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => String((row as { detail: unknown }).detail))
          .join("\n");

      expect(
        queryPlan(
          `SELECT id FROM workflow_runs
           WHERE status NOT IN (
             'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
           )
           ORDER BY updated_at LIMIT ?`,
          100
        )
      ).toContain("workflow_runs_active_updated");
      expect(
        queryPlan(
          `SELECT * FROM engine_outbox
           WHERE acknowledged_at IS NULL AND created_at <= ?
           ORDER BY created_at, id`,
          timestamp
        )
      ).toContain("engine_outbox_pending_created");
      expect(
        queryPlan(
          `SELECT * FROM gateway_commands
           WHERE state != 'terminal' AND command_seq > ?
           ORDER BY command_seq`,
          0
        )
      ).toContain("gateway_commands_active_sequence");
      expect(
        queryPlan(
          `SELECT gateway_commands.*
           FROM gateway_commands
           INNER JOIN node_executions
             ON node_executions.id = gateway_commands.node_execution_id
           WHERE gateway_commands.state = 'terminal'
             AND gateway_commands.result_json IS NOT NULL
             AND node_executions.status NOT IN (
               'succeeded', 'rejected', 'failed', 'timed_out',
               'cancelled', 'uncertain'
             )
           ORDER BY gateway_commands.command_seq`
        )
      ).toContain("gateway_commands_terminal_result_sequence");
      raw.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      expect(store.health().schemaVersion).toBe(15);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades an existing v3 database without changing assistance tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v3-upgrade-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path: databasePath });
      const run = createRun(seeded);
      const task = canonicalTask(run.id);
      seeded.createBlockingTaskAndPauseRun({
        task,
        runId: run.id,
        expectedRunRevision: 0,
        waitingEvent: event(run.id, 2, "ASSISTANCE_WAITING"),
        outbox: {
          id: "outbox-v3-upgrade",
          topic: "assistance.requested",
          aggregateId: task.task.taskId,
          payload: {},
          createdAt: timestamp
        }
      });
      seeded.close();

      const legacy = new Database(databasePath);
      legacy.exec(`
        DROP TABLE trigger_spec_versions;
        DROP TABLE browser_control_leases;
        DROP TABLE trigger_leases;
        DROP TABLE trigger_runs;
        DROP TABLE trigger_specs;
        DROP TABLE candidate_exports;
        DROP TABLE candidate_bundle_validations;
        DROP TABLE candidate_bundle_items;
        DROP TABLE candidate_bundles;
        DROP TABLE authoring_page_snapshots;
        DROP TABLE design_mode_grant_revisions;
        DROP TABLE design_mode_grants;
        DROP TABLE authoring_session_revisions;
        DROP TABLE authoring_sessions;
        DROP TABLE authoring_scenarios;
        DROP TRIGGER export_records_no_delete;
        DROP TRIGGER export_records_no_update;
        DROP TRIGGER run_resource_bindings_no_delete;
        DROP TRIGGER run_resource_bindings_no_update;
        DROP TRIGGER run_resource_binding_snapshots_no_delete;
        DROP TRIGGER run_resource_binding_snapshots_no_update;
        DROP TABLE export_record_assets;
        DROP TABLE export_records;
        DROP TABLE run_resource_bindings;
        DROP TABLE run_resource_binding_snapshots;
        DROP INDEX browser_sessions_connected;
        DROP INDEX browser_sessions_role_state;
        DROP INDEX evidence_transfers_run_created;
        DROP INDEX evidence_links_run_created;
        DROP INDEX evidence_link_sources_source;
        DROP INDEX evidence_link_assets_asset;
        ALTER TABLE browser_sessions DROP COLUMN observed_at;
        ALTER TABLE browser_sessions DROP COLUMN observation_state;
        ALTER TABLE browser_sessions DROP COLUMN observed_authentication;
        ALTER TABLE browser_sessions DROP COLUMN observed_origin;
        DROP TABLE browser_page_observations;
        ALTER TABLE browser_sessions DROP COLUMN session_role;
        ALTER TABLE browser_sessions DROP COLUMN observation_revision;
        DROP TRIGGER evidence_links_no_delete;
        DROP TRIGGER evidence_links_no_update;
        DROP TRIGGER asset_records_no_delete;
        DROP TRIGGER asset_records_no_update;
        DROP TRIGGER blobs_no_delete;
        DROP TRIGGER blobs_no_update;
        DROP TRIGGER source_records_no_delete;
        DROP TRIGGER source_records_no_update;
        DROP TABLE retention_jobs;
        DROP TABLE evidence_link_assets;
        DROP TABLE evidence_link_sources;
        DROP TABLE evidence_links;
        DROP TABLE evidence_chunks;
        DROP TABLE evidence_transfers;
        DROP TABLE staging_leases;
        DROP TABLE asset_deletions;
        DROP TABLE asset_derivations;
        DROP TABLE asset_sources;
        DROP TABLE asset_records;
        DROP TABLE blobs;
        DROP TABLE source_records;
        DROP TRIGGER workflow_candidates_no_delete;
        DROP TRIGGER workflow_candidates_no_update;
        DROP TRIGGER workflow_draft_revisions_no_delete;
        DROP TRIGGER workflow_draft_revisions_no_update;
        DROP TABLE workflow_candidates;
        DROP TABLE workflow_draft_revisions;
        DROP TABLE workflow_drafts;
        DROP TABLE engine_checkpoints;
        DROP INDEX assistance_tasks_owner_type_created;
        DROP INDEX assistance_tasks_status_mode_created;
        DROP INDEX assistance_task_request_results_task;
        DROP TABLE assistance_task_request_results;
        ALTER TABLE browser_capabilities DROP COLUMN adapter_version;
        ALTER TABLE browser_capabilities DROP COLUMN adapter_id;
        ALTER TABLE browser_capabilities DROP COLUMN routes_json;
        DROP INDEX workflow_runs_active_updated;
        DROP INDEX engine_outbox_pending_created;
        DROP INDEX gateway_commands_active_sequence;
        DROP INDEX gateway_commands_terminal_result_sequence;
        DELETE FROM schema_migrations
        WHERE version IN (4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
      `);
      legacy.close();

      const upgraded = new SqlitePersistence({ path: databasePath });
      expect(upgraded.health().schemaVersion).toBe(15);
      expect(upgraded.getAssistanceTask(task.task.taskId)).toEqual(task);
      expect(
        upgraded.getAssistanceRequestResult("not-recorded")
      ).toBeUndefined();
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers cleanly when migration v4 is interrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v4-crash-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      expect(
        () =>
          new SqlitePersistence({
            path: databasePath,
            failureInjector(point) {
              if (point === "migration.4.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const store = new SqlitePersistence({ path: databasePath });
      expect(store.health().schemaVersion).toBe(15);
      expect(store.getAssistanceRequestResult("not-recorded")).toBeUndefined();
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers cleanly when migration v5 is interrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v5-crash-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      expect(
        () =>
          new SqlitePersistence({
            path: databasePath,
            failureInjector(point) {
              if (point === "migration.5.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const store = new SqlitePersistence({ path: databasePath });
      expect(store.health().schemaVersion).toBe(15);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades an existing v5 database with the exact v6 checksum", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v5-upgrade-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path: databasePath });
      seeded.close();
      const legacy = new Database(databasePath);
      legacy.exec(`
        DROP TABLE trigger_spec_versions;
        DROP TABLE browser_control_leases;
        DROP TABLE trigger_leases;
        DROP TABLE trigger_runs;
        DROP TABLE trigger_specs;
        DROP TABLE candidate_exports;
        DROP TABLE candidate_bundle_validations;
        DROP TABLE candidate_bundle_items;
        DROP TABLE candidate_bundles;
        DROP TABLE authoring_page_snapshots;
        DROP TABLE design_mode_grant_revisions;
        DROP TABLE design_mode_grants;
        DROP TABLE authoring_session_revisions;
        DROP TABLE authoring_sessions;
        DROP TABLE authoring_scenarios;
        DROP TRIGGER export_records_no_delete;
        DROP TRIGGER export_records_no_update;
        DROP TRIGGER run_resource_bindings_no_delete;
        DROP TRIGGER run_resource_bindings_no_update;
        DROP TRIGGER run_resource_binding_snapshots_no_delete;
        DROP TRIGGER run_resource_binding_snapshots_no_update;
        DROP TABLE export_record_assets;
        DROP TABLE export_records;
        DROP TABLE run_resource_bindings;
        DROP TABLE run_resource_binding_snapshots;
        DROP INDEX browser_sessions_connected;
        DROP INDEX browser_sessions_role_state;
        DROP INDEX evidence_transfers_run_created;
        DROP INDEX evidence_links_run_created;
        DROP INDEX evidence_link_sources_source;
        DROP INDEX evidence_link_assets_asset;
        ALTER TABLE browser_sessions DROP COLUMN observed_at;
        ALTER TABLE browser_sessions DROP COLUMN observation_state;
        DROP TABLE browser_page_observations;
        ALTER TABLE browser_sessions DROP COLUMN observed_authentication;
        ALTER TABLE browser_sessions DROP COLUMN observed_origin;
        ALTER TABLE browser_sessions DROP COLUMN session_role;
        ALTER TABLE browser_sessions DROP COLUMN observation_revision;
        DROP TRIGGER evidence_links_no_delete;
        DROP TRIGGER evidence_links_no_update;
        DROP TRIGGER asset_records_no_delete;
        DROP TRIGGER asset_records_no_update;
        DROP TRIGGER blobs_no_delete;
        DROP TRIGGER blobs_no_update;
        DROP TRIGGER source_records_no_delete;
        DROP TRIGGER source_records_no_update;
        DROP TABLE retention_jobs;
        DROP TABLE evidence_link_assets;
        DROP TABLE evidence_link_sources;
        DROP TABLE evidence_links;
        DROP TABLE evidence_chunks;
        DROP TABLE evidence_transfers;
        DROP TABLE staging_leases;
        DROP TABLE asset_deletions;
        DROP TABLE asset_derivations;
        DROP TABLE asset_sources;
        DROP TABLE asset_records;
        DROP TABLE blobs;
        DROP TABLE source_records;
        DROP TRIGGER workflow_candidates_no_delete;
        DROP TRIGGER workflow_candidates_no_update;
        DROP TRIGGER workflow_draft_revisions_no_delete;
        DROP TRIGGER workflow_draft_revisions_no_update;
        DROP TABLE workflow_candidates;
        DROP TABLE workflow_draft_revisions;
        DROP TABLE workflow_drafts;
        ALTER TABLE browser_capabilities DROP COLUMN adapter_version;
        ALTER TABLE browser_capabilities DROP COLUMN adapter_id;
        ALTER TABLE browser_capabilities DROP COLUMN routes_json;
        DROP INDEX workflow_runs_active_updated;
        DROP INDEX engine_outbox_pending_created;
        DROP INDEX gateway_commands_active_sequence;
        DROP INDEX gateway_commands_terminal_result_sequence;
        DELETE FROM schema_migrations
        WHERE version IN (6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
      `);
      legacy.close();

      const upgraded = new SqlitePersistence({ path: databasePath });
      expect(upgraded.health().schemaVersion).toBe(15);
      expect(
        upgraded.createWorkflowDraft({
          draftId: "v5-upgraded-draft",
          revision: 0,
          content: { revision: 0 },
          createdAt: timestamp,
          updatedAt: timestamp
        })
      ).toMatchObject({
        draftId: "v5-upgraded-draft",
        revision: 0
      });
      upgraded.close();
      const inspected = new Database(databasePath, { readonly: true });
      const applied = inspected
        .prepare(
          "SELECT checksum FROM schema_migrations WHERE version = 6"
        )
        .get() as { checksum: string };
      expect(applied.checksum).toBe(migrationChecksum(migrations[5]!));
      inspected.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers cleanly when migration v6 is interrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v6-crash-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      expect(
        () =>
          new SqlitePersistence({
            path: databasePath,
            failureInjector(point) {
              if (point === "migration.6.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const store = new SqlitePersistence({ path: databasePath });
      expect(store.health().schemaVersion).toBe(15);
      expect(store.getWorkflowDraft("not-created")).toBeUndefined();
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
      expect(store.health().schemaVersion).toBe(15);
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
