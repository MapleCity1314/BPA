import type { AttentionItem } from "@bpa/attention-core";

export type InteractionDecision =
  | "continue_silently"
  | "record_for_later"
  | "aggregate"
  | "interrupt";

export interface InteractionContext {
  readonly item: AttentionItem;
  readonly automaticRecoveryAvailable: boolean;
  readonly automaticRecoveryExhausted: boolean;
  readonly matchingOpenGroup: boolean;
  readonly stageAlreadyPrompted: boolean;
}

export interface InteractionPolicyResult {
  readonly decision: InteractionDecision;
  readonly reason:
    | "automatic_recovery"
    | "information_only"
    | "merge_similar"
    | "stage_budget"
    | "explicit_approval"
    | "blocking_action"
    | "deferred_review";
}

export function evaluateInteraction(
  context: InteractionContext
): InteractionPolicyResult {
  const { item } = context;
  if (
    context.automaticRecoveryAvailable &&
    !context.automaticRecoveryExhausted &&
    item.kind !== "approval"
  ) {
    return {
      decision: "continue_silently",
      reason: "automatic_recovery"
    };
  }
  if (item.kind === "information") {
    return { decision: "record_for_later", reason: "information_only" };
  }
  if (context.matchingOpenGroup && item.batchable) {
    return { decision: "aggregate", reason: "merge_similar" };
  }
  if (
    context.stageAlreadyPrompted &&
    item.kind !== "approval" &&
    !item.blocking
  ) {
    return { decision: "aggregate", reason: "stage_budget" };
  }
  if (item.kind === "approval") {
    return { decision: "interrupt", reason: "explicit_approval" };
  }
  if (item.blocking || item.kind === "blocking") {
    return { decision: "interrupt", reason: "blocking_action" };
  }
  return { decision: "record_for_later", reason: "deferred_review" };
}
