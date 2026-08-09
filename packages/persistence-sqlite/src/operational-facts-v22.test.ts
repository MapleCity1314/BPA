import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OperationalFactConflictError,
  StaleFencingTokenError,
  type AuditRecord,
  type AttentionDeliveryRecord,
  type AttentionRecord,
  type DatasetVersionDefinition,
  type EngineCheckpointRecord,
  type ExecutionEventRecord,
  type OperationalExecutionContext,
  type OperationalDatasetCoverage,
  type RunPlanSnapshotRecord,
  type RunRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-08-09T05:00:00.000Z";
const sourceDigest = `sha256:${"a".repeat(64)}`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function event(runId: string, sequence: number): ExecutionEventRecord {
  return {
    id: `event:${runId}:${sequence}`,
    runId,
    sequence,
    type: `EVENT_${sequence}`,
    payload: {},
    occurredAt: timestamp
  };
}

function plan(runId: string): RunPlanSnapshotRecord {
  return {
    runId,
    irVersion: "bpa.workflow-ir/2",
    planDigest: "sha256:plan",
    workflowSourceDigest: "sha256:workflow",
    artifactClosureDigest: "sha256:closure",
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: "doudian.experience-score.daily",
        version: "1.0.1",
        digest: "sha256:workflow"
      },
      artifactClosure: { entries: [] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "done",
      steps: {
        done: { key: "done", kind: "terminal", status: "succeeded" }
      }
    },
    riskSnapshot: [],
    createdAt: timestamp
  };
}

