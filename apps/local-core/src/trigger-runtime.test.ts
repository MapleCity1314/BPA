import { randomUUID } from "node:crypto";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import { describe,expect,it } from "vitest";
import type { RunRecord,TriggerSpecDefinition } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import { TriggerRuntime } from "./trigger-runtime.js";

const base:TriggerSpecDefinition = {
  apiVersion:"bpa.trigger/v1alpha1",
  id:"inventory.manual",
  version:"1.0.0",
  appId:"inventory-monitor",
  kind:"manual",
  workflow:{ id:"inventory.refresh",version:"1.0.0" },
  enabled:true,
  inputSchemaVersion:"inventory.refresh-input/1",
  input:{ shopId:"10461048" },
  concurrencyKey:"inventory:10461048",
  idempotencyPolicy:"request_key",
  retryPolicy:"none"
};

function runtime(
  store:SqlitePersistence,
  now:() => Date
):TriggerRuntime {
  return new TriggerRuntime(store,(_trigger,input) => {
    const timestamp = now().toISOString();
    const run:RunRecord = {
      id:`run:${randomUUID()}`,workflowId:"inventory.refresh",
      workflowVersion:"1.0.0",workflowDigest:"sha256:test",status:"running",
      revision:0,input,createdAt:timestamp,updatedAt:timestamp
    };
    return store.createRun({
      run,
      event:{
        id:randomUUID(),runId:run.id,sequence:1,type:"RUN_CREATED",
        payload:{},occurredAt:timestamp
      }
    });
  },now);
}

describe("deterministic Trigger Runtime",() => {
  it("deduplicates one Manual request key and reconciles terminal workflow state",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const trigger = store.putTriggerSpec({
      spec:base,actor:"operator",occurredAt:"2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store,() => new Date("2026-08-05T00:00:00.000Z"));
    const first = engine.fire({ trigger,occurrenceKey:"manual:req-1" });
    expect(first).toMatchObject({ status:"run_created" });
    expect(engine.fire({ trigger,occurrenceKey:"manual:req-1" }).triggerRunId)
      .toBe(first.triggerRunId);
    const run = store.getRun(first.workflowRunId!)!;
    store.commitRunTransition({
      runId:run.id,expectedRevision:run.revision,nextStatus:"succeeded",
      event:{
        id:randomUUID(),runId:run.id,sequence:2,type:"RUN_SUCCEEDED",
        payload:{},occurredAt:"2026-08-05T00:00:01.000Z"
      }
    });
    engine.tick();
    expect(store.listTriggerRuns(base.id)[0]?.status).toBe("complete");
    store.close();
  });

  it("creates at most one Schedule occurrence per interval",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const schedule:TriggerSpecDefinition = {
      ...base,id:"inventory.schedule",kind:"schedule",
      idempotencyPolicy:"occurrence",missedRunPolicy:"run_once",
      schedule:{ intervalSeconds:1800,timezone:"Asia/Shanghai" }
    };
    store.putTriggerSpec({
      spec:schedule,actor:"operator",occurredAt:"2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store,() => new Date("2026-08-05T00:10:00.000Z"));
    engine.tick();
    engine.tick();
    expect(store.listTriggerRuns(schedule.id)).toHaveLength(1);
    store.close();
  });

  it("reconciles an active Run with its pinned TriggerSpec version",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const trigger = store.putTriggerSpec({
      spec:base,actor:"operator",occurredAt:"2026-08-05T00:00:00.000Z"
    });
    const engine = runtime(store,() => new Date("2026-08-05T00:00:00.000Z"));
    const triggerRun = engine.fire({ trigger,occurrenceKey:"manual:req-pinned" });
    store.putTriggerSpec({
      spec:{
        ...base,
        version:"2.0.0",
        workflow:{ id:"inventory.refresh",version:"2.0.0" },
        concurrencyKey:"inventory:replacement"
      },
      actor:"operator",
      occurredAt:"2026-08-05T00:00:01.000Z"
    });
    const run = store.getRun(triggerRun.workflowRunId!)!;
    store.commitRunTransition({
      runId:run.id,expectedRevision:run.revision,nextStatus:"succeeded",
      event:{
        id:randomUUID(),runId:run.id,sequence:2,type:"RUN_SUCCEEDED",
        payload:{},occurredAt:"2026-08-05T00:00:02.000Z"
      }
    });

    engine.tick();

    expect(store.listTriggerRuns(base.id)[0]).toMatchObject({
      triggerVersion:"1.0.0",status:"complete"
    });
    expect(store.acquireTriggerLease({
      concurrencyKey:base.concurrencyKey,
      ownerId:"next-run",
      now:"2026-08-05T00:00:03.000Z",
      ttlSeconds:300
    })).toBeDefined();
    store.close();
  });

  it.each(["rejected","uncertain","cancelled","failed"] as const)(
    "preserves the %s Workflow terminal status",
    (terminalStatus) => {
      const store = new SqlitePersistence({ path:":memory:" });
      const trigger = store.putTriggerSpec({
        spec:base,actor:"operator",occurredAt:"2026-08-05T00:00:00.000Z"
      });
      const engine = runtime(store,() => new Date("2026-08-05T00:00:00.000Z"));
      const triggerRun = engine.fire({
        trigger,
        occurrenceKey:`manual:req-${terminalStatus}`
      });
      const run = store.getRun(triggerRun.workflowRunId!)!;
      const terminalEvent = {
        id:randomUUID(),runId:run.id,sequence:2,
        type:`RUN_${terminalStatus.toUpperCase()}`,
        payload:{},occurredAt:"2026-08-05T00:00:01.000Z"
      };
      const item = terminalStatus === "cancelled"
        ? undefined
        : projectTerminalRunAttention({
            id:run.id,workflowId:run.workflowId,
            workflowVersion:run.workflowVersion,status:terminalStatus,
            updatedAt:terminalEvent.occurredAt,events:[terminalEvent]
          });
      store.commitRunTransition({
        runId:run.id,expectedRevision:run.revision,nextStatus:terminalStatus,
        ...(item ? {
          attention:{
            item,
            state:"open" as const,revision:0
          },
          attentionDelivery:createTerminalAttentionDelivery({
            attention:item,
            workflowId:run.workflowId,
            workflowVersion:run.workflowVersion
          })
        } : {}),
        event:terminalEvent
      });

      engine.tick();

      expect(store.listTriggerRuns(base.id)[0]?.status).toBe(terminalStatus);
      store.close();
    }
  );
});
