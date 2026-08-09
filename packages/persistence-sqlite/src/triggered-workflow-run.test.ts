import { describe,expect,it } from "vitest";
import type {
  EngineCheckpointRecord,
  ExecutionEventRecord,
  RunPlanSnapshotRecord,
  RunRecord,
  RunStatus,
  TriggerSpecDefinition
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const workflow = {
  id:"doudian.inventory.production-cycle",
  version:"1.0.0"
} as const;

function triggerSpec(input: {
  id:string;
  version?:string;
  appId?:string;
  workflowId?:string;
  workflowVersion?:string;
}): TriggerSpecDefinition {
  return {
    apiVersion:"bpa.trigger/v1alpha2",
    id:input.id,
    version:input.version ?? "1.0.0",
    appId:input.appId ?? "inventory-monitor",
    kind:"manual",
    workflow:{
      id:input.workflowId ?? workflow.id,
      version:input.workflowVersion ?? workflow.version
    },
    enabled:true,
    inputSchemaVersion:"inventory-production-cycle/1",
    input:{ expectedShopCount:13,shops:[] },
    concurrencyKey:`inventory:${input.id}`,
    idempotencyPolicy:"request_key",
    retryPolicy:"none"
  };
}

function plan(run: RunRecord): RunPlanSnapshotRecord {
  return {
    runId:run.id,
    irVersion:"bpa.workflow-ir/2",
    planDigest:`sha256:plan:${run.id}`,
    workflowSourceDigest:`sha256:workflow:${run.id}`,
    artifactClosureDigest:`sha256:closure:${run.id}`,
    planJson:{
      irVersion:"bpa.workflow-ir/2",
      workflow:{
        id:run.workflowId,
        version:run.workflowVersion,
        digest:run.workflowDigest
      },
      artifactClosure:{ entries:[] },
      riskSnapshot:[],
      limits:{ maxDepth:1,maxStepExecutions:1 },
      entry:"done",
      steps:{ done:{ key:"done",kind:"terminal",status:"succeeded" } }
    },
    riskSnapshot:[],
    createdAt:run.createdAt
  };
}

function checkpoint(run: RunRecord): EngineCheckpointRecord {
  return {
    runId:run.id,
    stateVersion:"bpa.engine-state/2",
    stateRevision:0,
    state:{
      stateVersion:"bpa.engine-state/2",
      runId:run.id,
      revision:0,
      status:"terminal"
    },
    updatedAt:run.updatedAt
  };
}

function event(run: RunRecord): ExecutionEventRecord {
  return {
    id:`event:${run.id}`,
    runId:run.id,
    sequence:1,
    type:"RUN_CREATED",
    payload:{},
    occurredAt:run.createdAt
  };
}

function createTriggeredRun(
  store: SqlitePersistence,
  input: {
    id:string;
    spec:TriggerSpecDefinition;
    scheduledAt:string;
    createdAt:string;
    updatedAt:string;
    status:RunStatus;
    output?:unknown;
  }
): RunRecord {
  store.putTriggerSpec({
    spec:input.spec,
    actor:"test",
    occurredAt:input.createdAt
  });
  const occurrenceId=`occurrence:${input.id}`;
  store.claimTriggerOccurrence({
    occurrenceId,
    triggerId:input.spec.id,
    triggerVersion:input.spec.version,
    occurrenceKey:`scheduled:${input.scheduledAt}:${input.id}`,
    scheduledAt:input.scheduledAt,
    status:"pending",
    attemptCount:0,
    revision:0,
    createdAt:input.createdAt,
    updatedAt:input.createdAt
  });
  const attemptId=`attempt:${input.id}`;
  store.createTriggerAttempt({
    attemptId,
    occurrenceId,
    expectedOccurrenceRevision:0,
    createdAt:input.createdAt
  });
  store.updateTriggerAttempt({
    attemptId,
    expectedRevision:0,
    status:"running",
    updatedAt:input.createdAt,
    fencingToken:1
  });
  const run:RunRecord={
    id:`run:${input.id}`,
    workflowId:input.spec.workflow.id,
    workflowVersion:input.spec.workflow.version,
    workflowDigest:`sha256:workflow:${input.id}`,
    status:input.status,
    revision:0,
    input:{},
    ...(input.output === undefined ? {} : { output:input.output }),
    createdAt:input.createdAt,
    updatedAt:input.updatedAt
  };
  return store.createRecoverableRun({
    run,
    event:event(run),
    planSnapshot:plan(run),
    checkpoint:checkpoint(run),
    triggerAttemptId:attemptId
  });
}

function query(store: SqlitePersistence) {
  return store.getLatestTriggeredWorkflowExecution({
    appId:"inventory-monitor",
    workflowId:workflow.id,
    workflowVersion:workflow.version
  });
}

describe("latest triggered Workflow Run",() => {
  it("uses pinned app and Workflow identity and excludes manual Runs",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    const exact=triggerSpec({ id:"inventory-exact" });
    createTriggeredRun(store,{
      id:"exact",spec:exact,status:"succeeded",
      scheduledAt:"2026-08-10T00:00:00.000Z",
      createdAt:"2026-08-10T00:00:01.000Z",
      updatedAt:"2026-08-10T00:01:00.000Z"
    });
    createTriggeredRun(store,{
      id:"cross-app",spec:triggerSpec({ id:"cross-app",appId:"other-app" }),
      status:"failed",scheduledAt:"2026-08-10T02:00:00.000Z",
      createdAt:"2026-08-10T02:00:01.000Z",
      updatedAt:"2026-08-10T02:01:00.000Z"
    });
    createTriggeredRun(store,{
      id:"other-version",
      spec:triggerSpec({ id:"other-version",workflowVersion:"2.0.0" }),
      status:"uncertain",scheduledAt:"2026-08-10T03:00:00.000Z",
      createdAt:"2026-08-10T03:00:01.000Z",
      updatedAt:"2026-08-10T03:01:00.000Z"
    });
    createTriggeredRun(store,{
      id:"other-workflow",
      spec:triggerSpec({ id:"other-workflow",workflowId:"other.workflow" }),
      status:"failed",scheduledAt:"2026-08-10T03:30:00.000Z",
      createdAt:"2026-08-10T03:30:01.000Z",
      updatedAt:"2026-08-10T03:31:00.000Z"
    });
    const manual:RunRecord={
      id:"run:manual",workflowId:workflow.id,workflowVersion:workflow.version,
      workflowDigest:"sha256:manual",status:"rejected",revision:0,input:{},
      createdAt:"2026-08-10T04:00:00.000Z",
      updatedAt:"2026-08-10T04:01:00.000Z"
    };
    store.createRun({ run:manual,event:event(manual) });

    expect(query(store)).toEqual({
      run:expect.objectContaining({ id:"run:exact",status:"succeeded" }),
      scheduledAt:"2026-08-10T00:00:00.000Z",
      occurrenceStatus:"running"
    });
    store.close();
  });

  it("orders by scheduled occurrence instead of a late old Run update",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    createTriggeredRun(store,{
      id:"newer-cycle",spec:triggerSpec({ id:"newer-cycle" }),
      status:"rejected",scheduledAt:"2026-08-10T02:00:00.000Z",
      createdAt:"2026-08-10T02:00:01.000Z",
      updatedAt:"2026-08-10T02:01:00.000Z"
    });
    createTriggeredRun(store,{
      id:"late-old-cycle",spec:triggerSpec({ id:"late-old-cycle" }),
      status:"uncertain",scheduledAt:"2026-08-10T01:00:00.000Z",
      createdAt:"2026-08-10T01:00:01.000Z",
      updatedAt:"2026-08-10T05:00:00.000Z"
    });

    expect(query(store)).toEqual({
      run:expect.objectContaining({ id:"run:newer-cycle",status:"rejected" }),
      scheduledAt:"2026-08-10T02:00:00.000Z",
      occurrenceStatus:"running"
    });
    store.close();
  });

  it("keeps an old pinned TriggerSpec version attributable after the pointer moves",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    const pinned=triggerSpec({ id:"inventory-pinned" });
    createTriggeredRun(store,{
      id:"pinned",spec:pinned,status:"failed",
      scheduledAt:"2026-08-10T01:00:00.000Z",
      createdAt:"2026-08-10T01:00:01.000Z",
      updatedAt:"2026-08-10T01:01:00.000Z"
    });
    store.putTriggerSpec({
      spec:{ ...pinned,version:"2.0.0",workflow:{ ...workflow,version:"2.0.0" } },
      actor:"test",occurredAt:"2026-08-10T02:00:00.000Z"
    });

    expect(query(store)).toEqual({
      run:expect.objectContaining({ id:"run:pinned",status:"failed" }),
      scheduledAt:"2026-08-10T01:00:00.000Z",
      occurrenceStatus:"running"
    });
    store.close();
  });

  it("returns the latest formal occurrence before Run creation",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    const older=triggerSpec({ id:"older-run" });
    createTriggeredRun(store,{
      id:"older-run",spec:older,status:"succeeded",
      scheduledAt:"2026-08-10T01:00:00.000Z",
      createdAt:"2026-08-10T01:00:01.000Z",
      updatedAt:"2026-08-10T01:01:00.000Z"
    });
    const latest=triggerSpec({ id:"latest-pre-run" });
    store.putTriggerSpec({
      spec:latest,actor:"test",occurredAt:"2026-08-10T02:00:00.000Z"
    });
    store.claimTriggerOccurrence({
      occurrenceId:"occurrence:latest-pre-run",
      triggerId:latest.id,triggerVersion:latest.version,
      occurrenceKey:"scheduled:latest-pre-run",
      scheduledAt:"2026-08-10T02:00:00.000Z",
      status:"pending",attemptCount:0,revision:0,
      createdAt:"2026-08-10T02:00:00.000Z",
      updatedAt:"2026-08-10T02:00:00.000Z"
    });

    expect(query(store)).toEqual({
      scheduledAt:"2026-08-10T02:00:00.000Z",
      occurrenceStatus:"pending"
    });
    store.close();
  });

  it("returns an active latest Run instead of an older healthy terminal Run",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    createTriggeredRun(store,{
      id:"older-success",spec:triggerSpec({ id:"older-success" }),
      status:"succeeded",scheduledAt:"2026-08-10T01:00:00.000Z",
      createdAt:"2026-08-10T01:00:01.000Z",
      updatedAt:"2026-08-10T01:01:00.000Z"
    });
    createTriggeredRun(store,{
      id:"latest-running",spec:triggerSpec({ id:"latest-running" }),
      status:"waiting_browser",scheduledAt:"2026-08-10T02:00:00.000Z",
      createdAt:"2026-08-10T02:00:01.000Z",
      updatedAt:"2026-08-10T02:01:00.000Z"
    });

    expect(query(store)).toEqual({
      run:expect.objectContaining({ id:"run:latest-running",status:"waiting_browser" }),
      scheduledAt:"2026-08-10T02:00:00.000Z",
      occurrenceStatus:"running"
    });
    store.close();
  });

  it("fails closed when a linked terminal occurrence contradicts its Run",() => {
    const store=new SqlitePersistence({ path:":memory:" });
    createTriggeredRun(store,{
      id:"corrupt-outcome",spec:triggerSpec({ id:"corrupt-outcome" }),
      status:"succeeded",scheduledAt:"2026-08-10T01:00:00.000Z",
      createdAt:"2026-08-10T01:00:01.000Z",
      updatedAt:"2026-08-10T01:01:00.000Z"
    });
    const attempt=store.getTriggerAttempt("attempt:corrupt-outcome")!;
    const occurrence=store.getTriggerOccurrence("occurrence:corrupt-outcome")!;
    store.finishTriggerAttempt({
      attemptId:attempt.attemptId,expectedAttemptRevision:attempt.revision,
      occurrenceId:occurrence.occurrenceId,
      expectedOccurrenceRevision:occurrence.revision,
      outcome:"failed",updatedAt:"2026-08-10T01:02:00.000Z"
    });

    expect(() => query(store)).toThrow(
      "Triggered Workflow execution attribution is invalid"
    );
    store.close();
  });
});
