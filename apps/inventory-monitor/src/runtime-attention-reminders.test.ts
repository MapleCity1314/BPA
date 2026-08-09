import { describe, expect, it, vi } from "vitest";
import { createRuntimeAttentionReminderProvider } from "./runtime-attention-reminders.js";

describe("runtime attention reminders", () => {
  it("requests only open inventory trigger occurrences and projects safe dashboard reminders", async () => {
    const request = vi.fn(async () => ({
      items:[{
        id:"trigger-occurrence:secret-internal-id",
        kind:"blocking",
        title:"库存采集被安全阻断",
        reason:"共享浏览器当前不可用。",
        requestedAction:"检查浏览器登录状态。",
        createdAt:"2026-08-09T09:00:00.000Z",
        state:"open",
        deliveryState:"not-requested",
        deliveryAttempt:0,
        deliveryPolicy:"dashboard-only",
        sourceRef:{ kind:"trigger-occurrence",occurrenceId:"must-not-leak" },
        triggerId:"must-not-leak"
      }],
      total:1,
      truncated:false
    }));
    const provider = createRuntimeAttentionReminderProvider({ request });

    const reminders = await provider();

    expect(request).toHaveBeenCalledWith(
      "attention.list",
      {
        states:["open"],
        sourceKind:"trigger-occurrence",
        appIds:["inventory-monitor"],
        limit:50
      },
      { timeoutMs:2_000 }
    );
    expect(reminders).toEqual([{
      id:expect.stringMatching(/^bpa-trigger-attention:[a-f0-9]{24}$/u),
      severity:"critical",
      title:"库存采集被安全阻断",
      detail:"共享浏览器当前不可用。",
      source:"BPA 触发调度",
      action:"检查浏览器登录状态。",
      notificationEligible:false
    }]);
    const serialized = JSON.stringify(reminders);
    expect(serialized).not.toContain("secret-internal-id");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("triggerId");
    expect(serialized).not.toContain("sourceRef");
  });

  it("fails closed for malformed envelopes or invalid items", async () => {
    const provider = createRuntimeAttentionReminderProvider({
      request:vi.fn(async () => ({
        items:[{
          id:"operator-notification",
          kind:"blocking",
          title:"不应展示",
          reason:"非面板提醒",
          requestedAction:"无",
          deliveryPolicy:"operator-notification"
        },{
          id:"workflow-run-dashboard-only",
          kind:"blocking",
          title:"不应展示",
          reason:"并非触发 occurrence",
          requestedAction:"无",
          deliveryPolicy:"dashboard-only",
          sourceRef:{ kind:"workflow-run" }
        }],
        total:2,
        truncated:false
      }))
    });
    await expect(provider()).rejects.toThrow("ATTENTION_LIST_ITEM_INVALID");

    const malformed = createRuntimeAttentionReminderProvider({
      request:vi.fn(async () => ({ items:"not-an-array" }))
    });
    await expect(malformed()).rejects.toThrow("ATTENTION_LIST_RESPONSE_INVALID");

    const inconsistent = createRuntimeAttentionReminderProvider({
      request:vi.fn(async () => ({
        items:[],
        total:3,
        truncated:false
      }))
    });
    await expect(inconsistent()).rejects.toThrow(
      "ATTENTION_LIST_RESPONSE_INVALID"
    );
  });
});
