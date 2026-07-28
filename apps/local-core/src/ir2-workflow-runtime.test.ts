import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimAssistanceTask,
  fromAssistanceTaskPersistenceAggregate,
  releaseAssistanceTask,
  submitAssistanceTask,
  toAssistanceTaskPersistenceAggregate,
  type AssistanceTask
} from "@bpa/assistance-core";
import {
  BuiltinRuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProvider
} from "@bpa/node-runtime";
import type { EngineState } from "@bpa/engine";
import type { AssistanceTaskRecord } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ArtifactRef, ExecutionPlan } from "@bpa/workflow-ir";
import { Ir2WorkflowRuntime } from "./ir2-workflow-runtime.js";

const digest = (character: string): string => character.repeat(64);
const node: ArtifactRef & { kind: "node" } = {
  kind: "node",
  id: "data.constant",
  version: "1.0.0",
  digest: digest("a")
};

function plan(providerId = "builtin"): ExecutionPlan {
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "test.recoverable",
      version: "1.0.0",
      digest: `sha256:${digest("b")}`
    },
    artifactClosure: { entries: [node] },
    riskSnapshot: [],
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    entry: "constant",
    steps: {
      constant: {
        kind: "call",
        key: "constant",
        node,
        providerId,
        permissionSnapshot: {
          riskLevel: "R0",
          permissions: [],
          domains: []
        },
        dependencies: {
          adapters: [],
          policies: [],
          datasetProfiles: []
        },
        input: {
          kind: "object",
          entries: {
            value: {
              kind: "literal",
              value: { recovered: true }
            }
          }
        },
        timeoutMs: 1_000,
        retry: {
          maxAttempts: 1,
          retryableOutcomes: [],
          retryableErrorCodes: [],
          backoff: {
            strategy: "fixed",
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0
          }
        },
        timing: {},
        routes: {
          succeeded: "done",
          failed: "failed",
          timed_out: "failed",
          rejected: "failed",
          cancelled: "failed",
          uncertain: "uncertain"
        }
      },
      done: { kind: "terminal", key: "done", status: "succeeded" },
      failed: {
        kind: "terminal",
        key: "failed",
        status: "failed",
        errorCode: "CALL_FAILED"
      },
      uncertain: {
        kind: "terminal",
        key: "uncertain",
        status: "uncertain"
      }
    }
  };
}

