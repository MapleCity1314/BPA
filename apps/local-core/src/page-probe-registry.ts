export type PageProbeReservation = "reserved" | "throttled" | "capacity_exceeded";

interface PageProbeEntry {
  readonly requestId: string;
  readonly requestedAt: number;
}

export interface PageProbeRegistryUsage {
  readonly active: number;
  readonly capacity: number;
  readonly ttlMs: number;
}

/**
 * Bounds the resident Core state used to refresh stale Browser observations.
 * A late result can only clear its own request, never a newer probe for the
 * same page.
 */
export class PageProbeRegistry {
  readonly #entries = new Map<string, PageProbeEntry>();

  constructor(
    readonly capacity = 32,
    readonly ttlMs = 10_000,
    readonly throttleMs = 1_000
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Page probe capacity must be a positive integer");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Page probe TTL must be a positive integer");
    }
    if (
      !Number.isSafeInteger(throttleMs) ||
      throttleMs < 0 ||
      throttleMs > ttlMs
    ) {
      throw new Error("Page probe throttle must be within the TTL");
    }
  }

  reserve(
    key: string,
    requestId: string,
    requestedAt: number
  ): PageProbeReservation {
    this.prune(requestedAt);
    const existing = this.#entries.get(key);
    if (
      existing &&
      requestedAt - existing.requestedAt < this.throttleMs
    ) {
      return "throttled";
    }
    if (!existing && this.#entries.size >= this.capacity) {
      return "capacity_exceeded";
    }
    this.#entries.set(key, { requestId, requestedAt });
    return "reserved";
  }

  complete(requestId: string): boolean {
    for (const [key, entry] of this.#entries) {
      if (entry.requestId !== requestId) continue;
      this.#entries.delete(key);
      return true;
    }
    return false;
  }

  forgetPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.#entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.#entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  prune(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now - entry.requestedAt < this.ttlMs) continue;
      this.#entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  usage(now = Date.now()): PageProbeRegistryUsage {
    this.prune(now);
    return {
      active: this.#entries.size,
      capacity: this.capacity,
      ttlMs: this.ttlMs
    };
  }
}
