import {
  claimAssistanceTask,
  evaluateAutoContinue,
  heartbeatAssistanceTask,
  releaseAssistanceTask,
  startAssistanceProcessing,
  submitAssistanceTask,
  type AssistanceTask,
  type AssistanceTransitionError,
  type AutoContinueDecision,
  type LeaseProof,
  type TransitionResult
} from "./index.js";

export interface TaskQueueFilter {
  statuses?: ReadonlyArray<AssistanceTask["status"]>;
  modes?: ReadonlyArray<AssistanceTask["mode"]>;
  ownerType?: "ai" | "human";
  limit?: number;
}

export type TaskQueueCommitResult =
  | { status: "saved"; task: AssistanceTask }
  | { status: "duplicate"; task: AssistanceTask }
  | { status: "conflict"; current?: AssistanceTask };

/**
 * Provider-neutral persistence boundary. Implementations may use SQLite,
 * Postgres, or a remote queue, but must atomically combine revision CAS and
 * request-id deduplication.
 */
export interface TaskQueuePort {
  list(filter: TaskQueueFilter): Promise<AssistanceTask[]>;
  get(taskId: string): Promise<AssistanceTask | undefined>;
  getRequestResult(requestId: string): Promise<AssistanceTask | undefined>;
  create(task: AssistanceTask, requestId: string): Promise<TaskQueueCommitResult>;
  compareAndSet(input: {
    taskId: string;
    expectedRevision: number;
    requestId: string;
    next: AssistanceTask;
  }): Promise<TaskQueueCommitResult>;
}

export interface OutputSchemaValidation {
  valid: boolean;
  errors: string[];
}

export interface AssistanceResultValidator {
  validateOutput(
    schema: Readonly<Record<string, unknown>>,
    output: unknown
  ): OutputSchemaValidation;
  validateDeterministicResult(
    task: AssistanceTask,
    output: unknown
  ): OutputSchemaValidation;
}

export interface AssistanceServiceDependencies {
  queue: TaskQueuePort;
  validator: AssistanceResultValidator;
  profilePublished(
    profile: AssistanceTask["profile"]
  ): boolean | Promise<boolean>;
}

export type AssistanceServiceError =
  | AssistanceTransitionError
  | "TASK_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "OUTPUT_SCHEMA_INVALID";

export type AssistanceServiceResult<T = AssistanceTask> =
  | {
      ok: true;
      task: T;
      duplicate: boolean;
      autoContinue?: AutoContinueDecision;
    }
  | {
      ok: false;
      error: AssistanceServiceError;
      validationErrors?: string[];
      current?: AssistanceTask;
    };

function validRequestId(requestId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId);
}

export class AssistanceTaskService {
  readonly #queue: TaskQueuePort;
  readonly #validator: AssistanceResultValidator;
  readonly #profilePublished: AssistanceServiceDependencies["profilePublished"];

  constructor(dependencies: AssistanceServiceDependencies) {
    this.#queue = dependencies.queue;
    this.#validator = dependencies.validator;
    this.#profilePublished = dependencies.profilePublished;
  }

  list(filter: TaskQueueFilter = {}): Promise<AssistanceTask[]> {
    return this.#queue.list(filter);
  }

