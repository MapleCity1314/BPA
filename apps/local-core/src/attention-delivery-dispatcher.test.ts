import { describe, expect, it, vi } from "vitest";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import type { RunRecord } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import {
  AttentionDeliveryDispatcher,
  type OperatorNotificationChannel
} from "./attention-delivery-dispatcher.js";

const createdAt = "2026-08-09T06:00:00.000Z";
const terminalAt = "2026-08-09T06:01:00.000Z";

function pendingStore(): SqlitePersistence {
  const store = new SqlitePersistence({ path: ":memory:" });
  const run: RunRecord = {
    id: "run-notification",
    workflowId: "doudian.inventory.refresh",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:test",
    status: "running",
    revision: 0,
    input: {},
    createdAt,
    updatedAt: createdAt
  };
  store.createRun({
    run,
    event: {
      id: "event-created",
      runId: run.id,
      sequence: 1,
      type: "RUN_CREATED",
      payload: {},
      occurredAt: createdAt
    }
  });
  const terminalEvent = {
    id: "event-terminal",
    runId: run.id,
    sequence: 2,
    type: "RUN_REJECTED",
    payload: { errorCode: "SESSION_EXPIRED" },
    occurredAt: terminalAt
  };
  const item = projectTerminalRunAttention({
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: "rejected",
    updatedAt: terminalAt,
    events: [terminalEvent]
  });
  store.commitRunTransition({
    runId: run.id,
    expectedRevision: run.revision,
    nextStatus: "rejected",
    attention: { item, state: "open", revision: 0 },
    attentionDelivery: createTerminalAttentionDelivery({
      attention: item,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion
    }),
    event: terminalEvent
  });
  return store;
}

function dispatcher(
  store: SqlitePersistence,
  channel: OperatorNotificationChannel
): AttentionDeliveryDispatcher {
  const timestamps = [
    Date.parse("2026-08-09T06:02:00.000Z"),
    Date.parse("2026-08-09T06:02:01.000Z"),
    Date.parse("2026-08-09T06:02:02.000Z")
  ];
  return new AttentionDeliveryDispatcher({
    persistence: store,
    channel,
    workerId: "worker-test",
    now: () => timestamps.shift()!,
    id: () => "lease-test"
  });
}

describe("Attention delivery dispatcher", () => {
  it("records provider acceptance once and then becomes idle", async () => {
    const store = pendingStore();
    const deliver = vi.fn(async () => ({
      status: "delivered" as const,
      providerReceiptId: "provider-request-1"
    }));
    const worker = dispatcher(store, { deliver });

    await expect(worker.dispatchNext()).resolves.toMatchObject({
      status: "delivered",
      delivery: {
        state: "delivered",
        attempt: 1,
        providerReceiptId: "provider-request-1"
      }
    });
    await expect(worker.dispatchNext()).resolves.toEqual({
      status: "idle",
      expiredLeaseCount: 0
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("persists an explicit provider rejection without retry", async () => {
    const store = pendingStore();
    const deliver = vi.fn(async () => ({
      status: "failed" as const,
      errorCode: "PROVIDER_REJECTED"
    }));
    const worker = dispatcher(store, { deliver });

    await expect(worker.dispatchNext()).resolves.toMatchObject({
      status: "failed",
      delivery: {
        state: "failed",
        attempt: 1,
        lastErrorCode: "PROVIDER_REJECTED"
      }
    });
    await expect(worker.dispatchNext()).resolves.toMatchObject({
      status: "idle"
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("sanitizes a transport exception as uncertain without retry", async () => {
    const store = pendingStore();
    const deliver = vi.fn(async () => {
      throw new Error("secret provider response body");
    });
    const worker = dispatcher(store, { deliver });

    const result = await worker.dispatchNext();
    expect(result).toMatchObject({
      status: "uncertain",
      delivery: {
        state: "uncertain",
        attempt: 1,
        lastErrorCode: "DELIVERY_TRANSPORT_UNCERTAIN"
      }
    });
    expect(JSON.stringify(result)).not.toContain(
      "secret provider response body"
    );
    await expect(worker.dispatchNext()).resolves.toMatchObject({
      status: "idle"
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    store.close();
  });
});
