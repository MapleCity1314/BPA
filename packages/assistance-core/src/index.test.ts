import { describe, expect, it } from "vitest";
import { validateAssistanceTask } from "@bpa/schemas";
import {
  awaitHumanAssistanceTask,
  claimAssistanceTask,
  createAssistanceTask,
  evaluateAutoContinue,
  fromAssistanceTaskPersistenceAggregate,
  heartbeatAssistanceTask,
  releaseAssistanceTask,
  startAssistanceProcessing,
  submitAssistanceTask,
  terminateAssistanceTask,
  toAssistanceTaskDefinition,
  toAssistanceTaskPersistenceAggregate
} from "./index.js";

const t0 = "2026-07-28T00:00:00.000Z";
const t1 = "2026-07-28T00:00:01.000Z";
const t2 = "2026-07-28T00:00:02.000Z";
const t3 = "2026-07-28T00:00:03.000Z";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

const defaultPolicy = {
  autoContinue: true,
  r1ProfileApproved: true,
  durableDecision: false,
  deterministicValidator: {
    id: "validator",
    version: "1.0.0",
    digest: digestA
  },
  onUnavailable: "continue_unresolved" as const
};

function queued() {
  return createAssistanceTask({
    taskId: "task-1",
    runId: "run-1",
    stepInstanceId: "step-1",
    profile: {
      id: "profile-1",
      version: "1.0.0",
      digest: digestB
    },
    mode: "ai_review",
    riskLevel: "R1",
    input: { batch: "batch-1" },
    outputSchema: { type: "object" },
    policySnapshot: defaultPolicy,
    contextRefs: [
      {
        evidenceId: "evidence-1",
        classification: "internal",
        digest: digestC
      }
    ],
    deadline: "2026-07-29T00:00:00.000Z",
    now: t0
  });
}

const proof = {
  leaseId: "private-lease-1",
  ownerId: "codex-1",
  fencingToken: 1
};

function claimed() {
  const result = claimAssistanceTask(queued(), {
    leaseId: proof.leaseId,
    ownerId: proof.ownerId,
    ownerType: "ai",
    now: t1,
    leaseDurationMs: 10_000
  });
  if (!result.ok) throw new Error(result.error);
  return result.task;
}

