import type { AssistanceTaskDefinition } from "@bpa/schemas";

export type AssistanceMode = AssistanceTaskDefinition["mode"];
export type AssistanceRiskLevel = AssistanceTaskDefinition["riskLevel"];
export type AssistanceStatus = AssistanceTaskDefinition["status"];
export type AssistancePolicySnapshot =
  AssistanceTaskDefinition["policySnapshot"];
export type AssistanceProfileRef = AssistanceTaskDefinition["profile"];

export const ASSISTANCE_MODES = [
  "ai_review",
  "human_confirm",
  "human_action"
] as const satisfies readonly AssistanceMode[];

export const ASSISTANCE_STATUSES = [
  "queued",
  "claimed",
  "processing",
  "awaiting_human",
  "completed",
  "expired",
  "cancelled",
  "failed"
] as const satisfies readonly AssistanceStatus[];

export const TERMINAL_ASSISTANCE_STATUSES = [
  "completed",
  "expired",
  "cancelled",
  "failed"
] as const satisfies readonly AssistanceStatus[];

export type TerminalAssistanceStatus =
  (typeof TERMINAL_ASSISTANCE_STATUSES)[number];
export type LeaseBearingStatus = "claimed" | "processing";

export interface AssistanceLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly ownerType: "ai" | "human";
  readonly fencingToken: number;
  readonly claimedAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface AssistanceResolution<TResult> {
  readonly resolverType: "ai" | "human" | "human_ai";
  readonly resolverId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly confidence?: number;
  readonly output: TResult;
  readonly submittedAt: string;
}

interface AssistanceTaskBase<TInput> {
  readonly apiVersion: AssistanceTaskDefinition["apiVersion"];
  readonly taskId: string;
  readonly runId: string;
  readonly stepInstanceId: string;
  readonly profile: AssistanceProfileRef;
  readonly mode: AssistanceMode;
  readonly riskLevel: AssistanceRiskLevel;
  readonly revision: number;
  readonly input: TInput;
  readonly outputSchema: AssistanceTaskDefinition["outputSchema"];
  readonly policySnapshot: AssistancePolicySnapshot;
  readonly contextRefs: Readonly<AssistanceTaskDefinition["contextRefs"]>;
  readonly deadline: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fencingCounter: number;
  readonly terminalReason?: string;
}

export type QueuedAssistanceTask<TInput = unknown> =
  AssistanceTaskBase<TInput> & {
    readonly status: "queued";
  };

export type AwaitingHumanAssistanceTask<TInput = unknown> =
  AssistanceTaskBase<TInput> & {
    readonly status: "awaiting_human";
  };

export type LeaseBearingAssistanceTask<TInput = unknown> =
  AssistanceTaskBase<TInput> & {
    readonly status: LeaseBearingStatus;
    readonly lease: AssistanceLease;
  };

export type CompletedAssistanceTask<TInput = unknown, TResult = unknown> =
  AssistanceTaskBase<TInput> & {
    readonly status: "completed";
    readonly resolution: AssistanceResolution<TResult>;
  };

export type NonCompletedTerminalAssistanceTask<TInput = unknown> =
  AssistanceTaskBase<TInput> & {
    readonly status: Exclude<TerminalAssistanceStatus, "completed">;
    readonly terminalReason: string;
  };

export type AssistanceTask<TInput = unknown, TResult = unknown> =
  | QueuedAssistanceTask<TInput>
  | AwaitingHumanAssistanceTask<TInput>
  | LeaseBearingAssistanceTask<TInput>
  | CompletedAssistanceTask<TInput, TResult>
  | NonCompletedTerminalAssistanceTask<TInput>;

export interface CreateAssistanceTaskInput<TInput> {
  readonly taskId: string;
  readonly runId: string;
  readonly stepInstanceId: string;
  readonly profile: AssistanceProfileRef;
  readonly mode: AssistanceMode;
  readonly riskLevel: AssistanceRiskLevel;
  readonly input: TInput;
  readonly outputSchema: AssistanceTaskDefinition["outputSchema"];
  readonly policySnapshot: AssistancePolicySnapshot;
  readonly contextRefs?: Readonly<AssistanceTaskDefinition["contextRefs"]>;
  readonly deadline: string;
  readonly now: string;
}

export interface LeaseProof {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}

export type AssistanceTransitionError =
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "TASK_ALREADY_CLAIMED"
  | "TASK_TERMINAL"
  | "TASK_NOT_CLAIMED"
  | "LEASE_ID_MISMATCH"
  | "OWNER_MISMATCH"
  | "CLAIMANT_NOT_AUTHORIZED"
  | "FENCING_TOKEN_MISMATCH"
  | "LEASE_EXPIRED";

