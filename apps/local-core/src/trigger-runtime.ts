import { randomUUID } from "node:crypto";
import { projectTerminalTriggerOccurrenceAttention } from "@bpa/attention-core";
import type {
  AttentionRecord,
  BrowserControlLeaseRecord,
  ExternalDomainLeaseRecord,
  Persistence,
  RunRecord,
  TriggerAttemptRecord,
  TriggerOccurrenceRecord,
  TriggerSpecDefinition,
  TriggerSpecRecord,
  TriggerTerminalOutcome
} from "@bpa/persistence";
import { RevisionConflictError } from "@bpa/persistence";
import { ExternalDomainLeaseCoordinator } from "./external-domain-lease-coordinator.js";
import { occurrencePageBetween } from "./schedule-calendar.js";

const LEASE_TTL_SECONDS = 300;
const DEFER_SECONDS = 60;
const ACTIVE_WORKFLOW_STATES = new Set([
  "created",
  "validated",
  "queued",
  "running",
  "waiting_browser",
  "waiting_assistance",
  "waiting_human",
  "paused",
  "compensating"
]);

interface TriggerControlLeases {
  readonly trigger: BrowserControlLeaseRecord;
  readonly browser?: BrowserControlLeaseRecord;
}

interface RetainedTriggerControlLeases {
  readonly trigger?: BrowserControlLeaseRecord;
  readonly browser?: BrowserControlLeaseRecord;
}

export interface TriggerFireInput {
  readonly trigger: TriggerSpecRecord;
  readonly occurrenceKey: string;
  readonly scheduledAt?: string;
  readonly dataset?: { readonly id: string; readonly version: string };
}

export interface TriggerFireResult {
  readonly occurrence: TriggerOccurrenceRecord;
  readonly attempt?: TriggerAttemptRecord;
}

export class TriggerRuntime {
  constructor(
    readonly persistence: Persistence,
    readonly createRun: (
      trigger: TriggerSpecRecord,
      input: unknown,
      triggerAttemptId: string,
      externalDomainLeaseRequestId?: string
    ) => RunRecord,
    readonly cancelWorkflow: (runId: string, reason: string) => RunRecord,
    readonly clock: () => Date = () => new Date(),
    readonly externalDomainLeases?: ExternalDomainLeaseCoordinator,
    readonly markWorkflowUncertain?: (
      runId: string,
      diagnostic: string
    ) => RunRecord
  ) {}

  fire(input: TriggerFireInput): TriggerFireResult {
    const now = this.clock().toISOString();
    const claimed = this.persistence.claimTriggerOccurrence({
      occurrenceId: `trigger-occurrence:${randomUUID()}`,
      triggerId: input.trigger.spec.id,
      triggerVersion: input.trigger.spec.version,
      occurrenceKey: input.occurrenceKey,
      scheduledAt: input.scheduledAt ?? now,
      status: "pending",
      attemptCount: 0,
      revision: 0,
      ...(input.dataset
        ? {
            datasetId: input.dataset.id,
            datasetVersion: input.dataset.version
          }
        : {}),
      createdAt: now,
      updatedAt: now
    });
    return this.startOccurrence(input.trigger, claimed.record, now);
  }

  tick(): void {
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    this.sweepAttemptLeases(now);
    this.reconcileActiveAttempts(now);
    this.sweepAttemptLeases(now);
    const excludedTriggerIds = new Set<string>();
    const triggerErrors: Error[] = [];
    for (const trigger of this.persistence.listTriggerSpecs()) {
      if (!trigger.spec.enabled) continue;
      try {
        if (trigger.spec.kind === "schedule" && trigger.spec.schedule) {
          if (!this.materializeSchedule(trigger, nowDate)) {
            excludedTriggerIds.add(trigger.spec.id);
          }
        }
        if (trigger.spec.kind === "dataset" && trigger.spec.dataset) {
          const dataset = this.persistence.latestDatasetVersion(
            trigger.spec.dataset.id
          );
          if (dataset) {
            this.fire({
              trigger,
              occurrenceKey: `dataset:${dataset.id}@${dataset.version}`,
              scheduledAt: dataset.createdAt,
              dataset: { id: dataset.id, version: dataset.version }
            });
          }
        }
      } catch (error) {
        excludedTriggerIds.add(trigger.spec.id);
        triggerErrors.push(
          new Error(`Trigger ${trigger.spec.id} tick failed.`, { cause: error })
        );
      }
    }
    this.startRunnableOccurrences(now, excludedTriggerIds);
    if (triggerErrors.length > 0) {
      throw new AggregateError(triggerErrors, "One or more Trigger ticks failed.");
    }
  }

