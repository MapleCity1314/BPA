import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectTerminalRunAttention } from "@bpa/attention-core";
import type { RunRecord } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";
import { createOperatorNotificationDispatcher } from "./operator-notification.js";

function fixture(mode = 0o600): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "bpa-notification-config-"));
  const path = join(directory, "operator-notification.json");
  writeFileSync(
    path,
    JSON.stringify({
      provider: "feishu-webhook",
      webhookUrl:
        "https://open.feishu.cn/open-apis/bot/v2/hook/example"
    }),
    { mode }
  );
  chmodSync(path, mode);
  return { directory, path };
}

function seedDelivery(persistence: SqlitePersistence): void {
  const createdAt = "2026-08-09T05:59:00.000Z";
  const terminalAt = "2026-08-09T06:00:00.000Z";
  const run: RunRecord = {
    id: "run-configured-notification",
    workflowId: "doudian.inventory.refresh",
    workflowVersion: "1.0.0",
    workflowDigest: "sha256:test",
    status: "running",
    revision: 0,
    input: {},
    createdAt,
    updatedAt: createdAt
  };
  persistence.createRun({
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
  persistence.commitRunTransition({
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
}

describe("operator notification runtime configuration", () => {
  it("stays disabled when no config path is explicitly supplied", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    expect(
      createOperatorNotificationDispatcher({
        persistence,
        environment: {},
        platform: "win32"
      })
    ).toBeUndefined();
    persistence.close();
  });

  it.skipIf(process.platform === "win32")(
    "loads a private macOS config and records provider acceptance",
    async () => {
      const { directory, path } = fixture();
      const persistence = new SqlitePersistence({ path: ":memory:" });
      seedDelivery(persistence);
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ code: 0, msg: "success" }), {
          status: 200
        })
      );
      try {
        const worker = createOperatorNotificationDispatcher({
          persistence,
          environment: { BPA_OPERATOR_NOTIFICATION_CONFIG: path },
          platform: "darwin",
          ...(process.getuid ? { currentUid: process.getuid() } : {}),
          fetchImpl: fetchImpl as typeof fetch,
          now: () => Date.parse("2026-08-09T06:00:00.000Z"),
          id: () => "lease-test"
        });
        await expect(worker?.dispatchNext()).resolves.toMatchObject({
          status: "delivered",
          expiredLeaseCount: 0,
          delivery: { state: "delivered", attempt: 1 }
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
      } finally {
        persistence.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a group-readable or relative explicit config",
    () => {
      const { directory, path } = fixture(0o640);
      const persistence = new SqlitePersistence({ path: ":memory:" });
      try {
        expect(() =>
          createOperatorNotificationDispatcher({
            persistence,
            environment: { BPA_OPERATOR_NOTIFICATION_CONFIG: path },
            platform: "darwin",
            ...(process.getuid ? { currentUid: process.getuid() } : {})
          })
        ).toThrow(/private regular file/u);
        expect(() =>
          createOperatorNotificationDispatcher({
            persistence,
            environment: {
              BPA_OPERATOR_NOTIFICATION_CONFIG: "operator-notification.json"
            },
            platform: "darwin",
            ...(process.getuid ? { currentUid: process.getuid() } : {})
          })
        ).toThrow(/must be absolute/u);
      } finally {
        persistence.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
