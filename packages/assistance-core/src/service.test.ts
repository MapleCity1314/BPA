import { describe, expect, it } from "vitest";
import {
  AssistanceTaskService,
  MemoryTaskQueue,
  claimAssistanceTask,
  createAssistanceTask,
  type AssistanceResultValidator,
  type TaskQueuePort
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-07-28T00:00:00.000Z";
const validator: AssistanceResultValidator = {
  validateOutput: (_schema, output) => ({
    valid:
      typeof output === "object" &&
      output !== null &&
      "selection" in output,
    errors:
      typeof output === "object" &&
      output !== null &&
      "selection" in output
        ? []
        : ["selection is required"]
  }),
  validateDeterministicResult: (_task, output) => ({
    valid: (output as { selection?: unknown }).selection === "record-1",
    errors: []
  })
};

function task() {
  return createAssistanceTask({
    taskId: "task-1",
    runId: "run-1",
    stepInstanceId: "step-1",
    profile: { id: "profile-1", version: "1.0.0", digest },
    mode: "ai_review",
    riskLevel: "R1",
    input: { choices: ["record-1"] },
    outputSchema: {
      type: "object",
      required: ["selection"],
      properties: { selection: { type: "string" } }
    },
    policySnapshot: {
      autoContinue: true,
      r1ProfileApproved: true,
      durableDecision: false,
      deterministicValidator: {
        id: "validator-1",
        version: "1.0.0",
        digest
      },
      onUnavailable: "continue_unresolved"
    },
    deadline: "2026-07-29T00:00:00.000Z",
    now
  });
}

async function service() {
  const queue = new MemoryTaskQueue();
  await queue.create(task(), "create-1");
  return {
    queue,
    service: new AssistanceTaskService({
      queue,
      validator,
      profilePublished: () => true
    })
  };
}

const proof = {
  leaseId: "lease-1",
  ownerId: "codex-1",
  fencingToken: 1
};

describe("provider-neutral AssistanceTaskService", () => {
  it("claims, starts, heartbeats, releases and lists without provider coupling", async () => {
    const { service: subject } = await service();
    expect(
      await subject.claim({
        taskId: "task-1",
        requestId: "claim-1",
        leaseId: proof.leaseId,
        actorId: proof.ownerId,
        actorType: "ai",
        now: "2026-07-28T00:00:01.000Z",
        leaseDurationMs: 10_000
      })
    ).toMatchObject({
      ok: true,
      task: { status: "claimed", fencingCounter: 1 }
    });
    await expect(
      subject.start({
        taskId: "task-1",
        requestId: "start-1",
        proof,
        now: "2026-07-28T00:00:02.000Z"
      })
    ).resolves.toMatchObject({ ok: true, task: { status: "processing" } });
    await expect(
      subject.heartbeat({
        taskId: "task-1",
        requestId: "heartbeat-1",
        proof,
        now: "2026-07-28T00:00:03.000Z",
        leaseDurationMs: 10_000
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      subject.release({
        taskId: "task-1",
        requestId: "release-1",
        proof,
        now: "2026-07-28T00:00:04.000Z"
      })
    ).resolves.toMatchObject({ ok: true, task: { status: "queued" } });
    await expect(subject.list({ statuses: ["queued"] })).resolves.toHaveLength(
      1
    );
  });

  it("validates output before submit and returns auto-continue decision", async () => {
    const { service: subject } = await service();
    await subject.claim({
      taskId: "task-1",
      requestId: "claim-1",
      leaseId: proof.leaseId,
      actorId: proof.ownerId,
      actorType: "ai",
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "submit-invalid",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: {},
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toEqual({
      ok: false,
      error: "OUTPUT_SCHEMA_INVALID",
      validationErrors: ["selection is required"]
    });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "submit-1",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId,
        provider: "codex",
        model: "gpt",
        confidence: 0.9
      })
    ).resolves.toMatchObject({
      ok: true,
      task: { status: "completed" },
      autoContinue: {
        allowed: true,
        reason: "R1_POLICY_APPROVED_AND_VALIDATED"
      }
    });
  });

  it("deduplicates request ids and rejects stale fencing or actor type", async () => {
    const { service: subject } = await service();
    const claim = {
      taskId: "task-1",
      requestId: "claim-1",
      leaseId: proof.leaseId,
      actorId: proof.ownerId,
      actorType: "ai" as const,
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    };
    await expect(subject.claim(claim)).resolves.toMatchObject({
      ok: true,
      duplicate: false
    });
    await expect(subject.claim(claim)).resolves.toMatchObject({
      ok: true,
      duplicate: true
    });
    await expect(
      subject.heartbeat({
        taskId: "task-1",
        requestId: "stale-heartbeat",
        proof: { ...proof, fencingToken: 2 },
        now: "2026-07-28T00:00:02.000Z",
        leaseDurationMs: 10_000
      })
    ).resolves.toEqual({
      ok: false,
      error: "FENCING_TOKEN_MISMATCH"
    });
  });

  it("surfaces CAS conflicts and missing tasks", async () => {
    const current = task();
    const conflictPort: TaskQueuePort = {
      list: async () => [],
      get: async (taskId) => (taskId === current.taskId ? current : undefined),
      getRequestResult: async () => undefined,
      create: async () => ({ status: "saved", task: current }),
      compareAndSet: async () => ({ status: "conflict", current })
    };
    const subject = new AssistanceTaskService({
      queue: conflictPort,
      validator,
      profilePublished: () => true
    });
    await expect(
      subject.claim({
        taskId: "task-1",
        requestId: "claim-1",
        leaseId: "lease",
        actorId: "actor",
        actorType: "ai",
        now: "2026-07-28T00:00:01.000Z",
        leaseDurationMs: 1000
      })
    ).resolves.toMatchObject({
      ok: false,
      error: "REVISION_CONFLICT"
    });
    await expect(
      subject.claim({
        taskId: "missing",
        requestId: "claim-2",
        leaseId: "lease",
        actorId: "actor",
        actorType: "ai",
        now: "2026-07-28T00:00:01.000Z",
        leaseDurationMs: 1000
      })
    ).resolves.toEqual({ ok: false, error: "TASK_NOT_FOUND" });
  });

  it("rejects invalid request ids and submit state conflicts", async () => {
    const { service: subject } = await service();
    await expect(
      subject.claim({
        taskId: "task-1",
        requestId: "bad request",
        leaseId: "lease",
        actorId: "actor",
        actorType: "ai",
        now: "2026-07-28T00:00:01.000Z",
        leaseDurationMs: 1000
      })
    ).resolves.toEqual({ ok: false, error: "INVALID_INPUT" });
    await expect(
      subject.submit({
        taskId: "missing",
        requestId: "missing-submit",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toEqual({ ok: false, error: "TASK_NOT_FOUND" });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "unclaimed-submit",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toEqual({ ok: false, error: "TASK_NOT_CLAIMED" });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "bad request",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toEqual({ ok: false, error: "INVALID_INPUT" });
  });

  it("covers queue create/CAS conflicts and duplicate submit replay", async () => {
    const queue = new MemoryTaskQueue();
    const initial = task();
    await expect(queue.create(initial, "create-1")).resolves.toMatchObject({
      status: "saved"
    });
    await expect(queue.create(initial, "create-1")).resolves.toMatchObject({
      status: "duplicate"
    });
    await expect(queue.create(initial, "create-2")).resolves.toMatchObject({
      status: "conflict"
    });
    await expect(
      queue.compareAndSet({
        taskId: "missing",
        expectedRevision: 0,
        requestId: "missing-cas",
        next: initial
      })
    ).resolves.toEqual({ status: "conflict" });

    const subject = new AssistanceTaskService({
      queue,
      validator,
      profilePublished: () => true
    });
    await subject.claim({
      taskId: "task-1",
      requestId: "claim-1",
      leaseId: proof.leaseId,
      actorId: proof.ownerId,
      actorType: "ai",
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    });
    const submit = {
      taskId: "task-1",
      requestId: "submit-1",
      proof,
      now: "2026-07-28T00:00:02.000Z",
      output: { selection: "record-1" },
      resolverType: "ai" as const,
      resolverId: proof.ownerId
    };
    await expect(subject.submit(submit)).resolves.toMatchObject({
      ok: true,
      duplicate: false
    });
    await expect(subject.submit(submit)).resolves.toMatchObject({
      ok: true,
      duplicate: true
    });
    await expect(subject.submit(submit)).resolves.not.toHaveProperty(
      "autoContinue"
    );
  });

  it("safely denies auto-continue when validation dependencies fail before commit", async () => {
    const queue = new MemoryTaskQueue();
    await queue.create(task(), "create-1");
    let committedRunOutcome:
      | { status: "resolved" | "escalated"; reason: string }
      | undefined;
    const observingQueue: TaskQueuePort = {
      list: (filter) => queue.list(filter),
      get: (taskId) => queue.get(taskId),
      getRequestResult: (requestId) =>
        queue.getRequestResult(requestId),
      create: (next, requestId) => queue.create(next, requestId),
      compareAndSet: (input) => {
        committedRunOutcome = input.runOutcome;
        return queue.compareAndSet(input);
      }
    };
    const subject = new AssistanceTaskService({
      queue: observingQueue,
      validator: {
        ...validator,
        validateDeterministicResult: () => {
          throw new Error("validator unavailable");
        }
      },
      profilePublished: () => {
        throw new Error("catalog unavailable");
      }
    });
    await subject.claim({
      taskId: "task-1",
      requestId: "claim-1",
      leaseId: proof.leaseId,
      actorId: proof.ownerId,
      actorType: "ai",
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "submit-safe-deny",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toMatchObject({
      ok: true,
      task: { status: "completed" },
      autoContinue: {
        allowed: false,
        reason: "PROFILE_NOT_PUBLISHED"
      }
    });
    await expect(queue.get("task-1")).resolves.toMatchObject({
      status: "completed"
    });
    expect(committedRunOutcome).toEqual({
      status: "escalated",
      reason: "PROFILE_NOT_PUBLISHED"
    });
  });

  it("surfaces a submit CAS conflict and applies queue filters deterministically", async () => {
    const claimed = claimAssistanceTask(task(), {
      leaseId: proof.leaseId,
      ownerId: proof.ownerId,
      ownerType: "ai",
      now: "2026-07-28T00:00:01.000Z",
      leaseDurationMs: 10_000
    });
    if (!claimed.ok) throw new Error(claimed.error);
    const conflictPort: TaskQueuePort = {
      list: async () => [],
      get: async () => claimed.task,
      getRequestResult: async () => undefined,
      create: async () => ({ status: "saved", task: claimed.task }),
      compareAndSet: async () => ({
        status: "conflict",
        current: claimed.task
      })
    };
    const subject = new AssistanceTaskService({
      queue: conflictPort,
      validator,
      profilePublished: () => true
    });
    await expect(
      subject.submit({
        taskId: "task-1",
        requestId: "submit-conflict",
        proof,
        now: "2026-07-28T00:00:02.000Z",
        output: { selection: "record-1" },
        resolverType: "ai",
        resolverId: proof.ownerId
      })
    ).resolves.toMatchObject({
      ok: false,
      error: "REVISION_CONFLICT"
    });

    const queue = new MemoryTaskQueue();
    await queue.create(task(), "create-a");
    const second = createAssistanceTask({
      ...task(),
      taskId: "task-2",
      now,
      deadline: "2026-07-29T00:00:00.000Z"
    });
    await queue.create(second, "create-b");
    await expect(
      queue.list({
        statuses: ["queued"],
        modes: ["ai_review"],
        ownerType: "human",
        limit: 1
      })
    ).resolves.toEqual([task()]);
  });
});
