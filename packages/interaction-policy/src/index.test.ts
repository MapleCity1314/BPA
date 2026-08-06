import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@bpa/attention-core";
import { evaluateInteraction } from "./index.js";

const item: AttentionItem = {
  id: "attention-1",
  runId: "run-1",
  stageKey: "collect",
  groupKey: "page-ready",
  kind: "action",
  source: "browser",
  title: "页面尚未准备",
  reason: "页面仍在加载",
  requestedAction: "保持页面打开",
  blocking: false,
  batchable: true,
  attemptedActions: [],
  resumesAutomatically: true,
  createdAt: "2026-07-31T01:00:00.000Z"
};

describe("interaction policy", () => {
  it("does not disturb the operator while recovery remains", () => {
    expect(
      evaluateInteraction({
        item,
        automaticRecoveryAvailable: true,
        automaticRecoveryExhausted: false,
        matchingOpenGroup: false,
        stageAlreadyPrompted: false
      })
    ).toEqual({
      decision: "continue_silently",
      reason: "automatic_recovery"
    });
  });

  it("keeps explicit approval interrupting", () => {
    expect(
      evaluateInteraction({
        item: { ...item, kind: "approval" },
        automaticRecoveryAvailable: true,
        automaticRecoveryExhausted: false,
        matchingOpenGroup: false,
        stageAlreadyPrompted: false
      })
    ).toEqual({
      decision: "interrupt",
      reason: "explicit_approval"
    });
  });
});
