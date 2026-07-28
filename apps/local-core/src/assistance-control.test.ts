import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ExecutionPlan } from "@bpa/workflow-ir";
import { LocalCoreService } from "./control.js";

const digest = (character: string): string => character.repeat(64);

function assistancePlan(): ExecutionPlan {
  const profile = {
    kind: "assistance_profile" as const,
    id: "profile.control-confirm",
    version: "1.0.0",
    digest: `sha256:${digest("a")}`
  };
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "test.assistance-control",
      version: "1.0.0",
      digest: `sha256:${digest("b")}`
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
}

describe("Local Core assistance control", () => {
  it("lists, claims and submits a human task through the control boundary", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    const run = service.ir2Runtime.start(assistancePlan(), {
      items: ["product-1"]
    });
    const listed = await service.handleAsync({
      id: "list-1",
      method: "assistance.task.list",
      params: {
        statuses: ["queued"],
        modes: ["human_confirm"],
        limit: 10
      }
    });
    expect(listed).toMatchObject({
      ok: true,
      result: [{ runId: run.id, status: "queued" }]
    });
    const taskId = (
      listed.result as Array<{ taskId: string }>
    )[0]?.taskId;
    if (!taskId) throw new Error("Assistance task was not listed");
    const claimed = await service.handleAsync({
      id: "claim-envelope",
      method: "assistance.task.claim",
      params: {
        operationId: "claim-operation",
        taskId,
        leaseId: "lease-1",
        actorId: "operator-1",
        actorType: "human",
        leaseDurationMs: 10_000
      }
    });
    expect(claimed).toMatchObject({
      ok: true,
      result: {
        ok: true,
        duplicate: false,
        task: { status: "claimed", fencingCounter: 1 }
      }
    });
    const submitted = await service.handleAsync({
      id: "submit-envelope",
      method: "assistance.task.submit",
      params: {
        operationId: "submit-operation",
        taskId,
        leaseId: "lease-1",
        actorId: "operator-1",
        resolverType: "human",
        fencingToken: 1,
        output: { approved: true }
      }
    });
    expect(submitted).toMatchObject({
      ok: true,
      result: {
        ok: true,
        duplicate: false,
        task: { status: "completed" },
        autoContinue: {
          allowed: false,
          reason: "MODE_REQUIRES_HUMAN"
        }
      }
    });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      output: { approved: true }
    });
    const replay = await service.handleAsync({
      id: "submit-replay-envelope",
      method: "assistance.task.submit",
      params: {
        operationId: "submit-operation",
        taskId,
        leaseId: "lease-1",
        actorId: "operator-1",
        resolverType: "human",
        fencingToken: 1,
        output: { approved: false }
      }
    });
    expect(replay).toMatchObject({
      ok: true,
      result: {
        ok: true,
        duplicate: true,
        task: {
          resolution: { output: { approved: true } }
        }
      }
    });
    persistence.close();
  });
});
