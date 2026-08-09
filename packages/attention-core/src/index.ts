export type AttentionKind =
  | "information"
  | "review"
  | "action"
  | "approval"
  | "blocking";

export type AttentionSource =
  | "assistance"
  | "browser"
  | "runtime"
  | "approval"
  | "business-rule";

export interface AttentionItem {
  readonly id: string;
  readonly runId?: string;
  readonly stageKey: string;
  readonly groupKey: string;
  readonly kind: AttentionKind;
  readonly source: AttentionSource;
  readonly title: string;
  readonly reason: string;
  readonly requestedAction: string;
  readonly blocking: boolean;
  readonly batchable: boolean;
  readonly attemptedActions: readonly string[];
  readonly resumesAutomatically: boolean;
  readonly createdAt: string;
  readonly dueAt?: string;
}

export interface AttentionGroup {
  readonly id: string;
  readonly runId?: string;
  readonly stageKey: string;
  readonly groupKey: string;
  readonly kind: AttentionKind;
  readonly title: string;
  readonly reason: string;
  readonly requestedAction: string;
  readonly blocking: boolean;
  readonly batchable: boolean;
  readonly resumesAutomatically: boolean;
  readonly itemIds: readonly string[];
  readonly attemptedActions: readonly string[];
  readonly createdAt: string;
  readonly dueAt?: string;
}

export interface TerminalRunAttentionInput {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly status: "rejected" | "failed" | "uncertain";
  readonly currentNodeKey?: string;
  readonly updatedAt: string;
  readonly events: readonly {
    readonly type: string;
    readonly payload: unknown;
  }[];
}

export interface TerminalTriggerOccurrenceAttentionInput {
  readonly occurrenceId: string;
  readonly outcome: "missed" | "skipped" | "blocked" | "failed";
  readonly updatedAt: string;
}

export interface SucceededRunBusinessAttentionMarker {
  readonly version: "1";
  readonly kind: "business-finding";
  readonly code: string;
}

export interface SucceededRunBusinessAttentionInput {
  readonly id: string;
  readonly marker: SucceededRunBusinessAttentionMarker;
  readonly updatedAt: string;
}