export type TransitionResult<T> =
  | { readonly ok: true; readonly task: T }
  | { readonly ok: false; readonly error: AssistanceTransitionError };

/**
 * Fields needed for durable lease recovery but intentionally absent from the
 * canonical public DTO.
 */
export interface AssistanceTaskPrivateState {
  readonly leaseId?: string;
  readonly claimedAt?: string;
  readonly heartbeatAt?: string;
  readonly ownerType?: "ai" | "human";
  readonly fencingCounter: number;
  readonly terminalReason?: string;
}

export interface AssistanceTaskPersistenceAggregate {
  readonly definition: AssistanceTaskDefinition;
  readonly privateState: AssistanceTaskPrivateState;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function timestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validDigestRef(ref: AssistanceProfileRef): boolean {
  return nonEmpty(ref.id) && nonEmpty(ref.version) && nonEmpty(ref.digest);
}

function freezeProfile(ref: AssistanceProfileRef): AssistanceProfileRef {
  return Object.freeze({ ...ref });
}

function freezePolicy(
  policy: AssistancePolicySnapshot
): AssistancePolicySnapshot {
  return Object.freeze({
    ...policy,
    ...(policy.deterministicValidator
      ? {
          deterministicValidator: Object.freeze({
            ...policy.deterministicValidator
          })
        }
      : {})
  });
}

function freezeTask<T>(task: T): T {
  const domainTask = task as AssistanceTask;
  Object.freeze(domainTask.profile);
  Object.freeze(domainTask.outputSchema);
  Object.freeze(domainTask.policySnapshot);
  Object.freeze(domainTask.contextRefs);
  for (const ref of domainTask.contextRefs) Object.freeze(ref);
  if ("lease" in domainTask) Object.freeze(domainTask.lease);
  if ("resolution" in domainTask) Object.freeze(domainTask.resolution);
  return Object.freeze(task);
}

function nextBase<TInput>(
  task: AssistanceTask<TInput, unknown>,
  now: string
): AssistanceTaskBase<TInput> {
  return {
    apiVersion: task.apiVersion,
    taskId: task.taskId,
    runId: task.runId,
    stepInstanceId: task.stepInstanceId,
    profile: task.profile,
    mode: task.mode,
    riskLevel: task.riskLevel,
    revision: task.revision + 1,
    input: task.input,
    outputSchema: task.outputSchema,
    policySnapshot: task.policySnapshot,
    contextRefs: task.contextRefs,
    deadline: task.deadline,
    createdAt: task.createdAt,
    updatedAt: now,
    fencingCounter: task.fencingCounter
  };
}

export function createAssistanceTask<TInput>(
  input: CreateAssistanceTaskInput<TInput>
): QueuedAssistanceTask<TInput> {
  const now = timestampMs(input.now);
  const deadline = timestampMs(input.deadline);
  if (
    !nonEmpty(input.taskId) ||
    !nonEmpty(input.runId) ||
    !nonEmpty(input.stepInstanceId) ||
    !validDigestRef(input.profile) ||
    now === undefined ||
    deadline === undefined ||
    deadline <= now
  ) {
    throw new Error("Assistance task identity, profile, or timing is invalid");
  }
  const contextRefs = (input.contextRefs ?? []).map((ref) =>
    Object.freeze({ ...ref })
  );
  return freezeTask({
    apiVersion: "bpa.assistance/v1alpha1",
    taskId: input.taskId,
    runId: input.runId,
    stepInstanceId: input.stepInstanceId,
    profile: freezeProfile(input.profile),
    mode: input.mode,
    riskLevel: input.riskLevel,
    revision: 0,
    input: input.input,
    outputSchema: Object.freeze({ ...input.outputSchema }),
    policySnapshot: freezePolicy(input.policySnapshot),
    contextRefs: Object.freeze(contextRefs),
    deadline: input.deadline,
    createdAt: input.now,
    updatedAt: input.now,
    fencingCounter: 0,
    status: "queued"
  });
}

function terminal(task: AssistanceTask): boolean {
  return TERMINAL_ASSISTANCE_STATUSES.includes(
    task.status as TerminalAssistanceStatus
  );
}

export function claimAssistanceTask<TInput, TResult>(
  task: AssistanceTask<TInput, TResult>,
  input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly ownerType: "ai" | "human";
    readonly now: string;
    readonly leaseDurationMs: number;
  }
): TransitionResult<LeaseBearingAssistanceTask<TInput>> {
  const now = timestampMs(input.now);
  if (
    !nonEmpty(input.leaseId) ||
    !nonEmpty(input.ownerId) ||
    now === undefined ||
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  if (
    input.ownerType === "ai" &&
    (task.status === "awaiting_human" ||
      task.mode === "human_confirm" ||
      task.mode === "human_action")
  ) {
    return { ok: false, error: "CLAIMANT_NOT_AUTHORIZED" };
  }
  if (terminal(task)) return { ok: false, error: "TASK_TERMINAL" };
  if (
    (task.status === "claimed" || task.status === "processing") &&
    now < (timestampMs(task.lease.expiresAt) ?? Number.POSITIVE_INFINITY)
  ) {
    return { ok: false, error: "TASK_ALREADY_CLAIMED" };
  }
  if (
    task.status !== "queued" &&
    task.status !== "awaiting_human" &&
    task.status !== "claimed" &&
    task.status !== "processing"
  ) {
    return { ok: false, error: "INVALID_TRANSITION" };
  }
  const fencingToken = task.fencingCounter + 1;
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      fencingCounter: fencingToken,
      status: "claimed",
      lease: {
        leaseId: input.leaseId,
        ownerId: input.ownerId,
        ownerType: input.ownerType,
        fencingToken,
        claimedAt: input.now,
        heartbeatAt: input.now,
        expiresAt: new Date(now + input.leaseDurationMs).toISOString()
      }
    })
  };
}

