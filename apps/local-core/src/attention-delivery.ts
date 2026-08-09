import { createHash } from "node:crypto";
import type { AttentionItem } from "@bpa/attention-core";
import type { AttentionDeliveryRecord } from "@bpa/persistence";

export interface TerminalAttentionDeliveryInput {
  readonly attention: AttentionItem;
  readonly workflowId: string;
  readonly workflowVersion: string;
}

/**
 * Creates the immutable, secret-free command consumed by notification adapters.
 * Provider credentials and provider-specific message formatting stay outside
 * Runtime and Workflow definitions.
 */
export function createTerminalAttentionDelivery(
  input: TerminalAttentionDeliveryInput
): AttentionDeliveryRecord {
  if (!input.attention.runId) {
    throw new Error("Terminal Attention delivery requires a Run identity");
  }
  const payload = {
    attentionId: input.attention.id,
    runId: input.attention.runId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    severity: input.attention.kind,
    title: input.attention.title,
    requestedAction: input.attention.requestedAction,
    occurredAt: input.attention.createdAt
  };
  const idempotencyKey = [
    "attention",
    input.attention.id,
    "operator-notification"
  ].join(":");
  return {
    id: `delivery:${idempotencyKey}`,
    attentionId: input.attention.id,
    channel: "operator-notification",
    idempotencyKey,
    requestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`,
    payload,
    state: "pending",
    revision: 0,
    attempt: 0,
    createdAt: input.attention.createdAt,
    updatedAt: input.attention.createdAt
  };
}
