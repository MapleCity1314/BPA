import { createHash } from "node:crypto";

const ATTENTION_LIMIT = 50;
const CONTROL_TIMEOUT_MS = 2_000;

export interface InventoryPanelReminder {
  readonly id: string;
  readonly severity: "critical" | "warning";
  readonly title: string;
  readonly detail: string;
  readonly source: string;
  readonly action: string;
  readonly notificationEligible: boolean;
}

export type RuntimeAttentionReminderProvider = () => Promise<
  readonly InventoryPanelReminder[]
>;

interface AttentionControlClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { requestId?: string; timeoutMs?: number }
  ): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function publicReminderId(attentionId: string): string {
  const digest = createHash("sha256").update(attentionId).digest("hex").slice(0, 24);
  return `bpa-trigger-attention:${digest}`;
}

function projectReminder(value: unknown): InventoryPanelReminder | undefined {
  const item = record(value);
  const sourceRef = record(item?.sourceRef);
  if (!item || !sourceRef) return undefined;
  const sourceKind = sourceRef.kind;
  const sourceRunId = boundedString(sourceRef.runId,512);
  const itemRunId = boundedString(item.runId,512);
  const runStatus = boundedString(item.runStatus,32);
  const isSucceededBusinessFinding = runStatus === "succeeded" &&
    item.source === "business-rule" &&
    item.kind === "action" &&
    item.blocking === false &&
    boundedString(item.groupKey,160)?.startsWith("business-finding:") === true;
  const isUnsuccessfulRunAttention =
    ["rejected","uncertain","failed"].includes(runStatus ?? "");
  const sourceReferenceIsValid = sourceKind === "trigger-occurrence"
    ? Boolean(boundedString(sourceRef.occurrenceId,512)) &&
      item.runId === undefined &&
      item.runStatus === undefined &&
      item.deliveryPolicy === "dashboard-only" &&
      item.deliveryState === "not-requested" &&
      item.deliveryAttempt === 0
    : sourceKind === "workflow-run"
      ? Boolean(sourceRunId) &&
        itemRunId === sourceRunId &&
        item.deliveryPolicy === "operator-notification" &&
        ["pending","delivering","delivered","failed","uncertain"].includes(
          String(item.deliveryState)
        ) &&
        Number.isSafeInteger(item.deliveryAttempt) &&
        Number(item.deliveryAttempt) >= 0 &&
        (isSucceededBusinessFinding || isUnsuccessfulRunAttention)
      : false;
  if (!sourceReferenceIsValid) return undefined;
  const id = boundedString(item.id, 512);
  const title = boundedString(item.title, 160);
  const detail = boundedString(item.reason, 500);
  const action = boundedString(item.requestedAction, 240);
  const kind = boundedString(item.kind, 32);
  const createdAt = boundedString(item.createdAt, 64);
  if (
    !id ||
    !title ||
    !detail ||
    !action ||
    !kind ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !["information", "review", "action", "approval", "blocking"].includes(kind) ||
    item.state !== "open"
  ) {
    return undefined;
  }
  return {
    id:publicReminderId(id),
    severity:kind === "blocking" ? "critical" : "warning",
    title,
    detail,
    source:"BPA 触发调度",
    action,
    notificationEligible:false
  };
}

export function createRuntimeAttentionReminderProvider(
  control: AttentionControlClient
): RuntimeAttentionReminderProvider {
  return async () => {
    const result = await control.request(
      "attention.list",
      {
        states:["open"],
        appIds:["inventory-monitor"],
        limit:ATTENTION_LIMIT
      },
      { timeoutMs:CONTROL_TIMEOUT_MS }
    );
    const parsed = record(result);
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error("ATTENTION_LIST_RESPONSE_INVALID");
    }
    const total = parsed.total;
    const truncated = parsed.truncated;
    if (
      !Number.isSafeInteger(total) ||
      Number(total) < parsed.items.length ||
      typeof truncated !== "boolean" ||
      (truncated ? Number(total) <= parsed.items.length : Number(total) !== parsed.items.length)
    ) {
      throw new Error("ATTENTION_LIST_RESPONSE_INVALID");
    }
    const reminders = parsed.items.map((item) => {
      const reminder = projectReminder(item);
      if (!reminder) throw new Error("ATTENTION_LIST_ITEM_INVALID");
      return reminder;
    });
    if (truncated) {
      reminders.push({
        id:"bpa-trigger-attention:truncated",
        severity:"warning",
        title:"BPA 触发提醒未完整展示",
        detail:"待处理的库存工作流触发提醒超过当前面板读取上限。",
        source:"BPA 触发调度",
        action:"请在 BPA 控制台查看完整列表。",
        notificationEligible:false
      });
    }
    return reminders;
  };
}