function ids() {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function taskRecord(task: AssistanceTask): AssistanceTaskRecord {
  const aggregate = toAssistanceTaskPersistenceAggregate(task);
  return {
    task: aggregate.definition,
    privateState: aggregate.privateState,
    fencingCounter: aggregate.privateState.fencingCounter
  };
}

describe("Local Core IR2 runtime", () => {
  it("recovers a frozen plan and consumes a pending provider effect once", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const providers = new RuntimeProviderRegistry();
    providers.register(new BuiltinRuntimeProvider());
    const first = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5
    });
    const run = first.start(plan(), {});
    expect(run).toMatchObject({ status: "running", revision: 0 });
    expect(persistence.getRunPlanSnapshot(run.id)?.planJson).toEqual(plan());
    expect(persistence.getEngineCheckpoint(run.id)).toMatchObject({
      stateVersion: "bpa.engine-state/2"
    });
    expect(persistence.listPendingEngineOutbox()).toHaveLength(1);

    const restarted = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_001,
      id: ids(),
      random: () => 0.5
    });
    expect(restarted.recover(run.id)).toMatchObject({
      status: "waiting_runtime"
    });
    await expect(restarted.drainOnce()).resolves.toBe(1);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      revision: 1,
      output: { recovered: true }
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    expect(persistence.listEvents(run.id).map((event) => event.type)).toEqual([
      "RUN_IR2_STARTED",
      "RUNTIME_RESULT_APPLIED"
    ]);
    await expect(restarted.drainOnce()).resolves.toBe(0);
    persistence.close();
  });

  it("times out an expired persisted invocation without calling its provider", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    let invocations = 0;
    const providers = new RuntimeProviderRegistry();
    providers.register({
      id: "counted",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return {
          status: "succeeded",
          output: { shouldNotRun: true },
          evidence: [],
          riskSignals: []
        };
      }
    });
    const first = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5
    });
    const run = first.start(plan("counted"), {});
    const restarted = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 2_000,
      id: ids(),
      random: () => 0.5
    });

    expect(restarted.recover(run.id)).toMatchObject({
      status: "waiting_runtime"
    });
    await expect(restarted.drainOnce()).resolves.toBe(1);
    expect(invocations).toBe(0);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "failed",
      revision: 1
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    persistence.close();
  });

  it("turns a missing provider into a deterministic failed route", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      }
    );
    const run = runtime.start(plan("missing"), {});
    await expect(runtime.drainOnce()).resolves.toBe(1);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "failed",
      output: null
    });
    persistence.close();
  });

  it("durably cancels once and never applies a late provider result", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ir2-cancel-"));
    const databasePath = join(directory, "core.db");
    try {
      const persistence = new SqlitePersistence({ path: databasePath });
      const cancellations: Array<{
        invocationId: string;
        fencingToken: number;
      }> = [];
      const provider: RuntimeProvider = {
        id: "cancellable",
        supports: () => true,
        invoke: async () => {
          throw new Error("cancel test must not invoke the provider");
        },
        cancel: async (invocationId, fencingToken) => {
          cancellations.push({ invocationId, fencingToken });
        }
      };
      const providers = new RuntimeProviderRegistry();
      providers.register(provider);
      const runtime = new Ir2WorkflowRuntime(persistence, providers, {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      });
      const run = runtime.start(plan("cancellable"), {});
      const waiting = persistence.getEngineCheckpoint(run.id)
        ?.state as unknown as EngineState;
      const active = waiting.active;
      if (active?.kind !== "call") throw new Error("fixture changed");

      expect(runtime.cancel(run.id, "operator-1")).toMatchObject({
        disposition: "advanced",
        run: { status: "cancelled", revision: 1 }
      });
      expect(cancellations).toEqual([
        {
          invocationId: active.invocation.invocationId,
          fencingToken: active.invocation.fencingToken
        }
      ]);
      expect(persistence.listPendingEngineOutbox()).toEqual([]);
      const cancelled = persistence.getEngineCheckpoint(run.id)!;
      expect(cancelled.state).toMatchObject({
        status: "cancelled",
        error: { code: "RUN_CANCELLED" }
      });
      expect(cancelled.state).not.toHaveProperty("active");
      expect(runtime.cancel(run.id, "operator-1")).toMatchObject({
        disposition: "duplicate",
        run: { status: "cancelled", revision: 1 }
      });
      expect(cancellations).toHaveLength(1);
      expect(
        runtime.acceptRuntimeResult({
          runId: run.id,
          outboxId: `effect:${active.invocation.invocationId}`,
          inboxMessageId: "late-result",
          invocationId: active.invocation.invocationId,
          fencingToken: active.invocation.fencingToken,
          outcome: {
            status: "succeeded",
            output: { tooLate: true },
            evidence: [],
            riskSignals: []
          }
        })
      ).toBe("duplicate");
      expect(persistence.getRun(run.id)).toMatchObject({
        status: "cancelled",
        revision: 1
      });
      expect(persistence.getRun(run.id)).not.toHaveProperty("output");
      expect(
        persistence
          .listEvents(run.id)
          .filter((event) => event.type === "RUN_IR2_CANCELLED")
      ).toHaveLength(1);
      persistence.close();

      const reopened = new SqlitePersistence({ path: databasePath });
      const restarted = new Ir2WorkflowRuntime(reopened, providers, {
        now: () => 2_000,
        id: ids(),
        random: () => 0.5
      });
      expect(restarted.recover(run.id)).toMatchObject({
        status: "cancelled",
        revision: cancelled.stateRevision
      });
      expect(reopened.listPendingEngineOutbox()).toEqual([]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists blocking assistance before exposing the waiting state", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      }
    );
    const profile = {
      kind: "assistance_profile" as const,
      id: "profile.review",
      version: "1.0.0",
      digest: `sha256:${digest("c")}`
    };
    const assistancePlan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.assistance",
        version: "1.0.0",
        digest: `sha256:${digest("d")}`
      },
      artifactClosure: { entries: [profile] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "review",
      steps: {
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "human_confirm",
          profile,
          deadlineMs: 60_000,
          onUnavailable: "fail",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "failed",
            expired: "failed",
            unavailable: "failed"
          }
        },
        done: { kind: "terminal", key: "done", status: "succeeded" },
        failed: {
          kind: "terminal",
          key: "failed",
          status: "failed",
          errorCode: "REVIEW_FAILED"
        },
        uncertain: {
          kind: "terminal",
          key: "uncertain",
          status: "uncertain"
        }
      }
    };
    const run = runtime.start(assistancePlan, {});
    expect(run.status).toBe("waiting_human");
    const tasks = persistence.listAssistanceTasks({ limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task).toMatchObject({
      runId: run.id,
      mode: "human_confirm",
      status: "queued"
    });
    expect(persistence.listPendingEngineOutbox()).toMatchObject([
      { topic: "assistance.requested" }
    ]);
    persistence.close();
  });

  it("atomically routes a denied AI result to human confirmation", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      }
    );
    const aiProfile = {
      kind: "assistance_profile" as const,
      id: "packaging_match_review",
      version: "1.0.0",
      digest: `sha256:${digest("7")}`
    };
    const humanProfile = {
      kind: "assistance_profile" as const,
      id: "binding_confirm",
      version: "1.0.0",
      digest: `sha256:${digest("8")}`
    };
    const assistancePlan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.ai-safe-escalation",
        version: "1.0.0",
        digest: `sha256:${digest("9")}`
      },
      artifactClosure: { entries: [aiProfile, humanProfile] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "review",
      steps: {
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "ai_review",
          profile: aiProfile,
          deadlineMs: 60_000,
          onUnavailable: "human_action",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "confirm",
            expired: "failed",
            unavailable: "confirm"
          }
        },
        confirm: {
          kind: "wait.assistance",
          key: "confirm",
          taskKind: "human_confirm",
          profile: humanProfile,
          deadlineMs: 60_000,
          onUnavailable: "fail",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "failed",
            expired: "failed",
            unavailable: "failed"
          }
        },
        done: { kind: "terminal", key: "done", status: "succeeded" },
        failed: {
          kind: "terminal",
          key: "failed",
          status: "failed",
          errorCode: "REVIEW_FAILED"
        }
      }
    };
    const run = runtime.start(assistancePlan, {});
    const queuedRecord = persistence
      .listAssistanceTasks({ modes: ["ai_review"], limit: 1 })[0];
    if (!queuedRecord) throw new Error("AI review fixture was not created");
    const queued = fromAssistanceTaskPersistenceAggregate({
      definition: queuedRecord.task,
      privateState: queuedRecord.privateState
    });
    const claimed = claimAssistanceTask(queued, {
      leaseId: "lease-ai",
      ownerId: "codex",
      ownerType: "ai",
      now: "1970-01-01T00:00:01.100Z",
      leaseDurationMs: 10_000
    });
    if (!claimed.ok) throw new Error(claimed.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(claimed.task),
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("accepted");
    const completed = submitAssistanceTask(claimed.task, {
      leaseId: "lease-ai",
      ownerId: "codex",
      fencingToken: 1,
      now: "1970-01-01T00:00:01.200Z",
      output: { review: "invalid-for-auto-continue" },
      resolverType: "ai",
      resolverId: "codex"
    });
    if (!completed.ok) throw new Error(completed.error);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-ai-escalated",
        task: taskRecord(completed.task),
        expectedRevision: 1,
        expectedFencingCounter: 1,
        runOutcome: {
          status: "escalated",
          reason: "R1_RESULT_VALIDATION_REQUIRED"
        }
      })
    ).toMatchObject({ status: "accepted" });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "waiting_human",
      currentNodeKey: "confirm"
    });
    expect(
      persistence.listAssistanceTasks({ limit: 10 }).map((entry) => ({
        mode: entry.task.mode,
        status: entry.task.status
      }))
    ).toEqual([
      { mode: "ai_review", status: "completed" },
      { mode: "human_confirm", status: "queued" }
    ]);
    expect(
      persistence.getEngineCheckpoint(run.id)?.state
    ).toMatchObject({
      status: "waiting_assistance",
      cursor: { stepKey: "confirm" },
      active: {
        kind: "assistance",
        request: { taskKind: "human_confirm" }
      }
    });
    expect(persistence.listEvents(run.id).at(-1)).toMatchObject({
      type: "ASSISTANCE_RESULT_APPLIED",
      payload: {
        outcome: "escalated",
        reason: "R1_RESULT_VALIDATION_REQUIRED"
      }
    });
    persistence.close();
  });

  it("atomically resumes a waiting Run after a reclaimed human task completes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      }
    );
    const profile = {
      kind: "assistance_profile" as const,
      id: "profile.confirm",
      version: "1.0.0",
      digest: `sha256:${digest("e")}`
    };
    const assistancePlan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.human-confirm",
        version: "1.0.0",
        digest: `sha256:${digest("f")}`
      },
      artifactClosure: { entries: [profile] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "confirm",
      steps: {
        confirm: {
          kind: "wait.assistance",
          key: "confirm",
          taskKind: "human_confirm",
          profile,
          deadlineMs: 60_000,
          onUnavailable: "fail",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "failed",
            expired: "failed",
            unavailable: "failed"
          }
        },
        done: { kind: "terminal", key: "done", status: "succeeded" },
        failed: {
          kind: "terminal",
          key: "failed",
          status: "failed",
          errorCode: "CONFIRM_FAILED"
        }
      }
    };
    const run = runtime.start(assistancePlan, {});
    const queuedRecord = persistence.listAssistanceTasks({ limit: 1 })[0];
    if (!queuedRecord) throw new Error("Assistance fixture was not created");
    const queued = fromAssistanceTaskPersistenceAggregate({
      definition: queuedRecord.task,
      privateState: queuedRecord.privateState
    });
    const firstClaim = claimAssistanceTask(queued, {
      leaseId: "lease-1",
      ownerId: "operator-1",
      ownerType: "human",
      now: "1970-01-01T00:00:01.100Z",
      leaseDurationMs: 10_000
    });
    if (!firstClaim.ok) throw new Error(firstClaim.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(firstClaim.task),
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("accepted");
    const released = releaseAssistanceTask(firstClaim.task, {
      leaseId: "lease-1",
      ownerId: "operator-1",
      fencingToken: 1,
      now: "1970-01-01T00:00:01.200Z"
    });
    if (!released.ok) throw new Error(released.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(released.task),
        expectedRevision: 1,
        expectedFencingCounter: 1
      }).status
    ).toBe("accepted");
    const secondClaim = claimAssistanceTask(released.task, {
      leaseId: "lease-2",
      ownerId: "operator-2",
      ownerType: "human",
      now: "1970-01-01T00:00:01.300Z",
      leaseDurationMs: 10_000
    });
    if (!secondClaim.ok) throw new Error(secondClaim.error);
    expect(secondClaim.task.fencingCounter).toBe(2);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(secondClaim.task),
        expectedRevision: 2,
        expectedFencingCounter: 1
      }).status
    ).toBe("accepted");
    const completed = submitAssistanceTask(secondClaim.task, {
      leaseId: "lease-2",
      ownerId: "operator-2",
      fencingToken: 2,
      now: "1970-01-01T00:00:01.400Z",
      output: { approved: true },
      resolverType: "human",
      resolverId: "operator-2"
    });
    if (!completed.ok) throw new Error(completed.error);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-human-1",
        task: taskRecord(completed.task),
        expectedRevision: 3,
        expectedFencingCounter: 2,
        runOutcome: {
          status: "resolved",
          reason: "MODE_REQUIRES_HUMAN"
        }
      })
    ).toMatchObject({ status: "accepted" });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      revision: 1,
      output: { approved: true }
    });
    expect(persistence.getEngineCheckpoint(run.id)).toMatchObject({
      stateRevision: 3,
      state: { status: "succeeded" }
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-human-1",
        task: taskRecord(completed.task),
        expectedRevision: 3,
        expectedFencingCounter: 2,
        runOutcome: {
          status: "resolved",
          reason: "MODE_REQUIRES_HUMAN"
        }
      }).status
    ).toBe("duplicate");
    persistence.close();
  });
});
