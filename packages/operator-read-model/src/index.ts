import {
  aggregateAttentionItems,
  type AttentionItem
} from "@bpa/attention-core";

export interface OperatorRunProjection {
  readonly id: string;
  readonly title: string;
  readonly status:
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  readonly businessSummary: string;
  readonly updatedAt: string;
}

export interface OperatorResultProjection {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface OperatorHomeProjection {
  readonly readiness: "ready" | "needs_action";
  readonly readinessMessage: string;
  readonly availableAutomationCount: number;
  readonly running: readonly OperatorRunProjection[];
  readonly attention: Readonly<ReturnType<typeof aggregateAttentionItems>>;
  readonly recentResults: readonly OperatorResultProjection[];
}

export function projectOperatorHome(input: {
  systemReady: boolean;
  readinessMessage?: string;
  availableAutomationCount: number;
  runs: readonly OperatorRunProjection[];
  attentionItems: readonly AttentionItem[];
  results: readonly OperatorResultProjection[];
  recentResultLimit?: number;
}): OperatorHomeProjection {
  const attention = aggregateAttentionItems(input.attentionItems);
  const running = input.runs
    .filter((run) => run.status === "running" || run.status === "waiting")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const recentResults = input.results
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.recentResultLimit ?? 5);
  const needsAction =
    !input.systemReady ||
    attention.some((item) => item.blocking || item.kind === "approval");
  return Object.freeze({
    readiness: needsAction ? "needs_action" : "ready",
    readinessMessage: needsAction
      ? input.readinessMessage ?? "BPA 需要处理后才能继续部分任务"
      : "BPA 已准备好",
    availableAutomationCount: input.availableAutomationCount,
    running: Object.freeze(running),
    attention: Object.freeze(attention),
    recentResults: Object.freeze(recentResults)
  });
}
