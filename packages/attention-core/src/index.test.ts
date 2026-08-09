import { describe, expect, it } from "vitest";
import {
  aggregateAttentionItems,
  attentionRequiresInterruption,
  createAttentionItem,
  parseSucceededRunBusinessAttentionMarker,
  projectSucceededRunBusinessAttention,
  projectTerminalTriggerOccurrenceAttention,
  projectTerminalRunAttention,
  type AttentionItem
} from "./index.js";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    runId: "run-1",
    stageKey: "matching",
    groupKey: "ambiguous-packaging",
    kind: "review",
    source: "assistance",
    title: "复核包装匹配",
    reason: "存在多个相近主数据记录",
    requestedAction: "批量选择正确记录",
    blocking: false,
    batchable: true,
    attemptedActions: ["确定性匹配已完成"],
    resumesAutomatically: true,
    createdAt: "2026-07-31T01:00:00.000Z",
    ...overrides
  };
}

describe("AttentionItem", () => {
  it("projects pre-Run Trigger terminal outcomes without leaking diagnostics", () => {
    const attention = projectTerminalTriggerOccurrenceAttention({
      occurrenceId: "occurrence-private-id",
      outcome: "blocked",
      updatedAt: "2026-08-09T12:00:00.000Z"
    });

    expect(attention).toMatchObject({
      id: "trigger-occurrence-terminal:occurrence-private-id",
      stageKey: "trigger",
      groupKey: "trigger-blocked",
      kind: "blocking",
      source: "runtime",
      blocking: true,
      batchable: false
    });
    expect(JSON.stringify(attention)).not.toContain("diagnostic");
  });

  it("groups similar ambiguity into one batch prompt", () => {
    const grouped = aggregateAttentionItems([
      item("attention-1"),
      item("attention-2", {
        attemptedActions: ["标题归一化已完成"],
        createdAt: "2026-07-31T01:00:01.000Z"
      })
    ]);
    expect(grouped).toEqual([
      expect.objectContaining({
        title: "复核包装匹配（2 项）",
        batchable: true,
        itemIds: ["attention-1", "attention-2"],
        attemptedActions: [
          "确定性匹配已完成",
          "标题归一化已完成"
        ]
      })
    ]);
  });

  it("prioritizes blocking and approval work", () => {
    const grouped = aggregateAttentionItems([
      item("review"),
      item("blocking", {
        stageKey: "auth",
        groupKey: "login",
        kind: "blocking",
        source: "browser",
        blocking: true,
        batchable: false
      })
    ]);
    expect(grouped[0]?.kind).toBe("blocking");
    expect(attentionRequiresInterruption(grouped[0]!)).toBe(true);
  });

  it("rejects contradictory interruption semantics", () => {
    expect(() =>
      createAttentionItem(item("invalid", { kind: "blocking" }))
    ).toThrow(/invalid/u);
  });

  it("projects login rejection without exposing raw event messages", () => {
    const attention = projectTerminalRunAttention({
      id: "run-login",
      workflowId: "doudian.inventory.refresh",
      workflowVersion: "1.0.0",
      status: "rejected",
      currentNodeKey: "collect",
      updatedAt: "2026-08-09T06:00:00.000Z",
      events: [
        {
          type: "RUNTIME_RESULT_APPLIED",
          payload: {
            errorCode: "SESSION_EXPIRED",
            message: "secret browser detail"
          }
        }
      ]
    });

    expect(attention).toMatchObject({
      id: "run-terminal:run-login",
      groupKey: "authentication",
      kind: "blocking",
      source: "browser",
      attemptedActions: []
    });
    expect(JSON.stringify(attention)).not.toContain("secret browser detail");
  });

  it("keeps uncertain outcomes blocking and forbids blind retry guidance", () => {
    const attention = projectTerminalRunAttention({
      id: "run-uncertain",
      workflowId: "delivery.feishu",
      workflowVersion: "1.0.0",
      status: "uncertain",
      updatedAt: "2026-08-09T06:00:00.000Z",
      events: []
    });

    expect(attention).toMatchObject({
      groupKey: "uncertain",
      blocking: true,
      resumesAutomatically: false
    });
    expect(attention.requestedAction).toContain("不要自动重试");
  });

  it("projects a successful business finding with controlled static copy", () => {
    const attention = projectSucceededRunBusinessAttention({
      id: "run-business-finding",
      marker: {
        version: "1",
        kind: "business-finding",
        code: "items-found"
      },
      updatedAt: "2026-08-09T06:00:00.000Z"
    });

    expect(attention).toMatchObject({
      id: "run-business-finding:run-business-finding",
      runId: "run-business-finding",
      stageKey: "run",
      groupKey: "business-finding:items-found",
      kind: "action",
      source: "business-rule",
      blocking: false,
      resumesAutomatically: false
    });
    expect(JSON.stringify(attention)).not.toContain("workflowId");
  });

  it("rejects business markers with extra, unsafe or oversized fields", () => {
    expect(() =>
      parseSucceededRunBusinessAttentionMarker({
        version: "1",
        kind: "business-finding",
        code: "items-found",
        title: "untrusted page copy"
      })
    ).toThrow(/marker is invalid/u);
    expect(() =>
      parseSucceededRunBusinessAttentionMarker({
        version: "1",
        kind: "business-finding",
        code: "items found"
      })
    ).toThrow(/marker is invalid/u);
    expect(() =>
      parseSucceededRunBusinessAttentionMarker({
        version: "1",
        kind: "business-finding",
        code: "a".repeat(65)
      })
    ).toThrow(/marker is invalid/u);
  });
});
