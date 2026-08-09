import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type { Persistence } from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const PROVIDER_ID = "inventory-data";
const NODE_ID = "inventory.snapshot.persist";
const NODE_VERSION = "2.0.0";
const PERMISSION = "inventory.service.snapshot.write";
const LEASE_PROVIDER_ID = "inventory-postgres";
const LEASE_DOMAIN_KEY = "inventory-production-cycle";

export function isInventoryDataNode(id: string, version: string): boolean {
  return id === NODE_ID && version === NODE_VERSION;
}

export interface LeaseFence {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly fencingToken: number;
}

export interface InventoryServiceWriter {
  persistSnapshot(
    input: {
      readonly snapshot: JsonValue;
      readonly lease: LeaseFence;
    },
    signal: AbortSignal
  ): Promise<JsonValue>;
}

export class InventoryServiceWriterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transportUncertain = false
  ) {
    super(message);
  }
}

function rejected(code: string, message: string): RuntimeOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function failed(code: string, message: string): RuntimeOutcome {
  return {
    status: "failed",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function uncertain(code: string, message: string): RuntimeOutcome {
  return {
    status: "uncertain",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function cancelled(): RuntimeOutcome {
  return {
    status: "cancelled",
    error: {
      code: "CANCELLED",
      message: "Inventory snapshot persistence was cancelled before dispatch.",
      retryable: false
    },
    evidence: [],
    riskSignals: []
  };
}

function inputObject(
  value: JsonValue,
  label: string
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, JsonValue>;
}

function exactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} must contain only ${required.join(", ")}.`);
  }
}

function estimatedRemainingMilliseconds(
  lease: {
    readonly serverNow?: string;
    readonly expiresAt?: string;
    readonly updatedAt: string;
  },
  localNow: string
): number | undefined {
  if (!lease.serverNow || !lease.expiresAt) return undefined;
  const grantedDuration =
    Date.parse(lease.expiresAt) - Date.parse(lease.serverNow);
  const localElapsed = Date.parse(localNow) - Date.parse(lease.updatedAt);
  if (!Number.isFinite(grantedDuration) || !Number.isFinite(localElapsed)) {
    return undefined;
  }
  if (localElapsed < 0) return undefined;
  return grantedDuration - localElapsed;
}

function controlledWriterMessage(code: string, uncertainWrite: boolean): string {
  if (uncertainWrite) {
    return code === "SCHEDULER_LEASE_LOST"
      ? "The inventory domain lease was lost during snapshot persistence; reconciliation is required."
      : "The inventory service write outcome is unknown; reconciliation is required.";
  }
  switch (code) {
    case "INVENTORY_SERVICE_NOT_CONFIGURED":
      return "The trusted inventory service is not configured.";
    case "INVENTORY_SERVICE_UNAVAILABLE":
      return "The trusted inventory service is unavailable.";
    case "INVENTORY_SERVICE_PROTOCOL_ERROR":
      return "The trusted inventory service returned an invalid response.";
    case "LEASE_FENCE_INVALID":
      return "The inventory service rejected the lease fence.";
    default:
      return "The trusted inventory service rejected snapshot persistence.";
  }
}

function supportedWriterCode(code: string): string {
  return new Set([
    "INVENTORY_SERVICE_NOT_CONFIGURED",
    "INVENTORY_SERVICE_UNAVAILABLE",
    "INVENTORY_SERVICE_PROTOCOL_ERROR",
    "INVENTORY_SERVICE_FAILED",
    "LEASE_FENCE_INVALID",
    "SCHEDULER_LEASE_LOST"
  ]).has(code)
    ? code
    : "INVENTORY_SERVICE_FAILED";
}

export class InventoryDataRuntimeProvider implements RuntimeProvider {
  readonly id = PROVIDER_ID;

  constructor(
    readonly persistence: Persistence,
    readonly writer: InventoryServiceWriter,
    readonly now: () => Date = () => new Date()
  ) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return isInventoryDataNode(node.id, node.version);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) return cancelled();
    if (!this.supports(invocation.node)) {
      return rejected(
        "INVENTORY_DATA_NODE_UNSUPPORTED",
        "Inventory data Node id and version are not exact."
      );
    }
    if (
      invocation.permissionSnapshot.riskLevel !== "R1" ||
      invocation.permissionSnapshot.permissions.length !== 1 ||
      invocation.permissionSnapshot.permissions[0] !== PERMISSION ||
      invocation.permissionSnapshot.domains.length !== 0
    ) {
      return rejected(
        "INVENTORY_DATA_PERMISSION_INVALID",
        "Inventory data permission snapshot is not exact."
      );
    }

    let snapshot: JsonValue;
    try {
      const input = inputObject(invocation.input, "Inventory snapshot input");
      exactKeys(input, ["snapshot"], "Inventory snapshot input");
      const candidate = input.snapshot;
      if (candidate === undefined) throw new Error("snapshot is required");
      inputObject(candidate, "Inventory snapshot");
      snapshot = candidate;
    } catch {
      return rejected(
        "INVENTORY_SNAPSHOT_INPUT_INVALID",
        "Inventory snapshot input must contain only an object snapshot."
      );
    }

    const leases = this.persistence
      .listExternalDomainLeases()
      .filter((lease) => lease.runId === invocation.identity.runId);
    if (leases.length !== 1) {
      return rejected(
        "INVENTORY_EXTERNAL_LEASE_INVALID",
        "The Run must own exactly one external inventory domain lease."
      );
    }
    const lease = leases[0]!;
    const run = this.persistence.getRun(invocation.identity.runId);
    const attempt = lease.triggerAttemptId
      ? this.persistence.getTriggerAttempt(lease.triggerAttemptId)
      : undefined;
    const occurrence = attempt
      ? this.persistence.getTriggerOccurrence(attempt.occurrenceId)
      : undefined;
    const pinned = occurrence
      ? this.persistence.getTriggerSpecVersion(
          occurrence.triggerId,
          occurrence.triggerVersion
        )
      : undefined;
    const remaining = estimatedRemainingMilliseconds(
      lease,
      this.now().toISOString()
    );
    if (
      !run ||
      run.status !== "running" ||
      !attempt ||
      attempt.status !== "running" ||
      attempt.workflowRunId !== run.id ||
      attempt.occurrenceId !== lease.occurrenceId ||
      !occurrence ||
      occurrence.status !== "running" ||
      !pinned ||
      pinned.workflow.id !== run.workflowId ||
      pinned.workflow.version !== run.workflowVersion ||
      pinned.externalDomainLease?.providerId !== LEASE_PROVIDER_ID ||
      pinned.externalDomainLease.resourceId !== LEASE_DOMAIN_KEY ||
      lease.providerId !== LEASE_PROVIDER_ID ||
      lease.domainKey !== LEASE_DOMAIN_KEY ||
      lease.ownerId !== attempt.attemptId ||
      lease.state !== "bound" ||
      !Number.isSafeInteger(lease.fencingToken) ||
      Number(lease.fencingToken) < 1 ||
      remaining === undefined ||
      remaining <= 0
    ) {
      return rejected(
        "INVENTORY_EXTERNAL_LEASE_INVALID",
        "The Run external inventory domain lease is not active and exact."
      );
    }

    try {
      const output = await this.writer.persistSnapshot(
        {
          snapshot,
          lease: {
            leaseKey: lease.domainKey,
            holderId: lease.ownerId,
            fencingToken: lease.fencingToken!
          }
        },
        signal
      );
      return {
        status: "succeeded",
        output,
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      const writerError =
        error instanceof InventoryServiceWriterError ? error : undefined;
      const code = supportedWriterCode(
        writerError?.code ?? "INVENTORY_SERVICE_FAILED"
      );
      const requiresReconciliation =
        writerError?.transportUncertain === true ||
        code === "SCHEDULER_LEASE_LOST";
      if (requiresReconciliation) {
        try {
          this.persistence.markExternalDomainLeaseReconciliationRequired({
            requestId: lease.requestId,
            expectedRevision: lease.revision,
            diagnostic: `Inventory snapshot persistence requires reconciliation: ${code}.`,
            updatedAt: this.now().toISOString()
          });
        } catch {
          // The write outcome is already uncertain. A concurrent state change
          // cannot make it safe to retry or downgrade the outcome.
        }
        return uncertain(code, controlledWriterMessage(code, true));
      }
      return failed(code, controlledWriterMessage(code, false));
    }
  }
}
