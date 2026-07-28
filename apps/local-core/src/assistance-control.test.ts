import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ExecutionPlan } from "@bpa/workflow-ir";
import { LocalCoreService } from "./control.js";

const digest = (character: string): string => character.repeat(64);
const readAsset = (path: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );

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
  it("validates the exact policy and saves the Profile as candidate-only", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    const policy = readAsset(
      "policies/core/packaging_match_review.validator.policy.json"
    );
    expect(
      service.handle({
        id: "publish-validator-policy",
        method: "asset.publish",
        params: {
          assetType: "policy",
          content: policy,
          actor: "test"
        }
      })
    ).toMatchObject({ ok: true });

    const profile = readAsset(
      "assistance-profiles/core/packaging_match_review.assistance-profile.json"
    );
    expect(
      service.handle({
        id: "save-profile-candidate",
        method: "asset.candidate",
        params: {
          assetType: "assistance_profile",
          content: profile,
          actor: "test"
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        assetId: "packaging_match_review",
        version: "1.0.0"
      }
    });
    expect(
      persistence.getPublished(
        "assistance_profile",
        "packaging_match_review",
        "1.0.0"
      )
    ).toBeUndefined();
    persistence.close();
  });

  it("automatically resumes an exact, deterministically valid R1 review", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    for (const [assetType, path] of [
      [
        "policy",
        "policies/core/packaging_match_review.validator.policy.json"
      ],
      [
        "assistance_profile",
        "assistance-profiles/core/packaging_match_review.assistance-profile.json"
      ]
    ] as const) {
      expect(
        service.handle({
          id: `publish-${assetType}`,
          method: "asset.publish",
          params: {
            assetType,
            content: readAsset(path),
            actor: "test"
          }
        })
      ).toMatchObject({ ok: true });
    }
    const published = persistence.getPublished(
      "assistance_profile",
      "packaging_match_review",
      "1.0.0"
    );
    if (!published) throw new Error("Profile fixture was not published");
    const profile = {
      kind: "assistance_profile" as const,
      id: published.assetId,
      version: published.version,
      digest: published.digest
    };
    const batchRef = `sha256:${digest("1")}`;
    const productRef = `sha256:${digest("2")}`;
    const candidateRef = `sha256:${digest("3")}`;
    const recordDigest = `sha256:${digest("4")}`;
    const reviewInput = {
      batchRef,
      items: [
        {
          productRef,
          productId: "product-1",
          candidates: [
            {
              candidateRef,
              recordId: "record-1",
              recordDigest
            }
          ]
        }
      ]
    };
    const plan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.packaging-review",
        version: "1.0.0",
        digest: `sha256:${digest("c")}`
      },
      artifactClosure: { entries: [profile] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "review",
      steps: {
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "ai_review",
          profile,
          deadlineMs: 60_000,
          onUnavailable: "human_action",
          blocking: true,
          input: { kind: "literal", value: reviewInput },
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
    const run = service.ir2Runtime.start(plan, {});
    const queued = persistence.listAssistanceTasks({ limit: 1 })[0];
    if (!queued) throw new Error("Review task fixture was not created");
    const claim = await service.assistance.claim({
      taskId: queued.task.taskId,
      requestId: "claim-packaging-review",
      leaseId: "lease-packaging-review",
      actorId: "codex",
      actorType: "ai",
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    });
    expect(claim).toMatchObject({ ok: true });
    const submitted = await service.assistance.submit({
      taskId: queued.task.taskId,
      requestId: "submit-packaging-review",
      proof: {
        leaseId: "lease-packaging-review",
        ownerId: "codex",
        fencingToken: 1
      },
      now: "2026-07-28T00:00:02.000Z",
      output: {
        batchRef,
        decisions: [
          {
            productRef,
            productId: "product-1",
            status: "selected",
            candidateRef,
            recordId: "record-1",
            recordDigest
          }
        ]
      },
      resolverType: "ai",
      resolverId: "codex"
    });
    expect(submitted).toMatchObject({
      ok: true,
      autoContinue: {
        allowed: true,
        reason: "R1_POLICY_APPROVED_AND_VALIDATED"
      }
    });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded"
    });
    persistence.close();
  });

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