  private materializeSchedule(
    trigger: TriggerSpecRecord,
    nowDate: Date
  ): boolean {
    const schedule = trigger.spec.schedule;
    const missedRunPolicy = trigger.spec.missedRunPolicy;
    if (!schedule || !missedRunPolicy) return true;
    const now = nowDate.toISOString();
    let state = this.persistence.initializeTriggerScheduleState({
      triggerId: trigger.spec.id,
      triggerVersion: trigger.spec.version,
      cursorAt: trigger.updatedAt,
      createdAt: now
    });
    if (Date.parse(trigger.updatedAt) > Date.parse(state.cursorAt)) {
      state = this.persistence.advanceTriggerScheduleState({
        triggerId: trigger.spec.id,
        triggerVersion: trigger.spec.version,
        expectedRevision: state.revision,
        cursorAt: trigger.updatedAt,
        updatedAt: now
      });
    }
    if (Date.parse(state.cursorAt) >= nowDate.getTime()) return true;
    const due = occurrencePageBetween(
      schedule,
      new Date(state.cursorAt),
      nowDate
    );
    for (const item of due) {
      this.persistence.claimTriggerOccurrence({
        occurrenceId: `trigger-occurrence:${randomUUID()}`,
        triggerId: trigger.spec.id,
        triggerVersion: trigger.spec.version,
        occurrenceKey: item.occurrenceKey,
        scheduledAt: item.scheduledAt,
        status: "pending",
        attemptCount: 0,
        revision: 0,
        createdAt: now,
        updatedAt: now
      });
    }
    const cursorAt = due.at(-1)?.scheduledAt ?? now;
    state = this.persistence.advanceTriggerScheduleState({
      triggerId: trigger.spec.id,
      triggerVersion: trigger.spec.version,
      expectedRevision: state.revision,
      cursorAt,
      updatedAt: now
    });
    this.applyMissedRunPolicy(trigger, nowDate);
    return due.length < 1_000;
  }

