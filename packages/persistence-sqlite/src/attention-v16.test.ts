import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type {
  AttentionDeliveryRecord,
  AttentionRecord,
  ExecutionEventRecord,
  RunRecord
} from "@bpa/persistence";
import { RevisionConflictError } from "@bpa/persistence";
import {
  migrationChecksum,
  migrations,
  SqlitePersistence
} from "./index.js";

const createdAt = "2026-08-09T06:00:00.000Z";
const terminalAt = "2026-08-09T06:01:00.000Z";

function run(): RunRecord {
  return {
    id: "run-attention",
    workflowId: "doudian.inventory.refresh",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:test",
    status: "running",
    revision: 0,
    input: {},
    createdAt,
    updatedAt: createdAt
  };
}

function event(sequence: number, type: string): ExecutionEventRecord {
  return {
    id: `event-${sequence}`,
    runId: "run-attention",
    sequence,
    type,
    payload: {},
    occurredAt: sequence === 1 ? createdAt : terminalAt
  };
}

function attention(): AttentionRecord {
  return {
    sourceRef: { kind: "workflow-run", runId: "run-attention" },
    deliveryPolicy: "operator-notification",
    item: {
      id: "run-terminal:run-attention",
      runId: "run-attention",
      stageKey: "collect",
      groupKey: "authentication",
      kind: "blocking",
      source: "browser",
      title: "浏览器登录或验证需要处理",
      reason: "浏览器返回了登录阻断。",
      requestedAction: "人工处理后显式创建新 Run。",
      blocking: true,
      batchable: false,
      attemptedActions: [],
      resumesAutomatically: false,
      createdAt: terminalAt
    },
    state: "open",
    revision: 0
  };
}