function validateLease<TInput>(
  task: AssistanceTask<TInput, unknown>,
  proof: LeaseProof,
  nowValue: string
): AssistanceTransitionError | undefined {
  const now = timestampMs(nowValue);
  if (
    !nonEmpty(proof.leaseId) ||
    !nonEmpty(proof.ownerId) ||
    !Number.isSafeInteger(proof.fencingToken) ||
    proof.fencingToken <= 0 ||
    now === undefined
  ) {
    return "INVALID_INPUT";
  }
  if (terminal(task)) return "TASK_TERMINAL";
  if (task.status !== "claimed" && task.status !== "processing") {
    return "TASK_NOT_CLAIMED";
  }
  if (proof.fencingToken !== task.lease.fencingToken) {
    return "FENCING_TOKEN_MISMATCH";
  }
  if (proof.leaseId !== task.lease.leaseId) return "LEASE_ID_MISMATCH";
  if (proof.ownerId !== task.lease.ownerId) return "OWNER_MISMATCH";
  if (now >= (timestampMs(task.lease.expiresAt) ?? 0)) return "LEASE_EXPIRED";
  return undefined;
}

export function startAssistanceProcessing<TInput>(
  task: AssistanceTask<TInput, unknown>,
  input: LeaseProof & { readonly now: string }
): TransitionResult<LeaseBearingAssistanceTask<TInput>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (task.status !== "claimed") {
    return { ok: false, error: "INVALID_TRANSITION" };
  }
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: "processing",
      lease: task.lease
    })
  };
}

export function heartbeatAssistanceTask<TInput>(
  task: AssistanceTask<TInput, unknown>,
  input: LeaseProof & {
    readonly now: string;
    readonly leaseDurationMs: number;
  }
): TransitionResult<LeaseBearingAssistanceTask<TInput>> {
  if (
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (task.status !== "claimed" && task.status !== "processing") {
    return { ok: false, error: "TASK_NOT_CLAIMED" };
  }
  const now = timestampMs(input.now);
  if (now === undefined) return { ok: false, error: "INVALID_INPUT" };
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: task.status,
      lease: {
        ...task.lease,
        heartbeatAt: input.now,
        expiresAt: new Date(now + input.leaseDurationMs).toISOString()
      }
    })
  };
}

export function releaseAssistanceTask<TInput>(
  task: AssistanceTask<TInput, unknown>,
  input: LeaseProof & { readonly now: string }
): TransitionResult<QueuedAssistanceTask<TInput>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: "queued"
    })
  };
}

export function awaitHumanAssistanceTask<TInput>(
  task: AssistanceTask<TInput, unknown>,
  input: LeaseProof & { readonly now: string }
): TransitionResult<AwaitingHumanAssistanceTask<TInput>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (task.status !== "processing") {
    return { ok: false, error: "INVALID_TRANSITION" };
  }
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: "awaiting_human"
    })
  };
}

