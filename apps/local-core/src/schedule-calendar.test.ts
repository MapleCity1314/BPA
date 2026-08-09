import { describe, expect, it } from "vitest";
import {
  occurrenceAtOrBefore,
  occurrencePageBetween,
  occurrencesBetween,
  type TriggerScheduleDefinition
} from "./schedule-calendar.js";

const shanghaiDaily: TriggerScheduleDefinition = {
  type: "daily",
  timezone: "Asia/Shanghai",
  localTime: "09:30",
  onTimeWindowSeconds: 1_800
};

describe("schedule calendar", () => {
  it("anchors daily occurrences to the declared Shanghai wall clock", () => {
    expect(
      occurrenceAtOrBefore(
        shanghaiDaily,
        new Date("2026-08-09T02:00:00.000Z")
      )
    ).toEqual({
      occurrenceKey:"schedule:daily:2026-08-09T09:30[Asia/Shanghai]",
      scheduledAt:"2026-08-09T01:30:00.000Z",
      localCalendarKey:"2026-08-09T09:30[Asia/Shanghai]"
    });
  });

  it("returns the same identity for repeated ticks in one daily occurrence", () => {
    const first = occurrenceAtOrBefore(
      shanghaiDaily,
      new Date("2026-08-09T01:30:01.000Z")
    );
    const repeated = occurrenceAtOrBefore(
      shanghaiDaily,
      new Date("2026-08-09T15:59:59.999Z")
    );
    expect(repeated?.occurrenceKey).toBe(first?.occurrenceKey);
    expect(repeated?.scheduledAt).toBe(first?.scheduledAt);
  });

  it("resolves a nonexistent New York spring time with one stable local key", () => {
    const schedule: TriggerScheduleDefinition = {
      type:"daily",timezone:"America/New_York",localTime:"02:30",
      onTimeWindowSeconds:1_800
    };
    expect(
      occurrenceAtOrBefore(
        schedule,
        new Date("2026-03-08T08:00:00.000Z")
      )
    ).toEqual({
      occurrenceKey:"schedule:daily:2026-03-08T02:30[America/New_York]",
      scheduledAt:"2026-03-08T07:30:00.000Z",
      localCalendarKey:"2026-03-08T02:30[America/New_York]"
    });
  });

  it("emits only one logical occurrence across the New York fall overlap", () => {
    const schedule: TriggerScheduleDefinition = {
      type:"daily",timezone:"America/New_York",localTime:"01:30",
      onTimeWindowSeconds:1_800
    };
    expect(
      occurrencesBetween(
        schedule,
        new Date("2026-11-01T04:00:00.000Z"),
        new Date("2026-11-01T07:00:00.000Z")
      )
    ).toEqual([{
      occurrenceKey:"schedule:daily:2026-11-01T01:30[America/New_York]",
      scheduledAt:"2026-11-01T05:30:00.000Z",
      localCalendarKey:"2026-11-01T01:30[America/New_York]"
    }]);
  });

  it("rejects invalid zones, local times and dates", () => {
    expect(() => occurrenceAtOrBefore({
      ...shanghaiDaily,timezone:"Mars/Olympus_Mons"
    },new Date())).toThrow("Invalid IANA timezone");
    expect(() => occurrenceAtOrBefore({
      ...shanghaiDaily,localTime:"24:00"
    },new Date())).toThrow("Invalid localTime");
    expect(() => occurrenceAtOrBefore(
      shanghaiDaily,new Date("invalid")
    )).toThrow("valid Date");
  });

  it("anchors intervals without process-start drift", () => {
    const schedule: TriggerScheduleDefinition = {
      type:"interval",anchorAt:"2026-08-09T00:07:00Z",
      intervalSeconds:1_800,onTimeWindowSeconds:300
    };
    expect(occurrenceAtOrBefore(
      schedule,new Date("2026-08-09T01:00:00.000Z")
    )).toEqual({
      occurrenceKey:"schedule:interval:2026-08-09T00:37:00.000Z",
      scheduledAt:"2026-08-09T00:37:00.000Z"
    });
    expect(occurrenceAtOrBefore(
      schedule,new Date("2026-08-08T23:59:59.000Z")
    )).toBeUndefined();
    expect(occurrencesBetween(
      schedule,
      new Date("2026-08-09T00:07:00.000Z"),
      new Date("2026-08-09T01:07:00.000Z")
    ).map((item) => item.scheduledAt)).toEqual([
      "2026-08-09T00:37:00.000Z",
      "2026-08-09T01:07:00.000Z"
    ]);
  });

  it("fails closed rather than silently truncating a requested range", () => {
    expect(() => occurrencesBetween(
      shanghaiDaily,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-09T00:00:00.000Z"),
      2
    )).toThrow("exceeds maxOccurrences");
  });

  it("pages a large interval backlog without truncation or overflow", () => {
    const schedule: TriggerScheduleDefinition = {
      type: "interval",
      anchorAt: "2026-08-01T00:00:00Z",
      intervalSeconds: 60,
      onTimeWindowSeconds: 60
    };
    const first = occurrencePageBetween(
      schedule,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-02T00:00:00Z"),
      1_000
    );
    expect(first).toHaveLength(1_000);
    const second = occurrencePageBetween(
      schedule,
      new Date(first.at(-1)!.scheduledAt),
      new Date("2026-08-02T00:00:00Z"),
      1_000
    );
    expect(second).toHaveLength(440);
    expect(second.at(-1)?.scheduledAt).toBe("2026-08-02T00:00:00.000Z");
  });
});
