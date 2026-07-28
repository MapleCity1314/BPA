export type AssistanceSupervisionState =
  | "unattended"
  | "attention"
  | "action_required";

export type SafeAssistanceSummaryCode =
  | "authorization_required"
  | "page_attention"
  | "adapter_attention"
  | "human_confirmation";

export interface SafeAssistanceTask {
  readonly taskId: string;
  readonly mode: "ai_review" | "human_confirm" | "human_action";
  readonly status:
    | "queued"
    | "claimed"
    | "processing"
    | "completed"
    | "expired"
    | "cancelled";
  readonly profileId: string;
  readonly ownerType?: "ai" | "human";
  readonly deadline?: string;
  readonly summaryCode: SafeAssistanceSummaryCode;
  readonly updatedAt: string;
}

export interface AssistancePanelSnapshot {
  readonly supervision: AssistanceSupervisionState;
  readonly tasks: readonly SafeAssistanceTask[];
  readonly updatedAt: string;
}

export interface AssistancePanelStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export const ASSISTANCE_PANEL_STORAGE_KEY = "bpaAssistancePanel";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MAX_TASKS = 50;

const MODES = new Set<SafeAssistanceTask["mode"]>([
  "ai_review",
  "human_confirm",
  "human_action"
]);
const STATUSES = new Set<SafeAssistanceTask["status"]>([
  "queued",
  "claimed",
  "processing",
  "completed",
  "expired",
  "cancelled"
]);
const SUMMARY_CODES = new Set<SafeAssistanceSummaryCode>([
  "authorization_required",
  "page_attention",
  "adapter_attention",
  "human_confirmation"
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sanitizeAssistanceTask(
  value: unknown
): SafeAssistanceTask | undefined {
  const input = record(value);
  if (!input) return undefined;
  const taskId = input.taskId;
  const mode = input.mode;
  const status = input.status;
  const profileId = input.profileId;
  const summaryCode = input.summaryCode;
  const updatedAt = input.updatedAt;
  if (
    typeof taskId !== "string" ||
    !SAFE_ID.test(taskId) ||
    typeof mode !== "string" ||
    !MODES.has(mode as SafeAssistanceTask["mode"]) ||
    typeof status !== "string" ||
    !STATUSES.has(status as SafeAssistanceTask["status"]) ||
    typeof profileId !== "string" ||
    !SAFE_ID.test(profileId) ||
    typeof summaryCode !== "string" ||
    !SUMMARY_CODES.has(summaryCode as SafeAssistanceSummaryCode) ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return undefined;
  }
  const ownerType =
    input.ownerType === "ai" || input.ownerType === "human"
      ? input.ownerType
      : undefined;
  const deadline =
    typeof input.deadline === "string" &&
    Number.isFinite(Date.parse(input.deadline))
      ? input.deadline
      : undefined;
  return {
    taskId,
    mode: mode as SafeAssistanceTask["mode"],
    status: status as SafeAssistanceTask["status"],
    profileId,
    summaryCode: summaryCode as SafeAssistanceSummaryCode,
    updatedAt,
    ...(ownerType ? { ownerType } : {}),
    ...(deadline ? { deadline } : {})
  };
}

export function deriveSupervisionState(
  tasks: readonly SafeAssistanceTask[]
): AssistanceSupervisionState {
  const active = tasks.filter(
    (task) =>
      task.status === "queued" ||
      task.status === "claimed" ||
      task.status === "processing"
  );
  if (
    active.some(
      (task) =>
        task.mode === "human_action" ||
        task.mode === "human_confirm" ||
        task.ownerType === "human"
    )
  ) {
    return "action_required";
  }
  return active.length > 0 ? "attention" : "unattended";
}

function emptySnapshot(at: string): AssistancePanelSnapshot {
  return { supervision: "unattended", tasks: [], updatedAt: at };
}

export class AssistancePanelRepository {
  constructor(
    private readonly storage: AssistancePanelStorage,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async read(): Promise<AssistancePanelSnapshot> {
    const now = this.clock().toISOString();
    const stored = await this.storage.get(ASSISTANCE_PANEL_STORAGE_KEY);
    const snapshot = record(stored[ASSISTANCE_PANEL_STORAGE_KEY]);
    if (!snapshot || !Array.isArray(snapshot.tasks)) {
      return emptySnapshot(now);
    }
    const tasks = snapshot.tasks
      .map(sanitizeAssistanceTask)
      .filter((task): task is SafeAssistanceTask => task !== undefined)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.taskId.localeCompare(right.taskId)
      )
      .slice(0, MAX_TASKS);
    return {
      supervision: deriveSupervisionState(tasks),
      tasks,
      updatedAt:
        typeof snapshot.updatedAt === "string" &&
        Number.isFinite(Date.parse(snapshot.updatedAt))
          ? snapshot.updatedAt
          : now
    };
  }

  async upsert(task: SafeAssistanceTask): Promise<AssistancePanelSnapshot> {
    const safe = sanitizeAssistanceTask(task);
    if (!safe) throw new Error("INVALID_ASSISTANCE_TASK_METADATA");
    const current = await this.read();
    const tasks = [
      safe,
      ...current.tasks.filter((candidate) => candidate.taskId !== safe.taskId)
    ].slice(0, MAX_TASKS);
    return this.#write(tasks);
  }

  async remove(taskId: string): Promise<AssistancePanelSnapshot> {
    if (!SAFE_ID.test(taskId)) throw new Error("INVALID_ASSISTANCE_TASK_ID");
    const current = await this.read();
    return this.#write(
      current.tasks.filter((candidate) => candidate.taskId !== taskId)
    );
  }

  async #write(
    tasks: readonly SafeAssistanceTask[]
  ): Promise<AssistancePanelSnapshot> {
    const updatedAt = this.clock().toISOString();
    const snapshot: AssistancePanelSnapshot = {
      supervision: deriveSupervisionState(tasks),
      tasks: [...tasks],
      updatedAt
    };
    await this.storage.set({ [ASSISTANCE_PANEL_STORAGE_KEY]: snapshot });
    return snapshot;
  }
}

export const ASSISTANCE_SUPERVISION_LABELS: Readonly<
  Record<AssistanceSupervisionState, string>
> = {
  unattended: "无需监管",
  attention: "请关注",
  action_required: "需要操作"
};

export const ASSISTANCE_SUMMARY_LABELS: Readonly<
  Record<SafeAssistanceSummaryCode, string>
> = {
  authorization_required: "需要恢复页面授权或登录状态",
  page_attention: "页面状态需要关注",
  adapter_attention: "页面结构需要检查",
  human_confirmation: "等待人工批量确认"
};
