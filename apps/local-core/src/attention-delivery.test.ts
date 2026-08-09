import { describe, expect, it } from "vitest";
import { createAttentionItem } from "@bpa/attention-core";
import { createTerminalAttentionDelivery } from "./attention-delivery.js";

describe("terminal Attention delivery", () => {
  it("creates a deterministic, secret-free notification command", () => {
    const attention = createAttentionItem({
      id: "run-terminal:run-1",
      runId: "run-1",
      stageKey: "collect",
      groupKey: "authentication",
      kind: "blocking",
      source: "browser",
      title: "浏览器登录或验证需要处理",
      reason: "受控原因",
      requestedAction: "人工处理后重新发起。",
      blocking: true,
      batchable: false,
      attemptedActions: [],
      resumesAutomatically: false,
      createdAt: "2026-08-09T06:00:00.000Z"
    });

    const first = createTerminalAttentionDelivery({
      attention,
      workflowId: "doudian.inventory.refresh",
      workflowVersion: "1.0.0"
    });
    const second = createTerminalAttentionDelivery({
      attention,
      workflowId: "doudian.inventory.refresh",
      workflowVersion: "1.0.0"
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      attentionId: attention.id,
      channel: "operator-notification",
      state: "pending",
      revision: 0,
      attempt: 0
    });
    expect(first.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(first.payload)).not.toContain(attention.reason);
  });

  it("rejects Attention without a Run identity", () => {
    const attention = createAttentionItem({
      id: "global-attention",
      stageKey: "system",
      groupKey: "runtime",
      kind: "action",
      source: "runtime",
      title: "需要处理",
      reason: "受控原因",
      requestedAction: "人工检查。",
      blocking: false,
      batchable: false,
      attemptedActions: [],
      resumesAutomatically: false,
      createdAt: "2026-08-09T06:00:00.000Z"
    });

    expect(() =>
      createTerminalAttentionDelivery({
        attention,
        workflowId: "workflow",
        workflowVersion: "1.0.0"
      })
    ).toThrow(/requires a Run identity/u);
  });
});