export function submitAssistanceTask<TInput, TResult>(
  task: AssistanceTask<TInput, unknown>,
  input: LeaseProof & {
    readonly now: string;
    readonly output: TResult;
    readonly resolverType: AssistanceResolution<TResult>["resolverType"];
    readonly resolverId: string;
    readonly provider?: string;
    readonly model?: string;
    readonly confidence?: number;
  }
): TransitionResult<CompletedAssistanceTask<TInput, TResult>> {
  const error = validateLease(task, input, input.now);
  if (error) return { ok: false, error };
  if (
    !nonEmpty(input.resolverId) ||
    input.resolverId !== input.ownerId ||
    ((task.status === "claimed" || task.status === "processing") &&
      ((task.lease.ownerType === "ai" && input.resolverType !== "ai") ||
        (task.lease.ownerType === "human" && input.resolverType === "ai"))) ||
    (input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1))
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: "completed",
      resolution: {
        resolverType: input.resolverType,
        resolverId: input.resolverId,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.confidence === undefined
          ? {}
          : { confidence: input.confidence }),
        output: input.output,
        submittedAt: input.now
      }
    })
  };
}

export function terminateAssistanceTask<TInput>(
  task: AssistanceTask<TInput, unknown>,
  input: {
    readonly status: Exclude<TerminalAssistanceStatus, "completed">;
    readonly reason: string;
    readonly now: string;
  }
): TransitionResult<NonCompletedTerminalAssistanceTask<TInput>> {
  if (
    terminal(task) ||
    !nonEmpty(input.reason) ||
    timestampMs(input.now) === undefined
  ) {
    return {
      ok: false,
      error: terminal(task) ? "TASK_TERMINAL" : "INVALID_INPUT"
    };
  }
  return {
    ok: true,
    task: freezeTask({
      ...nextBase(task, input.now),
      status: input.status,
      terminalReason: input.reason
    })
  };
}

function resolutionDto(
  resolution: AssistanceResolution<unknown>
): NonNullable<AssistanceTaskDefinition["resolution"]> {
  return {
    resolverType: resolution.resolverType,
    resolverId: resolution.resolverId,
    ...(resolution.provider === undefined
      ? {}
      : { provider: resolution.provider }),
    ...(resolution.model === undefined ? {} : { model: resolution.model }),
    ...(resolution.confidence === undefined
      ? {}
      : { confidence: resolution.confidence }),
    output: resolution.output,
    submittedAt: resolution.submittedAt
  };
}

