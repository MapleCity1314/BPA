import { describe, expect, it } from "vitest";
import {
  claimAssistanceTask,
  createAssistanceTask,
  evaluateAutoContinue,
  heartbeatAssistanceTask,
  releaseAssistanceTask,
  submitAssistanceTask
} from "./index.js";

function pendingTask() {
  return createAssistanceTask({
    taskId: "task-1",
    mode: "ai_review",
    profileId: "profile-1",
    riskLevel: "R1",
    payload: { batch: "batch-1" },
    now: 100
  });
}

function claimAt(now = 200) {
  return claimAssistanceTask(pendingTask(), {
    leaseId: "lease-1",
    claimantId: "worker-1",
    now,
    leaseDurationMs: 100
  });
}

const proof = {
  leaseId: "lease-1",
  claimantId: "worker-1",
  fencingToken: 1
};

describe("assistance task state machine", () => {
  it("creates an immutable pending task and validates its identity", () => {
    const task = pendingTask();
    expect(task).toMatchObject({
      status: "pending",
      fencingCounter: 0,
      createdAt: 100
    });
    expect(Object.isFrozen(task)).toBe(true);
    expect(() =>
      createAssistanceTask({
        taskId: "",
        mode: "human_action",
        profileId: "profile",
        riskLevel: "R2",
        payload: null,
        now: 0
      })
    ).toThrow(/identity and timestamp/);
  });

  it("claims, heartbeats, releases and reclaims with increasing fencing tokens", () => {
    const claimed = claimAt();
    expect(claimed).toMatchObject({
      ok: true,
      task: {
        status: "claimed",
        fencingCounter: 1,
        lease: { fencingToken: 1, expiresAt: 300 }
      }
    });
    if (!claimed.ok) throw new Error("claim failed");

    const heartbeat = heartbeatAssistanceTask(claimed.task, {
      ...proof,
      now: 250,
      leaseDurationMs: 200
    });
    expect(heartbeat).toMatchObject({
      ok: true,
      task: { lease: { heartbeatAt: 250, expiresAt: 450 } }
    });
    if (!heartbeat.ok) throw new Error("heartbeat failed");

    const released = releaseAssistanceTask(heartbeat.task, {
      ...proof,
      now: 300
    });
    expect(released).toMatchObject({
      ok: true,
      task: { status: "pending", fencingCounter: 1 }
    });
    if (!released.ok) throw new Error("release failed");

    const reclaimed = claimAssistanceTask(released.task, {
      leaseId: "lease-2",
      claimantId: "worker-2",
      now: 350,
      leaseDurationMs: 100
    });
    expect(reclaimed).toMatchObject({
      ok: true,
      task: {
        fencingCounter: 2,
        lease: { fencingToken: 2 }
      }
    });
  });

  it("allows takeover after expiry and rejects stale or mismatched lease proofs", () => {
    const first = claimAt();
    if (!first.ok) throw new Error("claim failed");
    expect(
      claimAssistanceTask(first.task, {
        leaseId: "lease-2",
        claimantId: "worker-2",
        now: 250,
        leaseDurationMs: 100
      })
    ).toEqual({ ok: false, error: "TASK_ALREADY_CLAIMED" });

    const second = claimAssistanceTask(first.task, {
      leaseId: "lease-2",
      claimantId: "worker-2",
      now: 300,
      leaseDurationMs: 100
    });
    if (!second.ok) throw new Error("takeover failed");
    expect(
      submitAssistanceTask(second.task, {
        ...proof,
        now: 320,
        result: "stale"
      })
    ).toEqual({ ok: false, error: "FENCING_TOKEN_MISMATCH" });
    expect(
      heartbeatAssistanceTask(second.task, {
        leaseId: "wrong",
        claimantId: "worker-2",
        fencingToken: 2,
        now: 320,
        leaseDurationMs: 100
      })
    ).toEqual({ ok: false, error: "LEASE_ID_MISMATCH" });
    expect(
      releaseAssistanceTask(second.task, {
        leaseId: "lease-2",
        claimantId: "wrong",
        fencingToken: 2,
        now: 320
      })
    ).toEqual({ ok: false, error: "CLAIMANT_MISMATCH" });
    expect(
      releaseAssistanceTask(second.task, {
        leaseId: "lease-2",
        claimantId: "worker-2",
        fencingToken: 2,
        now: 400
      })
    ).toEqual({ ok: false, error: "LEASE_EXPIRED" });
  });

  it("submits once and rejects duplicate or late submissions", () => {
    const claimed = claimAt();
    if (!claimed.ok) throw new Error("claim failed");
    const completed = submitAssistanceTask(claimed.task, {
      ...proof,
      now: 250,
      result: { choice: "record-1" },
      confidence: 0.96
    });
    expect(completed).toMatchObject({
      ok: true,
      task: {
        status: "completed",
        completion: {
          submittedBy: "worker-1",
          confidence: 0.96
        }
      }
    });
    if (!completed.ok) throw new Error("submit failed");
    expect(
      submitAssistanceTask(completed.task, {
        ...proof,
        now: 260,
        result: { choice: "record-2" }
      })
    ).toEqual({ ok: false, error: "TASK_ALREADY_COMPLETED" });
    expect(
      submitAssistanceTask(claimed.task, {
        ...proof,
        now: 300,
        result: null
      })
    ).toEqual({ ok: false, error: "LEASE_EXPIRED" });
  });

  it("rejects invalid transitions without mutating the task", () => {
    const pending = pendingTask();
    expect(
      heartbeatAssistanceTask(pending, {
        ...proof,
        now: 150,
        leaseDurationMs: 100
      })
    ).toEqual({ ok: false, error: "TASK_NOT_CLAIMED" });
    expect(
      claimAssistanceTask(pending, {
        leaseId: "",
        claimantId: "worker",
        now: 150,
        leaseDurationMs: 100
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    const claimed = claimAt();
    if (!claimed.ok) throw new Error("claim failed");
    expect(
      heartbeatAssistanceTask(claimed.task, {
        ...proof,
        now: 250,
        leaseDurationMs: 0
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(
      submitAssistanceTask(claimed.task, {
        ...proof,
        now: 250,
        result: null,
        confidence: 2
      })
    ).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(pending.status).toBe("pending");
  });
});

describe("automatic continuation policy", () => {
  const base = {
    mode: "ai_review" as const,
    profileId: "profile-1",
    profilePublished: true,
    r1ProfileAllowlist: ["profile-1"],
    deterministicResultValid: true
  };

  it("allows published R0 profiles by default", () => {
    expect(evaluateAutoContinue({ ...base, riskLevel: "R0" })).toEqual({
      allowed: true,
      reason: "R0_PUBLISHED_PROFILE"
    });
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R0",
        profilePublished: false
      })
    ).toEqual({ allowed: false, reason: "PROFILE_NOT_PUBLISHED" });
  });

  it("requires both an R1 allowlist entry and deterministic validation", () => {
    expect(evaluateAutoContinue({ ...base, riskLevel: "R1" })).toEqual({
      allowed: true,
      reason: "R1_ALLOWLISTED_AND_VALIDATED"
    });
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R1",
        r1ProfileAllowlist: []
      })
    ).toEqual({ allowed: false, reason: "R1_PROFILE_NOT_ALLOWLISTED" });
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R1",
        deterministicResultValid: false,
        confidence: 1
      })
    ).toEqual({
      allowed: false,
      reason: "R1_RESULT_VALIDATION_REQUIRED"
    });
  });

  it("never lets confidence authorize R2 or human tasks", () => {
    expect(
      evaluateAutoContinue({
        ...base,
        riskLevel: "R2",
        confidence: 1
      })
    ).toEqual({ allowed: false, reason: "R2_REQUIRES_HUMAN" });
    expect(
      evaluateAutoContinue({
        ...base,
        mode: "human_confirm",
        riskLevel: "R0",
        confidence: 1
      })
    ).toEqual({ allowed: false, reason: "MODE_REQUIRES_HUMAN" });
  });
});