function context(
  runId: string,
  stepKey: string,
  invocationId = `invocation:${runId}:${stepKey}`,
  fencingToken = 1
): OperationalExecutionContext {
  return {
    invocationId,
    identity: {
      runId,
      scopePath: [],
      iterationKey: "root",
      stepKey,
      attempt: 1
    },
    node: {
      kind: "node",
      id: stepKey === "persist-shop"
        ? "experience.shop.fact.persist"
        : "experience.daily.dataset.prepare",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`
    },
    idempotencyKey: `${runId}:root:${stepKey}:1`,
    fencingToken
  };
}

function checkpoint(
  runId: string,
  revision: number,
  execution?: OperationalExecutionContext,
  status:
    | "waiting_runtime"
    | "succeeded"
    | "rejected"
    | "failed"
    | "cancelled"
    | "uncertain" = "waiting_runtime"
): EngineCheckpointRecord {
  return {
    runId,
    stateVersion: "bpa.engine-state/2",
    stateRevision: revision,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId,
      status,
      revision,
      ...(execution
        ? {
            active: {
              kind: "call",
              invocation: execution
            }
          }
        : {})
    } as unknown as EngineCheckpointRecord["state"],
    updatedAt: timestamp
  };
}

function createRecoverableRun(
  store: SqlitePersistence,
  runId: string,
  execution: OperationalExecutionContext
): RunRecord {
  const run: RunRecord = {
    id: runId,
    workflowId: "doudian.experience-score.daily",
    workflowVersion: "1.0.1",
    workflowDigest: "sha256:workflow",
    status: "waiting_browser",
    revision: 0,
    input: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return store.createRecoverableRun({
    run,
    planSnapshot: plan(runId),
    checkpoint: checkpoint(runId, 1, execution),
    event: event(runId, 1)
  });
}

function factRecord(shopId = "10001") {
  return {
    id: shopId,
    businessDate: "2026-08-09",
    status: "complete",
    shop: { id: shopId, name: "测试店铺" },
    summary: { totalScore: 96.5 }
  };
}

function putFact(
  store: SqlitePersistence,
  execution: OperationalExecutionContext,
  record = factRecord()
) {
  return store.putOperationalFact({
    namespace: "doudian.experience.shop-snapshot",
    businessTimeZone: "Asia/Shanghai",
    subjectId: record.id,
    schemaVersion: "1.0.0",
    record,
    observedAt: timestamp,
    persistedAt: timestamp,
    executionContext: execution
  });
}

function dataset(
  records: readonly unknown[],
  version = "2026.8.9-run-run-facts"
): DatasetVersionDefinition {
  return {
    apiVersion: "bpa.data/v1alpha1",
    kind: "DatasetVersion",
    metadata: {
      id: "doudian-experience-daily",
      version,
      title: "抖店每日体验分"
    },
    profile: { id: "doudian-experience", version: "1.0.0" },
    source: {
      fileName: "doudian-experience.json",
      mediaType: "application/json",
      size: 1,
      digest: sourceDigest
    },
    recordSchema: { type: "object" },
    recordCount: records.length,
    recordsDigest: digest(records)
  };
}

function audit(version: string): AuditRecord {
  return {
    id: `audit:${version}`,
    action: "dataset.published",
    actor: "runtime",
    target: `dataset:doudian-experience-daily@${version}`,
    detail: {},
    occurredAt: timestamp
  };
}

const completeCoverage = {
  discovered: 1,
  collectable: 1,
  attempted: 1,
  persisted: 1,
  failed: 0,
  skipped: 0
} as const;

function preparePublication(
  store: SqlitePersistence,
  runId: string,
  version: string,
  options: {
    quality?: "complete" | "partial";
    coverage?: OperationalDatasetCoverage;
  } = {}
) {
  const factContext = context(runId, "persist-shop");
  const run = createRecoverableRun(store, runId, factContext);
  const fact = putFact(store, factContext).fact;
  const prepareContext = context(runId, "prepare-dataset");
  store.commitRecoverableTransition({
    runId,
    expectedRevision: 0,
    nextStatus: "waiting_browser",
    checkpoint: checkpoint(runId, 2, prepareContext),
    expectedCheckpointRevision: 1,
    event: event(runId, 2)
  });
  const definition = dataset([fact.record], version);
  const publicationIntentId = `intent:${runId}`;
  const coverage = options.coverage ?? completeCoverage;
  const quality = options.quality ?? "complete";
  const prepared = store.prepareOperationalDatasetPublication({
    publicationIntentId,
    runId,
    stagingId: `staging:${runId}`,
    dataset: definition,
    factKeys: [fact.factKey],
    audit: audit(version),
    quality,
    coverage,
    executionContext: prepareContext,
    preparedAt: timestamp
  });
  return { run, fact, prepareContext, definition, publicationIntentId, prepared };
}

function attentionPair(runId: string): {
  attention: AttentionRecord;
  attentionDelivery: AttentionDeliveryRecord;
} {
  const attention: AttentionRecord = {
    sourceRef: { kind: "workflow-run", runId },
    deliveryPolicy: "operator-notification",
    item: {
      id: `run-terminal:${runId}`,
      runId,
      stageKey: "terminal",
      groupKey: "runtime",
      kind: "action",
      source: "runtime",
      title: "运行未完成",
      reason: "运行进入异常终态。",
      requestedAction: "检查运行记录。",
      blocking: false,
      batchable: false,
      attemptedActions: [],
      resumesAutomatically: false,
      createdAt: timestamp
    },
    state: "open",
    revision: 0
  };
  const payload = { attentionId: attention.item.id, runId };
  return {
    attention,
    attentionDelivery: {
      id: `delivery:${runId}`,
      attentionId: attention.item.id,
      channel: "operator-notification",
      idempotencyKey: `attention:${runId}:operator-notification`,
      requestDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")}`,
      payload,
      state: "pending",
      revision: 0,
      attempt: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function createTriggeredRun(
  store: SqlitePersistence,
  runId: string,
  execution: OperationalExecutionContext,
  scheduledAt: string
) {
  const spec = {
    apiVersion: "bpa.trigger/v1alpha2" as const,
    id: `experience.${runId}`,
    version: "1.0.0",
    appId: "experience-score-monitor",
    kind: "manual" as const,
    workflow: { id: "doudian.experience-score.daily", version: "1.0.1" },
    enabled: true,
    inputSchemaVersion: "experience/1",
    input: {},
    concurrencyKey: `experience:${runId}`,
    browserInstanceId: "doudian-company-main",
    idempotencyPolicy: "request_key" as const,
    retryPolicy: "none" as const
  };
  store.putTriggerSpec({ spec, actor: "test", occurredAt: timestamp });
  const occurrenceId = `trigger-occurrence:${runId}`;
  store.claimTriggerOccurrence({
    occurrenceId,
    triggerId: spec.id,
    triggerVersion: spec.version,
    occurrenceKey: `manual:${runId}`,
    scheduledAt,
    status: "pending",
    attemptCount: 0,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const attemptId = `trigger-attempt:${runId}`;
  const triggerLease = store.acquireTriggerLease({
    concurrencyKey: spec.concurrencyKey,
    ownerId: attemptId,
    now: timestamp,
    ttlSeconds: 300
  })!;
  const browserLease = store.acquireBrowserControlLease({
    resourceId: `browser-instance:${spec.browserInstanceId}`,
    ownerId: attemptId,
    now: timestamp,
    ttlSeconds: 300
  })!;
  store.createTriggerAttempt({
    attemptId,
    occurrenceId,
    expectedOccurrenceRevision: 0,
    createdAt: timestamp
  });
  store.updateTriggerAttempt({
    attemptId,
    expectedRevision: 0,
    status: "running",
    updatedAt: timestamp,
    fencingToken: triggerLease.fencingToken,
    browserFencingToken: browserLease.fencingToken
  });
  const run: RunRecord = {
    id: runId,
    workflowId: "doudian.experience-score.daily",
    workflowVersion: "1.0.1",
    workflowDigest: "sha256:workflow",
    status: "waiting_browser",
    revision: 0,
    input: {},
    createdAt: "2026-08-10T05:00:00.000Z",
    updatedAt: timestamp
  };
  store.createRecoverableRun({
    run,
    planSnapshot: plan(runId),
    checkpoint: checkpoint(runId, 1, execution),
    event: event(runId, 1),
    triggerAttemptId: attemptId
  });
  return { spec, occurrenceId, attemptId, triggerLease, browserLease };
}

describe("operational facts and terminal Dataset publication v22", () => {
  it("keeps a Run-scoped shop fact idempotent and rejects stale execution identity", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const execution = context("run-facts", "persist-shop");
    createRecoverableRun(store, "run-facts", execution);

    const accepted = putFact(store, execution);
    expect(accepted.status).toBe("accepted");
    expect(putFact(store, execution)).toEqual({
      status: "duplicate",
      fact: accepted.fact
    });
    expect(() =>
      putFact(store, execution, {
        ...factRecord(),
        summary: { totalScore: 90 }
      })
    ).toThrow(OperationalFactConflictError);
    expect(() =>
      putFact(store, { ...execution, fencingToken: 2 })
    ).toThrow(StaleFencingTokenError);
    expect(accepted.fact).toMatchObject({
      runId: "run-facts",
      businessDate: "2026-08-09",
      subjectId: "10001",
      invocationId: execution.invocationId,
      fencingToken: 1
    });
    store.close();
  });

  it("allows a later Run to persist a fresh fact for the same shop and date", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const firstContext = context("run-first", "persist-shop");
    createRecoverableRun(store, "run-first", firstContext);
    const first = putFact(store, firstContext).fact;

    const secondContext = context("run-second", "persist-shop");
    createRecoverableRun(store, "run-second", secondContext);
    const second = putFact(
      store,
      secondContext,
      { ...factRecord(), summary: { totalScore: 97 } }
    ).fact;

    expect(second.factKey).not.toBe(first.factKey);
    expect(second.runId).toBe("run-second");
    store.close();
  });

  it("treats schemaVersion as part of the fact identity", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const execution = context("run-schema", "persist-shop");
    createRecoverableRun(store, "run-schema", execution);
    const first = putFact(store, execution).fact;
    const second = store.putOperationalFact({
      namespace: "doudian.experience.shop-snapshot",
      businessTimeZone: "Asia/Shanghai",
      subjectId: "10001",
      schemaVersion: "1.1.0",
      record: factRecord(),
      observedAt: timestamp,
      persistedAt: timestamp,
      executionContext: execution
    }).fact;
    expect(second.factKey).not.toBe(first.factKey);
    expect(second.schemaVersion).toBe("1.1.0");
    store.close();
  });

  it("rejects every drifted active RuntimeInvocation identity field", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const active = context("run-context", "persist-shop");
    createRecoverableRun(store, "run-context", active);
    const variants: OperationalExecutionContext[] = [
      { ...active, invocationId: "invocation:other" },
      { ...active, node: { ...active.node, version: "1.0.1" } },
      {
        ...active,
        identity: {
          ...active.identity,
          scopePath: [{ foreachStepKey: "shops", itemKey: "10001" }]
        }
      },
      { ...active, identity: { ...active.identity, iterationKey: "10001" } },
      { ...active, identity: { ...active.identity, stepKey: "other" } },
      { ...active, identity: { ...active.identity, attempt: 2 } },
      { ...active, idempotencyKey: "other" },
      { ...active, fencingToken: 2 }
    ];
    for (const drifted of variants) {
      expect(() => putFact(store, drifted)).toThrow(StaleFencingTokenError);
    }
    expect(store.listOperationalFactsForRun("run-context")).toEqual([]);
    store.close();
  });

  it("prepares without publishing and atomically publishes facts with terminal Run lineage", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const factContext = context("run-publish", "persist-shop");
    const run = createRecoverableRun(store, "run-publish", factContext);
    const fact = putFact(store, factContext).fact;
    const prepareContext = context("run-publish", "prepare-dataset");
    store.commitRecoverableTransition({
      runId: run.id,
      expectedRevision: 0,
      nextStatus: "waiting_browser",
      checkpoint: checkpoint(run.id, 2, prepareContext),
      expectedCheckpointRevision: 1,
      event: event(run.id, 2)
    });
    const definition = dataset([fact.record]);
    store.prepareOperationalDatasetPublication({
      publicationIntentId: "intent:run-publish",
      runId: run.id,
      stagingId: "staging-run-publish",
      dataset: definition,
      factKeys: [fact.factKey],
      audit: audit(definition.metadata.version),
      quality: "complete",
      coverage: completeCoverage,
      executionContext: prepareContext,
      preparedAt: timestamp
    });
    expect(() => putFact(store, factContext)).toThrow(StaleFencingTokenError);

    expect(
      store.getDataset(definition.metadata.id, definition.metadata.version)
    ).toBeUndefined();
    expect(store.getPreparedOperationalDatasetPublication(run.id)).toMatchObject({
      publicationIntentId: "intent:run-publish",
      factKeys: [fact.factKey]
    });

    store.commitRecoverableTransition({
      runId: run.id,
      expectedRevision: 1,
      nextStatus: "succeeded",
      checkpoint: checkpoint(run.id, 3, undefined, "succeeded"),
      expectedCheckpointRevision: 2,
      output: {
        status: "complete",
        operationalDatasetPublicationIntentId: "intent:run-publish"
      },
      operationalDatasetPublicationIntentId: "intent:run-publish",
      event: event(run.id, 3)
    });

    expect(store.getRun(run.id)).toMatchObject({
      status: "succeeded",
      revision: 2
    });
    expect(
      store.getDataset(definition.metadata.id, definition.metadata.version)
    ).toEqual(definition);
    expect(
      store.readDatasetRecords({
        id: definition.metadata.id,
        version: definition.metadata.version,
        limit: 10
      })
    ).toEqual({ records: [fact.record] });
    expect(
      store.getOperationalDatasetPublicationLineage(
        definition.metadata.id,
        definition.metadata.version
      )
    ).toEqual({
      runId: run.id,
      datasetId: definition.metadata.id,
      datasetVersion: definition.metadata.version,
      terminalStatus: "succeeded",
      quality: "complete",
      businessDate: "2026-08-09",
      coverage: completeCoverage,
      factKeys: [fact.factKey],
      publishedAt: timestamp
    });
    expect(store.getPreparedOperationalDatasetPublication(run.id)).toBeUndefined();
    expect(() =>
      store.commitRecoverableTransition({
        runId: run.id,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(run.id, 4, undefined, "succeeded"),
        expectedCheckpointRevision: 3,
        output: {
          operationalDatasetPublicationIntentId: "intent:run-publish"
        },
        operationalDatasetPublicationIntentId: "intent:run-publish",
        event: event(run.id, 4)
      })
    ).toThrow("revision changed");
    expect(
      store.listAudit(
        `dataset:${definition.metadata.id}@${definition.metadata.version}`
      )
    ).toHaveLength(1);
    store.close();
  });

  it("keeps staging and intent atomic, idempotent and sealed", () => {
    let crash = true;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "operational_dataset_prepare.after_staging") {
          throw new Error("prepare crash");
        }
      }
    });
    const factContext = context("run-prepare", "persist-shop");
    createRecoverableRun(store, "run-prepare", factContext);
    const fact = putFact(store, factContext).fact;
    const prepareContext = context("run-prepare", "prepare-dataset");
    store.commitRecoverableTransition({
      runId: "run-prepare",
      expectedRevision: 0,
      nextStatus: "waiting_browser",
      checkpoint: checkpoint("run-prepare", 2, prepareContext),
      expectedCheckpointRevision: 1,
      event: event("run-prepare", 2)
    });
    const definition = dataset([fact.record], "2026.8.9-run-prepare");
    const input = {
      publicationIntentId: "intent:run-prepare",
      runId: "run-prepare",
      stagingId: "staging:run-prepare",
      dataset: definition,
      factKeys: [fact.factKey],
      audit: audit(definition.metadata.version),
      quality: "complete" as const,
      coverage: completeCoverage,
      executionContext: prepareContext,
      preparedAt: timestamp
    };
    expect(() =>
      store.prepareOperationalDatasetPublication(input)
    ).toThrow("prepare crash");
    expect(store.getDatasetStaging(input.stagingId)).toBeUndefined();
    expect(
      store.getPreparedOperationalDatasetPublication(input.runId)
    ).toBeUndefined();

    crash = false;
    const prepared = store.prepareOperationalDatasetPublication(input);
    expect(store.prepareOperationalDatasetPublication(input)).toEqual(prepared);
    expect(store.getDatasetStaging(input.stagingId)).toMatchObject({
      state: "validated"
    });
    expect(() => putFact(store, factContext)).toThrow(StaleFencingTokenError);
    store.close();
  });

  it("lets an uncertain Run retain an unproven prepared intent without publishing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const prepared = preparePublication(
      store,
      "run-no-marker",
      "2026.8.9-run-no-marker"
    );
    store.commitRecoverableTransition({
      runId: prepared.run.id,
      expectedRevision: 1,
      nextStatus: "uncertain",
      checkpoint: checkpoint(prepared.run.id, 3, undefined, "uncertain"),
      expectedCheckpointRevision: 2,
      output: { status: "complete" },
      event: event(prepared.run.id, 3),
      ...attentionPair(prepared.run.id)
    });
    expect(store.getRun(prepared.run.id)?.status).toBe("uncertain");
    expect(
      store.getDataset(
        prepared.definition.metadata.id,
        prepared.definition.metadata.version
      )
    ).toBeUndefined();
    expect(
      store.getPreparedOperationalDatasetPublication(prepared.run.id)
    ).toBeDefined();
    store.close();
  });

  it("rolls back succeeded terminal state when a prepared intent marker is missing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const prepared = preparePublication(
      store,
      "run-succeeded-no-marker",
      "2026.8.9-run-succeeded-no-marker"
    );
    expect(() =>
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(prepared.run.id, 3, undefined, "succeeded"),
        expectedCheckpointRevision: 2,
        output: { status: "complete" },
        event: event(prepared.run.id, 3)
      })
    ).toThrow("requires its publication marker");
    expect(store.getRun(prepared.run.id)).toMatchObject({
      status: "waiting_browser",
      revision: 1
    });
    expect(store.getEngineCheckpoint(prepared.run.id)?.stateRevision).toBe(2);
    expect(
      store.getDataset(
        prepared.definition.metadata.id,
        prepared.definition.metadata.version
      )
    ).toBeUndefined();
    expect(
      store.getPreparedOperationalDatasetPublication(prepared.run.id)
    ).toBeDefined();
    store.close();
  });

  it("rejects a marker that does not exactly match terminal output", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const prepared = preparePublication(
      store,
      "run-marker-mismatch",
      "2026.8.9-run-marker-mismatch"
    );
    expect(() =>
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(prepared.run.id, 3, undefined, "succeeded"),
        expectedCheckpointRevision: 2,
        output: {
          operationalDatasetPublicationIntentId: prepared.publicationIntentId
        },
        event: event(prepared.run.id, 3)
      })
    ).toThrow("must be passed explicitly");
    expect(() =>
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: "waiting_browser",
        checkpoint: checkpoint(prepared.run.id, 3, prepared.prepareContext),
        expectedCheckpointRevision: 2,
        output: {
          operationalDatasetPublicationIntentId: prepared.publicationIntentId
        },
        operationalDatasetPublicationIntentId: prepared.publicationIntentId,
        event: event(prepared.run.id, 3)
      })
    ).toThrow("requires a publishable terminal Run");
    expect(() =>
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(prepared.run.id, 3, undefined, "succeeded"),
        expectedCheckpointRevision: 2,
        output: { operationalDatasetPublicationIntentId: "intent:other" },
        operationalDatasetPublicationIntentId: prepared.publicationIntentId,
        event: event(prepared.run.id, 3)
      })
    ).toThrow("must match terminal output");
    expect(store.getRun(prepared.run.id)).toMatchObject({
      status: "waiting_browser",
      revision: 1
    });
    store.close();
  });

  it("rejects publishing partial coverage as a succeeded Run", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const prepared = preparePublication(
      store,
      "run-partial",
      "2026.8.9-run-partial",
      {
        quality: "partial",
        coverage: {
          discovered: 2,
          collectable: 2,
          attempted: 2,
          persisted: 1,
          failed: 1,
          skipped: 0
        }
      }
    );
    expect(() =>
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(prepared.run.id, 3, undefined, "succeeded"),
        expectedCheckpointRevision: 2,
        output: {
          operationalDatasetPublicationIntentId: prepared.publicationIntentId
        },
        operationalDatasetPublicationIntentId: prepared.publicationIntentId,
        event: event(prepared.run.id, 3)
      })
    ).toThrow("Partial Operational Dataset requires uncertain Run");
    expect(store.getRun(prepared.run.id)?.status).toBe("waiting_browser");
    store.close();
  });

  it.each(["cancelled", "failed", "rejected"] as const)(
    "lets a Run become %s without silently publishing its prepared intent",
    (terminalStatus) => {
      const store = new SqlitePersistence({ path: ":memory:" });
      const prepared = preparePublication(
        store,
        `run-${terminalStatus}`,
        `2026.8.9-run-${terminalStatus}`
      );
      const attention =
        terminalStatus === "cancelled"
          ? {}
          : attentionPair(prepared.run.id);
      store.commitRecoverableTransition({
        runId: prepared.run.id,
        expectedRevision: 1,
        nextStatus: terminalStatus,
        checkpoint: checkpoint(prepared.run.id, 3, undefined, terminalStatus),
        expectedCheckpointRevision: 2,
        event: event(prepared.run.id, 3),
        ...attention
      });
      expect(store.getRun(prepared.run.id)?.status).toBe(terminalStatus);
      expect(
        store.getDataset(
          prepared.definition.metadata.id,
          prepared.definition.metadata.version
        )
      ).toBeUndefined();
      expect(
        store.getPreparedOperationalDatasetPublication(prepared.run.id)
      ).toBeDefined();
      store.close();
    }
  );

  it("anchors catch-up facts to TriggerOccurrence.scheduledAt across midnight", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    const execution = context("run-anchor", "persist-shop");
    createTriggeredRun(
      store,
      "run-anchor",
      execution,
      "2026-08-08T16:30:00.000Z"
    );
    expect(
      store.getOperationalBusinessContext("run-anchor", "Asia/Shanghai")
    ).toEqual({
      businessDate: "2026-08-09",
      anchorAt: "2026-08-08T16:30:00.000Z"
    });
    expect(putFact(store, execution).fact).toMatchObject({
      businessDate: "2026-08-09",
      businessAnchorAt: "2026-08-08T16:30:00.000Z"
    });
    store.close();
  });

  it.each(["trigger", "browser"] as const)(
    "rejects fact writes after the %s lease is lost",
    (leaseKind) => {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = `run-lost-${leaseKind}`;
      const execution = context(runId, "persist-shop");
      const control = createTriggeredRun(
        store,
        runId,
        execution,
        "2026-08-09T05:00:00.000Z"
      );
      if (leaseKind === "trigger") {
        store.releaseTriggerLease({
          concurrencyKey: control.spec.concurrencyKey,
          ownerId: control.attemptId,
          fencingToken: control.triggerLease.fencingToken,
          releasedAt: timestamp
        });
      } else {
        store.releaseBrowserControlLease({
          resourceId: `browser-instance:${control.spec.browserInstanceId}`,
          ownerId: control.attemptId,
          fencingToken: control.browserLease.fencingToken,
          releasedAt: timestamp
        });
      }
      expect(() => putFact(store, execution)).toThrow(StaleFencingTokenError);
      store.close();
    }
  );

  it.each(["trigger", "browser"] as const)(
    "rejects Dataset prepare after the %s lease is lost",
    (leaseKind) => {
      const store = new SqlitePersistence({
        path: ":memory:",
        clock: () => new Date(timestamp)
      });
      const runId = `run-prepare-lost-${leaseKind}`;
      const factContext = context(runId, "persist-shop");
      const control = createTriggeredRun(
        store,
        runId,
        factContext,
        timestamp
      );
      const fact = putFact(store, factContext).fact;
      const prepareContext = context(runId, "prepare-dataset");
      store.commitRecoverableTransition({
        runId,
        expectedRevision: 0,
        nextStatus: "waiting_browser",
        checkpoint: checkpoint(runId, 2, prepareContext),
        expectedCheckpointRevision: 1,
        event: event(runId, 2)
      });
      if (leaseKind === "trigger") {
        store.releaseTriggerLease({
          concurrencyKey: control.spec.concurrencyKey,
          ownerId: control.attemptId,
          fencingToken: control.triggerLease.fencingToken,
          releasedAt: timestamp
        });
      } else {
        store.releaseBrowserControlLease({
          resourceId: `browser-instance:${control.spec.browserInstanceId}`,
          ownerId: control.attemptId,
          fencingToken: control.browserLease.fencingToken,
          releasedAt: timestamp
        });
      }
      const definition = dataset(
        [fact.record],
        `2026.8.9-run-prepare-lost-${leaseKind}`
      );
      expect(() =>
        store.prepareOperationalDatasetPublication({
          publicationIntentId: `intent:${runId}`,
          runId,
          stagingId: `staging:${runId}`,
          dataset: definition,
          factKeys: [fact.factKey],
          audit: audit(definition.metadata.version),
          quality: "complete",
          coverage: completeCoverage,
          executionContext: prepareContext,
          preparedAt: timestamp
        })
      ).toThrow(StaleFencingTokenError);
      expect(store.getDatasetStaging(`staging:${runId}`)).toBeUndefined();
      store.close();
    }
  );

  it("revalidates Trigger ownership before terminal publication", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      clock: () => new Date(timestamp)
    });
    const runId = "run-terminal-lease-loss";
    const factContext = context(runId, "persist-shop");
    const control = createTriggeredRun(store, runId, factContext, timestamp);
    const fact = putFact(store, factContext).fact;
    const prepareContext = context(runId, "prepare-dataset");
    store.commitRecoverableTransition({
      runId,
      expectedRevision: 0,
      nextStatus: "waiting_browser",
      checkpoint: checkpoint(runId, 2, prepareContext),
      expectedCheckpointRevision: 1,
      event: event(runId, 2)
    });
    const definition = dataset(
      [fact.record],
      "2026.8.9-run-terminal-lease-loss"
    );
    const publicationIntentId = `intent:${runId}`;
    store.prepareOperationalDatasetPublication({
      publicationIntentId,
      runId,
      stagingId: `staging:${runId}`,
      dataset: definition,
      factKeys: [fact.factKey],
      audit: audit(definition.metadata.version),
      quality: "complete",
      coverage: completeCoverage,
      executionContext: prepareContext,
      preparedAt: timestamp
    });
    store.releaseBrowserControlLease({
      resourceId: `browser-instance:${control.spec.browserInstanceId}`,
      ownerId: control.attemptId,
      fencingToken: control.browserLease.fencingToken,
      releasedAt: timestamp
    });
    expect(() =>
      store.commitRecoverableTransition({
        runId,
        expectedRevision: 1,
        nextStatus: "succeeded",
        checkpoint: checkpoint(runId, 3, undefined, "succeeded"),
        expectedCheckpointRevision: 2,
        output: { operationalDatasetPublicationIntentId: publicationIntentId },
        operationalDatasetPublicationIntentId: publicationIntentId,
        event: event(runId, 3)
      })
    ).toThrow(StaleFencingTokenError);
    expect(store.getRun(runId)).toMatchObject({
      status: "waiting_browser",
      revision: 1
    });
    expect(
      store.getDataset(definition.metadata.id, definition.metadata.version)
    ).toBeUndefined();
    store.close();
  });

  it.each([
    "operational_dataset_publication.after_dataset",
    "operational_dataset_publication.after_lineage"
  ] as const)(
    "rolls back Run, checkpoint, Dataset and lineage when %s crashes",
    (failurePoint) => {
      let crash = false;
      const store = new SqlitePersistence({
        path: ":memory:",
        failureInjector(point) {
          if (crash && point === failurePoint) {
            throw new Error("crash");
          }
        }
      });
      const factContext = context("run-crash", "persist-shop");
      const run = createRecoverableRun(store, "run-crash", factContext);
      const fact = putFact(store, factContext).fact;
      const prepareContext = context("run-crash", "prepare-dataset");
      store.commitRecoverableTransition({
        runId: run.id,
        expectedRevision: 0,
        nextStatus: "waiting_browser",
        checkpoint: checkpoint(run.id, 2, prepareContext),
        expectedCheckpointRevision: 1,
        event: event(run.id, 2)
      });
      const definition = dataset(
        [fact.record],
        "2026.8.9-run-run-crash"
      );
      store.prepareOperationalDatasetPublication({
        publicationIntentId: "intent:run-crash",
        runId: run.id,
        stagingId: "staging-run-crash",
        dataset: definition,
        factKeys: [fact.factKey],
        audit: audit(definition.metadata.version),
        quality: "complete",
        coverage: completeCoverage,
        executionContext: prepareContext,
        preparedAt: timestamp
      });

      crash = true;
      expect(() =>
        store.commitRecoverableTransition({
          runId: run.id,
          expectedRevision: 1,
          nextStatus: "succeeded",
          checkpoint: checkpoint(run.id, 3, undefined, "succeeded"),
          expectedCheckpointRevision: 2,
          output: {
            operationalDatasetPublicationIntentId: "intent:run-crash"
          },
          operationalDatasetPublicationIntentId: "intent:run-crash",
          event: event(run.id, 3)
        })
      ).toThrow("crash");
      expect(store.getRun(run.id)).toMatchObject({
        status: "waiting_browser",
        revision: 1
      });
      expect(store.getEngineCheckpoint(run.id)?.stateRevision).toBe(2);
      expect(
        store.getDataset(definition.metadata.id, definition.metadata.version)
      ).toBeUndefined();
      expect(store.getDatasetStaging("staging-run-crash")?.state).toBe(
        "validated"
      );
      expect(
        store.getPreparedOperationalDatasetPublication(run.id)
      ).toBeDefined();
      expect(
        store.getOperationalDatasetPublicationLineage(
          definition.metadata.id,
          definition.metadata.version
        )
      ).toBeUndefined();
      store.close();
    }
  );

  it("rejects empty, cross-Run and non-SemVer publication intents", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const firstContext = context("run-guards", "prepare-dataset");
    createRecoverableRun(store, "run-guards", firstContext);
    const empty = dataset([], "2026.8.9-run-guards");
    expect(() =>
      store.prepareOperationalDatasetPublication({
        publicationIntentId: "intent:guards-empty",
        runId: "run-guards",
        stagingId: "staging-guards",
        dataset: empty,
        factKeys: [],
        audit: audit(empty.metadata.version),
        quality: "complete",
        coverage: { ...completeCoverage, persisted: 0, attempted: 0 },
        executionContext: firstContext,
        preparedAt: timestamp
      })
    ).toThrow("at least one fact");
    expect(() =>
      store.prepareOperationalDatasetPublication({
        publicationIntentId: "intent:guards-semver",
        runId: "run-guards",
        stagingId: "staging-guards",
        dataset: { ...empty, metadata: { ...empty.metadata, version: "2026-08-09" } },
        factKeys: ["fact:missing"],
        audit: audit("2026-08-09"),
        quality: "complete",
        coverage: completeCoverage,
        executionContext: firstContext,
        preparedAt: timestamp
      })
    ).toThrow("SemVer");
    store.close();
  });
});
