import type {
  ExternalDomainLeaseRecord,
  Persistence,
  TriggerOccurrenceRecord,
  TriggerSpecDefinition
} from "@bpa/persistence";
import { RevisionConflictError } from "@bpa/persistence";
import {
  ExternalDomainLeaseProviderError,
  type ExternalDomainLeaseProvider
} from "./inventory-domain-lease-client.js";

const DEFER_SECONDS = 60;
const POST_TERMINAL_RECONCILIATION =
  "External domain lease release requires post-terminal reconciliation.";

const TERMINAL_RUN_STATES = new Set([
  "succeeded",
  "rejected",
  "failed",
  "cancelled",
  "uncertain"
]);

function estimatedRemainingMilliseconds(
  lease: Pick<ExternalDomainLeaseRecord, "serverNow" | "expiresAt" | "updatedAt">,
  localNow: string
): number | undefined {
  if (!lease.serverNow || !lease.expiresAt) return undefined;
  const grantedDuration = Date.parse(lease.expiresAt) - Date.parse(lease.serverNow);
  const localElapsed = Date.parse(localNow) - Date.parse(lease.updatedAt);
  if (localElapsed < 0) return undefined;
  return grantedDuration - localElapsed;
}

function controlledDiagnostic(error: unknown): string {
  if (!(error instanceof ExternalDomainLeaseProviderError)) {
    return "External domain lease persistence coordination failed.";
  }
  switch (error.code) {
    case "DOMAIN_LEASE_BUSY":
      return "External inventory domain lease is busy.";
    case "DOMAIN_LEASE_LOST":
      return "External inventory domain lease was lost.";
    case "INVENTORY_SERVICE_UNAVAILABLE":
      return "External inventory domain lease provider is unavailable.";
    case "INVENTORY_SERVICE_PROTOCOL_ERROR":
      return "External inventory domain lease provider returned an invalid response.";
    default:
      return "External inventory domain lease provider rejected the request.";
  }
}

export class ExternalDomainLeaseCoordinator {
  readonly #providers: ReadonlyMap<string, ExternalDomainLeaseProvider>;
  readonly #verifiedRequestIds = new Set<string>();

