import { describe, expect, it } from "vitest";
import {
  MANAGED_TAB_CAPACITY,
  ManagedTabLifecycle,
  parseManagedTabObservations
} from "./managed-tab-lifecycle";

describe("managed tab lifecycle", () => {
  it("owns direct and nested child tabs until command release", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);
    expect(lifecycle.reserve("command-1")).toBe(true);

    expect(
      lifecycle.observeCreated(
        { id: 11, openerTabId: 10 },
        "2026-08-03T00:00:00.000Z"
      )
    ).toMatchObject({
      status: "managed",
      observation: { commandId: "command-1", sourceTabId: 10 }
    });
    expect(lifecycle.reserve("command-1")).toBe(true);
    expect(
      lifecycle.observeCreated(
        { id: 12, openerTabId: 11 },
        "2026-08-03T00:00:01.000Z"
      )
    ).toMatchObject({
      status: "managed",
      observation: { commandId: "command-1", sourceTabId: 10 }
    });
    expect(lifecycle.finish("command-1")).toEqual([11, 12]);
    expect(
      lifecycle.observeCreated({ id: 13, openerTabId: 10 })
    ).toEqual({ status: "unmanaged" });
  });

  it("never claims unrelated or unattributed tabs", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);

    expect(lifecycle.observeCreated({ id: 20, openerTabId: 99 })).toEqual({
      status: "unmanaged"
    });
    expect(lifecycle.observeCreated({ id: 21 })).toEqual({
      status: "unmanaged"
    });
    expect(lifecycle.observeCreated({ openerTabId: 10 })).toEqual({
      status: "unmanaged"
    });
    expect(lifecycle.snapshot()).toEqual([]);
  });

  it("owns a noopener target when Chrome attributes its navigation source", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);
    expect(lifecycle.reserve("command-1")).toBe(true);

    expect(
      lifecycle.observeAttributed(
        21,
        10,
        "2026-08-03T00:00:00.000Z"
      )
    ).toMatchObject({
      status: "managed",
      observation: {
        tabId: 21,
        commandId: "command-1",
        sourceTabId: 10
      }
    });
    expect(lifecycle.finish("command-1")).toEqual([21]);
  });

  it("keeps failed-to-close children recorded for startup recovery", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);
    expect(lifecycle.reserve("command-1")).toBe(true);
    lifecycle.observeCreated(
      { id: 11, openerTabId: 10 },
      "2026-08-03T00:00:00.000Z"
    );

    expect(lifecycle.finish("command-1")).toEqual([11]);
    expect(lifecycle.snapshot()).toHaveLength(1);
    lifecycle.forget(11);
    expect(lifecycle.snapshot()).toEqual([]);
  });

  it("accepts only complete persisted ownership records", () => {
    expect(
      parseManagedTabObservations([
        {
          tabId: 11,
          commandId: "command-1",
          sourceTabId: 10,
          createdAt: "2026-08-03T00:00:00.000Z"
        },
        { tabId: 12, commandId: "command-2" },
        { tabId: "13", commandId: "command-3", sourceTabId: 10 }
      ])
    ).toEqual([
      {
        tabId: 11,
        commandId: "command-1",
        sourceTabId: 10,
        createdAt: "2026-08-03T00:00:00.000Z"
      }
    ]);
  });

  it("restores a persisted orphan without claiming its source tab", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.restore({
      tabId: 11,
      commandId: "interrupted-command",
      sourceTabId: 10,
      createdAt: "2026-08-03T00:00:00.000Z"
    });

    expect(lifecycle.snapshot()).toHaveLength(1);
    expect(
      lifecycle.observeCreated({ id: 12, openerTabId: 10 })
    ).toEqual({ status: "unmanaged" });
    lifecycle.start("interrupted-command", 11);
    expect(lifecycle.reserve("interrupted-command")).toBe(true);
    expect(
      lifecycle.observeCreated({ id: 13, openerTabId: 11 })
    ).toMatchObject({
      status: "managed",
      observation: { commandId: "interrupted-command" }
    });
  });

  it("requires a reservation before accepting an attributed tab", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);

    expect(lifecycle.observeCreated({ id: 11, openerTabId: 10 })).toEqual({
      status: "unreserved",
      tabId: 11,
      commandId: "command-1"
    });
    expect(lifecycle.snapshot()).toEqual([]);
  });

  it("rejects a reservation before an effect can exceed the retained cap", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);
    for (let index = 0; index < MANAGED_TAB_CAPACITY; index += 1) {
      expect(lifecycle.reserve("command-1")).toBe(true);
    }
    expect(lifecycle.usage()).toEqual({
      active: 0,
      reserved: MANAGED_TAB_CAPACITY,
      capacity: MANAGED_TAB_CAPACITY
    });
    expect(lifecycle.reserve("command-1")).toBe(false);

    lifecycle.releaseReservation("command-1");
    expect(lifecycle.reserve("command-1")).toBe(true);
  });

  it("fails closed when persisted orphan ownership exceeds the cap", () => {
    const lifecycle = new ManagedTabLifecycle();
    for (let index = 0; index < MANAGED_TAB_CAPACITY; index += 1) {
      lifecycle.restore({
        tabId: index + 1,
        commandId: `command-${index}`,
        sourceTabId: 100 + index,
        createdAt: "2026-08-03T00:00:00.000Z"
      });
    }
    expect(() =>
      lifecycle.restore({
        tabId: 99,
        commandId: "overflow",
        sourceTabId: 199,
        createdAt: "2026-08-03T00:00:00.000Z"
      })
    ).toThrow("BROWSER_MANAGED_TAB_RECOVERY_CAPACITY_EXCEEDED");
  });
});