const BUSINESS_ATTENTION_MARKER_KEYS = ["code", "kind", "version"] as const;
const BUSINESS_ATTENTION_CODE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const AUTHENTICATION_CODES = new Set([
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "RISK_CONTROL",
  "SESSION_EXPIRED"
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function diagnosticCodes(value: unknown): string[] {
  const source = record(value);
  if (!source) return [];
  const direct = ["code", "errorCode", "reasonCode"].flatMap((key) =>
    typeof source[key] === "string" ? [source[key] as string] : []
  );
  const error = record(source.error);
  const riskSignals = Array.isArray(source.riskSignals)
    ? source.riskSignals
    : [];
  return [
    ...direct,
    ...(typeof error?.code === "string" ? [error.code] : []),
    ...riskSignals.flatMap((signal) => {
      const parsed = record(signal);
      return typeof parsed?.code === "string" ? [parsed.code] : [];
    })
  ];
}

/**
 * Parses the only marker shape allowed to request operator Attention from a
 * successful Run. The marker is an identifier, never dashboard copy.
 */
export function parseSucceededRunBusinessAttentionMarker(
  value: unknown
): SucceededRunBusinessAttentionMarker {
  const source = record(value);
  const keys = source ? Object.keys(source).toSorted() : [];
  if (
    !source ||
    keys.length !== BUSINESS_ATTENTION_MARKER_KEYS.length ||
    keys.some((key, index) => key !== BUSINESS_ATTENTION_MARKER_KEYS[index]) ||
    source.version !== "1" ||
    source.kind !== "business-finding" ||
    typeof source.code !== "string" ||
    !BUSINESS_ATTENTION_CODE.test(source.code)
  ) {
    throw new Error("Succeeded Run business Attention marker is invalid");
  }
  return Object.freeze({
    version: "1",
    kind: "business-finding",
    code: source.code
  });
}

/**
 * Converts a validated successful-Run marker into controlled, secret-free
 * operator copy. Marker values can group the item but cannot become UI text.
 */
export function projectSucceededRunBusinessAttention(
  input: SucceededRunBusinessAttentionInput
): AttentionItem {
  const marker = parseSucceededRunBusinessAttentionMarker(input.marker);
  return createAttentionItem({
    id: `run-business-finding:${input.id}`,
    runId: input.id,
    stageKey: "run",
    groupKey: `business-finding:${marker.code}`,
    kind: "action",
    source: "business-rule",
    title: "工作流发现待处理事项",
    reason: "工作流已成功完成，并发现需要运营处理的业务事项。",
    requestedAction: "查看本次运行结果与证据，并按业务流程处理。",
    blocking: false,
    batchable: false,
    attemptedActions: [],
    resumesAutomatically: false,
    createdAt: input.updatedAt
  });
}

/**
 * Projects a durable terminal Run into one operator-facing, secret-free item.
 * Delivery channels consume this projection instead of interpreting raw events.
 */
export function projectTerminalRunAttention(
  input: TerminalRunAttentionInput
): AttentionItem {
  const codes = [
    ...new Set(input.events.flatMap((event) => diagnosticCodes(event.payload)))
  ];
  const authenticationBlocked = codes.some((code) =>
    AUTHENTICATION_CODES.has(code)
  );
  const blocking = input.status === "rejected" || input.status === "uncertain";
  const statusLabel =
    input.status === "uncertain"
      ? "结果不确定"
      : input.status === "rejected"
        ? "任务已安全阻断"
        : "任务执行失败";
  return createAttentionItem({
    id: `run-terminal:${input.id}`,
    runId: input.id,
    stageKey: input.currentNodeKey ?? "run",
    groupKey: authenticationBlocked ? "authentication" : input.status,
    kind: blocking ? "blocking" : "action",
    source: authenticationBlocked ? "browser" : "runtime",
    title: authenticationBlocked ? "浏览器登录或验证需要处理" : statusLabel,
    reason: authenticationBlocked
      ? "浏览器返回了登录、验证码或平台风控阻断。"
      : `${input.workflowId}@${input.workflowVersion} ${statusLabel}。`,
    requestedAction: authenticationBlocked
      ? "在受管 Chrome Profile 中完成人工登录或验证，再重新发起工作流。"
      : input.status === "uncertain"
        ? "先核对运行记录与证据；确认外部效果前不要自动重试。"
        : "查看运行记录中的失败步骤，处理原因后再重新发起。",
    blocking,
    batchable: false,
    attemptedActions: [],
    resumesAutomatically: false,
    createdAt: input.updatedAt
  });
}

/**
 * Projects a Trigger occurrence that terminated before a Workflow Run existed.
 * The copy is deliberately controlled: diagnostics, Trigger identifiers and
 * shop inputs never cross into dashboard-facing Attention records.
 */
export function projectTerminalTriggerOccurrenceAttention(
  input: TerminalTriggerOccurrenceAttentionInput
): AttentionItem {
  const presentation = (() => {
    switch (input.outcome) {
      case "missed":
        return {
          kind: "review" as const,
          title: "计划任务未执行",
          reason: "系统保留了更新的补跑机会，本次计划窗口未执行。",
          requestedAction: "查看任务调度状态；确认最新一次计划任务已经进入执行队列。",
          blocking: false,
          batchable: true
        };
      case "skipped":
        return {
          kind: "review" as const,
          title: "计划任务已跳过",
          reason: "本次计划任务已超过允许的准时执行窗口。",
          requestedAction: "查看任务调度状态；如持续出现，请检查浏览器占用和计划频率。",
          blocking: false,
          batchable: true
        };
      case "blocked":
        return {
          kind: "blocking" as const,
          title: "任务启动前已安全阻断",
          reason: "工作流尚未启动，系统已停止本次执行以避免不确定操作。",
          requestedAction: "查看 BPA 运行状态并处理阻断原因；确认前不要重复触发。",
          blocking: true,
          batchable: false
        };
      case "failed":
        return {
          kind: "action" as const,
          title: "任务启动失败",
          reason: "工作流尚未创建，本次任务已在启动阶段失败。",
          requestedAction: "查看 BPA 运行状态并处理启动故障，然后等待下一次计划任务。",
          blocking: false,
          batchable: false
        };
    }
  })();
  return createAttentionItem({
    id: `trigger-occurrence-terminal:${input.occurrenceId}`,
    stageKey: "trigger",
    groupKey: `trigger-${input.outcome}`,
    source: "runtime",
    ...presentation,
    attemptedActions: [],
    resumesAutomatically: false,
    createdAt: input.updatedAt
  });
}

const PRIORITY: Record<AttentionKind, number> = {
  information: 0,
  review: 1,
  action: 2,
  approval: 3,
  blocking: 4
};

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function createAttentionItem(input: AttentionItem): AttentionItem {
  if (
    !nonEmpty(input.id) ||
    !nonEmpty(input.stageKey) ||
    !nonEmpty(input.groupKey) ||
    !nonEmpty(input.title) ||
    !nonEmpty(input.reason) ||
    !nonEmpty(input.requestedAction) ||
    !validTimestamp(input.createdAt) ||
    (input.dueAt !== undefined && !validTimestamp(input.dueAt)) ||
    (input.kind === "blocking" && !input.blocking) ||
    (input.kind === "information" && input.blocking)
  ) {
    throw new Error("AttentionItem is invalid");
  }
  return Object.freeze({
    ...input,
    attemptedActions: Object.freeze([...input.attemptedActions])
  });
}

function groupIdentity(item: AttentionItem): string {
  return [
    item.runId ?? "global",
    item.stageKey,
    item.groupKey
  ].join(":");
}

export function aggregateAttentionItems(
  items: readonly AttentionItem[]
): AttentionGroup[] {
  const groups = new Map<string, AttentionItem[]>();
  for (const candidate of items) {
    const item = createAttentionItem(candidate);
    const identity = groupIdentity(item);
    const existing = groups.get(identity) ?? [];
    existing.push(item);
    groups.set(identity, existing);
  }
  return [...groups.entries()]
    .map(([id, grouped]) => {
      const sorted = grouped.toSorted((left, right) => {
        const priority = PRIORITY[right.kind] - PRIORITY[left.kind];
        return priority || left.createdAt.localeCompare(right.createdAt);
      });
      const head = sorted[0]!;
      const attemptedActions = [
        ...new Set(sorted.flatMap((item) => item.attemptedActions))
      ];
      const dueAt = sorted
        .flatMap((item) => (item.dueAt ? [item.dueAt] : []))
        .toSorted()[0];
      return Object.freeze({
        id,
        ...(head.runId ? { runId: head.runId } : {}),
        stageKey: head.stageKey,
        groupKey: head.groupKey,
        kind: head.kind,
        title:
          sorted.length === 1 ? head.title : `${head.title}（${sorted.length} 项）`,
        reason: head.reason,
        requestedAction: head.requestedAction,
        blocking: sorted.some((item) => item.blocking),
        batchable:
          sorted.length > 1 && sorted.every((item) => item.batchable),
        resumesAutomatically: sorted.every(
          (item) => item.resumesAutomatically
        ),
        itemIds: Object.freeze(sorted.map((item) => item.id)),
        attemptedActions: Object.freeze(attemptedActions),
        createdAt: sorted[0]!.createdAt,
        ...(dueAt ? { dueAt } : {})
      });
    })
    .toSorted((left, right) => {
      const priority = PRIORITY[right.kind] - PRIORITY[left.kind];
      return priority || left.createdAt.localeCompare(right.createdAt);
    });
}

export function attentionRequiresInterruption(
  item: Pick<AttentionGroup, "kind" | "blocking">
): boolean {
  return item.blocking || item.kind === "approval";
}
