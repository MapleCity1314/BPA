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

interface TriggerControlLeases {
  readonly trigger: BrowserControlLeaseRecord;
  readonly browser?: BrowserControlLeaseRecord;
}

export interface TriggerFireInput {
  readonly trigger: TriggerSpecRecord;
  readonly occurrenceKey: string;
  readonly dataset?: { readonly id:string;readonly version:string };
}

export class TriggerRuntime {
  constructor(
    readonly persistence: Persistence,
    readonly createRun: (
      trigger: TriggerSpecRecord,
      input: unknown,
      triggerRunId: string
    ) => RunRecord,
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
    const triggerLease = this.persistence.acquireTriggerLease({
      concurrencyKey:input.trigger.spec.concurrencyKey,
      ownerId:triggerRunId,now,ttlSeconds:LEASE_TTL_SECONDS
    });
    if (!triggerLease) {
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"skipped",updatedAt:now,
        diagnostic:"Another active Trigger Run owns the concurrency lease."
      });
    }
    const browserInstanceId = input.trigger.spec.browserInstanceId;
    const browserLease = browserInstanceId
      ? this.persistence.acquireBrowserControlLease({
          resourceId:this.browserResourceId(browserInstanceId),
          ownerId:triggerRunId,now,ttlSeconds:LEASE_TTL_SECONDS
        })
      : undefined;
    if (browserInstanceId && !browserLease) {
      this.persistence.releaseTriggerLease({
        concurrencyKey:input.trigger.spec.concurrencyKey,
        ownerId:triggerRunId,fencingToken:triggerLease.fencingToken,releasedAt:now
      });
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"skipped",updatedAt:now,
        diagnostic:"Another active controller owns the browser instance lease."
      });
    }
    let run: RunRecord;
    try {
      this.persistence.updateTriggerRun({
        triggerRunId,status:"lease_acquired",updatedAt:now,
        fencingToken:triggerLease.fencingToken,
        ...(browserLease
          ? { browserFencingToken:browserLease.fencingToken }
          : {})
      });
      const workflowInput = input.trigger.spec.input;
      run = this.createRun(input.trigger,workflowInput,triggerRunId);
    } catch (error) {
      if (browserLease && browserInstanceId) {
        this.persistence.releaseBrowserControlLease({
          resourceId:this.browserResourceId(browserInstanceId),
          ownerId:triggerRunId,fencingToken:browserLease.fencingToken,releasedAt:now
        });
      }
      this.persistence.releaseTriggerLease({
        concurrencyKey:input.trigger.spec.concurrencyKey,
        ownerId:triggerRunId,fencingToken:triggerLease.fencingToken,releasedAt:now
      });
      return this.persistence.updateTriggerRun({
        triggerRunId,status:"blocked",updatedAt:now,
        diagnostic:error instanceof Error ? error.message : String(error)
      });
    }
    const linked = this.persistence.getTriggerRun(triggerRunId);
    if (
      !linked ||
      linked.status !== "run_created" ||
      linked.workflowRunId !== run.id
    ) {
      throw new Error(
        `Workflow Run was not atomically linked to Trigger Run: ${triggerRunId}`
      );
    }
    return linked;
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
      const control = this.findOrRenewLeases(trigger,triggerRun,now);
      if ("diagnostic" in control) {
        this.persistence.updateTriggerRun({
          triggerRunId:triggerRun.triggerRunId,status:"failed",updatedAt:now,
          diagnostic:control.diagnostic
        });
        continue;
      }
      if (!triggerRun.workflowRunId) {
        this.finish(
          trigger,triggerRun,control.leases,"failed",now,
          "Workflow Run was not created before reconciliation."
        );
        continue;
      }
      const run = this.persistence.getRun(triggerRun.workflowRunId);
      if (!run) {
        this.finish(
          trigger,triggerRun,control.leases,"failed",now,"Workflow Run is missing."
        );
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
      this.finish(trigger,triggerRun,control.leases,status,now);
    }
  }

  private findOrRenewLeases(
    trigger: TriggerSpecDefinition,
    triggerRun: TriggerRunRecord,
    now: string
  ): { readonly leases: TriggerControlLeases } | { readonly diagnostic: string } {
    const triggerLease = triggerRun.fencingToken === undefined
      ? undefined
      : this.persistence.renewTriggerLease({
        concurrencyKey:trigger.concurrencyKey,
        ownerId:triggerRun.triggerRunId,fencingToken:triggerRun.fencingToken,
        now,ttlSeconds:LEASE_TTL_SECONDS
      });
    if (!triggerLease) {
      this.releaseBrowserLease(trigger,triggerRun,now);
      return { diagnostic:"Trigger concurrency lease was lost." };
    }
    if (!trigger.browserInstanceId) {
      return { leases:{ trigger:triggerLease } };
    }
    if (triggerRun.browserFencingToken === undefined) {
      this.persistence.releaseTriggerLease({
        concurrencyKey:trigger.concurrencyKey,
        ownerId:triggerRun.triggerRunId,
        fencingToken:triggerLease.fencingToken,
        releasedAt:now
      });
      return { diagnostic:"Browser instance lease token is missing." };
    }
    const browserLease = this.persistence.renewBrowserControlLease({
      resourceId:this.browserResourceId(trigger.browserInstanceId),
      ownerId:triggerRun.triggerRunId,
      fencingToken:triggerRun.browserFencingToken,
      now,ttlSeconds:LEASE_TTL_SECONDS
    });
    if (!browserLease) {
      this.persistence.releaseTriggerLease({
        concurrencyKey:trigger.concurrencyKey,
        ownerId:triggerRun.triggerRunId,
        fencingToken:triggerLease.fencingToken,
        releasedAt:now
      });
      return { diagnostic:"Browser instance lease was lost." };
    }
    return { leases:{ trigger:triggerLease,browser:browserLease } };
  }

  private finish(
    trigger: TriggerSpecDefinition,
    triggerRun: TriggerRunRecord,
    leases: TriggerControlLeases,
    status: "complete" | "rejected" | "failed" | "cancelled" | "uncertain",
    now: string,
    diagnostic?: string
  ): void {
    this.persistence.updateTriggerRun({
      triggerRunId:triggerRun.triggerRunId,status,updatedAt:now,
      ...(diagnostic ? { diagnostic } : {})
    });
    if (leases.browser && trigger.browserInstanceId) {
      this.persistence.releaseBrowserControlLease({
        resourceId:this.browserResourceId(trigger.browserInstanceId),
        ownerId:triggerRun.triggerRunId,
        fencingToken:leases.browser.fencingToken,
        releasedAt:now
      });
    }
    this.persistence.releaseTriggerLease({
      concurrencyKey:trigger.concurrencyKey,
      ownerId:triggerRun.triggerRunId,
      fencingToken:leases.trigger.fencingToken,
      releasedAt:now
    });
  }

  private releaseBrowserLease(
    trigger: TriggerSpecDefinition,
    triggerRun: TriggerRunRecord,
    releasedAt: string
  ): void {
    if (!trigger.browserInstanceId || triggerRun.browserFencingToken === undefined) return;
    this.persistence.releaseBrowserControlLease({
      resourceId:this.browserResourceId(trigger.browserInstanceId),
      ownerId:triggerRun.triggerRunId,
      fencingToken:triggerRun.browserFencingToken,
      releasedAt
    });
  }

  private browserResourceId(browserInstanceId: string): string {
    return `browser-instance:${browserInstanceId}`;
  }
}
