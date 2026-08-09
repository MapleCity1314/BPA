import { randomUUID } from "node:crypto";
import type {
  AttentionDeliveryRecord,
  Persistence
} from "@bpa/persistence";

export type OperatorNotificationResult =
  | { readonly status: "delivered"; readonly providerReceiptId?: string }
  | { readonly status: "failed"; readonly errorCode: string }
  | { readonly status: "uncertain"; readonly errorCode: string };

export interface OperatorNotificationChannel {
  deliver(input: {
    readonly payload: unknown;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<OperatorNotificationResult>;
}

export interface AttentionDeliveryDispatcherOptions {
  readonly persistence: Persistence;
  readonly channel: OperatorNotificationChannel;
  readonly workerId: string;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly leaseDurationMs?: number;
}

export type AttentionDeliveryDispatchResult =
  | { readonly status: "idle"; readonly expiredLeaseCount: number }
  | {
      readonly status: "delivered" | "failed" | "uncertain";
      readonly delivery: AttentionDeliveryRecord;
      readonly expiredLeaseCount: number;
    };

/**
 * Dispatches at most one notification. Transport exceptions are ambiguous
 * external effects, so they become uncertain and are never auto-retried.
 */
export class AttentionDeliveryDispatcher {
  readonly #persistence: Persistence;
  readonly #channel: OperatorNotificationChannel;
  readonly #workerId: string;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #leaseDurationMs: number;

  constructor(options: AttentionDeliveryDispatcherOptions) {
    if (!options.workerId.trim()) {
      throw new Error("Attention delivery worker identity is required");
    }
    const leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
      throw new Error("Attention delivery lease duration is invalid");
    }
    this.#persistence = options.persistence;
    this.#channel = options.channel;
    this.#workerId = options.workerId;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#leaseDurationMs = leaseDurationMs;
  }

  async dispatchNext(): Promise<AttentionDeliveryDispatchResult> {
    const claimedAtMs = this.#now();
    const claimedAt = new Date(claimedAtMs).toISOString();
    const expiredLeaseCount = this.#persistence.expireAttentionDeliveryLeases({
      now: claimedAt
    });
    const leaseId = this.#id();
    const delivery = this.#persistence.claimNextAttentionDelivery({
      leaseId,
      leaseOwner: this.#workerId,
      claimedAt,
      leaseExpiresAt: new Date(
        claimedAtMs + this.#leaseDurationMs
      ).toISOString()
    });
    if (!delivery) return { status: "idle", expiredLeaseCount };

    let outcome: OperatorNotificationResult;
    try {
      outcome = await this.#channel.deliver({
        payload: delivery.payload,
        idempotencyKey: delivery.idempotencyKey,
        requestDigest: delivery.requestDigest
      });
    } catch {
      outcome = {
        status: "uncertain",
        errorCode: "DELIVERY_TRANSPORT_UNCERTAIN"
      };
    }

    const completedAt = new Date(this.#now()).toISOString();
    const completed = this.#persistence.completeAttentionDelivery({
      id: delivery.id,
      expectedRevision: delivery.revision,
      leaseId,
      outcome: outcome.status,
      completedAt,
      ...(outcome.status === "delivered"
        ? outcome.providerReceiptId
          ? { providerReceiptId: outcome.providerReceiptId }
          : {}
        : { lastErrorCode: outcome.errorCode })
    });
    return { status: outcome.status, delivery: completed, expiredLeaseCount };
  }
}