describe("canonical assistance aggregate", () => {
  it("creates a queued aggregate and serializes the canonical DTO", () => {
    const task = queued();
    expect(task.status).toBe("queued");
    expect(task.revision).toBe(0);
    expect(Object.isFrozen(task)).toBe(true);
    const definition = toAssistanceTaskDefinition(task);
    expect(definition).toMatchObject({
      apiVersion: "bpa.assistance/v1alpha1",
      status: "queued",
      runId: "run-1",
      policySnapshot: defaultPolicy
    });
    expect(validateAssistanceTask(definition)).toBe(true);
    expect(() =>
      createAssistanceTask({
        ...task,
        profile: { ...task.profile, digest: "" },
        now: t0
      })
    ).toThrow(/invalid/);
  });

  it("moves claimed to processing, heartbeats, then releases", () => {
    const processing = startAssistanceProcessing(claimed(), {
      ...proof,
      now: t2
    });
    expect(processing).toMatchObject({
      ok: true,
      task: { status: "processing", revision: 2 }
    });
    if (!processing.ok) throw new Error(processing.error);
    const heartbeat = heartbeatAssistanceTask(processing.task, {
      ...proof,
      now: t3,
      leaseDurationMs: 20_000
    });
    expect(heartbeat).toMatchObject({
      ok: true,
      task: {
        status: "processing",
        lease: { heartbeatAt: t3 }
      }
    });
    if (!heartbeat.ok) throw new Error(heartbeat.error);
    expect(
      releaseAssistanceTask(heartbeat.task, {
        ...proof,
        now: "2026-07-28T00:00:04.000Z"
      })
    ).toMatchObject({ ok: true, task: { status: "queued" } });
  });

  it("supports processing to awaiting-human and a later human claim", () => {
    const processing = startAssistanceProcessing(claimed(), {
      ...proof,
      now: t2
    });
    if (!processing.ok) throw new Error(processing.error);
    const waiting = awaitHumanAssistanceTask(processing.task, {
      ...proof,
      now: t3
    });
    expect(waiting).toMatchObject({
      ok: true,
      task: { status: "awaiting_human" }
    });
    if (!waiting.ok) throw new Error(waiting.error);
    expect(
      claimAssistanceTask(waiting.task, {
        leaseId: "ai-lease",
        ownerId: "codex-2",
        ownerType: "ai",
        now: "2026-07-28T00:00:04.000Z",
        leaseDurationMs: 10_000
      })
    ).toEqual({ ok: false, error: "CLAIMANT_NOT_AUTHORIZED" });
    const humanClaim = claimAssistanceTask(waiting.task, {
      leaseId: "human-lease",
      ownerId: "human-1",
      ownerType: "human",
      now: "2026-07-28T00:00:04.000Z",
      leaseDurationMs: 10_000
    });
    expect(humanClaim).toMatchObject({
      ok: true,
      task: { status: "claimed", fencingCounter: 2 }
    });
  });

  it("takes over an expired lease with a new fencing token", () => {
    const first = claimed();
    expect(
      claimAssistanceTask(first, {
        leaseId: "too-early",
        ownerId: "worker-2",
        ownerType: "ai",
        now: t2,
        leaseDurationMs: 10_000
      })
    ).toEqual({ ok: false, error: "TASK_ALREADY_CLAIMED" });
    const takeover = claimAssistanceTask(first, {
      leaseId: "private-lease-2",
      ownerId: "worker-2",
      ownerType: "ai",
      now: "2026-07-28T00:00:11.000Z",
      leaseDurationMs: 10_000
    });
    expect(takeover).toMatchObject({
      ok: true,
      task: {
        status: "claimed",
        fencingCounter: 2,
        lease: { fencingToken: 2, ownerId: "worker-2" }
      }
    });
  });

  it("submits a canonical resolution once", () => {
    const completed = submitAssistanceTask(claimed(), {
      ...proof,
      now: t2,
      output: { selection: "record-1" },
      resolverType: "ai",
      resolverId: "codex-1",
      provider: "openai",
      model: "model-1",
      confidence: 0.9
    });
    expect(completed).toMatchObject({
      ok: true,
      task: {
        status: "completed",
        resolution: {
          resolverType: "ai",
          output: { selection: "record-1" }
        }
      }
    });
    if (!completed.ok) throw new Error(completed.error);
    const definition = toAssistanceTaskDefinition(completed.task);
    expect(definition.resolution).toEqual(completed.task.resolution);
    expect(validateAssistanceTask(definition)).toBe(true);
    expect(
      submitAssistanceTask(claimed(), {
        ...proof,
        now: t2,
        output: null,
        resolverType: "human",
        resolverId: proof.ownerId
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(
      submitAssistanceTask(claimed(), {
        ...proof,
        now: t2,
        output: null,
        resolverType: "ai",
        resolverId: "another-owner"
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(
      submitAssistanceTask(completed.task, {
        ...proof,
        now: t3,
        output: null,
        resolverType: "ai",
        resolverId: "codex-1"
      })
    ).toEqual({ ok: false, error: "TASK_TERMINAL" });
  });

  it.each(["expired", "cancelled", "failed"] as const)(
    "supports the %s terminal transition",
    (status) => {
      const result = terminateAssistanceTask(queued(), {
        status,
        reason: `${status} reason`,
        now: t1
      });
      expect(result).toMatchObject({
        ok: true,
        task: { status, terminalReason: `${status} reason` }
      });
      if (!result.ok) throw new Error(result.error);
      expect(
        claimAssistanceTask(result.task, {
          leaseId: "lease",
          ownerId: "worker",
          ownerType: "ai",
          now: t2,
          leaseDurationMs: 1_000
        })
      ).toEqual({ ok: false, error: "TASK_TERMINAL" });
    }
  );

  it("rejects stale, mismatched, expired, and invalid state transitions", () => {
    const task = claimed();
    expect(
      heartbeatAssistanceTask(task, {
        ...proof,
        fencingToken: 0,
        now: t2,
        leaseDurationMs: 1_000
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(
      heartbeatAssistanceTask(task, {
        ...proof,
        fencingToken: 2,
        now: t2,
        leaseDurationMs: 1_000
      })
    ).toEqual({ ok: false, error: "FENCING_TOKEN_MISMATCH" });
    expect(
      heartbeatAssistanceTask(task, {
        ...proof,
        leaseId: "wrong",
        now: t2,
        leaseDurationMs: 1_000
      })
    ).toEqual({ ok: false, error: "LEASE_ID_MISMATCH" });
    expect(
      heartbeatAssistanceTask(task, {
        ...proof,
        ownerId: "wrong",
        now: t2,
        leaseDurationMs: 1_000
      })
    ).toEqual({ ok: false, error: "OWNER_MISMATCH" });
    expect(
      heartbeatAssistanceTask(task, {
        ...proof,
        now: "2026-07-28T00:00:11.000Z",
        leaseDurationMs: 1_000
      })
    ).toEqual({ ok: false, error: "LEASE_EXPIRED" });
    expect(
      startAssistanceProcessing(queued(), { ...proof, now: t1 })
    ).toEqual({ ok: false, error: "TASK_NOT_CLAIMED" });
    expect(
      awaitHumanAssistanceTask(task, { ...proof, now: t2 })
    ).toEqual({ ok: false, error: "INVALID_TRANSITION" });
  });

  it("round-trips through an explicit canonical/private persistence boundary", () => {
    const task = claimed();
    const persisted = toAssistanceTaskPersistenceAggregate(task);
    expect(persisted.definition.lease).not.toHaveProperty("leaseId");
    expect(persisted.privateState).toMatchObject({
      leaseId: proof.leaseId,
      fencingCounter: 1
    });
    expect(fromAssistanceTaskPersistenceAggregate(persisted)).toEqual(task);
    expect(() =>
      fromAssistanceTaskPersistenceAggregate({
        definition: persisted.definition,
        privateState: { fencingCounter: 1 }
      })
    ).toThrow(/private lease state/);
  });
});

describe("automatic continuation policy snapshot", () => {
  const base = {
    mode: "ai_review" as const,
    riskLevel: "R0" as const,
    profilePublished: true,
    policySnapshot: defaultPolicy,
    deterministicResultValid: true,
    confidence: 1
  };

  it("allows R0 only when the snapshot explicitly enables it", () => {
    expect(evaluateAutoContinue(base)).toEqual({
      allowed: true,
      reason: "R0_POLICY_APPROVED"
    });
    expect(
      evaluateAutoContinue({
        ...base,
        policySnapshot: { ...defaultPolicy, autoContinue: false }
      })
    ).toEqual({
      allowed: false,
      reason: "POLICY_AUTO_CONTINUE_DISABLED"
    });
  });

  it("requires the full R1 policy and validator gates", () => {
    expect(evaluateAutoContinue({ ...base, riskLevel: "R1" })).toEqual({
      allowed: true,
      reason: "R1_POLICY_APPROVED_AND_VALIDATED"
    });
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R1",
        policySnapshot: { ...defaultPolicy, r1ProfileApproved: false }
      })
    ).toEqual({ allowed: false, reason: "R1_PROFILE_NOT_APPROVED" });
    const { deterministicValidator: _, ...withoutValidator } = defaultPolicy;
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R1",
        policySnapshot: withoutValidator
      })
    ).toEqual({ allowed: false, reason: "R1_VALIDATOR_NOT_CONFIGURED" });
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R1",
        deterministicResultValid: false
      })
    ).toEqual({
      allowed: false,
      reason: "R1_RESULT_VALIDATION_REQUIRED"
    });
  });

  it("blocks durable decisions, human modes, unpublished profiles and R2-R4", () => {
    expect(
      evaluateAutoContinue({
        ...base,
        policySnapshot: { ...defaultPolicy, durableDecision: true }
      })
    ).toEqual({
      allowed: false,
      reason: "DURABLE_DECISION_REQUIRES_HUMAN"
    });
    expect(
      evaluateAutoContinue({ ...base, mode: "human_confirm" })
    ).toEqual({ allowed: false, reason: "MODE_REQUIRES_HUMAN" });
    expect(
      evaluateAutoContinue({ ...base, profilePublished: false })
    ).toEqual({ allowed: false, reason: "PROFILE_NOT_PUBLISHED" });
    for (const riskLevel of ["R2", "R3", "R4"] as const) {
      expect(evaluateAutoContinue({ ...base, riskLevel })).toEqual({
        allowed: false,
        reason: "R2_PLUS_REQUIRES_HUMAN"
      });
    }
  });
});
