import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe,expect,it } from "vitest";
import type {
  AttentionRecord,
  TriggerOccurrenceRecord,
  TriggerSpecDefinition
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const now = "2026-08-05T00:00:00.000Z";
const spec:TriggerSpecDefinition = {
  apiVersion:"bpa.trigger/v1alpha2",
  id:"inventory.refresh.manual",
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

function occurrence(
  id: string,
  scheduledAt = now,
  overrides: Partial<TriggerOccurrenceRecord> = {}
): TriggerOccurrenceRecord {
  return {
    occurrenceId:id,
    triggerId:spec.id,
    triggerVersion:spec.version,
    occurrenceKey:`manual:${id}`,
    scheduledAt,
    status:"pending",
    attemptCount:0,
    revision:0,
    createdAt:now,
    updatedAt:now,
    ...overrides
  };
}

function occurrenceAttention(
  occurrenceId: string,
  outcome: "missed" | "skipped" | "blocked" | "failed",
  diagnostic: string
): AttentionRecord {
  return {
    sourceRef: { kind:"trigger-occurrence",occurrenceId },
    deliveryPolicy:"dashboard-only",
    item: {
      id:`trigger-occurrence-terminal:${occurrenceId}`,
      stageKey:"trigger",
      groupKey:outcome,
      kind:outcome === "blocked" ? "blocking" : "action",
      source:"runtime",
      title:`Trigger ${outcome}`,
      reason:diagnostic,
      requestedAction:"Review the Trigger occurrence on the dashboard.",
      blocking:outcome === "blocked",
      batchable:false,
      attemptedActions:[],
      resumesAutomatically:false,
      createdAt:now
    },
    state:"open",
    revision:0
  };
}

describe("Trigger occurrence, attempt, schedule and lease persistence",() => {
  it("audits versioned Trigger configuration and enforces CAS enable changes",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const created = store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    expect(created.revision).toBe(1);
    const disabled = store.setTriggerEnabled({
      id:spec.id,expectedRevision:1,enabled:false,actor:"operator",occurredAt:now
    });
    expect(disabled).toMatchObject({ revision:2,spec:{ enabled:false } });
    expect(store.getTriggerSpecVersion(spec.id,spec.version)).toEqual(spec);
    expect(() => store.setTriggerEnabled({
      id:spec.id,expectedRevision:1,enabled:true,actor:"operator",occurredAt:now
    })).toThrow("Trigger revision changed");
    expect(store.listAudit(`trigger:${spec.id}`).map((item) => item.action))
      .toEqual(expect.arrayContaining(["trigger.spec.put","trigger.spec.enable"]));
    store.close();
  });

  it("keeps every TriggerSpec version immutable after the current pointer moves",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    const next = {
      ...spec,
      version:"2.0.0",
      workflow:{ id:"inventory.refresh",version:"2.0.0" },
      concurrencyKey:"inventory:all-shops"
    };
    store.putTriggerSpec({
      spec:next,actor:"operator",occurredAt:"2026-08-05T00:00:01.000Z"
    });

    expect(store.getTriggerSpecVersion(spec.id,"1.0.0")).toEqual(spec);
    expect(store.getTriggerSpecVersion(spec.id,"2.0.0")).toEqual(next);
    expect(() => store.putTriggerSpec({
      spec:{ ...spec,concurrencyKey:"inventory:changed-without-version" },
      actor:"operator",
      occurredAt:"2026-08-05T00:00:02.000Z"
    })).toThrow(`Trigger identity conflict: ${spec.id}@1.0.0`);
    store.close();
  });

  it("deduplicates logical occurrences and retains Dataset lineage",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    const first = occurrence("occ-1",now,{
      datasetId:"inventory",datasetVersion:"2026-08-05"
    });
    expect(store.claimTriggerOccurrence(first)).toEqual({ status:"accepted",record:first });
    expect(store.claimTriggerOccurrence({
      ...first,occurrenceId:"occ-competing"
    })).toEqual({ status:"duplicate",record:first });
    expect(store.getTriggerOccurrence(first.occurrenceId)).toMatchObject({
      datasetId:"inventory",datasetVersion:"2026-08-05",attemptCount:0,revision:0
    });
    const nextSpec = { ...spec,version:"2.0.0" };
    store.putTriggerSpec({
      spec:nextSpec,actor:"operator",occurredAt:"2026-08-05T00:00:01.000Z"
    });
    const nextVersion = {
      ...first,occurrenceId:"occ-v2",triggerVersion:"2.0.0"
    };
    expect(store.claimTriggerOccurrence(nextVersion)).toEqual({
      status:"accepted",record:nextVersion
    });
    store.close();
  });

  it("lists due work in schedule order and excludes deferred work before its retry time",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    store.claimTriggerOccurrence(occurrence("later","2026-08-05T00:02:00.000Z"));
    store.claimTriggerOccurrence(occurrence("earlier","2026-08-05T00:01:00.000Z"));
    store.claimTriggerOccurrence(occurrence("future","2026-08-06T00:00:00.000Z"));
    store.claimTriggerOccurrence(occurrence("deferred","2026-08-05T00:00:00.000Z"));
    store.deferTriggerOccurrence({
      occurrenceId:"deferred",expectedRevision:0,
      nextAttemptAt:"2026-08-05T00:10:00.000Z",updatedAt:now
    });
    expect(store.listRunnableTriggerOccurrences({
      now:"2026-08-05T00:05:00.000Z"
    }).map((item) => item.occurrenceId)).toEqual(["earlier","later"]);
    expect(store.listRunnableTriggerOccurrences({
      now:"2026-08-05T00:10:00.000Z"
    }).map((item) => item.occurrenceId)).toEqual(["deferred","earlier","later"]);
    store.close();
  });

  it("atomically terminalizes a pre-Run occurrence with dashboard-only Attention",() => {
    let injectFailure = true;
    const store = new SqlitePersistence({
      path:":memory:",
      failureInjector(point) {
        if (
          injectFailure &&
          point === "trigger_occurrence.attention.after_occurrence"
        ) {
          throw new Error("simulated Attention crash");
        }
      }
    });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    store.claimTriggerOccurrence(occurrence("occ-missed"));
    const diagnostic = "daily occurrence exceeded its on-time window";
    const attention = occurrenceAttention("occ-missed","missed",diagnostic);

    expect(() => store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-missed",expectedRevision:0,outcome:"missed",
      diagnostic,updatedAt:now,attention
    })).toThrow("simulated Attention crash");
    expect(store.getTriggerOccurrence("occ-missed")).toMatchObject({
      status:"pending",revision:0
    });
    expect(store.queryAttention({ limit:20 }).records).toEqual([]);

    injectFailure = false;
    const finished = store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-missed",expectedRevision:0,outcome:"missed",
      diagnostic,updatedAt:now,attention
    });
    expect(finished).toEqual({
      occurrence:expect.objectContaining({
        status:"terminal",terminalOutcome:"missed",revision:1,diagnostic
      }),
      attention
    });
    expect(store.listAttentionDeliveries({ limit:20 })).toEqual([]);

    expect(store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-missed",expectedRevision:0,outcome:"missed",
      diagnostic,updatedAt:now,attention
    })).toEqual(finished);
    expect(() => store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-missed",expectedRevision:0,outcome:"missed",
      diagnostic:"different",updatedAt:now,
      attention:{ ...attention,item:{ ...attention.item,reason:"different" } }
    })).toThrow("Trigger Occurrence is already terminal");

    store.claimTriggerOccurrence(occurrence("occ-skipped"));
    const skipped = occurrenceAttention(
      "occ-skipped","skipped","older catch-up occurrence superseded"
    );
    store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-skipped",expectedRevision:0,outcome:"skipped",
      diagnostic:"older catch-up occurrence superseded",updatedAt:now,
      attention:skipped
    });
    expect(store.queryAttention({
      sourceKinds:["trigger-occurrence"],appIds:[spec.appId],limit:1
    })).toEqual({ records:[attention],total:2,truncated:true });
    expect(store.queryAttention({
      sourceKinds:["workflow-run"],limit:20
    })).toEqual({ records:[],total:0,truncated:false });
    expect(store.queryAttention({
      appIds:["another-app"],limit:20
    })).toEqual({ records:[],total:0,truncated:false });
    expect(() => store.queryAttention({
      appIds:[],limit:20
    })).toThrow("Attention appId filter is invalid");
    const acknowledged = store.acknowledgeAttention({
      id:attention.item.id,expectedRevision:0,actor:"operator",
      acknowledgedAt:"2026-08-05T00:01:00.000Z"
    });
    expect(store.finishTriggerOccurrenceWithAttention({
      occurrenceId:"occ-missed",expectedRevision:0,outcome:"missed",
      diagnostic,updatedAt:now,attention
    })).toEqual({ occurrence:finished.occurrence,attention:acknowledged });
    store.close();
  });

  it("creates an attempt with an occurrence CAS and does not consume losing claims",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    store.claimTriggerOccurrence(occurrence("occ-attempt"));
    const claimed = store.createTriggerAttempt({
      attemptId:"attempt-1",occurrenceId:"occ-attempt",
      expectedOccurrenceRevision:0,createdAt:now
    });
    expect(claimed).toMatchObject({
      occurrence:{ status:"running",attemptCount:1,revision:1 },
      attempt:{ attemptNumber:1,status:"pending",revision:0 }
    });
    expect(() => store.createTriggerAttempt({
      attemptId:"attempt-loser",occurrenceId:"occ-attempt",
      expectedOccurrenceRevision:0,createdAt:now
    })).toThrow("Trigger Occurrence is not claimable");
    expect(store.getTriggerOccurrence("occ-attempt")?.attemptCount).toBe(1);
    expect(store.listTriggerAttempts("occ-attempt")).toHaveLength(1);
    expect(() => store.updateTriggerAttempt({
      attemptId:"attempt-1",expectedRevision:0,status:"pending",updatedAt:now
    })).toThrow("Invalid Trigger Attempt transition: pending -> pending");

    const running = store.updateTriggerAttempt({
      attemptId:"attempt-1",expectedRevision:0,status:"running",updatedAt:now,
      fencingToken:1,browserFencingToken:2
    });
    expect(running).toMatchObject({ status:"running",revision:1,fencingToken:1 });
    const failedAttention = occurrenceAttention(
      "occ-attempt","failed","attempt failed before Run creation"
    );
    expect(() => store.finishTriggerAttempt({
      attemptId:"attempt-1",expectedAttemptRevision:1,
      occurrenceId:"occ-attempt",expectedOccurrenceRevision:1,
      outcome:"complete",updatedAt:now
    })).toThrow(
      "A pre-Run Trigger Attempt may only terminate as blocked or failed"
    );
    expect(store.getTriggerAttempt("attempt-1")).toMatchObject({
      status:"running",revision:1
    });
    expect(() => store.finishTriggerAttempt({
      attemptId:"attempt-1",expectedAttemptRevision:0,
      occurrenceId:"occ-attempt",expectedOccurrenceRevision:1,
      outcome:"failed",diagnostic:"attempt failed before Run creation",
      updatedAt:now,attention:failedAttention
    })).toThrow("Trigger Attempt finish CAS failed");
    const terminal = store.finishTriggerAttempt({
      attemptId:"attempt-1",expectedAttemptRevision:1,
      occurrenceId:"occ-attempt",expectedOccurrenceRevision:1,
      outcome:"failed",diagnostic:"attempt failed before Run creation",
      updatedAt:now,attention:failedAttention
    });
    expect(() => store.updateTriggerAttempt({
      attemptId:"attempt-1",expectedRevision:terminal.attempt.revision,
      status:"running",updatedAt:now
    })).toThrow("Invalid Trigger Attempt transition: terminal -> running");
    expect(() => store.deferTriggerOccurrence({
      occurrenceId:"occ-attempt",expectedRevision:terminal.occurrence.revision,
      nextAttemptAt:"2026-08-05T01:00:00.000Z",updatedAt:now
    })).toThrow("Invalid Trigger Occurrence transition: terminal -> deferred");
    store.close();
  });

  it("finishes an Attempt and its running Occurrence atomically",() => {
    const diagnostic = "blocked before Run creation";
    const attention = occurrenceAttention("occ-finish","blocked",diagnostic);
    let injectFailure = true;
    const store = new SqlitePersistence({
      path:":memory:",
      failureInjector(point) {
        if (injectFailure && point === "trigger_attempt.finish.after_attempt") {
          throw new Error("simulated finish crash");
        }
      }
    });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    store.claimTriggerOccurrence(occurrence("occ-finish"));
    store.createTriggerAttempt({
      attemptId:"attempt-finish",occurrenceId:"occ-finish",
      expectedOccurrenceRevision:0,createdAt:now
    });

    expect(() => store.finishTriggerAttempt({
      attemptId:"attempt-finish",expectedAttemptRevision:0,
      occurrenceId:"occ-finish",expectedOccurrenceRevision:1,
      outcome:"blocked",diagnostic,updatedAt:now,attention
    })).toThrow("simulated finish crash");
    expect(store.getTriggerAttempt("attempt-finish")).toMatchObject({
      status:"pending",revision:0
    });
    expect(store.getTriggerOccurrence("occ-finish")).toMatchObject({
      status:"running",revision:1
    });

    injectFailure = false;
    expect(() => store.finishTriggerAttempt({
      attemptId:"attempt-finish",expectedAttemptRevision:0,
      occurrenceId:"occ-finish",expectedOccurrenceRevision:0,
      outcome:"blocked",diagnostic,updatedAt:now,attention
    })).toThrow("Trigger Occurrence finish CAS failed");
    expect(store.getTriggerAttempt("attempt-finish")).toMatchObject({
      status:"pending",revision:0
    });
    expect(store.getTriggerOccurrence("occ-finish")).toMatchObject({
      status:"running",revision:1
    });

    expect(() => store.finishTriggerAttempt({
      attemptId:"attempt-finish",expectedAttemptRevision:1,
      occurrenceId:"occ-finish",expectedOccurrenceRevision:1,
      outcome:"blocked",diagnostic,updatedAt:now,attention
    })).toThrow("Trigger Attempt finish CAS failed");

    expect(store.finishTriggerAttempt({
      attemptId:"attempt-finish",expectedAttemptRevision:0,
      occurrenceId:"occ-finish",expectedOccurrenceRevision:1,
      outcome:"blocked",diagnostic,updatedAt:now,attention
    })).toMatchObject({
      attempt:{ status:"terminal",terminalOutcome:"blocked",revision:1,
        diagnostic },
      occurrence:{ status:"terminal",terminalOutcome:"blocked",revision:2,
        diagnostic }
    });
    expect(store.getAttention(attention.item.id)).toEqual(attention);
    expect(store.listAttentionDeliveries({ limit:20 })).toEqual([]);
    expect(store.finishTriggerAttempt({
      attemptId:"attempt-finish",expectedAttemptRevision:0,
      occurrenceId:"occ-finish",expectedOccurrenceRevision:1,
      outcome:"blocked",diagnostic,updatedAt:now,attention
    })).toMatchObject({
      attempt:{ status:"terminal",terminalOutcome:"blocked" },
      occurrence:{ status:"terminal",terminalOutcome:"blocked" }
    });
    store.close();
  });

  it("returns every active attempt beyond the historical 200-row window",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    for (let index = 0; index < 205; index += 1) {
      const occurrenceId = `occ-${index}`;
      store.claimTriggerOccurrence(occurrence(occurrenceId));
      store.createTriggerAttempt({
        attemptId:`attempt-${index}`,occurrenceId,
        expectedOccurrenceRevision:0,createdAt:now
      });
    }
    expect(store.listActiveTriggerAttempts(spec.id)).toHaveLength(205);
    expect(store.listActiveTriggerOccurrences(spec.id)).toHaveLength(205);
    store.close();
  });

  it("initializes one schedule cursor anchor and advances it with CAS",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    const initial = store.initializeTriggerScheduleState({
      triggerId:spec.id,triggerVersion:spec.version,cursorAt:now,createdAt:now
    });
    expect(initial).toMatchObject({ cursorAt:now,revision:0 });
    expect(store.initializeTriggerScheduleState({
      triggerId:spec.id,triggerVersion:spec.version,
      cursorAt:"2026-08-06T00:00:00.000Z",createdAt:"2026-08-06T00:00:00.000Z"
    })).toEqual(initial);
    expect(store.advanceTriggerScheduleState({
      triggerId:spec.id,triggerVersion:spec.version,expectedRevision:0,
      cursorAt:"2026-08-06T00:00:00.000Z",updatedAt:"2026-08-06T00:00:00.000Z"
    })).toMatchObject({ cursorAt:"2026-08-06T00:00:00.000Z",revision:1 });
    expect(() => store.advanceTriggerScheduleState({
      triggerId:spec.id,triggerVersion:spec.version,expectedRevision:0,
      cursorAt:"2026-08-07T00:00:00.000Z",updatedAt:"2026-08-07T00:00:00.000Z"
    })).toThrow("Trigger Schedule State revision changed");
    expect(() => store.advanceTriggerScheduleState({
      triggerId:spec.id,triggerVersion:spec.version,expectedRevision:1,
      cursorAt:now,updatedAt:"2026-08-07T00:00:00.000Z"
    })).toThrow("Trigger Schedule State revision changed");
    store.close();
  });

  it("fences competing browser owners",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const first = store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-a",now,ttlSeconds:120
    });
    expect(first?.fencingToken).toBe(1);
    const rollbackRenewal = store.renewBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-a",fencingToken:1,
      now:"2026-08-04T23:00:00.000Z",ttlSeconds:120
    });
    expect(rollbackRenewal?.expiresAt).toBe(first?.expiresAt);
    expect(store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-b",now,ttlSeconds:120
    })).toBeUndefined();
    expect(store.releaseBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-a",fencingToken:1,
      releasedAt:"2026-08-05T00:00:01.000Z"
    })).toBe(true);
    const second = store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-b",
      now:"2026-08-05T00:00:02.000Z",ttlSeconds:120
    });
    expect(second?.fencingToken).toBe(2);
    store.close();
  });

  it("refuses to silently remove an occupied legacy Trigger control plane",() => {
    const directory = mkdtempSync(join(tmpdir(),"bpa-trigger-v20-"));
    const path = join(directory,"bpa.sqlite3");
    try {
      const seeded = new SqlitePersistence({ path });
      seeded.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
      seeded.close();
      const legacy = new Database(path);
      legacy.exec(`
        DROP TABLE trigger_schedule_state;
        DROP TABLE trigger_attempts;
        DROP TABLE trigger_occurrences;
        CREATE TABLE trigger_runs (
          trigger_run_id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL REFERENCES trigger_specs(trigger_id) ON DELETE RESTRICT,
          trigger_version TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          status TEXT NOT NULL,
          workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
          fencing_token INTEGER,
          dataset_id TEXT,
          dataset_version TEXT,
          diagnostic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          browser_fencing_token INTEGER,
          UNIQUE(trigger_id, occurrence_key)
        ) STRICT;
        INSERT INTO trigger_runs VALUES (
          'legacy-run', '${spec.id}', '${spec.version}', 'manual:legacy',
          'failed', NULL, 3, 'inventory', 'v1', 'legacy diagnostic',
          '${now}', '${now}', 4
        );
        DELETE FROM schema_migrations WHERE version>=20;
      `);
      legacy.close();

      expect(() => new SqlitePersistence({ path })).toThrow(
        "Schema 20 requires an empty legacy Trigger control plane"
      );
      const unchanged = new Database(path, { readonly: true });
      expect(
        unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get()
      ).toEqual({ version: 19 });
      expect(
        unchanged.prepare("SELECT COUNT(*) AS count FROM trigger_runs").get()
      ).toEqual({ count: 1 });
      unchanged.close();
    } finally {
      rmSync(directory,{ recursive:true,force:true });
    }
  });
});
