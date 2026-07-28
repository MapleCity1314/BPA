export const ASSISTANCE_MODES = [
  "ai_review",
  "human_confirm",
  "human_action"
] as const;

export type AssistanceMode = (typeof ASSISTANCE_MODES)[number];
export type AssistanceRiskLevel = "R0" | "R1" | "R2";

interface AssistanceTaskBase<TPayload> {
  readonly taskId: string;
  readonly mode: AssistanceMode;
  readonly profileId: string;
  readonly riskLevel: AssistanceRiskLevel;
  readonly payload: TPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fencingCounter: number;
}

export interface AssistanceLease {
  readonly leaseId: string;
  readonly claimantId: string;
  readonly fencingToken: number;
  readonly claimedAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

export interface AssistanceCompletion<TResult> {
  readonly result: TResult;
  readonly submittedBy: string;
  readonly submittedAt: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly confidence?: number;
}

export type PendingAssistanceTask<TPayload = unknown> =
  AssistanceTaskBase<TPayload> & {
    readonly status: "pending";
  };

export type ClaimedAssistanceTask<TPayload = unknown> =
  AssistanceTaskBase<TPayload> & {
    readonly status: "claimed";
    readonly lease: AssistanceLease;
  };

export type CompletedAssistanceTask<TPayload = unknown, TResult = unknown> =
  AssistanceTaskBase<TPayload> & {
    readonly status: "completed";
    readonly completion: AssistanceCompletion<TResult>;
  };

export type AssistanceTask<TPayload = unknown, TResult = unknown> =
  | PendingAssistanceTask<TPayload>
  | ClaimedAssistanceTask<TPayload>
  | CompletedAssistanceTask<TPayload, TResult>;

export interface CreateAssistanceTaskInput<TPayload> {
  readonly taskId: string;
  readonly mode: AssistanceMode;
  readonly profileId: string;
  readonly riskLevel: AssistanceRiskLevel;
  readonly payload: TPayload;
  readonly now: number;
}

export type AssistanceTransitionError =
  | "INVALID_INPUT"
  | "TASK_ALREADY_CLAIMED"
  | "TASK_ALREADY_COMPLETED"
  | "TASK_NOT_CLAIMED"
  | "LEASE_ID_MISMATCH"
  | "CLAIMANT_MISMATCH"
  | "FENCING_TOKEN_MISMATCH"
  | "LEASE_EXPIRED";

export type TransitionResult<T> =
  | { readonly ok: true; readonly task: T }
  | { readonly ok: false; readonly error: AssistanceTransitionError };

export interface LeaseProof {
  readonly leaseId: string;
  readonly claimantId: string;
  readonly fencingToken: number;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function freezeTask<T extends AssistanceTask<unknown, unknown>>(task: T): T {
  if (task.status === "claimed") {
    Object.freeze(task.lease);
  }
  if (task.status === "completed") {
    Object.freeze(task.completion);
  }
  return Object.freeze(task);
}

export function createAssistanceTask<TPayload>(
  input: CreateAssistanceTaskInput<TPayload>
): PendingAssistanceTask<TPayload> {
  if (
    !isNonEmpty(input.taskId) ||
    !isNonEmpty(input.profileId) ||
    !validTime(input.now)
  ) {
    throw new Error("Assistance task identity and timestamp must be valid");
  }
  return freezeTask({
    taskId: input.taskId,
    mode: input.mode,
    profileId: input.profileId,
    riskLevel: input.riskLevel,
    payload: input.payload,
    createdAt: input.now,
    updatedAt: input.now,
    fencingCounter: 0,
    status: "pending"
  });
}

export function claimAssistanceTask<TPayload, TResult>(
  task: AssistanceTask<TPayload, TResult>,
  input: {
    readonly leaseId: string;
    readonly claimantId: string;
    readonly now: number;
    readonly leaseDurationMs: number;
  }
): TransitionResult<ClaimedAssistanceTask<TPayload>> {
  if (
    !isNonEmpty(input.leaseId) ||
    !isNonEmpty(input.claimantId) ||
    !validTime(input.now) ||
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  if (task.status === "completed") {
    return { ok: false, error: "TASK_ALREADY_COMPLETED" };
  }
  if (task.status === "claimed" && input.now < task.lease.expiresAt) {
    return { ok: false, error: "TASK_ALREADY_CLAIMED" };
  }

  const fencingToken = task.fencingCounter + 1;
  return {
    ok: true,
    task: freezeTask({
      taskId: task.taskId,
      mode: task.mode,
      profileId: task.profileId,
      riskLevel: task.riskLevel,
      payload: task.payload,
      createdAt: task.createdAt,
      updatedAt: input.now,
      fencingCounter: fencingToken,
      status: "claimed",
      lease: {
        leaseId: input.leaseId,
        claimantId: input.claimantId,
        fencingToken,
        claimedAt: input.now,
        heartbeatAt: input.now,
        expiresAt: input.now + input.leaseDurationMs
      }
    })
  };
}

function validateLease<TPayload>(
  task: AssistanceTask<TPayload, unknown>,
  proof: LeaseProof,
  now: number
): AssistanceTransitionError | undefined {
  if (
    !isNonEmpty(proof.leaseId) ||
    !isNonEmpty(proof.claimantId) ||
    !Number.isInteger(proof.fencingToken) ||
    proof.fencingToken <= 0 ||
    !validTime(now)
  ) {
    return "INVALID_INPUT";
  }
  if (task.status === "completed") return "TASK_ALREADY_COMPLETED";
  if (task.status !== "claimed") return "TASK_NOT_CLAIMED";
  if (proof.fencingToken !== task.lease.fencingToken) {
    return "FENCING_TOKEN_MISMATCH";
  }
  if (proof.leaseId !== task.lease.leaseId) return "LEASE_ID_MISMATCH";
  if (proof.claimantId !== task.lease.claimantId) return "CLAIMANT_MISMATCH";
  if (now >= task.lease.expiresAt) return "LEASE_EXPIRED";
  return undefined;
}

export function heartbeatAssistanceTask<TPayload>(
  task: AssistanceTask<TPayload, unknown>,
  input: LeaseProof & {
    readonly now: number;
    readonly leaseDurationMs: number;
  }
): TransitionResult<ClaimedAssistanceTask<TPayload>> {
  if (
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (task.status !== "claimed") {
    return { ok: false, error: "TASK_NOT_CLAIMED" };
  }
  return {
    ok: true,
    task: freezeTask({
      ...task,
      updatedAt: input.now,
      lease: {
        ...task.lease,
        heartbeatAt: input.now,
        expiresAt: input.now + input.leaseDurationMs
      }
    })
  };
}

export function releaseAssistanceTask<TPayload>(
  task: AssistanceTask<TPayload, unknown>,
  input: LeaseProof & { readonly now: number }
): TransitionResult<PendingAssistanceTask<TPayload>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  return {
    ok: true,
    task: freezeTask({
      taskId: task.taskId,
      mode: task.mode,
      profileId: task.profileId,
      riskLevel: task.riskLevel,
      payload: task.payload,
      createdAt: task.createdAt,
      updatedAt: input.now,
      fencingCounter: task.fencingCounter,
      status: "pending"
    })
  };
}

export function submitAssistanceTask<TPayload, TResult>(
  task: AssistanceTask<TPayload, TResult>,
  input: LeaseProof & {
    readonly now: number;
    readonly result: TResult;
    readonly confidence?: number;
  }
): TransitionResult<CompletedAssistanceTask<TPayload, TResult>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  return {
    ok: true,
    task: freezeTask({
      taskId: task.taskId,
      mode: task.mode,
      profileId: task.profileId,
      riskLevel: task.riskLevel,
      payload: task.payload,
      createdAt: task.createdAt,
      updatedAt: input.now,
      fencingCounter: task.fencingCounter,
      status: "completed",
      completion: {
        result: input.result,
        submittedBy: input.claimantId,
        submittedAt: input.now,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        ...(input.confidence === undefined
          ? {}
          : { confidence: input.confidence })
      }
    })
  };
}

export type AutoContinueReason =
  | "R0_PUBLISHED_PROFILE"
  | "R1_ALLOWLISTED_AND_VALIDATED"
  | "MODE_REQUIRES_HUMAN"
  | "PROFILE_NOT_PUBLISHED"
  | "R1_PROFILE_NOT_ALLOWLISTED"
  | "R1_RESULT_VALIDATION_REQUIRED"
  | "R2_REQUIRES_HUMAN";

export type AutoContinueDecision =
  | { readonly allowed: true; readonly reason: AutoContinueReason }
  | { readonly allowed: false; readonly reason: AutoContinueReason };

export function evaluateAutoContinue(input: {
  readonly mode: AssistanceMode;
  readonly riskLevel: AssistanceRiskLevel;
  readonly profileId: string;
  readonly profilePublished: boolean;
  readonly r1ProfileAllowlist: readonly string[];
  readonly deterministicResultValid: boolean;
  readonly confidence?: number;
}): AutoContinueDecision {
  if (input.mode !== "ai_review") {
    return { allowed: false, reason: "MODE_REQUIRES_HUMAN" };
  }
  if (input.riskLevel === "R2") {
    return { allowed: false, reason: "R2_REQUIRES_HUMAN" };
  }
  if (!input.profilePublished) {
    return { allowed: false, reason: "PROFILE_NOT_PUBLISHED" };
  }
  if (input.riskLevel === "R0") {
    return { allowed: true, reason: "R0_PUBLISHED_PROFILE" };
  }
  if (!input.r1ProfileAllowlist.includes(input.profileId)) {
    return { allowed: false, reason: "R1_PROFILE_NOT_ALLOWLISTED" };
  }
  if (!input.deterministicResultValid) {
    return { allowed: false, reason: "R1_RESULT_VALIDATION_REQUIRED" };
  }
  return { allowed: true, reason: "R1_ALLOWLISTED_AND_VALIDATED" };
}
