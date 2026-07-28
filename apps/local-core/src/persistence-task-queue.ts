import {
  fromAssistanceTaskPersistenceAggregate,
  toAssistanceTaskPersistenceAggregate,
  type AssistanceTask,
  type TaskQueueCommitResult,
  type TaskQueueFilter,
  type TaskQueuePort
} from "@bpa/assistance-core";
import type {
  AssistanceTaskRecord,
  Persistence
} from "@bpa/persistence";
import type { Ir2WorkflowRuntime } from "./ir2-workflow-runtime.js";

function domainTask(record: AssistanceTaskRecord): AssistanceTask {
  return fromAssistanceTaskPersistenceAggregate({
    definition: record.task,
    privateState: record.privateState
  });
}

function persistenceTask(task: AssistanceTask): AssistanceTaskRecord {
  const aggregate = toAssistanceTaskPersistenceAggregate(task);
  return {
    task: aggregate.definition,
    privateState: aggregate.privateState,
    fencingCounter: aggregate.privateState.fencingCounter
  };
}

/**
 * Adapts the synchronous Core persistence boundary to the provider-neutral
 * Assistance service. Engine-owned tasks are created by the Engine UoW; this
 * adapter only performs durable lease and completion transitions.
 */
export class PersistenceTaskQueue implements TaskQueuePort {
  constructor(
    readonly persistence: Persistence,
    readonly runtime: Ir2WorkflowRuntime
  ) {}

  async list(filter: TaskQueueFilter): Promise<AssistanceTask[]> {
    return this.persistence.listAssistanceTasks(filter).map(domainTask);
  }

  async get(taskId: string): Promise<AssistanceTask | undefined> {
    const task = this.persistence.getAssistanceTask(taskId);
    return task ? domainTask(task) : undefined;
  }

  async getRequestResult(
    requestId: string
  ): Promise<AssistanceTask | undefined> {
    const task = this.persistence.getAssistanceRequestResult(requestId);
    return task ? domainTask(task) : undefined;
  }

  async create(
    task: AssistanceTask,
    _requestId: string
  ): Promise<TaskQueueCommitResult> {
    const current = await this.get(task.taskId);
    if (current) return { status: "conflict", current };
    throw new Error(
      "Core assistance tasks must be created by a recoverable Engine transition"
    );
  }

  async compareAndSet(input: {
    taskId: string;
    expectedRevision: number;
    requestId: string;
    next: AssistanceTask;
    wakeRun?: boolean;
  }): Promise<TaskQueueCommitResult> {
    const duplicate = this.persistence.getAssistanceRequestResult(
      input.requestId
    );
    if (duplicate) {
      return { status: "duplicate", task: domainTask(duplicate) };
    }
    const current = this.persistence.getAssistanceTask(input.taskId);
    if (!current || current.task.revision !== input.expectedRevision) {
      return {
        status: "conflict",
        ...(current ? { current: domainTask(current) } : {})
      };
    }
    const next = persistenceTask(input.next);
    const committed = this.runtime.commitAssistanceTask({
      requestId: input.requestId,
      task: next,
      expectedRevision: input.expectedRevision,
      expectedFencingCounter: current.fencingCounter,
      wakeRun: input.wakeRun === true
    });
    if (committed.status === "accepted") {
      return { status: "saved", task: domainTask(committed.task) };
    }
    if (committed.status === "duplicate") {
      return { status: "duplicate", task: domainTask(committed.task) };
    }
    const latest = this.persistence.getAssistanceTask(input.taskId);
    return {
      status: "conflict",
      ...(latest ? { current: domainTask(latest) } : {})
    };
  }
}