export function toAssistanceTaskDefinition(
  task: AssistanceTask
): AssistanceTaskDefinition {
  const definition: AssistanceTaskDefinition = {
    apiVersion: task.apiVersion,
    taskId: task.taskId,
    runId: task.runId,
    stepInstanceId: task.stepInstanceId,
    profile: { ...task.profile },
    mode: task.mode,
    riskLevel: task.riskLevel,
    status: task.status,
    revision: task.revision,
    input: task.input,
    outputSchema: { ...task.outputSchema },
    policySnapshot: {
      ...task.policySnapshot,
      ...(task.policySnapshot.deterministicValidator
        ? {
            deterministicValidator: {
              ...task.policySnapshot.deterministicValidator
            }
          }
        : {})
    },
    contextRefs: task.contextRefs.map((ref) => ({ ...ref })),
    deadline: task.deadline,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
  if (task.status === "claimed" || task.status === "processing") {
    definition.lease = {
      ownerId: task.lease.ownerId,
      fencingToken: task.lease.fencingToken,
      expiresAt: task.lease.expiresAt
    };
  }
  if ("resolution" in task && task.resolution) {
    definition.resolution = resolutionDto(task.resolution);
  }
  return definition;
}

export function toAssistanceTaskPersistenceAggregate(
  task: AssistanceTask
): AssistanceTaskPersistenceAggregate {
  return {
    definition: toAssistanceTaskDefinition(task),
    privateState: {
      fencingCounter: task.fencingCounter,
      ...("lease" in task
        ? {
            leaseId: task.lease.leaseId,
            claimedAt: task.lease.claimedAt,
            heartbeatAt: task.lease.heartbeatAt,
            ownerType: task.lease.ownerType
          }
        : {}),
      ...(task.terminalReason === undefined
        ? {}
        : { terminalReason: task.terminalReason })
    }
  };
}

export function fromAssistanceTaskPersistenceAggregate(
  persisted: AssistanceTaskPersistenceAggregate
): AssistanceTask {
  const dto = persisted.definition;
  const common: AssistanceTaskBase<unknown> = {
    apiVersion: dto.apiVersion,
    taskId: dto.taskId,
    runId: dto.runId,
    stepInstanceId: dto.stepInstanceId,
    profile: freezeProfile(dto.profile),
    mode: dto.mode,
    riskLevel: dto.riskLevel,
    revision: dto.revision,
    input: dto.input,
    outputSchema: Object.freeze({ ...dto.outputSchema }),
    policySnapshot: freezePolicy(dto.policySnapshot),
    contextRefs: Object.freeze(
      dto.contextRefs.map((ref) => Object.freeze({ ...ref }))
    ),
    deadline: dto.deadline,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    fencingCounter: persisted.privateState.fencingCounter,
    ...(persisted.privateState.terminalReason === undefined
      ? {}
      : { terminalReason: persisted.privateState.terminalReason })
  };
  if (dto.status === "claimed" || dto.status === "processing") {
    if (
      !dto.lease ||
      !persisted.privateState.leaseId ||
      !persisted.privateState.claimedAt ||
      !persisted.privateState.heartbeatAt ||
      !persisted.privateState.ownerType
    ) {
      throw new Error("Lease-bearing task is missing private lease state");
    }
    return freezeTask({
      ...common,
      status: dto.status,
      lease: {
        leaseId: persisted.privateState.leaseId,
        ownerId: dto.lease.ownerId,
        ownerType: persisted.privateState.ownerType,
        fencingToken: dto.lease.fencingToken,
        claimedAt: persisted.privateState.claimedAt,
        heartbeatAt: persisted.privateState.heartbeatAt,
        expiresAt: dto.lease.expiresAt
      }
    });
  }
  if (dto.status === "completed") {
    if (!dto.resolution) {
      throw new Error("Completed task is missing its resolution");
    }
    return freezeTask({
      ...common,
      status: "completed",
      resolution: { ...dto.resolution }
    });
  }
  if (
    dto.status === "expired" ||
    dto.status === "cancelled" ||
    dto.status === "failed"
  ) {
    if (!persisted.privateState.terminalReason) {
      throw new Error("Terminal task is missing its private reason");
    }
    return freezeTask({
      ...common,
      status: dto.status,
      terminalReason: persisted.privateState.terminalReason
    });
  }
  return freezeTask({ ...common, status: dto.status });
}

export type AutoContinueReason =
  | "R0_POLICY_APPROVED"
  | "R1_POLICY_APPROVED_AND_VALIDATED"
  | "MODE_REQUIRES_HUMAN"
  | "PROFILE_NOT_PUBLISHED"
  | "POLICY_AUTO_CONTINUE_DISABLED"
  | "DURABLE_DECISION_REQUIRES_HUMAN"
  | "R1_PROFILE_NOT_APPROVED"
  | "R1_VALIDATOR_NOT_CONFIGURED"
  | "R1_RESULT_VALIDATION_REQUIRED"
  | "R2_PLUS_REQUIRES_HUMAN";

export type AutoContinueDecision =
  | { readonly allowed: true; readonly reason: AutoContinueReason }
  | { readonly allowed: false; readonly reason: AutoContinueReason };

export function evaluateAutoContinue(input: {
  readonly mode: AssistanceMode;
  readonly riskLevel: AssistanceRiskLevel;
  readonly profilePublished: boolean;
  readonly policySnapshot: AssistancePolicySnapshot;
  readonly deterministicResultValid: boolean;
  readonly confidence?: number;
}): AutoContinueDecision {
  if (input.mode !== "ai_review") {
    return { allowed: false, reason: "MODE_REQUIRES_HUMAN" };
  }
  if (input.policySnapshot.durableDecision) {
    return { allowed: false, reason: "DURABLE_DECISION_REQUIRES_HUMAN" };
  }
  if (!input.policySnapshot.autoContinue) {
    return { allowed: false, reason: "POLICY_AUTO_CONTINUE_DISABLED" };
  }
  if (!input.profilePublished) {
    return { allowed: false, reason: "PROFILE_NOT_PUBLISHED" };
  }
  if (
    input.riskLevel === "R2" ||
    input.riskLevel === "R3" ||
    input.riskLevel === "R4"
  ) {
    return { allowed: false, reason: "R2_PLUS_REQUIRES_HUMAN" };
  }
  if (input.riskLevel === "R0") {
    return { allowed: true, reason: "R0_POLICY_APPROVED" };
  }
  if (!input.policySnapshot.r1ProfileApproved) {
    return { allowed: false, reason: "R1_PROFILE_NOT_APPROVED" };
  }
  if (!input.policySnapshot.deterministicValidator) {
    return { allowed: false, reason: "R1_VALIDATOR_NOT_CONFIGURED" };
  }
  if (!input.deterministicResultValid) {
    return { allowed: false, reason: "R1_RESULT_VALIDATION_REQUIRED" };
  }
  return {
    allowed: true,
    reason: "R1_POLICY_APPROVED_AND_VALIDATED"
  };
}
