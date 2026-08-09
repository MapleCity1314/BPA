import { randomUUID } from "node:crypto";
import type {
  BrowserControlLeaseRecord,
  Persistence,
  RunRecord,
  TriggerRunRecord,
  TriggerSpecDefinition,
  TriggerSpecRecord
} from "@bpa/persistence";

const LEASE_TTL_SECONDS = 300;
const ACTIVE_TRIGGER_STATES = new Set([
  "due","lease_acquired","run_created","running"
]);

export interface TriggerFireInput {
  readonly trigger: TriggerSpecRecord;
  readonly occurrenceKey: string;
  readonly dataset?: { readonly id:string;readonly version:string };
}

export class TriggerRuntime {
  constructor(
    readonly persistence: Persistence,
    readonly createRun: (trigger: TriggerSpecRecord, input: unknown) => RunRecord,
    readonly clock: () => Date = () => new Date()
  ) {}

  fire(input: TriggerFireInput): TriggerRunRecord {
    const now = this.clock().toISOString();
    const triggerRunId = `trigger-run:${randomUUID()}`;
    const claimed = this.persistence.claimTriggerOccurrence({
      triggerRunId,triggerId:input.trigger.spec.id,
      triggerVersion:input.trigger.spec.version,
      occurrenceKey:input.occurrenceKey,status:"due",
      ...(input.dataset ? {
        datasetId:input.dataset.id,datasetVersion:input.dataset.version
      } : {}),
      createdAt:now,updatedAt:now
    });
    if (claimed.status === "duplicate") return claimed.record;
    const lease = this.persistence.acquireTriggerLease({
      concurrencyKey:input.trigger.spec.concurrencyKey,
      ownerId:triggerRunId,now,ttlSeconds:LEASE_TTL_SECONDS
    });
    if (!lease) {
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"skipped",updatedAt:now,
        diagnostic:"Another active Trigger Run owns the concurrency lease."
      });
    }
    this.persistence.updateTriggerRun({
      triggerRunId,status:"lease_acquired",updatedAt:now,fencingToken:lease.fencingToken
    });
    try {
      const workflowInput = {
        ...input.trigger.spec.input,
        trigger:{
          id:input.trigger.spec.id,version:input.trigger.spec.version,
          kind:input.trigger.spec.kind,occurrenceKey:input.occurrenceKey,
          ...(input.dataset ? { dataset:input.dataset } : {})
        }
      };
      const run = this.createRun(input.trigger,workflowInput);
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"run_created",updatedAt:now,workflowRunId:run.id
      });
    } catch (error) {
      this.persistence.releaseTriggerLease({
        concurrencyKey:input.trigger.spec.concurrencyKey,
        ownerId:triggerRunId,fencingToken:lease.fencingToken,releasedAt:now
      });
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"blocked",updatedAt:now,
        diagnostic:error instanceof Error ? error.message : String(error)
      });
    }
  }

  tick(): void {
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    this.reconcileActiveRuns(now);
    for (const trigger of this.persistence.listTriggerSpecs()) {
      if (!trigger.spec.enabled) continue;
      if (trigger.spec.kind === "schedule" && trigger.spec.schedule) {
        const intervalMs = trigger.spec.schedule.intervalSeconds * 1000;
        const occurrence = Math.floor(nowDate.getTime() / intervalMs) * intervalMs;
        this.fire({ trigger,occurrenceKey:`schedule:${new Date(occurrence).toISOString()}` });
      }
      if (trigger.spec.kind === "dataset" && trigger.spec.dataset) {
        const dataset = this.persistence.latestDatasetVersion(trigger.spec.dataset.id);
        if (dataset) {
          this.fire({
            trigger,occurrenceKey:`dataset:${dataset.id}@${dataset.version}`,
            dataset:{ id:dataset.id,version:dataset.version }
          });
        }
      }
    }
  }

  private reconcileActiveRuns(now: string): void {
    for (const triggerRun of this.persistence.listTriggerRuns()) {
      if (!ACTIVE_TRIGGER_STATES.has(triggerRun.status)) continue;
      const trigger = this.persistence.getTriggerSpecVersion(
        triggerRun.triggerId,
        triggerRun.triggerVersion
      );
      if (!trigger) {
        this.persistence.updateTriggerRun({
          triggerRunId:triggerRun.triggerRunId,status:"failed",updatedAt:now,
          diagnostic:"Pinned TriggerSpec version is missing."
        });
        continue;
      }
      const lease = this.findOrRenewLease(trigger,triggerRun,now);
      if (!lease) {
        this.persistence.updateTriggerRun({
          triggerRunId:triggerRun.triggerRunId,status:"failed",updatedAt:now,
          diagnostic:"Trigger concurrency lease was lost."
        });
        continue;
      }
      if (!triggerRun.workflowRunId) continue;
      const run = this.persistence.getRun(triggerRun.workflowRunId);
      if (!run) {
        this.finish(trigger,triggerRun,lease,"failed",now,"Workflow Run is missing.");
        continue;
      }
      if (["created","validated","queued","running","waiting_browser","waiting_assistance","waiting_human","paused","compensating"].includes(run.status)) {
        if (triggerRun.status !== "running") {
          this.persistence.updateTriggerRun({
            triggerRunId:triggerRun.triggerRunId,status:"running",updatedAt:now
          });
        }
        continue;
      }
      const status = (() => {
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
      this.finish(trigger,triggerRun,lease,status,now);
    }
  }

  private findOrRenewLease(
    trigger: TriggerSpecDefinition,
    triggerRun: TriggerRunRecord,
    now: string
  ): BrowserControlLeaseRecord | undefined {
    if (triggerRun.fencingToken !== undefined) {
      return this.persistence.renewTriggerLease({
        concurrencyKey:trigger.concurrencyKey,
        ownerId:triggerRun.triggerRunId,fencingToken:triggerRun.fencingToken,
        now,ttlSeconds:LEASE_TTL_SECONDS
      });
    }
    return this.persistence.acquireTriggerLease({
      concurrencyKey:trigger.concurrencyKey,
      ownerId:triggerRun.triggerRunId,now,ttlSeconds:LEASE_TTL_SECONDS
    });
  }

  private finish(
    trigger: TriggerSpecDefinition,
    triggerRun: TriggerRunRecord,
    lease: BrowserControlLeaseRecord,
    status: "complete" | "rejected" | "failed" | "cancelled" | "uncertain",
    now: string,
    diagnostic?: string
  ): void {
    this.persistence.updateTriggerRun({
      triggerRunId:triggerRun.triggerRunId,status,updatedAt:now,
      ...(diagnostic ? { diagnostic } : {})
    });
    this.persistence.releaseTriggerLease({
      concurrencyKey:trigger.concurrencyKey,
      ownerId:triggerRun.triggerRunId,fencingToken:lease.fencingToken,releasedAt:now
    });
  }
}
