import { describe, expect, it, vi } from "vitest";
import { createRuntimeAttentionReminderProvider } from "./runtime-attention-reminders.js";

describe("runtime attention reminders", () => {
  it("projects pre-Run and post-Run inventory attention without leaking identifiers", async () => {
    const request = vi.fn(async () => ({
      items:[
        {
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
        },
        {
          id:"run-terminal:secret-run-id",
          kind:"action",
          title:"任务执行失败",
          reason:"库存采集工作流执行失败。",
          requestedAction:"查看失败步骤后再重新发起。",
          createdAt:"2026-08-09T09:01:00.000Z",
          state:"open",
          deliveryState:"pending",
          deliveryAttempt:0,
          deliveryPolicy:"operator-notification",
          sourceRef:{ kind:"workflow-run",runId:"secret-run-id" },
          runId:"secret-run-id",
          runStatus:"failed"
        },
        {
          id:"run-terminal:secret-partial-run-id",
          kind:"blocking",
          title:"结果不确定",
          reason:"库存采集只完成了部分结果。",
          requestedAction:"先核对运行记录与证据。",
          createdAt:"2026-08-09T09:02:00.000Z",
          state:"open",
          deliveryState:"failed",
          deliveryAttempt:1,
          deliveryPolicy:"operator-notification",
          sourceRef:{ kind:"workflow-run",runId:"secret-partial-run-id" },
          runId:"secret-partial-run-id",
          runStatus:"uncertain"
        },
        {
          id:"run-business-finding:secret-succeeded-run-id",
          kind:"action",
          source:"business-rule",
          groupKey:"business-finding:items-found",
          blocking:false,
          title:"工作流发现待处理事项",
          reason:"库存采集成功完成，并发现需要运营处理的业务事项。",
          requestedAction:"查看本次运行结果与证据。",
          createdAt:"2026-08-09T09:03:00.000Z",
          state:"open",
          deliveryState:"delivered",
          deliveryAttempt:1,
          deliveryPolicy:"operator-notification",
          sourceRef:{ kind:"workflow-run",runId:"secret-succeeded-run-id" },
          runId:"secret-succeeded-run-id",
          runStatus:"succeeded"
        }
      ],
      total:4,
      truncated:false
    }));
    const provider = createRuntimeAttentionReminderProvider({ request });

    const reminders = await provider();

    expect(request).toHaveBeenCalledWith(
      "attention.list",
      {
        states:["open"],
        appIds:["inventory-monitor"],
        limit:50
      },
      { timeoutMs:2_000 }
    );
    expect(reminders).toEqual([
      {
        id:expect.stringMatching(/^bpa-trigger-attention:[a-f0-9]{24}$/u),
        severity:"critical",
        title:"库存采集被安全阻断",
        detail:"共享浏览器当前不可用。",
        source:"BPA 触发调度",
        action:"检查浏览器登录状态。",
        notificationEligible:false
      },
      {
        id:expect.stringMatching(/^bpa-trigger-attention:[a-f0-9]{24}$/u),
        severity:"warning",
        title:"任务执行失败",
        detail:"库存采集工作流执行失败。",
        source:"BPA 触发调度",
        action:"查看失败步骤后再重新发起。",
        notificationEligible:false
      },
      {
        id:expect.stringMatching(/^bpa-trigger-attention:[a-f0-9]{24}$/u),
        severity:"critical",
        title:"结果不确定",
        detail:"库存采集只完成了部分结果。",
        source:"BPA 触发调度",
        action:"先核对运行记录与证据。",
        notificationEligible:false
      },
      {
        id:expect.stringMatching(/^bpa-trigger-attention:[a-f0-9]{24}$/u),
        severity:"warning",
        title:"工作流发现待处理事项",
        detail:"库存采集成功完成，并发现需要运营处理的业务事项。",
        source:"BPA 触发调度",
        action:"查看本次运行结果与证据。",
        notificationEligible:false
      }
    ]);
    const serialized = JSON.stringify(reminders);
    expect(serialized).not.toContain("secret-internal-id");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("secret-run-id");
    expect(serialized).not.toContain("secret-partial-run-id");
    expect(serialized).not.toContain("secret-succeeded-run-id");
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
          createdAt:"2026-08-09T09:00:00.000Z",
          state:"open",
          deliveryState:"pending",
          deliveryAttempt:0,
          deliveryPolicy:"dashboard-only",
          sourceRef:{ kind:"workflow-run",runId:"run-invalid-policy" },
          runStatus:"failed"
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
