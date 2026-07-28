import { describe, expect, it } from "vitest";
import { BuiltinRuntimeProvider, RuntimeProviderRegistry } from "@bpa/node-runtime";
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
});
