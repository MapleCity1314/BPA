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

interface BrowserPageObservation {
  readonly sessionId: string;
  readonly browserInstanceId: string;
  readonly tabId: number;
  readonly windowId?: number;
  readonly origin: string;
  readonly contentScriptReady?: boolean;
  readonly observationState?: string;
}

const TERMINAL = new Set(["succeeded","rejected","failed","timed_out","cancelled","uncertain"]);
const LEASE_TTL_SECONDS = 120;

export function workflowDegradationDiagnostic(
  workflowId: string,
  status: string
): string | undefined {
  return status === "succeeded"
    ? undefined
    : `${workflowId} ended ${status}; dependent risk results must remain data-quality unknown.`;
}

export function shouldEvaluatePersistedSnapshots(
  workflowStatus: string,
  persistedSnapshotCount: number
): boolean {
  return persistedSnapshotCount > 0 && workflowStatus !== "uncertain";
}

export function shouldCollectInventorySnapshot(
  persistedSnapshotCount: number
): boolean {
  return persistedSnapshotCount === 0;
}

export function shouldUseRecentOrdersBrowser(
  browserEnabled: boolean,
  browserInstanceId: string | undefined
): boolean {
  return browserEnabled && Boolean(browserInstanceId);
}

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
    readonly shop: { id: string; name: string; browserInstanceId?: string },
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
      const sales = shouldUseRecentOrdersBrowser(
        process.env.BPA_RECENT_BROWSER_ENABLED !== "0",
        this.shop.browserInstanceId
      )
        ? await this.runWorkflow("ecom.sales-demand.refresh", {
            shopId:this.shop.id,shopName:this.shop.name,
            lease:{ leaseKey,holderId:this.#holderId,fencingToken }
          },true,renew,"1.0.3")
        : await this.runNode("ecom.sales-demand.sync","1.0.0",{
          shopId:this.shop.id,shopName:this.shop.name,
          lease:{ leaseKey,holderId:this.#holderId,fencingToken }
        },renew);
      workflowRunIds.push(sales.id);
      const salesDiagnostic = workflowDegradationDiagnostic(
        "sales demand refresh",
        sales.status
      );
      if (salesDiagnostic) diagnostics.push(salesDiagnostic);
      if (!this.shop.browserInstanceId) {
        diagnostics.push(
          "Inventory browser binding is not configured; sales demand refresh completed and inventory collection was skipped."
        );
        const completed = await this.repository.completeScheduleRun({
          scheduleRunId,leaseKey,holderId:this.#holderId,fencingToken,
          status:"degraded",workflowRunIds,diagnostics
        });
        if (!completed) throw new Error("SCHEDULER_LEASE_LOST");
        return { status:"degraded",scheduleRunId };
      }
      let facts: readonly { snapshotId: string; envelope: unknown }[] =
        await this.repository.latestSnapshotFacts(
          this.shop.id,
          new Date(scheduledFor.getTime() - 45 * 60_000).toISOString()
        );
      if (shouldCollectInventorySnapshot(facts.length)) {
        const inventory = await this.runWorkflow("doudian.inventory.snapshot.refresh", {
          shopId: this.shop.id,shopName: this.shop.name,
          lease:{ leaseKey,holderId:this.#holderId,fencingToken }
        },true,renew);
        workflowRunIds.push(inventory.id);
        await renew();
        facts = snapshotFacts(inventory);
        if (facts.length === 0 && inventory.status === "failed") {
          facts = [...await this.repository.latestSnapshotFacts(
            this.shop.id,
            new Date(scheduledFor.getTime() - 45 * 60_000).toISOString()
          )];
          if (facts.length > 0) {
            diagnostics.push(
              `Inventory collection produced no terminal output; recovered ${facts.length} fresh persisted snapshots for evaluation.`
            );
          }
        }
        if (!shouldEvaluatePersistedSnapshots(inventory.status,facts.length)) {
          throw new Error(`INVENTORY_SNAPSHOT_WORKFLOW_${inventory.status.toUpperCase()}`);
        }
        if (inventory.status !== "succeeded") {
          diagnostics.push(
            `Inventory collection ended ${inventory.status} after persisting ${facts.length} product snapshots; evaluating the persisted subset.`
          );
        }
      }
      if (facts.length === 0) throw new Error("INVENTORY_SNAPSHOT_OUTPUT_EMPTY");
      for (const fact of facts) {
        if (this.#stopped || leaseLost) throw new Error("SCHEDULER_LEASE_LOST");
        const riskInput = {
          snapshotId:fact.snapshotId,envelope:fact.envelope,evaluatedAt:new Date().toISOString(),
          lease:{ leaseKey,holderId:this.#holderId,fencingToken }
        };
        let risk = await this.runWorkflow(
          "inventory.risk.shadow.evaluate",riskInput,false,renew,"1.0.1"
        );
        workflowRunIds.push(risk.id);
        if (risk.status !== "succeeded") {
          await new Promise((resolve) => setTimeout(resolve,5_000));
          await renew();
          risk = await this.runWorkflow(
            "inventory.risk.shadow.evaluate",riskInput,false,renew,"1.0.1"
          );
          workflowRunIds.push(risk.id);
        }
        if (risk.status !== "succeeded") diagnostics.push(`Risk workflow ${risk.id} ended ${risk.status}.`);
        await new Promise((resolve) => setTimeout(resolve,750));
        await renew();
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
    renew: () => Promise<void>,
    workflowVersion = "1.0.0"
  ): Promise<WorkflowRun> {
    if (browser) await this.probeBrowserPages();
    const resourceBindings = browser
      ? (await this.#client.request<{ resourceBindings: Record<string, unknown> }>(
          "browser.resource-binding.resolve",{
            workflowId,
            workflowVersion,
            ...(this.shop.browserInstanceId
              ? { browserInstanceId:this.shop.browserInstanceId }
              : {})
          }
        )).resourceBindings
      : {};
    // A resource binding freezes the selected page observation for the run.
    // Probing after dispatch advances that revision and makes an otherwise
    // healthy read-only browser command fail with BROWSER_OBSERVATION_STALE.
    // Refresh once before resolving the binding, then leave it immutable.
    let run = await this.#client.request<WorkflowRun>("run.create", {
      workflowId,workflowVersion,input,resourceBindings,actor:"bpa-inventory-scheduler"
    });
    while (!TERMINAL.has(run.status)) {
      if (this.#stopped) throw new Error("SCHEDULER_STOPPED");
      await new Promise((resolve) => setTimeout(resolve,2_000));
      await renew();
      run = await this.#client.request<WorkflowRun>("run.inspect",{ runId:run.id });
    }
    return run;
  }

  private async probeBrowserPages(): Promise<void> {
    if (!this.shop.browserInstanceId) return;
    const pages = await this.#client.request<readonly BrowserPageObservation[]>(
      "browser.page-observation.list",{
        limit:200,
        browserInstanceId:this.shop.browserInstanceId
      }
    );
    const candidates = pages.filter((page) =>
      page.browserInstanceId === this.shop.browserInstanceId &&
      page.contentScriptReady === true &&
      page.observationState === "ready"
    );
    await Promise.allSettled(candidates.map((page) =>
      this.#client.request("browser.page-observation.probe",{
        sessionId:page.sessionId,
        browserInstanceId:page.browserInstanceId,
        tabId:page.tabId,
        ...(page.windowId === undefined ? {} : { windowId:page.windowId }),
        origin:page.origin,
        timeoutMs:2_000
      })
    ));
  }

  private async runNode(
    nodeId: string,
    nodeVersion: string,
    input: Record<string, unknown>,
    renew: () => Promise<void>
  ): Promise<WorkflowRun> {
    const preview = await this.#client.request<{
      previewDigest: string;
      requiresConfirmation: boolean;
    }>("run.node.preview",{ nodeId,nodeVersion,input });
    let run = await this.#client.request<WorkflowRun>("run.node.create",{
      nodeId,nodeVersion,input,
      expectedPreviewDigest:preview.previewDigest,
      confirmed:preview.requiresConfirmation,
      resourceBindings:{},
      actor:"bpa-inventory-scheduler"
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
