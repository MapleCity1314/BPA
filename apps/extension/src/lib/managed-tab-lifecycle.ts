export interface ManagedTabObservation {
  readonly tabId: number;
  readonly commandId: string;
  readonly sourceTabId: number;
  readonly createdAt: string;
}

export interface CreatedTab {
  readonly id?: number | undefined;
  readonly openerTabId?: number | undefined;
}

export const MANAGED_TAB_CAPACITY = 8;

export type ManagedTabAdmission =
  | { readonly status: "unmanaged" }
  | {
      readonly status: "managed";
      readonly observation: ManagedTabObservation;
    }
  | {
      readonly status: "unreserved";
      readonly tabId: number;
      readonly commandId: string;
    };

/**
 * Tracks only tabs that Chrome explicitly attributes to a running BPA command
 * through an opener or a created-navigation source. Tabs without either form
 * of evidence are deliberately ignored so cleanup cannot claim an unrelated
 * RPA or human-created tab.
 */
export class ManagedTabLifecycle {
  private readonly sourceOwners = new Map<
    number,
    { commandId: string; sourceTabId: number }
  >();
  private readonly derivedTabs = new Map<number, ManagedTabObservation>();
  private readonly reservations = new Map<string, number>();

  start(commandId: string, sourceTabId: number): void {
    this.sourceOwners.set(sourceTabId, { commandId, sourceTabId });
  }

  restore(observation: ManagedTabObservation): void {
    if (
      !this.derivedTabs.has(observation.tabId) &&
      this.derivedTabs.size >= MANAGED_TAB_CAPACITY
    ) {
      throw new Error("BROWSER_MANAGED_TAB_RECOVERY_CAPACITY_EXCEEDED");
    }
    this.derivedTabs.set(observation.tabId, observation);
  }

  reserve(commandId: string): boolean {
    const active = [...this.sourceOwners.values()].some(
      (owner) => owner.commandId === commandId
    );
    if (!active || this.#occupiedSlots() >= MANAGED_TAB_CAPACITY) {
      return false;
    }
    this.reservations.set(
      commandId,
      (this.reservations.get(commandId) ?? 0) + 1
    );
    return true;
  }

  releaseReservation(commandId: string): void {
    this.#consumeReservation(commandId);
  }

  observeCreated(
    tab: CreatedTab,
    createdAt = new Date().toISOString()
  ): ManagedTabAdmission {
    if (tab.id == null || tab.openerTabId == null) {
      return { status: "unmanaged" };
    }
    return this.observeAttributed(tab.id, tab.openerTabId, createdAt);
  }

  observeAttributed(
    tabId: number,
    sourceTabId: number,
    createdAt = new Date().toISOString()
  ): ManagedTabAdmission {
    const existing = this.derivedTabs.get(tabId);
    if (existing) {
      return { status: "managed", observation: existing };
    }
    const owner =
      this.sourceOwners.get(sourceTabId) ?? this.derivedTabs.get(sourceTabId);
    if (!owner) return { status: "unmanaged" };
    if ((this.reservations.get(owner.commandId) ?? 0) < 1) {
      return {
        status: "unreserved",
        tabId,
        commandId: owner.commandId
      };
    }
    this.#consumeReservation(owner.commandId);
    const observation = {
      tabId,
      commandId: owner.commandId,
      sourceTabId: owner.sourceTabId,
      createdAt
    } satisfies ManagedTabObservation;
    this.derivedTabs.set(tabId, observation);
    return { status: "managed", observation };
  }

  finish(commandId: string): readonly number[] {
    for (const [sourceTabId, owner] of this.sourceOwners) {
      if (owner.commandId === commandId) this.sourceOwners.delete(sourceTabId);
    }
    this.reservations.delete(commandId);
    return [...this.derivedTabs.values()]
      .filter((tab) => tab.commandId === commandId)
      .map((tab) => tab.tabId);
  }

  forget(tabId: number): void {
    this.derivedTabs.delete(tabId);
  }

  snapshot(): readonly ManagedTabObservation[] {
    return [...this.derivedTabs.values()].sort(
      (left, right) => left.tabId - right.tabId
    );
  }

  usage(): {
    readonly active: number;
    readonly reserved: number;
    readonly capacity: number;
  } {
    return {
      active: this.derivedTabs.size,
      reserved: this.#reservationCount(),
      capacity: MANAGED_TAB_CAPACITY
    };
  }

  #consumeReservation(commandId: string): void {
    const current = this.reservations.get(commandId) ?? 0;
    if (current <= 1) {
      this.reservations.delete(commandId);
    } else {
      this.reservations.set(commandId, current - 1);
    }
  }

  #reservationCount(): number {
    let total = 0;
    for (const count of this.reservations.values()) total += count;
    return total;
  }

  #occupiedSlots(): number {
    return this.derivedTabs.size + this.#reservationCount();
  }
}

export function parseManagedTabObservations(
  value: unknown
): readonly ManagedTabObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    return Number.isSafeInteger(record.tabId) &&
      Number(record.tabId) >= 0 &&
      typeof record.commandId === "string" &&
      record.commandId.length > 0 &&
      Number.isSafeInteger(record.sourceTabId) &&
      Number(record.sourceTabId) >= 0 &&
      typeof record.createdAt === "string" &&
      Number.isFinite(Date.parse(record.createdAt))
      ? [
          {
            tabId: Number(record.tabId),
            commandId: record.commandId,
            sourceTabId: Number(record.sourceTabId),
            createdAt: record.createdAt
          }
        ]
      : [];
  });
}
