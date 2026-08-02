import { randomUUID } from "node:crypto";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import type { InventoryRepository } from "./repository.js";

interface WorkflowRun {
  readonly id: string;
  readonly status: string;
  readonly output?: unknown;
  readonly error?: unknown;
}

const TERMINAL = new Set(["succeeded","rejected","failed","timed_out","cancelled","uncertain"]);
const LEASE_TTL_SECONDS = 120;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function snapshotFacts(run: WorkflowRun): readonly {
  snapshotId: string;
  envelope: Record<string, unknown>;
}[] {
  const output = record(run.output);
  const snapshots = record(output?.snapshots);
  const succeeded = record(snapshots?.succeeded);
  const items = Array.isArray(succeeded?.items) ? succeeded.items : [];
  return items.flatMap((item) => {
    const result = record(record(item)?.output);
    return typeof result?.snapshotId === "string" && record(result.envelope)
      ? [{ snapshotId: result.snapshotId, envelope: record(result.envelope)! }]
      : [];
  });
}

export class InventoryShadowScheduler {
  readonly #client: ControlClient;
  readonly #holderId = `inventory-scheduler:${process.pid}:${randomUUID()}`;
  #stopped = false;

  constructor(
    readonly repository: InventoryRepository,
    readonly shop: { id: string; name: string },
    controlSocketPath = resolveControlSocketPath()
  ) {
    this.#client = new ControlClient(
      new UnixSocketControlTransport(controlSocketPath, {
        runtime: { name: "bpa-inventory-scheduler", version: "1.0.0" },
        features: ["resource_bindings"]
      }),
      { timeoutMs: 30_000 }
    );
  }

  stop(): void {
    this.#stopped = true;
  }

  async run(scheduledFor = new Date()): Promise<{ status: string; scheduleRunId: string }> {
    const leaseKey = `inventory-shadow:${this.shop.id}`;
    const scheduleRunId = `schedule:${this.shop.id}:${scheduledFor.toISOString()}`;
    const fencingToken = await this.repository.acquireLease({
      leaseKey,
      holderId: this.#holderId,
      ttlSeconds: LEASE_TTL_SECONDS
    });
    if (fencingToken === undefined) {
      await this.repository.startScheduleRun({
        scheduleRunId,leaseKey,holderId:this.#holderId,scheduledFor:scheduledFor.toISOString(),
        status:"skipped",diagnostic:"The previous collection still holds the PostgreSQL lease."
      });
      return { status: "skipped", scheduleRunId };
    }
    const started = await this.repository.startScheduleRun({
      scheduleRunId,leaseKey,holderId:this.#holderId,fencingToken,scheduledFor:scheduledFor.toISOString()
    });
    if (!started) {
      await this.repository.releaseLease({ leaseKey,holderId:this.#holderId,fencingToken });
      return { status: "skipped", scheduleRunId };
    }
    const workflowRunIds: string[] = [];
    const diagnostics: string[] = [];
    let leaseLost = false;
    const renew = async (): Promise<void> => {
      const held = await this.repository.renewLease({
        leaseKey,holderId:this.#holderId,fencingToken,ttlSeconds:LEASE_TTL_SECONDS
      });
      if (!held) {
        leaseLost = true;
        throw new Error("SCHEDULER_LEASE_LOST");
      }
    };
    const renewal = setInterval(() => { void renew().catch(() => { leaseLost = true; }); },30_000);
    renewal.unref();
    try {
      const sales = await this.runWorkflow("ecom.sales-demand.refresh", {
        shopId: this.shop.id,shopName: this.shop.name,
        lease:{ leaseKey,holderId:this.#holderId,fencingToken }
      },true,renew);
      workflowRunIds.push(sales.id);
      if (sales.status !== "succeeded") throw new Error(`SALES_DEMAND_WORKFLOW_${sales.status.toUpperCase()}`);
      const inventory = await this.runWorkflow("doudian.inventory.snapshot.refresh", {
        shopId: this.shop.id,shopName: this.shop.name,
        lease:{ leaseKey,holderId:this.#holderId,fencingToken }
      },true,renew);
      workflowRunIds.push(inventory.id);
      await renew();
      if (inventory.status !== "succeeded") throw new Error(`INVENTORY_SNAPSHOT_WORKFLOW_${inventory.status.toUpperCase()}`);
      const facts = snapshotFacts(inventory);
      if (facts.length === 0) throw new Error("INVENTORY_SNAPSHOT_OUTPUT_EMPTY");
      for (const fact of facts) {
        if (this.#stopped || leaseLost) throw new Error("SCHEDULER_LEASE_LOST");
        const risk = await this.runWorkflow("inventory.risk.shadow.evaluate", {
          snapshotId:fact.snapshotId,envelope:fact.envelope,evaluatedAt:new Date().toISOString(),
          lease:{ leaseKey,holderId:this.#holderId,fencingToken }
        },false,renew);
        workflowRunIds.push(risk.id);
        if (risk.status !== "succeeded") diagnostics.push(`Risk workflow ${risk.id} ended ${risk.status}.`);
      }
      const status = diagnostics.length ? "degraded" : "succeeded";
      const completed = await this.repository.completeScheduleRun({
        scheduleRunId,leaseKey,holderId:this.#holderId,fencingToken,status,workflowRunIds,diagnostics
      });
      if (!completed) throw new Error("SCHEDULER_LEASE_LOST");
      return { status,scheduleRunId };
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      await this.repository.completeScheduleRun({
        scheduleRunId,leaseKey,holderId:this.#holderId,fencingToken,status:"failed",workflowRunIds,diagnostics
      }).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(renewal);
      await this.repository.releaseLease({ leaseKey,holderId:this.#holderId,fencingToken }).catch(() => undefined);
    }
  }

  private async runWorkflow(
    workflowId: string,
    input: Record<string, unknown>,
    browser: boolean,
    renew: () => Promise<void>
  ): Promise<WorkflowRun> {
    const resourceBindings = browser
      ? (await this.#client.request<{ resourceBindings: Record<string, unknown> }>(
          "browser.resource-binding.resolve",{ workflowId,workflowVersion:"1.0.0" }
        )).resourceBindings
      : {};
    let run = await this.#client.request<WorkflowRun>("run.create", {
      workflowId,workflowVersion:"1.0.0",input,resourceBindings,actor:"bpa-inventory-scheduler"
    });
    while (!TERMINAL.has(run.status)) {
      if (this.#stopped) throw new Error("SCHEDULER_STOPPED");
      await new Promise((resolve) => setTimeout(resolve,2_000));
      await renew();
      run = await this.#client.request<WorkflowRun>("run.inspect",{ runId:run.id });
    }
    return run;
  }
}
