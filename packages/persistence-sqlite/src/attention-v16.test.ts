import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AttentionRecord,
  ExecutionEventRecord,
  RunRecord
} from "@bpa/persistence";
import { RevisionConflictError } from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

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

function seed(store: SqlitePersistence): RunRecord {
  const value = run();
  return store.createRun({ run: value, event: event(1, "RUN_CREATED") });
}

describe("durable Attention schema v16", () => {
  it("rolls a terminal transition back when its Attention fact is missing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const value = seed(store);

    expect(() =>
      store.commitRunTransition({
        runId: value.id,
        expectedRevision: value.revision,
        nextStatus: "rejected",
        event: event(2, "RUN_REJECTED")
      })
    ).toThrow(/requires one new open Attention/u);
    expect(store.getRun(value.id)).toMatchObject({
      status: "running",
      revision: 0
    });
    expect(store.listEvents(value.id)).toHaveLength(1);
    expect(store.listAttention({ states: ["open"], limit: 20 })).toEqual([]);
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
        event: event(2, "RUN_UNCERTAIN")
      });
      first.close();

      const second = new SqlitePersistence({ path });
      expect(second.listAttention({ states: ["open"], limit: 20 })).toEqual([
        attention()
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
      expect(third.listAttention({ states: ["open"], limit: 20 })).toEqual([]);
      expect(third.getAttention(attention().item.id)).toMatchObject({
        state: "acknowledged",
        revision: 1,
        acknowledgedBy: "operator:test"
      });
      third.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