  constructor(
    readonly persistence: Persistence,
    providers: readonly ExternalDomainLeaseProvider[],
    readonly clock: () => Date = () => new Date()
  ) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
    if (this.#providers.size !== providers.length) {
      throw new Error("External domain lease provider ids must be unique");
    }
  }

  hasProvider(providerId: string): boolean {
    return this.#providers.has(providerId);
  }

  canStart(requestId: string): boolean {
    return this.#verifiedRequestIds.has(requestId);
  }

  markReconciliationRequired(requestId: string, diagnostic: string): void {
    const current = this.persistence.getExternalDomainLease(requestId);
    if (!current || current.state === "released") return;
    if (current.state === "reconciliation_required") return;
    this.#verifiedRequestIds.delete(requestId);
    try {
      this.persistence.markExternalDomainLeaseReconciliationRequired({
        requestId,
        expectedRevision: current.revision,
        diagnostic: diagnostic.slice(0, 1_000),
        updatedAt: this.clock().toISOString()
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
    }
  }

  async tick(): Promise<void> {
    const errors: Error[] = [];
    for (const lease of this.persistence.listExternalDomainLeases()) {
      try {
        if (lease.state === "released") continue;
        const provider = this.#providers.get(lease.providerId);
        if (!provider) {
          this.markReconciliationRequired(
            lease.requestId,
            "External domain lease provider is not configured."
          );
          continue;
        }
        if (lease.state === "acquiring") {
          await this.acquire(provider, lease);
          continue;
        }
        if (lease.state === "reconciliation_required") {
          await this.reconcile(provider, lease);
          continue;
        }
        if (!this.#verifiedRequestIds.has(lease.requestId)) {
          await this.verifyBound(provider, lease);
          continue;
        }
        if (this.shouldRelease(lease)) {
          await this.release(provider, lease);
          continue;
        }
        await this.renewIfDue(provider, lease);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "External domain lease coordination failed.");
    }
  }

  private config(lease: ExternalDomainLeaseRecord):
    | NonNullable<TriggerSpecDefinition["externalDomainLease"]>
    | undefined {
    const occurrence = this.persistence.getTriggerOccurrence(lease.occurrenceId);
    const trigger = occurrence
      ? this.persistence.getTriggerSpecVersion(
          occurrence.triggerId,
          occurrence.triggerVersion
        )
      : undefined;
    const config = trigger?.externalDomainLease;
    return config?.providerId === lease.providerId &&
      config.resourceId === lease.domainKey
      ? config
      : undefined;
  }

  private async acquire(
    provider: ExternalDomainLeaseProvider,
    lease: ExternalDomainLeaseRecord
  ): Promise<void> {
    const config = this.config(lease);
    if (!config) {
      this.markReconciliationRequired(
        lease.requestId,
        "Pinned Trigger external domain lease configuration is missing or changed."
      );
      return;
    }
    try {
      const requestStartedAt = this.clock().toISOString();
      const grant = await provider.acquire({
        requestId: lease.requestId,
        domainKey: lease.domainKey,
        ownerId: lease.ownerId,
        ttlSeconds: config.ttlSeconds
      });
      if (!grant.active || Date.parse(grant.expiresAt) <= Date.parse(grant.serverNow)) {
        this.markReconciliationRequired(
          lease.requestId,
          "External domain lease acquisition replay is no longer active."
        );
        return;
      }
      this.persistence.bindExternalDomainLease({
        requestId: lease.requestId,
        expectedRevision: lease.revision,
        fencingToken: grant.fencingToken,
        serverNow: grant.serverNow,
        expiresAt: grant.expiresAt,
        updatedAt: requestStartedAt
      });
      this.#verifiedRequestIds.add(lease.requestId);
    } catch (error) {
      if (
        error instanceof ExternalDomainLeaseProviderError &&
        error.code === "DOMAIN_LEASE_BUSY"
      ) {
        this.releaseLocalAndDefer(lease, "The external inventory lease is busy.");
        return;
      }
      if (
        error instanceof ExternalDomainLeaseProviderError &&
        error.transportUncertain
      ) {
        return;
      }
      this.markReconciliationRequired(
        lease.requestId,
        controlledDiagnostic(error)
      );
    }
  }

  private async verifyBound(
    provider: ExternalDomainLeaseProvider,
    lease: ExternalDomainLeaseRecord
  ): Promise<boolean> {
    try {
      const requestStartedAt = this.clock().toISOString();
      const remote = await provider.read(lease.domainKey);
      if (
        !remote ||
        !remote.active ||
        Date.parse(remote.expiresAt) <= Date.parse(remote.serverNow) ||
        remote.ownerId !== lease.ownerId ||
        remote.fencingToken !== lease.fencingToken
      ) {
        this.markReconciliationRequired(
          lease.requestId,
          this.shouldRelease(lease)
            ? POST_TERMINAL_RECONCILIATION
            : "External domain lease could not be verified after Core startup."
        );
        return false;
      }
      this.persistence.renewExternalDomainLease({
        requestId: lease.requestId,
        expectedRevision: lease.revision,
        fencingToken: remote.fencingToken,
        serverNow: remote.serverNow,
        expiresAt: remote.expiresAt,
        updatedAt: requestStartedAt
      });
      this.#verifiedRequestIds.add(lease.requestId);
      return true;
    } catch (error) {
      if (
        error instanceof ExternalDomainLeaseProviderError &&
        error.transportUncertain
      ) {
        return false;
      }
      if (error instanceof ExternalDomainLeaseProviderError) {
        this.markReconciliationRequired(
          lease.requestId,
          controlledDiagnostic(error)
        );
        return false;
      }
      throw error;
    }
  }

  private async renewIfDue(
    provider: ExternalDomainLeaseProvider,
    lease: ExternalDomainLeaseRecord
  ): Promise<void> {
    const config = this.config(lease);
    if (!config || lease.fencingToken === undefined || !lease.expiresAt) {
      this.markReconciliationRequired(
        lease.requestId,
        "Bound external domain lease is missing its pinned configuration or fence."
      );
      return;
    }
    const now = this.clock();
    const remaining = estimatedRemainingMilliseconds(
      lease,
      now.toISOString()
    );
    if (remaining === undefined) {
      this.markReconciliationRequired(
        lease.requestId,
        "Bound external domain lease is missing its server clock window."
      );
      return;
    }
    if (remaining <= 0) {
      this.markReconciliationRequired(
        lease.requestId,
        "External domain lease expired before renewal."
      );
      return;
    }
    if (remaining > Math.max(1, Math.floor(config.ttlSeconds / 3)) * 1_000) {
      return;
    }
    try {
      const grant = await provider.renew({
        domainKey: lease.domainKey,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        ttlSeconds: config.ttlSeconds
      });
      if (!grant.active) {
        this.markReconciliationRequired(
          lease.requestId,
          "External domain lease renewal returned an inactive grant."
        );
        return;
      }
      this.persistence.renewExternalDomainLease({
        requestId: lease.requestId,
        expectedRevision: lease.revision,
        fencingToken: grant.fencingToken,
        serverNow: grant.serverNow,
        expiresAt: grant.expiresAt,
        updatedAt: now.toISOString()
      });
      this.#verifiedRequestIds.add(lease.requestId);
    } catch (error) {
      this.markReconciliationRequired(
        lease.requestId,
        controlledDiagnostic(error)
      );
    }
  }

  private shouldRelease(lease: ExternalDomainLeaseRecord): boolean {
    if (lease.runId) {
      const run = this.persistence.getRun(lease.runId);
      return !!run && TERMINAL_RUN_STATES.has(run.status);
    }
    const attempt = this.persistence.getTriggerAttempt(lease.ownerId);
    return !!attempt && attempt.status === "terminal";
  }

  private async release(
    provider: ExternalDomainLeaseProvider,
    lease: ExternalDomainLeaseRecord
  ): Promise<void> {
    if (lease.fencingToken === undefined) {
      this.markReconciliationRequired(
        lease.requestId,
        POST_TERMINAL_RECONCILIATION
      );
      return;
    }
    try {
      const grant = await provider.release({
        domainKey: lease.domainKey,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken
      });
      if (grant.active) {
        this.markReconciliationRequired(
          lease.requestId,
          POST_TERMINAL_RECONCILIATION
        );
        return;
      }
      this.releaseLocal(lease);
    } catch (error) {
      this.markReconciliationRequired(
        lease.requestId,
        POST_TERMINAL_RECONCILIATION
      );
    }
  }

  private async reconcile(
    provider: ExternalDomainLeaseProvider,
    lease: ExternalDomainLeaseRecord
  ): Promise<void> {
    const run = lease.runId ? this.persistence.getRun(lease.runId) : undefined;
    if (run && !TERMINAL_RUN_STATES.has(run.status)) return;
    const attempt = this.persistence.getTriggerAttempt(lease.ownerId);
    const attemptRun = attempt?.workflowRunId
      ? this.persistence.getRun(attempt.workflowRunId)
      : undefined;
    if (attemptRun && !TERMINAL_RUN_STATES.has(attemptRun.status)) return;
    const linkedTerminalRun = run ?? attemptRun;
    if (linkedTerminalRun &&
      lease.diagnostic !== POST_TERMINAL_RECONCILIATION) {
      // A provider/write reconciliation marker is not cleared merely because
      // the remote lease can be read or released. The business effect must be
      // verified by an explicit reconciler before another Attempt may write.
      return;
    }
    try {
      const remote = await provider.read(lease.domainKey);
      if (!remote || !remote.active) {
        this.releaseLocal(lease);
        return;
      }
      if (
        remote.ownerId !== lease.ownerId ||
        (lease.fencingToken !== undefined &&
          remote.fencingToken !== lease.fencingToken)
      ) {
        this.releaseLocal(lease);
        return;
      }
      const released = await provider.release({
        domainKey: lease.domainKey,
        ownerId: remote.ownerId,
        fencingToken: remote.fencingToken
      });
      if (!released.active) this.releaseLocal(lease);
    } catch {
      // Reconciliation remains durable and is retried without changing identity.
    }
  }

  private releaseLocal(lease: ExternalDomainLeaseRecord): void {
    const current = this.persistence.getExternalDomainLease(lease.requestId);
    if (!current || current.state === "released") return;
    try {
      this.persistence.releaseExternalDomainLease({
        requestId: current.requestId,
        expectedRevision: current.revision,
        releasedAt: this.clock().toISOString()
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      return;
    }
    this.#verifiedRequestIds.delete(lease.requestId);
    if (!this.persistence.getTriggerAttempt(current.ownerId)) {
      const occurrence = this.persistence.getTriggerOccurrence(current.occurrenceId);
      if (
        occurrence &&
        (occurrence.status === "pending" || occurrence.status === "deferred")
      ) {
        this.defer(occurrence, current.diagnostic ?? "External domain lease was released before Run creation.");
      }
    }
  }

  private releaseLocalAndDefer(
    lease: ExternalDomainLeaseRecord,
    diagnostic: string
  ): void {
    const current = this.persistence.getExternalDomainLease(lease.requestId);
    if (!current || current.state === "released") return;
    this.persistence.releaseExternalDomainLease({
      requestId: current.requestId,
      expectedRevision: current.revision,
      releasedAt: this.clock().toISOString()
    });
    this.#verifiedRequestIds.delete(lease.requestId);
    const occurrence = this.persistence.getTriggerOccurrence(current.occurrenceId);
    if (occurrence) this.defer(occurrence, diagnostic);
  }

  private defer(
    occurrence: TriggerOccurrenceRecord,
    diagnostic: string
  ): void {
    try {
      const now = this.clock();
      this.persistence.deferTriggerOccurrence({
        occurrenceId: occurrence.occurrenceId,
        expectedRevision: occurrence.revision,
        updatedAt: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + DEFER_SECONDS * 1_000).toISOString(),
        diagnostic
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
    }
  }
}

export function externalLeaseAllowsRunEffects(
  persistence: Persistence,
  runId: string,
  now: string,
  canUse: (requestId: string) => boolean = () => true
): boolean {
  const lease = persistence
    .listExternalDomainLeases()
    .find((item) => item.runId === runId);
  if (lease) {
    const remaining = estimatedRemainingMilliseconds(lease, now);
    return (
      lease.state === "bound" &&
      remaining !== undefined &&
      remaining > 0 &&
      canUse(lease.requestId)
    );
  }
  const attempt = persistence
    .listActiveTriggerAttempts()
    .find((item) => item.workflowRunId === runId);
  if (!attempt) return true;
  const occurrence = persistence.getTriggerOccurrence(attempt.occurrenceId);
  const pinned = occurrence
    ? persistence.getTriggerSpecVersion(
        occurrence.triggerId,
        occurrence.triggerVersion
      )
    : undefined;
  return pinned?.externalDomainLease === undefined;
}
