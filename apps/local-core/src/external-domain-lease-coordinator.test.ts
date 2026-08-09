import type {
  ExternalDomainLeaseRecord,
  Persistence,
  TriggerOccurrenceRecord,
  TriggerSpecDefinition
} from "@bpa/persistence";
import { describe, expect, it } from "vitest";
import { ExternalDomainLeaseCoordinator } from "./external-domain-lease-coordinator.js";
import type {
  ExternalDomainLeaseGrant,
  ExternalDomainLeaseProvider
} from "./inventory-domain-lease-client.js";

const spec: TriggerSpecDefinition = {
  apiVersion: "bpa.trigger/v1alpha2",
  id: "inventory.manual",
  version: "1.0.0",
  appId: "inventory-monitor",
  kind: "manual",
  workflow: { id: "inventory.refresh", version: "1.0.0" },
  enabled: true,
  inputSchemaVersion: "inventory.refresh-input/1",
  input: {},
  concurrencyKey: "inventory",
  externalDomainLease: {
    providerId: "inventory-postgres",
    resourceId: "inventory-production-cycle",
    ttlSeconds: 300
  },
  idempotencyPolicy: "request_key",
  retryPolicy: "none"
};

function lease(requestId: string, occurrenceId: string): ExternalDomainLeaseRecord {
  return {
    requestId,
    providerId: "inventory-postgres",
    domainKey: "inventory-production-cycle",
    occurrenceId,
    ownerId: `trigger-attempt:${requestId}`,
    state: "acquiring",
    revision: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

function occurrence(occurrenceId: string): TriggerOccurrenceRecord {
  return {
    occurrenceId,
    triggerId: spec.id,
    triggerVersion: spec.version,
    occurrenceKey: occurrenceId,
    scheduledAt: "2026-08-05T00:00:00.000Z",
    status: "pending",
    attemptCount: 0,
    revision: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

describe("ExternalDomainLeaseCoordinator", () => {
  it("isolates a per-lease failure and still processes later leases", async () => {
    const first = lease("request:first", "occurrence:first");
    const second = lease("request:second", "occurrence:second");
    const bound: string[] = [];
    const persistence = {
      listExternalDomainLeases: () => [first, second],
      getTriggerOccurrence: (occurrenceId: string) => {
        if (occurrenceId === first.occurrenceId) {
          throw new Error("injected first lease read failure");
        }
        return occurrence(occurrenceId);
      },
      getTriggerSpecVersion: () => spec,
      bindExternalDomainLease: (input: { requestId: string }) => {
        bound.push(input.requestId);
        return { status: "updated", record: second };
      }
    } as unknown as Persistence;
    const grant: ExternalDomainLeaseGrant = {
      domainKey: "inventory-production-cycle",
      ownerId: second.ownerId,
      fencingToken: 3,
      serverNow: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T00:05:00.000Z",
      active: true
    };
    const provider: ExternalDomainLeaseProvider = {
      id: "inventory-postgres",
      acquire: async (input) => ({ ...grant, ownerId: input.ownerId }),
      renew: async () => grant,
      release: async () => ({ ...grant, active: false }),
      read: async () => grant
    };
    const coordinator = new ExternalDomainLeaseCoordinator(
      persistence,
      [provider],
      () => new Date("2026-08-05T00:00:00.000Z")
    );

    await expect(coordinator.tick()).rejects.toBeInstanceOf(AggregateError);
    expect(bound).toEqual([second.requestId]);
    expect(coordinator.canStart(second.requestId)).toBe(true);
  });

  it("starts the local lease window before the remote acquisition round trip", async () => {
    const current = lease("request:delayed", "occurrence:delayed");
    let now = "2026-08-05T00:00:00.000Z";
    let boundUpdatedAt: string | undefined;
    const persistence = {
      listExternalDomainLeases: () => [current],
      getExternalDomainLease: (requestId: string) =>
        requestId === current.requestId ? current : undefined,
      getTriggerOccurrence: () => occurrence(current.occurrenceId),
      getTriggerSpecVersion: () => spec,
      bindExternalDomainLease: (input: { updatedAt: string }) => {
        boundUpdatedAt = input.updatedAt;
        return { status: "updated", record: current };
      }
    } as unknown as Persistence;
    const grant: ExternalDomainLeaseGrant = {
      domainKey: current.domainKey,
      ownerId: current.ownerId,
      fencingToken: 9,
      serverNow: "2026-08-05T08:00:00.000Z",
      expiresAt: "2026-08-05T08:05:00.000Z",
      active: true
    };
    const provider: ExternalDomainLeaseProvider = {
      id: "inventory-postgres",
      acquire: async () => {
        now = "2026-08-05T00:00:10.000Z";
        return grant;
      },
      renew: async () => grant,
      release: async () => ({ ...grant, active: false }),
      read: async () => grant
    };
    const coordinator = new ExternalDomainLeaseCoordinator(
      persistence,
      [provider],
      () => new Date(now)
    );

    await coordinator.tick();

    expect(boundUpdatedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(coordinator.canStart(current.requestId)).toBe(true);
  });

  it("revokes local verification when the Core wall clock regresses", async () => {
    let current: ExternalDomainLeaseRecord = {
      ...lease("request:clock-regression", "occurrence:clock-regression"),
      state: "bound",
      revision: 1,
      fencingToken: 12,
      serverNow: "2026-08-05T08:00:00.000Z",
      expiresAt: "2026-08-05T08:05:00.000Z",
      updatedAt: "2026-08-05T00:01:00.000Z"
    };
    let now = "2026-08-05T00:01:00.000Z";
    const persistence = {
      listExternalDomainLeases: () => [current],
      getExternalDomainLease: (requestId: string) =>
        requestId === current.requestId ? current : undefined,
      getTriggerOccurrence: () => occurrence(current.occurrenceId),
      getTriggerSpecVersion: () => spec,
      getTriggerAttempt: () => undefined,
      renewExternalDomainLease: (input: {
        serverNow: string;
        expiresAt: string;
        updatedAt: string;
      }) => {
        current = {
          ...current,
          serverNow: input.serverNow,
          expiresAt: input.expiresAt,
          updatedAt: input.updatedAt,
          revision: current.revision + 1
        };
        return { status: "updated", record: current };
      },
      markExternalDomainLeaseReconciliationRequired: (input: {
        diagnostic: string;
        updatedAt: string;
      }) => {
        current = {
          ...current,
          state: "reconciliation_required",
          diagnostic: input.diagnostic,
          updatedAt: input.updatedAt,
          revision: current.revision + 1
        };
        return { status: "updated", record: current };
      }
    } as unknown as Persistence;
    const remote: ExternalDomainLeaseGrant = {
      domainKey: current.domainKey,
      ownerId: current.ownerId,
      fencingToken: 12,
      serverNow: "2026-08-05T08:00:00.000Z",
      expiresAt: "2026-08-05T08:05:00.000Z",
      active: true
    };
    const provider: ExternalDomainLeaseProvider = {
      id: "inventory-postgres",
      acquire: async () => remote,
      renew: async () => remote,
      release: async () => ({ ...remote, active: false }),
      read: async () => remote
    };
    const coordinator = new ExternalDomainLeaseCoordinator(
      persistence,
      [provider],
      () => new Date(now)
    );

    await coordinator.tick();
    expect(coordinator.canStart(current.requestId)).toBe(true);

    now = "2026-08-05T00:00:59.000Z";
    await coordinator.tick();

    expect(coordinator.canStart(current.requestId)).toBe(false);
    expect(current).toMatchObject({
      state: "reconciliation_required",
      diagnostic: "Bound external domain lease is missing its server clock window."
    });
  });
});
