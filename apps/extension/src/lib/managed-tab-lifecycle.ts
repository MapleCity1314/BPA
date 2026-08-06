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

  start(commandId: string, sourceTabId: number): void {
    this.sourceOwners.set(sourceTabId, { commandId, sourceTabId });
  }

  restore(observation: ManagedTabObservation): void {
    this.derivedTabs.set(observation.tabId, observation);
  }

  observeCreated(
    tab: CreatedTab,
    createdAt = new Date().toISOString()
  ): ManagedTabObservation | undefined {
    if (tab.id == null || tab.openerTabId == null) return undefined;
    return this.observeAttributed(tab.id, tab.openerTabId, createdAt);
  }

  observeAttributed(
    tabId: number,
    sourceTabId: number,
    createdAt = new Date().toISOString()
  ): ManagedTabObservation | undefined {
    const owner =
      this.sourceOwners.get(sourceTabId) ?? this.derivedTabs.get(sourceTabId);
    if (!owner) return undefined;
    const observation = {
      tabId,
      commandId: owner.commandId,
      sourceTabId: owner.sourceTabId,
      createdAt
    } satisfies ManagedTabObservation;
    this.derivedTabs.set(tabId, observation);
    return observation;
  }

  finish(commandId: string): readonly number[] {
    for (const [sourceTabId, owner] of this.sourceOwners) {
      if (owner.commandId === commandId) this.sourceOwners.delete(sourceTabId);
    }
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