  async #apply<T extends AssistanceTask>(input: {
    taskId: string;
    requestId: string;
    transition(task: AssistanceTask): TransitionResult<T>;
  }): Promise<AssistanceServiceResult<T>> {
    if (!validRequestId(input.requestId)) {
      return { ok: false, error: "INVALID_INPUT" };
    }
    const duplicate = await this.#queue.getRequestResult(input.requestId);
    if (duplicate) {
      return {
        ok: true,
        task: duplicate as T,
        duplicate: true
      };
    }
    const current = await this.#queue.get(input.taskId);
    if (!current) return { ok: false, error: "TASK_NOT_FOUND" };
    const transitioned = input.transition(current);
    if (!transitioned.ok) return transitioned;
    const committed = await this.#queue.compareAndSet({
      taskId: current.taskId,
      expectedRevision: current.revision,
      requestId: input.requestId,
      next: transitioned.task
    });
    if (committed.status === "conflict") {
      return {
        ok: false,
        error: "REVISION_CONFLICT",
        ...(committed.current ? { current: committed.current } : {})
      };
    }
    return {
      ok: true,
      task: committed.task as T,
      duplicate: committed.status === "duplicate"
    };
  }

  claim(input: {
    taskId: string;
    requestId: string;
    leaseId: string;
    actorId: string;
    actorType: "ai" | "human";
    now: string;
    leaseDurationMs: number;
  }) {
    return this.#apply({
      taskId: input.taskId,
      requestId: input.requestId,
      transition: (task) =>
        claimAssistanceTask(task, {
          leaseId: input.leaseId,
          ownerId: input.actorId,
          ownerType: input.actorType,
          now: input.now,
          leaseDurationMs: input.leaseDurationMs
        })
    });
  }

  start(input: {
    taskId: string;
    requestId: string;
    proof: LeaseProof;
    now: string;
  }) {
    return this.#apply({
      taskId: input.taskId,
      requestId: input.requestId,
      transition: (task) =>
        startAssistanceProcessing(task, { ...input.proof, now: input.now })
    });
  }

  heartbeat(input: {
    taskId: string;
    requestId: string;
    proof: LeaseProof;
    now: string;
    leaseDurationMs: number;
  }) {
    return this.#apply({
      taskId: input.taskId,
      requestId: input.requestId,
      transition: (task) =>
        heartbeatAssistanceTask(task, {
          ...input.proof,
          now: input.now,
          leaseDurationMs: input.leaseDurationMs
        })
    });
  }

  release(input: {
    taskId: string;
    requestId: string;
    proof: LeaseProof;
    now: string;
  }) {
    return this.#apply({
      taskId: input.taskId,
      requestId: input.requestId,
      transition: (task) =>
        releaseAssistanceTask(task, { ...input.proof, now: input.now })
    });
  }

  async submit(input: {
    taskId: string;
    requestId: string;
    proof: LeaseProof;
    now: string;
    output: unknown;
    resolverType: "ai" | "human" | "human_ai";
    resolverId: string;
    provider?: string;
    model?: string;
    confidence?: number;
  }): Promise<AssistanceServiceResult> {
    if (!validRequestId(input.requestId)) {
      return { ok: false, error: "INVALID_INPUT" };
    }
    const duplicate = await this.#queue.getRequestResult(input.requestId);
    if (duplicate) {
      return { ok: true, task: duplicate, duplicate: true };
    }
    const current = await this.#queue.get(input.taskId);
    if (!current) return { ok: false, error: "TASK_NOT_FOUND" };
    const outputValidation = this.#validator.validateOutput(
      current.outputSchema,
      input.output
    );
    if (!outputValidation.valid) {
      return {
        ok: false,
        error: "OUTPUT_SCHEMA_INVALID",
        validationErrors: outputValidation.errors
      };
    }
    const transitioned = submitAssistanceTask(current, {
      ...input.proof,
      now: input.now,
      output: input.output,
      resolverType: input.resolverType,
      resolverId: input.resolverId,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.confidence === undefined
        ? {}
        : { confidence: input.confidence })
    });
    if (!transitioned.ok) return transitioned;
    const committed = await this.#queue.compareAndSet({
      taskId: current.taskId,
      expectedRevision: current.revision,
      requestId: input.requestId,
      next: transitioned.task
    });
    if (committed.status === "conflict") {
      return {
        ok: false,
        error: "REVISION_CONFLICT",
        ...(committed.current ? { current: committed.current } : {})
      };
    }
    const deterministicValidation =
      this.#validator.validateDeterministicResult(current, input.output);
    const autoContinue = evaluateAutoContinue({
      mode: current.mode,
      riskLevel: current.riskLevel,
      profilePublished: await this.#profilePublished(current.profile),
      policySnapshot: current.policySnapshot,
      deterministicResultValid: deterministicValidation.valid,
      ...(input.confidence === undefined
        ? {}
        : { confidence: input.confidence })
    });
    return {
      ok: true,
      task: committed.task,
      duplicate: committed.status === "duplicate",
      autoContinue
    };
  }
}

export class MemoryTaskQueue implements TaskQueuePort {
  readonly #tasks = new Map<string, AssistanceTask>();
  readonly #requests = new Map<string, AssistanceTask>();

  async list(filter: TaskQueueFilter): Promise<AssistanceTask[]> {
    const limit = Math.max(0, Math.min(filter.limit ?? 100, 1000));
    return [...this.#tasks.values()]
      .filter(
        (task) =>
          (!filter.statuses || filter.statuses.includes(task.status)) &&
          (!filter.modes || filter.modes.includes(task.mode)) &&
          (!filter.ownerType ||
            (task.status !== "claimed" && task.status !== "processing") ||
            task.lease.ownerType === filter.ownerType)
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.taskId.localeCompare(right.taskId)
      )
      .slice(0, limit);
  }

  async get(taskId: string): Promise<AssistanceTask | undefined> {
    return this.#tasks.get(taskId);
  }

  async getRequestResult(
    requestId: string
  ): Promise<AssistanceTask | undefined> {
    return this.#requests.get(requestId);
  }

  async create(
    task: AssistanceTask,
    requestId: string
  ): Promise<TaskQueueCommitResult> {
    const duplicate = this.#requests.get(requestId);
    if (duplicate) return { status: "duplicate", task: duplicate };
    const current = this.#tasks.get(task.taskId);
    if (current) return { status: "conflict", current };
    this.#tasks.set(task.taskId, task);
    this.#requests.set(requestId, task);
    return { status: "saved", task };
  }

  async compareAndSet(input: {
    taskId: string;
    expectedRevision: number;
    requestId: string;
    next: AssistanceTask;
  }): Promise<TaskQueueCommitResult> {
    const duplicate = this.#requests.get(input.requestId);
    if (duplicate) return { status: "duplicate", task: duplicate };
    const current = this.#tasks.get(input.taskId);
    if (!current || current.revision !== input.expectedRevision) {
      return {
        status: "conflict",
        ...(current ? { current } : {})
      };
    }
    this.#tasks.set(input.taskId, input.next);
    this.#requests.set(input.requestId, input.next);
    return { status: "saved", task: input.next };
  }
}
