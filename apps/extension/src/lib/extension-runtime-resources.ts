export const EXTENSION_RUNTIME_LIMITS = {
  activeCommands: 32,
  observations: 64,
  pacingReservations: 64,
  pacingReservationTtlMs: 120_000,
  probes: 32,
  probeTtlMs: 30_000
} as const;

export interface ExtensionRuntimeRegistryUsage {
  readonly pacingReservations: {
    readonly active: number;
    readonly capacity: number;
    readonly ttlMs: number;
  };
  readonly probes: {
    readonly active: number;
    readonly capacity: number;
    readonly ttlMs: number;
  };
}

interface PacingReservation {
  readonly executeAt: number;
  readonly expiresAt: number;
}

interface ProbeGeneration {
  readonly generation: number;
  readonly expiresAt: number;
}

export class ExtensionRuntimeResourceRegistry {
  readonly #pacingReservations = new Map<string, PacingReservation>();
  readonly #probes = new Map<number, ProbeGeneration>();
  #nextProbeGeneration = 0;

  pacingReservation(key: string, now = Date.now()): number {
    this.#prunePacing(now);
    return this.#pacingReservations.get(key)?.executeAt ?? 0;
  }

  reservePacing(key: string, executeAt: number, now = Date.now()): boolean {
    this.#prunePacing(now);
    if (
      !this.#pacingReservations.has(key) &&
      this.#pacingReservations.size >=
        EXTENSION_RUNTIME_LIMITS.pacingReservations
    ) {
      return false;
    }
    this.#pacingReservations.set(key, {
      executeAt,
      expiresAt:
        Math.max(now, executeAt) +
        EXTENSION_RUNTIME_LIMITS.pacingReservationTtlMs
    });
    return true;
  }

  beginProbe(tabId: number, now = Date.now()): number | undefined {
    this.#pruneProbes(now);
    if (
      !this.#probes.has(tabId) &&
      this.#probes.size >= EXTENSION_RUNTIME_LIMITS.probes
    ) {
      return undefined;
    }
    this.#nextProbeGeneration += 1;
    const generation = this.#nextProbeGeneration;
    this.#probes.set(tabId, {
      generation,
      expiresAt: now + EXTENSION_RUNTIME_LIMITS.probeTtlMs
    });
    return generation;
  }

  isCurrentProbe(
    tabId: number,
    generation: number,
    now = Date.now()
  ): boolean {
    const probe = this.#probes.get(tabId);
    if (!probe) return false;
    if (probe.expiresAt <= now) {
      this.#probes.delete(tabId);
      return false;
    }
    return probe.generation === generation;
  }

  completeProbe(tabId: number, generation: number): void {
    if (this.#probes.get(tabId)?.generation === generation) {
      this.#probes.delete(tabId);
    }
  }

  forgetProbe(tabId: number): void {
    this.#probes.delete(tabId);
  }

  usage(now = Date.now()): ExtensionRuntimeRegistryUsage {
    this.#prunePacing(now);
    this.#pruneProbes(now);
    return {
      pacingReservations: {
        active: this.#pacingReservations.size,
        capacity: EXTENSION_RUNTIME_LIMITS.pacingReservations,
        ttlMs: EXTENSION_RUNTIME_LIMITS.pacingReservationTtlMs
      },
      probes: {
        active: this.#probes.size,
        capacity: EXTENSION_RUNTIME_LIMITS.probes,
        ttlMs: EXTENSION_RUNTIME_LIMITS.probeTtlMs
      }
    };
  }

  #prunePacing(now: number): void {
    for (const [key, reservation] of this.#pacingReservations) {
      if (reservation.expiresAt <= now) this.#pacingReservations.delete(key);
    }
  }

  #pruneProbes(now: number): void {
    for (const [tabId, probe] of this.#probes) {
      if (probe.expiresAt <= now) this.#probes.delete(tabId);
    }
  }
}
