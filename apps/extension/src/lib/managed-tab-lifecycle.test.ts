import { describe, expect, it } from "vitest";
import {
  ManagedTabLifecycle,
  parseManagedTabObservations
} from "./managed-tab-lifecycle";

describe("managed tab lifecycle", () => {
  it("owns direct and nested child tabs until command release", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);

    expect(
      lifecycle.observeCreated(
        { id: 11, openerTabId: 10 },
        "2026-08-03T00:00:00.000Z"
      )
    ).toMatchObject({ commandId: "command-1", sourceTabId: 10 });
    expect(
      lifecycle.observeCreated(
        { id: 12, openerTabId: 11 },
        "2026-08-03T00:00:01.000Z"
      )
    ).toMatchObject({ commandId: "command-1", sourceTabId: 10 });
    expect(lifecycle.finish("command-1")).toEqual([11, 12]);
    expect(
      lifecycle.observeCreated({ id: 13, openerTabId: 10 })
    ).toBeUndefined();
  });

  it("never claims unrelated or unattributed tabs", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);

    expect(lifecycle.observeCreated({ id: 20, openerTabId: 99 })).toBeUndefined();
    expect(lifecycle.observeCreated({ id: 21 })).toBeUndefined();
    expect(lifecycle.observeCreated({ openerTabId: 10 })).toBeUndefined();
    expect(lifecycle.snapshot()).toEqual([]);
  });

  it("owns a noopener target when Chrome attributes its navigation source", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);

    expect(
      lifecycle.observeAttributed(
        21,
        10,
        "2026-08-03T00:00:00.000Z"
      )
    ).toMatchObject({
      tabId: 21,
      commandId: "command-1",
      sourceTabId: 10
    });
    expect(lifecycle.finish("command-1")).toEqual([21]);
  });

  it("keeps failed-to-close children recorded for startup recovery", () => {
    const lifecycle = new ManagedTabLifecycle();
    lifecycle.start("command-1", 10);
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
    ).toBeUndefined();
    expect(
      lifecycle.observeCreated({ id: 13, openerTabId: 11 })
    ).toMatchObject({ commandId: "interrupted-command" });
  });
});