  private applyMissedRunPolicy(
    trigger: TriggerSpecRecord,
    nowDate: Date
  ): void {
    const schedule = trigger.spec.schedule!;
    const policy = trigger.spec.missedRunPolicy!;
    const candidates = this.persistence
      .listActiveTriggerOccurrences(trigger.spec.id)
      .filter(
        (item) =>
          item.triggerVersion === trigger.spec.version &&
          (item.status === "pending" || item.status === "deferred")
      )
      .sort(
        (left, right) =>
          Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt) ||
          left.occurrenceId.localeCompare(right.occurrenceId)
      );
    let keepFrom = candidates.length;
    let outcome: Extract<TriggerTerminalOutcome, "missed" | "skipped"> =
      "missed";
    if (policy === "skip") {
      const cutoff = nowDate.getTime() - schedule.onTimeWindowSeconds * 1_000;
      keepFrom = candidates.findIndex(
        (item) => Date.parse(item.scheduledAt) >= cutoff
      );
      if (keepFrom < 0) keepFrom = candidates.length;
      outcome = "skipped";
    } else if (policy === "run_once") {
      keepFrom = Math.max(0, candidates.length - 1);
    } else {
      keepFrom = Math.max(
        0,
        candidates.length - (trigger.spec.maxCatchUpOccurrences ?? 0)
      );
    }
    const now = nowDate.toISOString();
    for (const stale of candidates.slice(0, keepFrom)) {
      this.persistence.finishTriggerOccurrenceWithAttention({
        occurrenceId: stale.occurrenceId,
        expectedRevision: stale.revision,
        outcome,
        diagnostic:
          outcome === "skipped"
            ? "The schedule occurrence exceeded its on-time window."
            : "A newer schedule occurrence superseded this catch-up candidate.",
        updatedAt: now,
        attention: this.triggerAttention(stale, outcome, now)
      });
    }
  }

  private startRunnableOccurrences(
    now: string,
    excludedTriggerIds: ReadonlySet<string> = new Set()
  ): void {
    for (const occurrence of this.persistence.listRunnableTriggerOccurrences({
      now
    })) {
      if (excludedTriggerIds.has(occurrence.triggerId)) continue;
      const current = this.persistence.getTriggerSpec(occurrence.triggerId);
      if (!current?.spec.enabled) continue;
      const pinned = this.persistence.getTriggerSpecVersion(
        occurrence.triggerId,
        occurrence.triggerVersion
      );
      if (!pinned) {
        this.persistence.finishTriggerOccurrenceWithAttention({
          occurrenceId: occurrence.occurrenceId,
          expectedRevision: occurrence.revision,
          outcome: "failed",
          diagnostic: "Pinned TriggerSpec version is missing.",
          updatedAt: now,
          attention: this.triggerAttention(occurrence, "failed", now)
        });
        continue;
      }
      const trigger: TriggerSpecRecord =
        current.spec.version === pinned.version
          ? current
          : {
              spec: pinned,
              revision: 0,
              createdAt: occurrence.createdAt,
              updatedAt: occurrence.updatedAt,
              createdBy: "trigger-runtime",
              updatedBy: "trigger-runtime"
            };
      this.startOccurrence(trigger, occurrence, now);
    }
  }

  private startOccurrence(
    trigger: TriggerSpecRecord,
    occurrence: TriggerOccurrenceRecord,
    now: string
  ): TriggerFireResult {
    if (
      occurrence.status === "running" ||
      occurrence.status === "terminal" ||
      (occurrence.status === "deferred" &&
        Date.parse(occurrence.nextAttemptAt ?? "") > Date.parse(now))
    ) {
      return {
        occurrence,
        ...this.latestAttempt(occurrence.occurrenceId)
      };
    }
    const externalConfig = trigger.spec.externalDomainLease;
    if (externalConfig && !this.externalDomainLeases?.hasProvider(externalConfig.providerId)) {
      const failed = this.persistence.finishTriggerOccurrenceWithAttention({
        occurrenceId: occurrence.occurrenceId,
        expectedRevision: occurrence.revision,
        outcome: "blocked",
        diagnostic: `External domain lease provider is not configured: ${externalConfig.providerId}`,
        updatedAt: now,
        attention: this.triggerAttention(occurrence, "blocked", now)
      });
      return { occurrence: failed.occurrence };
    }
    const externalLease = externalConfig
      ? this.persistence
          .listExternalDomainLeases()
          .find(
            (item) =>
              item.occurrenceId === occurrence.occurrenceId &&
              item.state !== "released"
          )
      : undefined;
    if (externalConfig && !externalLease) {
      const ownerId = `trigger-attempt:${randomUUID()}`;
      this.persistence.beginExternalDomainLeaseAcquisition({
        requestId: `external-domain-lease:${randomUUID()}`,
        providerId: externalConfig.providerId,
        domainKey: externalConfig.resourceId,
        occurrenceId: occurrence.occurrenceId,
        ownerId,
        createdAt: now
      });
      return { occurrence, ...this.latestAttempt(occurrence.occurrenceId) };
    }
    if (
      externalLease &&
      (externalLease.state === "acquiring" ||
        externalLease.state === "reconciliation_required")
    ) {
      return { occurrence, ...this.latestAttempt(occurrence.occurrenceId) };
    }
    if (
      externalLease &&
      !this.externalDomainLeases?.canStart(externalLease.requestId)
    ) {
      return { occurrence, ...this.latestAttempt(occurrence.occurrenceId) };
    }
    const attemptId = externalLease?.ownerId ?? `trigger-attempt:${randomUUID()}`;
    const triggerLease = this.persistence.acquireTriggerLease({
      concurrencyKey: trigger.spec.concurrencyKey,
      ownerId: attemptId,
      now,
      ttlSeconds: LEASE_TTL_SECONDS
    });
    if (!triggerLease) {
      if (externalLease) {
        this.externalDomainLeases!.markReconciliationRequired(
          externalLease.requestId,
          "Local Trigger concurrency lease is busy after external acquisition."
        );
        return { occurrence };
      }
      return { occurrence: this.deferOccurrence(occurrence, now) };
    }
    const browserInstanceId = trigger.spec.browserInstanceId;
    const browserLease = browserInstanceId
      ? this.persistence.acquireBrowserControlLease({
          resourceId: this.browserResourceId(browserInstanceId),
          ownerId: attemptId,
          now,
          ttlSeconds: LEASE_TTL_SECONDS
        })
      : undefined;
    if (browserInstanceId && !browserLease) {
      this.persistence.releaseTriggerLease({
        concurrencyKey: trigger.spec.concurrencyKey,
        ownerId: attemptId,
        fencingToken: triggerLease.fencingToken,
        releasedAt: now
      });
      if (externalLease) {
        this.externalDomainLeases!.markReconciliationRequired(
          externalLease.requestId,
          "Local Browser instance lease is busy after external acquisition."
        );
        return { occurrence };
      }
      return { occurrence: this.deferOccurrence(occurrence, now) };
    }
    let created: {
      occurrence: TriggerOccurrenceRecord;
      attempt: TriggerAttemptRecord;
    };
    try {
      created = this.persistence.createTriggerAttempt({
        attemptId,
        occurrenceId: occurrence.occurrenceId,
        expectedOccurrenceRevision: occurrence.revision,
        createdAt: now
      });
    } catch (error) {
      if (externalLease) {
        this.externalDomainLeases!.markReconciliationRequired(
          externalLease.requestId,
          "Trigger Attempt creation conflicted after external lease acquisition."
        );
      }
      this.releaseLeases(
        trigger.spec,
        attemptId,
        { trigger: triggerLease, ...(browserLease ? { browser: browserLease } : {}) },
        now
      );
      if (error instanceof RevisionConflictError) {
        const current = this.persistence.getTriggerOccurrence(
          occurrence.occurrenceId
        );
        if (!current) throw error;
        return { occurrence: current, ...this.latestAttempt(current.occurrenceId) };
      }
      throw error;
    }
    let attempt = this.persistence.updateTriggerAttempt({
      attemptId,
      expectedRevision: created.attempt.revision,
      status: "running",
      fencingToken: triggerLease.fencingToken,
      ...(browserLease
        ? { browserFencingToken: browserLease.fencingToken }
        : {}),
      updatedAt: now
    });
    try {
      this.createRun(
        trigger,
        trigger.spec.input,
        attemptId,
        externalLease?.requestId
      );
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const currentAttempt = this.persistence.getTriggerAttempt(attemptId)!;
      if (currentAttempt.workflowRunId) {
        return {
          occurrence: this.persistence.getTriggerOccurrence(
            created.occurrence.occurrenceId
          )!,
          attempt: currentAttempt
        };
      }
      if (externalLease) {
        this.externalDomainLeases!.markReconciliationRequired(
          externalLease.requestId,
          "Workflow Run creation failed after external lease acquisition."
        );
      } else {
        this.persistence.finishTriggerAttempt({
          attemptId,
          expectedAttemptRevision: currentAttempt.revision,
          occurrenceId: created.occurrence.occurrenceId,
          expectedOccurrenceRevision: created.occurrence.revision,
          outcome: "blocked",
          diagnostic,
          updatedAt: now,
          attention: this.triggerAttention(created.occurrence, "blocked", now)
        });
        this.releaseLeases(
          trigger.spec,
          attemptId,
          { trigger: triggerLease, ...(browserLease ? { browser: browserLease } : {}) },
          now
        );
      }
      return {
        occurrence: this.persistence.getTriggerOccurrence(
          created.occurrence.occurrenceId
        )!,
        attempt: this.persistence.getTriggerAttempt(attemptId)!
      };
    }
    attempt = this.persistence.getTriggerAttempt(attemptId)!;
    if (!attempt.workflowRunId) {
      throw new Error(
        `Workflow Run was not atomically linked to Trigger Attempt: ${attemptId}`
      );
    }
    return {
      occurrence: this.persistence.getTriggerOccurrence(
        created.occurrence.occurrenceId
      )!,
      attempt
    };
  }

  private deferOccurrence(
    occurrence: TriggerOccurrenceRecord,
    now: string
  ): TriggerOccurrenceRecord {
    try {
      return this.persistence.deferTriggerOccurrence({
        occurrenceId: occurrence.occurrenceId,
        expectedRevision: occurrence.revision,
        nextAttemptAt: new Date(
          Date.parse(now) + DEFER_SECONDS * 1_000
        ).toISOString(),
        updatedAt: now,
        diagnostic: "The required execution lease is busy."
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const current = this.persistence.getTriggerOccurrence(
        occurrence.occurrenceId
      );
      if (!current) throw error;
      return current;
    }
  }

  private reconcileActiveAttempts(now: string): void {
    for (const attempt of this.persistence.listActiveTriggerAttempts()) {
      const occurrence = this.persistence.getTriggerOccurrence(
        attempt.occurrenceId
      );
      if (!occurrence) continue;
      const trigger = this.persistence.getTriggerSpecVersion(
        occurrence.triggerId,
        occurrence.triggerVersion
      );
      if (!trigger) {
        this.reconcileMissingPinnedTrigger(attempt, occurrence, now);
        continue;
      }
      const externalLease = trigger.externalDomainLease
        ? this.persistence
            .listExternalDomainLeases()
            .find((item) => item.ownerId === attempt.attemptId)
        : undefined;
      const control = this.findOrRenewLeases(trigger, attempt, now);
      if ("diagnostic" in control) {
        if (trigger.externalDomainLease && externalLease) {
          this.externalDomainLeases?.markReconciliationRequired(
            externalLease.requestId,
            control.diagnostic
          );
          if (attempt.workflowRunId) {
            try {
              this.markWorkflowUncertain?.(
                attempt.workflowRunId,
                control.diagnostic
              );
            } catch {
              // Keep the reconciliation blocker if the Workflow is not in a
              // state that can be safely marked uncertain.
            }
          }
          this.releaseRetainedLeases(
            trigger,
            attempt.attemptId,
            control.retainedLeases,
            now
          );
          continue;
        }
        this.reconcileLostControl(
          trigger,
          attempt,
          occurrence,
          now,
          control.diagnostic,
          control.retainedLeases
        );
        continue;
      }
      if (trigger.externalDomainLease) {
        if (!externalLease) {
          // The pinned Trigger requires an external fence. Keep the Attempt
          // active and block effects until an operator reconciles the missing
          // durable lease record; do not manufacture a terminal outcome.
          if (attempt.workflowRunId) {
            try {
              this.markWorkflowUncertain?.(
                attempt.workflowRunId,
                "External domain lease record is missing."
              );
            } catch {
              // Keep the Attempt active and effects fenced for reconciliation.
            }
          }
          continue;
        }
        if (externalLease.state !== "bound") {
          this.reconcileInactiveExternalLease(
            trigger,
            attempt,
            occurrence,
            control.leases,
            externalLease,
            now
          );
          continue;
        }
      }
      if (!attempt.workflowRunId) {
        this.finishAttempt(
          trigger,
          attempt,
          occurrence,
          control.leases,
          "failed",
          now,
          "Workflow Run was not created before reconciliation."
        );
        continue;
      }
      const run = this.persistence.getRun(attempt.workflowRunId);
      if (!run) {
        this.finishAttempt(
          trigger,
          attempt,
          occurrence,
          control.leases,
          "failed",
          now,
          "Workflow Run is missing."
        );
        continue;
      }
      if (ACTIVE_WORKFLOW_STATES.has(run.status)) continue;
      if (externalLease?.state === "bound") {
        // The coordinator must release the remote fence and durably record the
        // release before the Trigger Attempt can become terminal.
        continue;
      }
      const outcome: TriggerTerminalOutcome = (() => {
        switch (run.status) {
          case "succeeded":
            return "complete";
          case "rejected":
          case "uncertain":
          case "cancelled":
          case "failed":
            return run.status;
          default:
            throw new Error(`Unsupported Workflow terminal: ${run.status}`);
        }
      })();
      this.finishAttempt(
        trigger,
        attempt,
        occurrence,
        control.leases,
        outcome,
        now
      );
    }
  }

  private reconcileInactiveExternalLease(
    trigger: TriggerSpecDefinition,
    attempt: TriggerAttemptRecord,
    occurrence: TriggerOccurrenceRecord,
    leases: TriggerControlLeases,
    externalLease: ExternalDomainLeaseRecord,
    now: string
  ): void {
    if (externalLease.state !== "released") {
      // Effects are fenced while timers may still drive the Workflow to its
      // own uncertain terminal. Do not misclassify domain loss as cancellation.
      if (attempt.workflowRunId) {
        try {
          this.markWorkflowUncertain?.(
            attempt.workflowRunId,
            externalLease.diagnostic ??
              "External domain lease requires reconciliation."
          );
        } catch {
          // Keep the reconciliation blocker if the Workflow cannot yet be
          // terminalized without inventing a successful or cancelled result.
        }
      }
      return;
    }
    if (!attempt.workflowRunId) {
      this.finishAttempt(
        trigger,
        attempt,
        occurrence,
        leases,
        "blocked",
        now,
        externalLease.diagnostic ?? "Workflow Run was not created."
      );
      return;
    }
    const run = this.persistence.getRun(attempt.workflowRunId);
    if (!run) {
      this.finishAttempt(
        trigger,
        attempt,
        occurrence,
        leases,
        "failed",
        now,
        "Workflow Run is missing."
      );
      return;
    }
    if (ACTIVE_WORKFLOW_STATES.has(run.status)) {
      return;
    }
    const current = this.persistence.getRun(run.id);
    const outcome = current ? this.workflowTerminalOutcome(current) : undefined;
    if (!outcome) return;
    this.finishAttempt(
      trigger,
      attempt,
      occurrence,
      leases,
      outcome,
      now,
      outcome === "cancelled" ? externalLease.diagnostic : undefined
    );
  }

  private findOrRenewLeases(
    trigger: TriggerSpecDefinition,
    attempt: TriggerAttemptRecord,
    now: string
  ):
    | { readonly leases: TriggerControlLeases }
    | {
        readonly diagnostic: string;
        readonly retainedLeases: RetainedTriggerControlLeases;
      } {
    const triggerLease =
      attempt.fencingToken === undefined
        ? undefined
        : this.persistence.renewTriggerLease({
            concurrencyKey: trigger.concurrencyKey,
            ownerId: attempt.attemptId,
            fencingToken: attempt.fencingToken,
            now,
            ttlSeconds: LEASE_TTL_SECONDS
          });
    if (!triggerLease) {
      const retainedBrowserLease =
        trigger.browserInstanceId && attempt.browserFencingToken !== undefined
          ? this.persistence.renewBrowserControlLease({
              resourceId: this.browserResourceId(trigger.browserInstanceId),
              ownerId: attempt.attemptId,
              fencingToken: attempt.browserFencingToken,
              now,
              ttlSeconds: LEASE_TTL_SECONDS
            })
          : undefined;
      return {
        diagnostic: "Trigger concurrency lease was lost.",
        retainedLeases: {
          ...(retainedBrowserLease ? { browser: retainedBrowserLease } : {})
        }
      };
    }
    if (!trigger.browserInstanceId) {
      return { leases: { trigger: triggerLease } };
    }
    if (attempt.browserFencingToken === undefined) {
      return {
        diagnostic: "Browser instance lease token is missing.",
        retainedLeases: { trigger: triggerLease }
      };
    }
    const browserLease = this.persistence.renewBrowserControlLease({
      resourceId: this.browserResourceId(trigger.browserInstanceId),
      ownerId: attempt.attemptId,
      fencingToken: attempt.browserFencingToken,
      now,
      ttlSeconds: LEASE_TTL_SECONDS
    });
    if (!browserLease) {
      return {
        diagnostic: "Browser instance lease was lost.",
        retainedLeases: { trigger: triggerLease }
      };
    }
    return { leases: { trigger: triggerLease, browser: browserLease } };
  }

  private finishAttempt(
    trigger: TriggerSpecDefinition,
    attempt: TriggerAttemptRecord,
    occurrence: TriggerOccurrenceRecord,
    leases: TriggerControlLeases,
    outcome: TriggerTerminalOutcome,
    now: string,
    diagnostic?: string
  ): void {
    this.persistence.finishTriggerAttempt({
      attemptId: attempt.attemptId,
      expectedAttemptRevision: attempt.revision,
      occurrenceId: occurrence.occurrenceId,
      expectedOccurrenceRevision: occurrence.revision,
      outcome,
      ...(diagnostic ? { diagnostic } : {}),
      updatedAt: now,
      ...(!attempt.workflowRunId && (outcome === "blocked" || outcome === "failed")
        ? { attention: this.triggerAttention(occurrence, outcome, now) }
        : {})
    });
    this.releaseLeases(trigger, attempt.attemptId, leases, now);
  }

  private finishWithoutLeases(
    attempt: TriggerAttemptRecord,
    occurrence: TriggerOccurrenceRecord,
    outcome: TriggerTerminalOutcome,
    now: string,
    diagnostic?: string
  ): void {
    this.persistence.finishTriggerAttempt({
      attemptId: attempt.attemptId,
      expectedAttemptRevision: attempt.revision,
      occurrenceId: occurrence.occurrenceId,
      expectedOccurrenceRevision: occurrence.revision,
      outcome,
      ...(diagnostic ? { diagnostic } : {}),
      updatedAt: now,
      ...(!attempt.workflowRunId && (outcome === "blocked" || outcome === "failed")
        ? { attention: this.triggerAttention(occurrence, outcome, now) }
        : {})
    });
  }

  private reconcileLostControl(
    trigger: TriggerSpecDefinition,
    attempt: TriggerAttemptRecord,
    occurrence: TriggerOccurrenceRecord,
    now: string,
    diagnostic: string,
    retainedLeases: RetainedTriggerControlLeases
  ): void {
    if (!attempt.workflowRunId) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        "failed",
        now,
        diagnostic
      );
      this.releaseRetainedLeases(
        trigger,
        attempt.attemptId,
        retainedLeases,
        now
      );
      return;
    }
    const run = this.persistence.getRun(attempt.workflowRunId);
    if (!run) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        "failed",
        now,
        "Workflow Run is missing."
      );
      this.releaseRetainedLeases(
        trigger,
        attempt.attemptId,
        retainedLeases,
        now
      );
      return;
    }
    const existingOutcome = this.workflowTerminalOutcome(run);
    if (existingOutcome) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        existingOutcome,
        now,
        existingOutcome === "cancelled" ? diagnostic : undefined
      );
      this.releaseRetainedLeases(
        trigger,
        attempt.attemptId,
        retainedLeases,
        now
      );
      return;
    }
    if (!ACTIVE_WORKFLOW_STATES.has(run.status)) {
      throw new Error(`Unsupported Workflow state: ${run.status}`);
    }
    try {
      this.cancelWorkflow(run.id, diagnostic);
    } catch {
      // The Trigger Attempt remains active so a later tick retries the durable
      // cancellation before it is allowed to become terminal.
      return;
    }
    const current = this.persistence.getRun(run.id);
    if (!current) return;
    const cancelledOutcome = this.workflowTerminalOutcome(current);
    if (!cancelledOutcome) return;
    this.finishWithoutLeases(
      attempt,
      occurrence,
      cancelledOutcome,
      now,
      cancelledOutcome === "cancelled" ? diagnostic : undefined
    );
    this.releaseRetainedLeases(
      trigger,
      attempt.attemptId,
      retainedLeases,
      now
    );
  }

  private reconcileMissingPinnedTrigger(
    attempt: TriggerAttemptRecord,
    occurrence: TriggerOccurrenceRecord,
    now: string
  ): void {
    const diagnostic = "Pinned TriggerSpec version is missing.";
    if (!attempt.workflowRunId) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        "failed",
        now,
        diagnostic
      );
      return;
    }
    const run = this.persistence.getRun(attempt.workflowRunId);
    if (!run) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        "failed",
        now,
        "Workflow Run is missing."
      );
      return;
    }
    const existingOutcome = this.workflowTerminalOutcome(run);
    if (existingOutcome) {
      this.finishWithoutLeases(
        attempt,
        occurrence,
        existingOutcome,
        now,
        existingOutcome === "cancelled" ? diagnostic : undefined
      );
      return;
    }
    if (!ACTIVE_WORKFLOW_STATES.has(run.status)) {
      throw new Error(`Unsupported Workflow state: ${run.status}`);
    }
    try {
      this.cancelWorkflow(run.id, diagnostic);
    } catch {
      // Without the immutable TriggerSpec the Runtime cannot safely renew or
      // target leases. Keep the Attempt active so leases fence until TTL while
      // durable cancellation is retried.
      return;
    }
    const current = this.persistence.getRun(run.id);
    if (!current) return;
    const cancelledOutcome = this.workflowTerminalOutcome(current);
    if (!cancelledOutcome) return;
    this.finishWithoutLeases(
      attempt,
      occurrence,
      cancelledOutcome,
      now,
      cancelledOutcome === "cancelled" ? diagnostic : undefined
    );
  }

  private workflowTerminalOutcome(
    run: RunRecord
  ): TriggerTerminalOutcome | undefined {
    switch (run.status) {
      case "succeeded":
        return "complete";
      case "rejected":
      case "uncertain":
      case "cancelled":
      case "failed":
        return run.status;
      default:
        return undefined;
    }
  }

  private releaseLeases(
    trigger: TriggerSpecDefinition,
    ownerId: string,
    leases: TriggerControlLeases,
    releasedAt: string
  ): void {
    this.releaseRetainedLeases(trigger, ownerId, leases, releasedAt);
  }

  private releaseRetainedLeases(
    trigger: TriggerSpecDefinition,
    ownerId: string,
    leases: RetainedTriggerControlLeases,
    releasedAt: string
  ): void {
    if (leases.browser && trigger.browserInstanceId) {
      this.persistence.releaseBrowserControlLease({
        resourceId: this.browserResourceId(trigger.browserInstanceId),
        ownerId,
        fencingToken: leases.browser.fencingToken,
        releasedAt
      });
    }
    if (leases.trigger) {
      this.persistence.releaseTriggerLease({
        concurrencyKey: trigger.concurrencyKey,
        ownerId,
        fencingToken: leases.trigger.fencingToken,
        releasedAt
      });
    }
  }

  private sweepAttemptLeases(now: string): void {
    for (const lease of this.persistence.listTriggerLeases(now)) {
      if (!lease.ownerId.startsWith("trigger-attempt:")) continue;
      const attempt = this.persistence.getTriggerAttempt(lease.ownerId);
      if (!attempt || attempt.status !== "terminal") continue;
      this.persistence.releaseTriggerLease({
        concurrencyKey: lease.resourceId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        releasedAt: now
      });
    }
    for (const lease of this.persistence.listBrowserControlLeases(now)) {
      if (!lease.ownerId.startsWith("trigger-attempt:")) continue;
      const attempt = this.persistence.getTriggerAttempt(lease.ownerId);
      if (!attempt || attempt.status !== "terminal") continue;
      this.persistence.releaseBrowserControlLease({
        resourceId: lease.resourceId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        releasedAt: now
      });
    }
  }

  private latestAttempt(
    occurrenceId: string
  ): { readonly attempt?: TriggerAttemptRecord } {
    const attempts = this.persistence.listTriggerAttempts(occurrenceId);
    const attempt = attempts.at(-1);
    return attempt ? { attempt } : {};
  }

  private browserResourceId(browserInstanceId: string): string {
    return `browser-instance:${browserInstanceId}`;
  }

  private triggerAttention(
    occurrence: TriggerOccurrenceRecord,
    outcome: "missed" | "skipped" | "blocked" | "failed",
    now: string
  ): AttentionRecord {
    return {
      sourceRef: {
        kind: "trigger-occurrence",
        occurrenceId: occurrence.occurrenceId
      },
      deliveryPolicy: "dashboard-only",
      item: projectTerminalTriggerOccurrenceAttention({
        occurrenceId: occurrence.occurrenceId,
        outcome,
        updatedAt: now
      }),
      state: "open",
      revision: 0
    };
  }
}
