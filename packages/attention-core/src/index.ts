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
