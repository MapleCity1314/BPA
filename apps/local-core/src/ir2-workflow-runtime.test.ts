import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimAssistanceTask,
  fromAssistanceTaskPersistenceAggregate,
  releaseAssistanceTask,
  submitAssistanceTask,
  toAssistanceTaskPersistenceAggregate,
  type AssistanceTask
} from "@bpa/assistance-core";
import {
  BuiltinRuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeInvocation,
  type RuntimeProvider
} from "@bpa/node-runtime";
import { contentDigest } from "@bpa/compiler";
import type { EngineState, TimerRequest } from "@bpa/engine";
import type { AssistanceTaskRecord } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type {
  ArtifactRef,
  ExecutionPlan,
  JsonValue,
  ResourceBindingSnapshot,
  RuntimeNodeSchemaContract
} from "@bpa/workflow-ir";
import type { NodeDefinition } from "@bpa/schemas";
import { Ir2WorkflowRuntime } from "./ir2-workflow-runtime.js";

const digest = (character: string): string => character.repeat(64);
const node: ArtifactRef & { kind: "node" } = {
  kind: "node",
  id: "data.constant",
  version: "1.0.0",
  digest: digest("a")
};

const validInputSchema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: {
    value: {
      type: "object",
      required: ["recovered"],
      properties: { recovered: { type: "boolean" } }
    }
  }
} as const;
const validOutputSchema = {
  type: "object",
  required: ["recovered"],
  additionalProperties: false,
  properties: { recovered: { type: "boolean" } }
} as const;

function contract(
  inputSchema: Readonly<Record<string, JsonValue>> = validInputSchema,
  outputSchema: Readonly<Record<string, JsonValue>> = validOutputSchema
): RuntimeNodeSchemaContract {
  return {
    nodeDigest: node.digest,
    inputSchema,
    inputSchemaDigest: contentDigest(inputSchema),
    outputSchema,
    outputSchemaDigest: contentDigest(outputSchema)
  };
}

function plan(
  providerId = "builtin",
  options: {
    schemaContract?: RuntimeNodeSchemaContract;
    maxAttempts?: number;
  } = {}
): ExecutionPlan {
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
        schemaContract: options.schemaContract ?? contract(),
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
          maxAttempts: options.maxAttempts ?? 1,
          retryableOutcomes: ["failed"],
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

const browserRequirement = {
  kind: "browser" as const,
  capabilities: ["browser.dom.read"],
  allowedOrigins: ["https://www.chanmama.com"],
  authentication: "authenticated" as const,
  purpose: "Read authenticated metrics"
};

function resourcePlan(): ExecutionPlan {
  const current = plan("browser");
  const call = current.steps.constant;
  if (call?.kind !== "call") throw new Error("fixture changed");
  return {
    ...current,
    resourceSlots: {
      metrics_source: browserRequirement
    },
    steps: {
      ...current.steps,
      constant: {
        ...call,
        permissionSnapshot: {
          riskLevel: "R1",
          permissions: ["browser.dom.read"],
          domains: ["https://www.chanmama.com"]
        },
        resourceRequirements: {
          page_session: browserRequirement
        },
        resourceMappings: {
          page_session: {
            requirementName: "page_session",
            slotName: "metrics_source",
            requirement: browserRequirement,
            requirementDigest: contentDigest(browserRequirement)
          }
        }
      }
    }
  };
}

function resourceBindingSnapshot(runId: string): ResourceBindingSnapshot {
  return {
    snapshotVersion: "bpa.resource-binding/1",
    runId,
    resourceSlots: {
      metrics_source: browserRequirement
    },
    bindings: {
      metrics_source: {
        bindingId: "binding-1",
        revision: 1,
        slotName: "metrics_source",
        sessionId: "session-1",
        capabilityDigest: digest("6"),
        origin: "https://www.chanmama.com",
        authentication: "authenticated",
        frozenAt: 900,
        approvedBy: "user:test"
      }
    }
  };
}

const legacyNodeDefinition: NodeDefinition = {
  apiVersion: "bpa/v1alpha1",
  kind: "Node",
  metadata: {
    id: "data.constant",
    version: "1.0.0",
    title: "Legacy constant"
  },
  runtime: "engine_builtin",
  inputSchema: validInputSchema,
  outputSchema: validOutputSchema,
  risk: { level: "R0", permissions: [] },
  execution: {
    timeoutDefault: "1s",
    idempotency: "pure",
    cancellable: true
  },
  errors: []
};

function legacyPlan(providerId = "builtin"): ExecutionPlan {
  const current = plan(providerId);
  const call = current.steps.constant;
  if (call?.kind !== "call") throw new Error("fixture changed");
  const { schemaContract: _schemaContract, ...legacyCall } = call;
  const legacyNode = {
    kind: "node" as const,
    id: legacyNodeDefinition.metadata.id,
    version: legacyNodeDefinition.metadata.version,
    digest: contentDigest(legacyNodeDefinition)
  };
  return {
    ...current,
    artifactClosure: { entries: [legacyNode] },
    steps: {
      ...current.steps,
      constant: { ...legacyCall, node: legacyNode }
    }
  };
}

function ids() {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function taskRecord(task: AssistanceTask): AssistanceTaskRecord {
  const aggregate = toAssistanceTaskPersistenceAggregate(task);
  return {
    task: aggregate.definition,
    privateState: aggregate.privateState,
    fencingCounter: aggregate.privateState.fencingCounter
  };
}

const blockingProfile = {
  kind: "assistance_profile" as const,
  id: "profile.review",
  version: "1.0.0",
  digest: `sha256:${digest("c")}`
};

function blockingAssistancePlan(deadlineMs = 60_000): ExecutionPlan {
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "test.assistance",
      version: "1.0.0",
      digest: `sha256:${digest("d")}`
    },
    artifactClosure: { entries: [blockingProfile] },
    riskSnapshot: [],
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    entry: "review",
    steps: {
      review: {
        kind: "wait.assistance",
        key: "review",
        taskKind: "human_confirm",
        profile: blockingProfile,
        deadlineMs,
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
      }
    }
  };
}

