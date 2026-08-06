import { describe, expect, it } from "vitest";
import {
  aggregateAttentionItems,
  attentionRequiresInterruption,
  createAttentionItem,
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
});
