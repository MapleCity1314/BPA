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
  return new TriggerRuntime(store,(trigger,input,triggerRunId) => {
    const timestamp = now().toISOString();
    const run:RunRecord = {
      id:`run:${randomUUID()}`,workflowId:trigger.spec.workflow.id,
      workflowVersion:trigger.spec.workflow.version,
      workflowDigest:"sha256:test",status:"running",
      revision:0,input,createdAt:timestamp,updatedAt:timestamp
    };
    const created = store.createRun({
      run,
      event:{
        id:randomUUID(),runId:run.id,sequence:1,type:"RUN_CREATED",
        payload:{},occurredAt:timestamp
      }
    });
    store.updateTriggerRun({
      triggerRunId,status:"run_created",updatedAt:timestamp,
      workflowRunId:created.id
    });
    return created;
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

  it("serializes inventory, retired-product, and experience workflows on one browser",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const specifications = [
      ["inventory.schedule","inventory-monitor","inventory.refresh","inventory:cycle"],
      ["retired.schedule","retired-monitor","retired-products.scan","retired:cycle"],
      ["experience.schedule","experience-monitor","experience-score.collect","experience:cycle"]
    ] as const;
    const triggers = specifications.map(([id,appId,workflowId,concurrencyKey]) =>
      store.putTriggerSpec({
        spec:{
          ...base,id,appId,workflow:{ id:workflowId,version:"1.0.0" },
          concurrencyKey,browserInstanceId:"doudian-company-main"
        },
        actor:"operator",occurredAt:current.toISOString()
      })
    );
    const engine = runtime(store,() => current);

    const inventory = engine.fire({
      trigger:triggers[0]!,occurrenceKey:"manual:inventory"
    });
    expect(inventory).toMatchObject({
      status:"run_created",browserFencingToken:1
    });
    expect(engine.fire({
      trigger:triggers[1]!,occurrenceKey:"manual:retired"
    })).toMatchObject({
      status:"skipped",
      diagnostic:"Another active controller owns the browser instance lease."
    });
    expect(engine.fire({
      trigger:triggers[2]!,occurrenceKey:"manual:experience-busy"
    })).toMatchObject({ status:"skipped" });

    const run = store.getRun(inventory.workflowRunId!)!;
    current = new Date("2026-08-05T00:00:01.000Z");
    store.commitRunTransition({
      runId:run.id,expectedRevision:run.revision,nextStatus:"succeeded",
      event:{
        id:randomUUID(),runId:run.id,sequence:2,type:"RUN_SUCCEEDED",
        payload:{},occurredAt:current.toISOString()
      }
    });
    engine.tick();

    expect(engine.fire({
      trigger:triggers[2]!,occurrenceKey:"manual:experience-after-release"
    })).toMatchObject({ status:"run_created",browserFencingToken:2 });
    store.close();
  });

  it("fails closed when a browser lease is fenced by another controller",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    let current = new Date("2026-08-05T00:00:00.000Z");
    const trigger = store.putTriggerSpec({
      spec:{ ...base,browserInstanceId:"doudian-company-main" },
      actor:"operator",occurredAt:current.toISOString()
    });
    const engine = runtime(store,() => current);
    const triggerRun = engine.fire({ trigger,occurrenceKey:"manual:fenced" });
    expect(triggerRun.browserFencingToken).toBe(1);

    current = new Date("2026-08-05T00:00:01.000Z");
    expect(store.releaseBrowserControlLease({
      resourceId:"browser-instance:doudian-company-main",
      ownerId:triggerRun.triggerRunId,
      fencingToken:triggerRun.browserFencingToken!,
      releasedAt:current.toISOString()
    })).toBe(true);
    const successor = store.acquireBrowserControlLease({
      resourceId:"browser-instance:doudian-company-main",
      ownerId:"recovery-session:successor",
      now:current.toISOString(),ttlSeconds:300
    });
    expect(successor?.fencingToken).toBe(2);

    current = new Date("2026-08-05T00:00:02.000Z");
    engine.tick();

    expect(store.listTriggerRuns(base.id)[0]).toMatchObject({
      status:"failed",diagnostic:"Browser instance lease was lost."
    });
    expect(store.listBrowserControlLeases(current.toISOString())).toEqual([
      expect.objectContaining({ ownerId:"recovery-session:successor",fencingToken:2 })
    ]);
    store.close();
  });

  it("releases both leases when startup stopped before Workflow creation",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const now = "2026-08-05T00:00:00.000Z";
    store.putTriggerSpec({
      spec:{ ...base,browserInstanceId:"doudian-company-main" },
      actor:"operator",occurredAt:now
    });
    const triggerRunId = "trigger-run:interrupted-start";
    store.claimTriggerOccurrence({
      triggerRunId,triggerId:base.id,triggerVersion:base.version,
      occurrenceKey:"manual:interrupted-start",status:"due",
      createdAt:now,updatedAt:now
    });
    const triggerLease = store.acquireTriggerLease({
      concurrencyKey:base.concurrencyKey,ownerId:triggerRunId,now,ttlSeconds:300
    })!;
    const browserLease = store.acquireBrowserControlLease({
      resourceId:"browser-instance:doudian-company-main",
      ownerId:triggerRunId,now,ttlSeconds:300
    })!;
    store.updateTriggerRun({
      triggerRunId,status:"lease_acquired",updatedAt:now,
      fencingToken:triggerLease.fencingToken,
      browserFencingToken:browserLease.fencingToken
    });

    runtime(store,() => new Date("2026-08-05T00:00:01.000Z")).tick();

    expect(store.listTriggerRuns(base.id)[0]).toMatchObject({
      status:"failed",
      diagnostic:"Workflow Run was not created before reconciliation."
    });
    expect(store.listBrowserControlLeases("2026-08-05T00:00:01.000Z"))
      .toEqual([]);
    expect(store.acquireTriggerLease({
      concurrencyKey:base.concurrencyKey,ownerId:"next-trigger",
      now:"2026-08-05T00:00:01.000Z",ttlSeconds:300
    })).toBeDefined();
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