function persistedTimer(persistence: SqlitePersistence): {
  outboxId: string;
  timer: TimerRequest;
} {
  const message = persistence
    .listPendingEngineOutbox()
    .find((candidate) => candidate.topic === "timer.scheduled");
  const effect = message?.payload as
    | { kind: "timer.schedule"; timer: TimerRequest }
    | undefined;
  if (!message || effect?.kind !== "timer.schedule") {
    throw new Error("Timer fixture was not persisted");
  }
  return { outboxId: message.id, timer: effect.timer };
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

  it("hydrates frozen Resource Bindings and validates them before Provider dispatch", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const providers = new RuntimeProviderRegistry();
    let observed: RuntimeInvocation | undefined;
    providers.register({
      id: "browser",
      supports: () => true,
      invoke: async (invocation) => {
        observed = invocation;
        return {
          status: "succeeded",
          output: { recovered: true },
          evidence: [],
          riskSignals: []
        };
      }
    });
    const runtime = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5,
      resolveResourceBindingSnapshot: resourceBindingSnapshot,
      browserSessions: {
        getBrowserSession: () => ({
          sessionId: "session-1",
          capabilityDigest: digest("6"),
          capabilities: ["browser.dom.read"],
          origin: "https://www.chanmama.com",
          authentication: "authenticated",
          state: "available"
        })
      }
    });
    const expectedPlan = resourcePlan();
    const expectedCall = expectedPlan.steps.constant;
    if (expectedCall?.kind !== "call") throw new Error("fixture changed");
    const run = runtime.start(expectedPlan, {});
    await expect(runtime.drainOnce()).resolves.toBe(1);
    expect(observed?.resourceMappings).toEqual(
      expectedCall.resourceMappings
    );
    expect(observed?.resourceBindings).toMatchObject({
      page_session: {
        requirementName: "page_session",
        slotName: "metrics_source",
        binding: {
          sessionId: "session-1",
          capabilityDigest: digest("6")
        }
      }
    });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      output: { recovered: true }
    });
    persistence.close();
  });

  it("rejects a missing frozen Resource Binding without invoking the Provider", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const providers = new RuntimeProviderRegistry();
    let invocations = 0;
    providers.register({
      id: "browser",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return {
          status: "succeeded",
          output: { recovered: true },
          evidence: [],
          riskSignals: []
        };
      }
    });
    const runtime = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5,
      browserSessions: {
        getBrowserSession: () => undefined
      }
    });
    const run = runtime.start(resourcePlan(), {});
    const active = (
      persistence.getEngineCheckpoint(run.id)?.state as unknown as EngineState
    ).active;
    if (active?.kind !== "call") throw new Error("fixture changed");
    await expect(runtime.drainOnce()).resolves.toBe(1);
    expect(invocations).toBe(0);
    expect(
      persistence.getInboxMessage(
        `result:${active.invocation.invocationId}`
      )?.payload
    ).toMatchObject({
      status: "rejected",
      error: {
        code: "RESOURCE_BINDING_MISSING",
        retryable: false
      }
    });
    expect(persistence.getRun(run.id)).toMatchObject({ status: "failed" });
    persistence.close();
  });

  it.each([
    {
      name: "session",
      sessionId: "session-other",
      capabilityDigest: digest("6"),
      capabilities: ["browser.dom.read"]
    },
    {
      name: "capability digest",
      sessionId: "session-1",
      capabilityDigest: digest("7"),
      capabilities: ["browser.dom.read"]
    },
    {
      name: "capability set",
      sessionId: "session-1",
      capabilityDigest: digest("6"),
      capabilities: []
    }
  ])(
    "rejects a changed browser $name without invoking the Provider",
    async ({ sessionId, capabilityDigest, capabilities }) => {
      const persistence = new SqlitePersistence({ path: ":memory:" });
      const providers = new RuntimeProviderRegistry();
      let invocations = 0;
      providers.register({
        id: "browser",
        supports: () => true,
        invoke: async () => {
          invocations += 1;
          return {
            status: "succeeded",
            output: { recovered: true },
            evidence: [],
            riskSignals: []
          };
        }
      });
      const runtime = new Ir2WorkflowRuntime(persistence, providers, {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5,
        resolveResourceBindingSnapshot: resourceBindingSnapshot,
        browserSessions: {
          getBrowserSession: () => ({
            sessionId,
            capabilityDigest,
            capabilities,
            origin: "https://www.chanmama.com",
            authentication: "authenticated",
            state: "available"
          })
        }
      });
      const run = runtime.start(resourcePlan(), {});
      const active = (
        persistence.getEngineCheckpoint(run.id)?.state as unknown as EngineState
      ).active;
      if (active?.kind !== "call") throw new Error("fixture changed");
      await expect(runtime.drainOnce()).resolves.toBe(1);
      expect(invocations).toBe(0);
      expect(
        persistence.getInboxMessage(
          `result:${active.invocation.invocationId}`
        )?.payload
      ).toMatchObject({
        status: "rejected",
        error: {
          code: "RESOURCE_BINDING_INVALID",
          retryable: false
        }
      });
      expect(persistence.getRun(run.id)).toMatchObject({ status: "failed" });
      persistence.close();
    }
  );

  it.each(["builtin", "team", "browser"])(
    "rejects invalid frozen input before invoking the %s provider",
    async (providerId) => {
      const persistence = new SqlitePersistence({ path: ":memory:" });
      let invocations = 0;
      const providers = new RuntimeProviderRegistry();
      providers.register({
        id: providerId,
        supports: () => true,
        invoke: async () => {
          invocations += 1;
          return {
            status: "succeeded",
            output: { recovered: true },
            evidence: [],
            riskSignals: []
          };
        }
      });
      const invalidInputSchema = {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } }
      } as const;
      const runtime = new Ir2WorkflowRuntime(persistence, providers, {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      });
      const run = runtime.start(
        plan(providerId, {
          schemaContract: contract(
            invalidInputSchema,
            validOutputSchema
          ),
          maxAttempts: 3
        }),
        {}
      );
      const active = (
        persistence.getEngineCheckpoint(run.id)?.state as unknown as EngineState
      ).active;
      if (active?.kind !== "call") throw new Error("fixture changed");

      await expect(runtime.drainOnce()).resolves.toBe(1);
      expect(invocations).toBe(0);
      expect(persistence.getRun(run.id)).toMatchObject({
        status: "failed",
        revision: 1
      });
      expect(persistence.listPendingEngineOutbox()).toEqual([]);
      expect(persistence.listEvents(run.id).at(-1)).toMatchObject({
        type: "RUNTIME_SCHEMA_VALIDATION_FAILED",
        payload: { errorCode: "RUNTIME_INPUT_SCHEMA_INVALID" }
      });
      expect(
        persistence.getInboxMessage(
          `result:${active.invocation.invocationId}`
        )?.payload
      ).toMatchObject({
        status: "failed",
        error: {
          code: "RUNTIME_INPUT_SCHEMA_INVALID",
          retryable: false
        }
      });
      persistence.close();
    }
  );

  it("fails closed and audits an invalid successful provider output", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    let invocations = 0;
    const providers = new RuntimeProviderRegistry();
    providers.register({
      id: "team",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return {
          status: "succeeded",
          output: { recovered: "not-a-boolean" },
          evidence: [],
          riskSignals: []
        };
      }
    });
    const runtime = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5
    });
    const run = runtime.start(plan("team", { maxAttempts: 3 }), {});
    const active = (
      persistence.getEngineCheckpoint(run.id)?.state as unknown as EngineState
    ).active;
    if (active?.kind !== "call") throw new Error("fixture changed");

    await expect(runtime.drainOnce()).resolves.toBe(1);
    expect(invocations).toBe(1);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "failed",
      revision: 1
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    expect(
      persistence.getInboxMessage(
        `result:${active.invocation.invocationId}`
      )?.payload
    ).toMatchObject({
      status: "failed",
      output: { recovered: "not-a-boolean" },
      error: {
        code: "RUNTIME_OUTPUT_SCHEMA_INVALID",
        retryable: false,
        details: {
          schemaDigest: contract().outputSchemaDigest,
          valueDigest: expect.stringMatching(/^sha256:/)
        }
      }
    });
    expect(persistence.listEvents(run.id).at(-1)).toMatchObject({
      type: "RUNTIME_SCHEMA_VALIDATION_FAILED",
      payload: { errorCode: "RUNTIME_OUTPUT_SCHEMA_INVALID" }
    });
    persistence.close();
  });

  it("backfills a pre-contract snapshot only from an exact published Node after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ir2-contract-"));
    const databasePath = join(directory, "core.db");
    try {
      const firstPersistence = new SqlitePersistence({ path: databasePath });
      firstPersistence.publish({
        assetType: "node",
        assetId: legacyNodeDefinition.metadata.id,
        version: legacyNodeDefinition.metadata.version,
        digest: contentDigest(legacyNodeDefinition),
        content: legacyNodeDefinition,
        actor: "test"
      });
      const first = new Ir2WorkflowRuntime(
        firstPersistence,
        new RuntimeProviderRegistry(),
        { now: () => 1_000, id: ids(), random: () => 0.5 }
      );
      const run = first.start(legacyPlan(), {});
      expect(
        (
          firstPersistence.getRunPlanSnapshot(run.id)?.planJson.steps
            .constant as { schemaContract?: unknown }
        ).schemaContract
      ).toBeUndefined();
      firstPersistence.close();

      const reopened = new SqlitePersistence({ path: databasePath });
      const providers = new RuntimeProviderRegistry();
      providers.register(new BuiltinRuntimeProvider());
      const restarted = new Ir2WorkflowRuntime(reopened, providers, {
        now: () => 1_001,
        id: ids(),
        random: () => 0.5
      });
      expect(restarted.recover(run.id)).toMatchObject({
        status: "waiting_runtime"
      });
      await expect(restarted.drainOnce()).resolves.toBe(1);
      expect(reopened.getRun(run.id)).toMatchObject({
        status: "succeeded",
        output: { recovered: true }
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing", "drifted"] as const)(
    "fails closed when a pre-contract snapshot Node is %s",
    async (mode) => {
      const persistence = new SqlitePersistence({ path: ":memory:" });
      if (mode === "drifted") {
        const drifted = {
          ...legacyNodeDefinition,
          outputSchema: { type: "string" }
        };
        persistence.publish({
          assetType: "node",
          assetId: drifted.metadata.id,
          version: drifted.metadata.version,
          digest: contentDigest(drifted),
          content: drifted,
          actor: "test"
        });
      }
      let invocations = 0;
      const providers = new RuntimeProviderRegistry();
      providers.register({
        id: "builtin",
        supports: () => true,
        invoke: async () => {
          invocations += 1;
          return {
            status: "succeeded",
            output: { recovered: true },
            evidence: [],
            riskSignals: []
          };
        }
      });
      const runtime = new Ir2WorkflowRuntime(persistence, providers, {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      });
      const run = runtime.start(legacyPlan(), {});
      await expect(runtime.drainOnce()).resolves.toBe(1);

      expect(invocations).toBe(0);
      expect(persistence.getRun(run.id)).toMatchObject({ status: "failed" });
      expect(persistence.listEvents(run.id).at(-1)).toMatchObject({
        type: "RUNTIME_SCHEMA_VALIDATION_FAILED",
        payload: { errorCode: "RUNTIME_NODE_CONTRACT_UNAVAILABLE" }
      });
      persistence.close();
    }
  );

  it("times out an expired persisted invocation without calling its provider", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    let invocations = 0;
    const providers = new RuntimeProviderRegistry();
    providers.register({
      id: "counted",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return {
          status: "succeeded",
          output: { shouldNotRun: true },
          evidence: [],
          riskSignals: []
        };
      }
    });
    const first = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 1_000,
      id: ids(),
      random: () => 0.5
    });
    const run = first.start(plan("counted"), {});
    const restarted = new Ir2WorkflowRuntime(persistence, providers, {
      now: () => 2_000,
      id: ids(),
      random: () => 0.5
    });

    expect(restarted.recover(run.id)).toMatchObject({
      status: "waiting_runtime"
    });
    await expect(restarted.drainOnce()).resolves.toBe(1);
    expect(invocations).toBe(0);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "failed",
      revision: 1
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
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

  it("durably cancels once and never applies a late provider result", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-ir2-cancel-"));
    const databasePath = join(directory, "core.db");
    try {
      const persistence = new SqlitePersistence({ path: databasePath });
      const cancellations: Array<{
        invocationId: string;
        fencingToken: number;
      }> = [];
      const provider: RuntimeProvider = {
        id: "cancellable",
        supports: () => true,
        invoke: async () => {
          throw new Error("cancel test must not invoke the provider");
        },
        cancel: async (invocationId, fencingToken) => {
          cancellations.push({ invocationId, fencingToken });
        }
      };
      const providers = new RuntimeProviderRegistry();
      providers.register(provider);
      const runtime = new Ir2WorkflowRuntime(persistence, providers, {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      });
      const run = runtime.start(plan("cancellable"), {});
      const waiting = persistence.getEngineCheckpoint(run.id)
        ?.state as unknown as EngineState;
      const active = waiting.active;
      if (active?.kind !== "call") throw new Error("fixture changed");

      expect(runtime.cancel(run.id, "operator-1")).toMatchObject({
        disposition: "advanced",
        run: { status: "cancelled", revision: 1 }
      });
      expect(cancellations).toEqual([
        {
          invocationId: active.invocation.invocationId,
          fencingToken: active.invocation.fencingToken
        }
      ]);
      expect(persistence.listPendingEngineOutbox()).toEqual([]);
      const cancelled = persistence.getEngineCheckpoint(run.id)!;
      expect(cancelled.state).toMatchObject({
        status: "cancelled",
        error: { code: "RUN_CANCELLED" }
      });
      expect(cancelled.state).not.toHaveProperty("active");
      expect(runtime.cancel(run.id, "operator-1")).toMatchObject({
        disposition: "duplicate",
        run: { status: "cancelled", revision: 1 }
      });
      expect(cancellations).toHaveLength(1);
      expect(
        runtime.acceptRuntimeResult({
          runId: run.id,
          outboxId: `effect:${active.invocation.invocationId}`,
          inboxMessageId: "late-result",
          invocationId: active.invocation.invocationId,
          fencingToken: active.invocation.fencingToken,
          outcome: {
            status: "succeeded",
            output: { tooLate: true },
            evidence: [],
            riskSignals: []
          }
        })
      ).toBe("duplicate");
      expect(persistence.getRun(run.id)).toMatchObject({
        status: "cancelled",
        revision: 1
      });
      expect(persistence.getRun(run.id)).not.toHaveProperty("output");
      expect(
        persistence
          .listEvents(run.id)
          .filter((event) => event.type === "RUN_IR2_CANCELLED")
      ).toHaveLength(1);
      persistence.close();

      const reopened = new SqlitePersistence({ path: databasePath });
      const restarted = new Ir2WorkflowRuntime(reopened, providers, {
        now: () => 2_000,
        id: ids(),
        random: () => 0.5
      });
      expect(restarted.recover(run.id)).toMatchObject({
        status: "cancelled",
        revision: cancelled.stateRevision
      });
      expect(reopened.listPendingEngineOutbox()).toEqual([]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const assistancePlan = blockingAssistancePlan();
    const run = runtime.start(assistancePlan, {});
    expect(run.status).toBe("waiting_human");
    const tasks = persistence.listAssistanceTasks({ limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task).toMatchObject({
      runId: run.id,
      mode: "human_confirm",
      status: "queued"
    });
    expect(
      persistence.listPendingEngineOutbox().map((message) => message.topic)
    ).toEqual(["assistance.requested", "timer.scheduled"]);
    persistence.close();
  });

  it("rolls back checkpoint, task, and timer intent together", () => {
    const persistence = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (point === "recoverable_run.after_effects") {
          throw new Error("injected timer persistence failure");
        }
      }
    });
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => 1_000,
        id: ids(),
        random: () => 0.5
      }
    );

    expect(() => runtime.start(blockingAssistancePlan(1_000), {})).toThrow(
      "injected timer persistence failure"
    );
    expect(persistence.getRun("id-1")).toBeUndefined();
    expect(persistence.getEngineCheckpoint("id-1")).toBeUndefined();
    expect(persistence.listAssistanceTasks({ limit: 10 })).toEqual([]);
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    persistence.close();
  });

  it("expires a reclaimed blocking task once after restart and rejects late work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-assistance-timer-"));
    const databasePath = join(directory, "core.db");
    try {
      const firstPersistence = new SqlitePersistence({ path: databasePath });
      const first = new Ir2WorkflowRuntime(
        firstPersistence,
        new RuntimeProviderRegistry(),
        {
          now: () => 1_000,
          id: ids(),
          random: () => 0.5
        }
      );
      const run = first.start(blockingAssistancePlan(1_000), {});
      const persisted = firstPersistence.listAssistanceTasks({ limit: 1 })[0];
      if (!persisted) throw new Error("Assistance fixture was not created");
      const queued = fromAssistanceTaskPersistenceAggregate({
        definition: persisted.task,
        privateState: persisted.privateState
      });
      const claimed = claimAssistanceTask(queued, {
        leaseId: "lease-before-deadline",
        ownerId: "operator",
        ownerType: "human",
        now: "1970-01-01T00:00:01.100Z",
        leaseDurationMs: 10_000
      });
      if (!claimed.ok) throw new Error(claimed.error);
      expect(
        firstPersistence.commitAssistanceTask({
          task: taskRecord(claimed.task),
          expectedRevision: 0,
          expectedFencingCounter: 0
        }).status
      ).toBe("accepted");
      const released = releaseAssistanceTask(claimed.task, {
        leaseId: "lease-before-deadline",
        ownerId: "operator",
        fencingToken: 1,
        now: "1970-01-01T00:00:01.200Z"
      });
      if (!released.ok) throw new Error(released.error);
      expect(
        firstPersistence.commitAssistanceTask({
          task: taskRecord(released.task),
          expectedRevision: 1,
          expectedFencingCounter: 1
        }).status
      ).toBe("accepted");
      const reclaimed = claimAssistanceTask(released.task, {
        leaseId: "lease-reclaimed",
        ownerId: "operator-2",
        ownerType: "human",
        now: "1970-01-01T00:00:01.300Z",
        leaseDurationMs: 10_000
      });
      if (!reclaimed.ok) throw new Error(reclaimed.error);
      expect(reclaimed.task.fencingCounter).toBe(2);
      expect(
        firstPersistence.commitAssistanceTask({
          task: taskRecord(reclaimed.task),
          expectedRevision: 2,
          expectedFencingCounter: 1
        }).status
      ).toBe("accepted");
      const lateCompletion = submitAssistanceTask(reclaimed.task, {
        leaseId: "lease-reclaimed",
        ownerId: "operator-2",
        fencingToken: 2,
        now: "1970-01-01T00:00:01.500Z",
        output: { approved: true },
        resolverType: "human",
        resolverId: "operator-2"
      });
      if (!lateCompletion.ok) throw new Error(lateCompletion.error);
      const timer = persistedTimer(firstPersistence);
      firstPersistence.close();

      const reopened = new SqlitePersistence({ path: databasePath });
      const restarted = new Ir2WorkflowRuntime(
        reopened,
        new RuntimeProviderRegistry(),
        {
          now: () => 2_000,
          id: ids(),
          random: () => 0.5
        }
      );
      expect(restarted.recover(run.id)).toMatchObject({
        status: "waiting_assistance"
      });
      expect(
        restarted.acceptTimerFire({
          outboxId: timer.outboxId,
          inboxMessageId: "timer.fire:stale-fencing",
          timer: { ...timer.timer, fencingToken: 0 }
        })
      ).toBe("stale");
      expect(reopened.getRun(run.id)?.status).toBe("waiting_human");

      await expect(restarted.drainOnce()).resolves.toBe(1);
      expect(reopened.getRun(run.id)).toMatchObject({
        status: "failed",
        revision: 1
      });
      expect(reopened.getAssistanceTask(persisted.task.taskId)).toMatchObject({
        task: { status: "expired", revision: 4 },
        fencingCounter: 2,
        privateState: {
          fencingCounter: 2,
          terminalReason: "Assistance deadline elapsed"
        }
      });
      expect(reopened.listPendingEngineOutbox()).toEqual([]);
      expect(
        restarted.acceptTimerFire({
          outboxId: timer.outboxId,
          inboxMessageId: `timer.fire:${timer.timer.timerId}`,
          timer: timer.timer
        })
      ).toBe("duplicate");
      expect(
        restarted.commitAssistanceTask({
          requestId: "late-assistance-submit",
          task: taskRecord(lateCompletion.task),
          expectedRevision: 3,
          expectedFencingCounter: 2,
          runOutcome: {
            status: "resolved",
            reason: "MODE_REQUIRES_HUMAN"
          }
        }).status
      ).toBe("stale");
      expect(
        reopened.listEvents(run.id).map((event) => event.type)
      ).toEqual(["RUN_IR2_STARTED", "ASSISTANCE_DEADLINE_EXPIRED"]);
      await expect(restarted.drainOnce()).resolves.toBe(0);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels a blocking task and ignores its late timer fire", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    let now = 1_000;
    const runtime = new Ir2WorkflowRuntime(
      persistence,
      new RuntimeProviderRegistry(),
      {
        now: () => now,
        id: ids(),
        random: () => 0.5
      }
    );
    const run = runtime.start(blockingAssistancePlan(1_000), {});
    const task = persistence.listAssistanceTasks({ limit: 1 })[0];
    if (!task) throw new Error("Assistance fixture was not created");
    const timer = persistedTimer(persistence);
    now = 1_500;

    expect(runtime.cancel(run.id, "operator")).toMatchObject({
      disposition: "advanced",
      run: { status: "cancelled", revision: 1 }
    });
    expect(persistence.getAssistanceTask(task.task.taskId)).toMatchObject({
      task: { status: "cancelled", revision: 1 },
      privateState: { terminalReason: "Run cancelled by operator" }
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    now = 2_000;
    expect(
      runtime.acceptTimerFire({
        outboxId: timer.outboxId,
        inboxMessageId: `timer.fire:${timer.timer.timerId}`,
        timer: timer.timer
      })
    ).toBe("duplicate");
    await expect(runtime.drainOnce()).resolves.toBe(0);
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "cancelled",
      revision: 1
    });
    persistence.close();
  });

  it("atomically routes a denied AI result to human confirmation", () => {
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
    const aiProfile = {
      kind: "assistance_profile" as const,
      id: "packaging_match_review",
      version: "1.0.0",
      digest: `sha256:${digest("7")}`
    };
    const humanProfile = {
      kind: "assistance_profile" as const,
      id: "binding_confirm",
      version: "1.0.0",
      digest: `sha256:${digest("8")}`
    };
    const assistancePlan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.ai-safe-escalation",
        version: "1.0.0",
        digest: `sha256:${digest("9")}`
      },
      artifactClosure: { entries: [aiProfile, humanProfile] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "review",
      steps: {
        review: {
          kind: "wait.assistance",
          key: "review",
          taskKind: "ai_review",
          profile: aiProfile,
          deadlineMs: 60_000,
          onUnavailable: "human_action",
          blocking: true,
          routes: {
            resolved: "done",
            escalated: "confirm",
            expired: "failed",
            unavailable: "confirm"
          }
        },
        confirm: {
          kind: "wait.assistance",
          key: "confirm",
          taskKind: "human_confirm",
          profile: humanProfile,
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
        }
      }
    };
    const run = runtime.start(assistancePlan, {});
    const queuedRecord = persistence
      .listAssistanceTasks({ modes: ["ai_review"], limit: 1 })[0];
    if (!queuedRecord) throw new Error("AI review fixture was not created");
    const queued = fromAssistanceTaskPersistenceAggregate({
      definition: queuedRecord.task,
      privateState: queuedRecord.privateState
    });
    const claimed = claimAssistanceTask(queued, {
      leaseId: "lease-ai",
      ownerId: "codex",
      ownerType: "ai",
      now: "1970-01-01T00:00:01.100Z",
      leaseDurationMs: 10_000
    });
    if (!claimed.ok) throw new Error(claimed.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(claimed.task),
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("accepted");
    const completed = submitAssistanceTask(claimed.task, {
      leaseId: "lease-ai",
      ownerId: "codex",
      fencingToken: 1,
      now: "1970-01-01T00:00:01.200Z",
      output: { review: "invalid-for-auto-continue" },
      resolverType: "ai",
      resolverId: "codex"
    });
    if (!completed.ok) throw new Error(completed.error);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-ai-escalated",
        task: taskRecord(completed.task),
        expectedRevision: 1,
        expectedFencingCounter: 1,
        runOutcome: {
          status: "escalated",
          reason: "R1_RESULT_VALIDATION_REQUIRED"
        }
      })
    ).toMatchObject({ status: "accepted" });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "waiting_human",
      currentNodeKey: "confirm"
    });
    expect(
      persistence.listAssistanceTasks({ limit: 10 }).map((entry) => ({
        mode: entry.task.mode,
        status: entry.task.status
      }))
    ).toEqual([
      { mode: "ai_review", status: "completed" },
      { mode: "human_confirm", status: "queued" }
    ]);
    expect(
      persistence.listPendingEngineOutbox().map((message) => message.topic)
    ).toEqual(["assistance.requested", "timer.scheduled"]);
    expect(
      persistence.getEngineCheckpoint(run.id)?.state
    ).toMatchObject({
      status: "waiting_assistance",
      cursor: { stepKey: "confirm" },
      active: {
        kind: "assistance",
        request: { taskKind: "human_confirm" }
      }
    });
    expect(persistence.listEvents(run.id).at(-1)).toMatchObject({
      type: "ASSISTANCE_RESULT_APPLIED",
      payload: {
        outcome: "escalated",
        reason: "R1_RESULT_VALIDATION_REQUIRED"
      }
    });
    persistence.close();
  });

  it("atomically resumes a waiting Run after a reclaimed human task completes", () => {
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
      id: "profile.confirm",
      version: "1.0.0",
      digest: `sha256:${digest("e")}`
    };
    const assistancePlan: ExecutionPlan = {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "test.human-confirm",
        version: "1.0.0",
        digest: `sha256:${digest("f")}`
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
    const run = runtime.start(assistancePlan, {});
    const queuedRecord = persistence.listAssistanceTasks({ limit: 1 })[0];
    if (!queuedRecord) throw new Error("Assistance fixture was not created");
    const queued = fromAssistanceTaskPersistenceAggregate({
      definition: queuedRecord.task,
      privateState: queuedRecord.privateState
    });
    const firstClaim = claimAssistanceTask(queued, {
      leaseId: "lease-1",
      ownerId: "operator-1",
      ownerType: "human",
      now: "1970-01-01T00:00:01.100Z",
      leaseDurationMs: 10_000
    });
    if (!firstClaim.ok) throw new Error(firstClaim.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(firstClaim.task),
        expectedRevision: 0,
        expectedFencingCounter: 0
      }).status
    ).toBe("accepted");
    const released = releaseAssistanceTask(firstClaim.task, {
      leaseId: "lease-1",
      ownerId: "operator-1",
      fencingToken: 1,
      now: "1970-01-01T00:00:01.200Z"
    });
    if (!released.ok) throw new Error(released.error);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(released.task),
        expectedRevision: 1,
        expectedFencingCounter: 1
      }).status
    ).toBe("accepted");
    const secondClaim = claimAssistanceTask(released.task, {
      leaseId: "lease-2",
      ownerId: "operator-2",
      ownerType: "human",
      now: "1970-01-01T00:00:01.300Z",
      leaseDurationMs: 10_000
    });
    if (!secondClaim.ok) throw new Error(secondClaim.error);
    expect(secondClaim.task.fencingCounter).toBe(2);
    expect(
      persistence.commitAssistanceTask({
        task: taskRecord(secondClaim.task),
        expectedRevision: 2,
        expectedFencingCounter: 1
      }).status
    ).toBe("accepted");
    const completed = submitAssistanceTask(secondClaim.task, {
      leaseId: "lease-2",
      ownerId: "operator-2",
      fencingToken: 2,
      now: "1970-01-01T00:00:01.400Z",
      output: { approved: true },
      resolverType: "human",
      resolverId: "operator-2"
    });
    if (!completed.ok) throw new Error(completed.error);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-human-1",
        task: taskRecord(completed.task),
        expectedRevision: 3,
        expectedFencingCounter: 2,
        runOutcome: {
          status: "resolved",
          reason: "MODE_REQUIRES_HUMAN"
        }
      })
    ).toMatchObject({ status: "accepted" });
    expect(persistence.getRun(run.id)).toMatchObject({
      status: "succeeded",
      revision: 1,
      output: { approved: true }
    });
    expect(persistence.getEngineCheckpoint(run.id)).toMatchObject({
      stateRevision: 3,
      state: { status: "succeeded" }
    });
    expect(persistence.listPendingEngineOutbox()).toEqual([]);
    expect(
      runtime.commitAssistanceTask({
        requestId: "submit-human-1",
        task: taskRecord(completed.task),
        expectedRevision: 3,
        expectedFencingCounter: 2,
        runOutcome: {
          status: "resolved",
          reason: "MODE_REQUIRES_HUMAN"
        }
      }).status
    ).toBe("duplicate");
    persistence.close();
  });
});