function delivery(): AttentionDeliveryRecord {
  const payload = {
    attentionId: attention().item.id,
    runId: "run-attention"
  };
  return {
    id: "delivery:attention:run-terminal:run-attention:operator-notification",
    attentionId: attention().item.id,
    channel: "operator-notification",
    idempotencyKey:
      "attention:run-terminal:run-attention:operator-notification",
    requestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`,
    payload,
    state: "pending",
    revision: 0,
    attempt: 0,
    createdAt: terminalAt,
    updatedAt: terminalAt
  };
}

function seed(store: SqlitePersistence): RunRecord {
  const value = run();
  return store.createRun({ run: value, event: event(1, "RUN_CREATED") });
}

describe("durable Attention delivery schema v21", () => {
  it("refuses to migrate an occupied legacy Attention control plane", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-attention-v20-"));
    const path = join(directory, "bpa.sqlite3");
    try {
      const legacy = new Database(path);
      legacy.pragma("foreign_keys = ON");
      for (const migration of migrations.filter(({ version }) => version <= 20)) {
        legacy.transaction(() => {
          legacy.exec(migration.sql);
          const hasChecksum = (legacy
            .prepare("PRAGMA table_info(schema_migrations)")
            .all() as Array<{ name:string }>).some(
              ({ name }) => name === "checksum"
            );
          legacy.prepare(
            hasChecksum
              ? `INSERT INTO schema_migrations(version,applied_at,checksum)
                 VALUES (?,?,?)`
              : `INSERT INTO schema_migrations(version,applied_at)
                 VALUES (?,?)`
          ).run(
            ...(hasChecksum
              ? [migration.version,createdAt,migrationChecksum(migration)]
              : [migration.version,createdAt])
          );
          if (hasChecksum) {
            const update = legacy.prepare(
              `UPDATE schema_migrations SET checksum=?
               WHERE version=? AND checksum IS NULL`
            );
            for (const applied of migrations.filter(
              ({ version }) => version <= migration.version
            )) {
              update.run(migrationChecksum(applied),applied.version);
            }
          }
        })();
      }
      const value = attention();
      const notification = delivery();
      legacy.prepare(
        `INSERT INTO workflow_runs(
          id,workflow_id,workflow_version,workflow_digest,status,revision,
          input_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,0,'{}',?,?)`
      ).run(
        run().id,run().workflowId,run().workflowVersion,run().workflowDigest,
        "uncertain",createdAt,terminalAt
      );
      legacy.prepare(
        `INSERT INTO attention_records(
          attention_id,run_id,stage_key,group_key,kind,source,title,reason,
          requested_action,blocking,batchable,attempted_actions_json,
          resumes_automatically,state,revision,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',?,'open',0,?)`
      ).run(
        value.item.id,value.item.runId,value.item.stageKey,value.item.groupKey,
        value.item.kind,value.item.source,value.item.title,value.item.reason,
        value.item.requestedAction,1,0,0,value.item.createdAt
      );
      legacy.prepare(
        `INSERT INTO attention_deliveries(
          delivery_id,attention_id,channel,idempotency_key,request_digest,
          payload_json,state,revision,attempt,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,'pending',0,0,?,?)`
      ).run(
        notification.id,notification.attentionId,notification.channel,
        notification.idempotencyKey,notification.requestDigest,
        JSON.stringify(notification.payload),notification.createdAt,
        notification.updatedAt
      );
      legacy.close();

      expect(() => new SqlitePersistence({ path })).toThrow(
        "Schema 21 requires an empty legacy Attention control plane"
      );
      const unchanged = new Database(path, { readonly:true });
      expect(
        (unchanged.prepare(
          "SELECT MAX(version) AS version FROM schema_migrations"
        ).get() as { version:number }).version
      ).toBe(20);
      expect(
        (unchanged.prepare(
          "SELECT COUNT(*) AS count FROM attention_records"
        ).get() as { count:number }).count
      ).toBe(1);
      expect(
        (unchanged.prepare(
          "SELECT COUNT(*) AS count FROM attention_deliveries"
        ).get() as { count:number }).count
      ).toBe(1);
      unchanged.close();
    } finally {
      rmSync(directory,{ recursive:true,force:true });
    }
  });

  it("rolls a terminal transition back when its Attention delivery is missing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const value = seed(store);

    expect(() =>
      store.commitRunTransition({
        runId: value.id,
        expectedRevision: value.revision,
        nextStatus: "rejected",
        event: event(2, "RUN_REJECTED")
      })
    ).toThrow(/requires one new Attention delivery pair/u);
    expect(store.getRun(value.id)).toMatchObject({
      status: "running",
      revision: 0
    });
    expect(store.listEvents(value.id)).toHaveLength(1);
    expect(store.queryAttention({ states: ["open"], limit: 20 }).records).toEqual([]);
    expect(store.listAttentionDeliveries({ limit: 20 })).toEqual([]);
    store.close();
  });

  it("rolls the terminal pair back when the immutable request digest differs", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const value = seed(store);

    expect(() =>
      store.commitRunTransition({
        runId: value.id,
        expectedRevision: value.revision,
        nextStatus: "failed",
        attention: attention(),
        attentionDelivery: {
          ...delivery(),
          requestDigest:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        },
        event: event(2, "RUN_FAILED")
      })
    ).toThrow(/request digest does not match payload/u);
    expect(store.getRun(value.id)).toMatchObject({
      status: "running",
      revision: 0
    });
    expect(store.queryAttention({ limit: 20 }).records).toEqual([]);
    expect(store.listAttentionDeliveries({ limit: 20 })).toEqual([]);
    store.close();
  });

  it("survives restart and acknowledges with revision CAS", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-attention-v16-"));
    const path = join(directory, "bpa.sqlite3");
    try {
      const first = new SqlitePersistence({ path });
      const value = seed(first);
      first.commitRunTransition({
        runId: value.id,
        expectedRevision: value.revision,
        nextStatus: "uncertain",
        attention: attention(),
        attentionDelivery: delivery(),
        event: event(2, "RUN_UNCERTAIN")
      });
      first.close();

      const second = new SqlitePersistence({ path });
      expect(second.queryAttention({ states: ["open"], limit: 20 }).records).toEqual([
        attention()
      ]);
      expect(second.listAttentionDeliveries({ limit: 20 })).toEqual([
        delivery()
      ]);
      expect(
        second.acknowledgeAttention({
          id: attention().item.id,
          expectedRevision: 0,
          actor: "operator:test",
          acknowledgedAt: "2026-08-09T06:02:00.000Z"
        })
      ).toMatchObject({
        state: "acknowledged",
        revision: 1,
        acknowledgedBy: "operator:test"
      });
      expect(
        second.listAudit("attention:run-terminal:run-attention")
      ).toEqual([
        expect.objectContaining({
          action: "attention.acknowledged",
          actor: "operator:test",
          detail: {
            runId: "run-attention",
            previousRevision: 0,
            revision: 1
          }
        })
      ]);
      expect(() =>
        second.acknowledgeAttention({
          id: attention().item.id,
          expectedRevision: 0,
          actor: "operator:stale",
          acknowledgedAt: "2026-08-09T06:03:00.000Z"
        })
      ).toThrow(RevisionConflictError);
      second.close();

      const third = new SqlitePersistence({ path });
      expect(third.queryAttention({ states: ["open"], limit: 20 }).records).toEqual([]);
      expect(third.getAttention(attention().item.id)).toMatchObject({
        state: "acknowledged",
        revision: 1,
        acknowledgedBy: "operator:test"
      });
      expect(third.getAttentionDelivery(delivery().id)).toEqual(delivery());
      third.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("claims once and records a delivered provider acknowledgement", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      idFactory: () => "audit-delivered"
    });
    const value = seed(store);
    store.commitRunTransition({
      runId: value.id,
      expectedRevision: value.revision,
      nextStatus: "failed",
      attention: attention(),
      attentionDelivery: delivery(),
      event: event(2, "RUN_FAILED")
    });

    const claimed = store.claimNextAttentionDelivery({
      leaseId: "lease-1",
      leaseOwner: "worker-1",
      claimedAt: "2026-08-09T06:02:00.000Z",
      leaseExpiresAt: "2026-08-09T06:03:00.000Z"
    });
    expect(claimed).toMatchObject({
      state: "delivering",
      revision: 1,
      attempt: 1,
      leaseId: "lease-1"
    });
    expect(
      store.claimNextAttentionDelivery({
        leaseId: "lease-2",
        leaseOwner: "worker-2",
        claimedAt: "2026-08-09T06:02:10.000Z",
        leaseExpiresAt: "2026-08-09T06:03:10.000Z"
      })
    ).toBeUndefined();

    expect(
      store.completeAttentionDelivery({
        id: delivery().id,
        expectedRevision: claimed!.revision,
        leaseId: "lease-1",
        outcome: "delivered",
        providerReceiptId: "provider-request-1",
        completedAt: "2026-08-09T06:02:30.000Z"
      })
    ).toMatchObject({
      state: "delivered",
      revision: 2,
      attempt: 1,
      providerReceiptId: "provider-request-1"
    });
    expect(() =>
      store.completeAttentionDelivery({
        id: delivery().id,
        expectedRevision: claimed!.revision,
        leaseId: "lease-1",
        outcome: "delivered",
        completedAt: "2026-08-09T06:02:31.000Z"
      })
    ).toThrow(RevisionConflictError);
    expect(store.listAudit(`attention-delivery:${delivery().id}`)).toEqual([
      expect.objectContaining({
        action: "attention.delivery.completed",
        actor: "delivery:worker-1",
        detail: expect.objectContaining({ outcome: "delivered", attempt: 1 })
      })
    ]);
    store.close();
  });

  it("expires an ambiguous in-flight delivery to uncertain without retry", () => {
    const store = new SqlitePersistence({
      path: ":memory:",
      idFactory: () => "audit-expired"
    });
    const value = seed(store);
    store.commitRunTransition({
      runId: value.id,
      expectedRevision: value.revision,
      nextStatus: "uncertain",
      attention: attention(),
      attentionDelivery: delivery(),
      event: event(2, "RUN_UNCERTAIN")
    });
    store.claimNextAttentionDelivery({
      leaseId: "lease-expired",
      leaseOwner: "worker-crashed",
      claimedAt: "2026-08-09T06:02:00.000Z",
      leaseExpiresAt: "2026-08-09T06:03:00.000Z"
    });

    expect(
      store.expireAttentionDeliveryLeases({
        now: "2026-08-09T06:03:01.000Z"
      })
    ).toBe(1);
    expect(store.getAttentionDelivery(delivery().id)).toMatchObject({
      state: "uncertain",
      revision: 2,
      attempt: 1,
      lastErrorCode: "DELIVERY_LEASE_EXPIRED",
      completedAt: "2026-08-09T06:03:01.000Z"
    });
    expect(
      store.claimNextAttentionDelivery({
        leaseId: "lease-retry",
        leaseOwner: "worker-2",
        claimedAt: "2026-08-09T06:04:00.000Z",
        leaseExpiresAt: "2026-08-09T06:05:00.000Z"
      })
    ).toBeUndefined();
    store.close();
  });
});
