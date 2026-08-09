import { describe, expect, it } from "vitest";
import {
  EXTENSION_RUNTIME_LIMITS,
  ExtensionRuntimeResourceRegistry
} from "./extension-runtime-resources";

describe("ExtensionRuntimeResourceRegistry", () => {
  it("expires pacing reservations and rejects new keys at capacity", () => {
    const registry = new ExtensionRuntimeResourceRegistry();
    for (
      let index = 0;
      index < EXTENSION_RUNTIME_LIMITS.pacingReservations;
      index += 1
    ) {
      expect(registry.reservePacing(`key-${index}`, 1_000, 0)).toBe(true);
    }
    expect(registry.reservePacing("overflow", 1_000, 0)).toBe(false);
    expect(registry.pacingReservation("key-0", 1_000)).toBe(1_000);

    const expiredAt =
      1_000 + EXTENSION_RUNTIME_LIMITS.pacingReservationTtlMs;
    expect(registry.pacingReservation("key-0", expiredAt)).toBe(0);
    expect(registry.reservePacing("replacement", expiredAt, expiredAt)).toBe(
      true
    );
    expect(registry.usage(expiredAt).pacingReservations.active).toBe(1);
  });

  it("bounds active probes and fences expired and superseded generations", () => {
    const registry = new ExtensionRuntimeResourceRegistry();
    const first = registry.beginProbe(1, 0)!;
    const replacement = registry.beginProbe(1, 1)!;
    expect(registry.isCurrentProbe(1, first, 1)).toBe(false);
    expect(registry.isCurrentProbe(1, replacement, 1)).toBe(true);

    for (let tabId = 2; tabId <= EXTENSION_RUNTIME_LIMITS.probes; tabId += 1) {
      expect(registry.beginProbe(tabId, 1)).toBeDefined();
    }
    expect(registry.beginProbe(10_000, 1)).toBeUndefined();

    expect(
      registry.isCurrentProbe(
        1,
        replacement,
        1 + EXTENSION_RUNTIME_LIMITS.probeTtlMs
      )
    ).toBe(false);
    expect(
      registry.beginProbe(
        10_000,
        1 + EXTENSION_RUNTIME_LIMITS.probeTtlMs
      )
    ).toBeDefined();
  });

  it("does not let a stale completion clear a newer probe", () => {
    const registry = new ExtensionRuntimeResourceRegistry();
    const first = registry.beginProbe(9, 0)!;
    const second = registry.beginProbe(9, 1)!;
    registry.completeProbe(9, first);
    expect(registry.isCurrentProbe(9, second, 1)).toBe(true);
    registry.completeProbe(9, second);
    expect(registry.usage(1).probes.active).toBe(0);
  });
});
