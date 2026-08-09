import { describe, expect, it } from "vitest";
import { PageProbeRegistry } from "./page-probe-registry.js";

describe("PageProbeRegistry", () => {
  it("throttles a page, fences late results, and clears the current result", () => {
    const registry = new PageProbeRegistry(2, 10_000, 1_000);
    expect(registry.reserve("session:1", "request-1", 0)).toBe("reserved");
    expect(registry.reserve("session:1", "request-2", 999)).toBe(
      "throttled"
    );
    expect(registry.reserve("session:1", "request-2", 1_000)).toBe(
      "reserved"
    );
    expect(registry.complete("request-1")).toBe(false);
    expect(registry.usage(1_000).active).toBe(1);
    expect(registry.complete("request-2")).toBe(true);
    expect(registry.usage(1_000).active).toBe(0);
  });

  it("fails closed at capacity and admits a new page after TTL pruning", () => {
    const registry = new PageProbeRegistry(2, 10_000, 1_000);
    expect(registry.reserve("session:1", "request-1", 0)).toBe("reserved");
    expect(registry.reserve("session:2", "request-2", 0)).toBe("reserved");
    expect(registry.reserve("session:3", "request-3", 0)).toBe(
      "capacity_exceeded"
    );
    expect(registry.reserve("session:3", "request-3", 10_000)).toBe(
      "reserved"
    );
    expect(registry.usage(10_000)).toEqual({
      active: 1,
      capacity: 2,
      ttlMs: 10_000
    });
  });

  it("forgets only probes owned by a detached Browser Session", () => {
    const registry = new PageProbeRegistry();
    registry.reserve("session-a:1", "request-1", 0);
    registry.reserve("session-a:2", "request-2", 0);
    registry.reserve("session-b:1", "request-3", 0);

    expect(registry.forgetPrefix("session-a:")).toBe(2);
    expect(registry.usage(0).active).toBe(1);
  });
});
