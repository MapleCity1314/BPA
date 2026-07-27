import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  RevisionConflictError,
  type ExecutionEventRecord,
  type NodeExecutionRecord,
  type RunRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-07-27T00:00:00.000Z";

function event(
  runId: string,
  sequence: number,
  type: string,
  nodeExecutionId?: string
): ExecutionEventRecord {
  return {
    id: randomUUID(),
    runId,
    ...(nodeExecutionId ? { nodeExecutionId } : {}),
    sequence,
    type,
    payload: {},
    occurredAt: timestamp
  };
}

function createRun(store: SqlitePersistence): RunRecord {
  const run: RunRecord = {
    id: randomUUID(),
    workflowId: "test.workflow",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:test",
    status: "running",
    revision: 0,
    input: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return store.createRun({
    run,
    event: event(run.id, 1, "RUN_CREATED")
  });
}

describe("sqlite persistence", () => {
  it("keeps a published version immutable", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const base = {
      assetType: "workflow" as const,
      assetId: "test.workflow",
      version: "1.0.0",
      digest: "sha256:first",
      content: { version: 1 },
      actor: "test"
    };
    expect(store.publish(base).digest).toBe("sha256:first");
    expect(store.publish(base).digest).toBe("sha256:first");
    expect(() =>
      store.publish({
        ...base,
        digest: "sha256:changed",
        content: { version: 2 }
      })
    ).toThrow(ArtifactConflictError);
    store.close();
  });

  it("atomically advances node state with event, idempotency and outbox", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const run = createRun(store);
    const node: NodeExecutionRecord = {
      id: randomUUID(),
      runId: run.id,
      nodeKey: "observe",
      nodeId: "browser.observe",
      nodeVersion: "1.0.0",
      status: "scheduled",
      revision: 0,
      attempt: 1,
      idempotencyKey: "idem-1",
      fencingToken: 1,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.createNodeExecution(node, event(run.id, 2, "NODE_SCHEDULED", node.id));
    const updated = store.commitNodeTransition({
      nodeExecutionId: node.id,
      expectedRevision: 0,
      nextStatus: "succeeded",
      output: { ok: true },
      event: event(run.id, 3, "NODE_SUCCEEDED", node.id),
      idempotencyResult: {
        key: node.idempotencyKey,
        status: "succeeded",
        result: { ok: true }
      },
      outbox: {
        id: randomUUID(),
        topic: "node.completed",
        aggregateId: node.id,
        payload: { ok: true },
        createdAt: timestamp
      }
    });
    expect(updated.revision).toBe(1);
    expect(updated.output).toEqual({ ok: true });
    expect(store.listEvents(run.id)).toHaveLength(3);
    expect(() =>
      store.commitNodeTransition({
        nodeExecutionId: node.id,
        expectedRevision: 0,
        nextStatus: "failed",
        event: event(run.id, 4, "NODE_FAILED", node.id)
      })
    ).toThrow(RevisionConflictError);
    expect(store.listEvents(run.id)).toHaveLength(3);
    store.close();
  });

  it("deduplicates gateway results and audits stale fencing tokens", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    store.enqueueCommand(
      {
        id: "command-1",
        nodeExecutionId: "node-1",
        commandSeq: 1,
        idempotencyKey: "idem-1",
        fencingToken: 2,
        state: "queued",
        payload: {},
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "outbox-1",
        topic: "command.dispatch",
        aggregateId: "command-1",
        payload: {},
        createdAt: timestamp
      }
    );
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 1,
        result: {},
        inboxMessageId: "message-stale",
        receivedAt: timestamp
      })
    ).toBe("stale");
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 2,
        result: { ok: true },
        inboxMessageId: "message-1",
        receivedAt: timestamp
      })
    ).toBe("accepted");
    expect(
      store.acceptResult({
        commandId: "command-1",
        fencingToken: 2,
        result: { ok: true },
        inboxMessageId: "message-1",
        receivedAt: timestamp
      })
    ).toBe("duplicate");
    store.close();
  });
});
