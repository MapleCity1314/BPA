import { describe,expect,it } from "vitest";
import {
  buildOperationalReminders,
  buildStoreDemandBacktest
} from "./dashboard-analytics.js";

describe("dashboard analytics", () => {
  it("builds a deterministic rolling backtest without future leakage", () => {
    const points = Array.from({ length: 70 },(_,index) => ({
      date: new Date(Date.UTC(2026,4,index + 1)).toISOString().slice(0,10),
      actual: 100 + (index % 7) * 10
    }));
    const result = buildStoreDemandBacktest(points);
    expect(result.status).toBe("ready");
    expect(result.points).toHaveLength(35);
    expect(result.metrics.p90Coverage).not.toBeNull();
    expect(result.points.at(-1)?.actual).toBe(160);
  });

  it("keeps the backtest unavailable when history is too short", () => {
    const result = buildStoreDemandBacktest([
      { date:"2026-08-01",actual:12 },
      { date:"2026-08-02",actual:9 }
    ]);
    expect(result.status).toBe("insufficient_data");
    expect(result.points).toEqual([]);
  });

  it("raises operational reminders for missing collection and stale orders", () => {
    const backtest = buildStoreDemandBacktest([]);
    const result = buildOperationalReminders({
      now:"2026-08-02T12:00:00.000Z",
      latestInventoryAt:null,
      latestOrderAt:"2026-08-02T09:00:00.000Z",
      productCount:0,
      freshProductCount:0,
      scheduleCount:0,
      incidents:[],
      backtest
    });
    expect(result.map((reminder) => reminder.id)).toEqual([
      "inventory-collection-missing",
      "recent-orders-stale",
      "scheduler-not-running"
    ]);
  });

  it("does not report a healthy store from one fresh product", () => {
    const result = buildOperationalReminders({
      now:"2026-08-04T06:30:00.000Z",
      latestInventoryAt:"2026-08-04T06:29:00.000Z",
      latestOrderAt:"2026-08-04T06:10:00.000Z",
      productCount:74,
      freshProductCount:26,
      scheduleCount:1,
      incidents:[],
      backtest:buildStoreDemandBacktest([])
    });
    expect(result).toContainEqual(expect.objectContaining({
      id:"inventory-collection-partial",
      severity:"critical"
    }));
  });

  it("shows an in-progress collection as a warning instead of a severe outage",() => {
    const result = buildOperationalReminders({
      now:"2026-08-04T07:00:00.000Z",
      latestInventoryAt:"2026-08-04T04:59:00.000Z",
      latestOrderAt:"2026-08-04T06:45:00.000Z",
      productCount:74,freshProductCount:74,scheduleCount:1,collectionRunning:true,
      incidents:[],backtest:buildStoreDemandBacktest([])
    });
    expect(result).toContainEqual(expect.objectContaining({
      id:"inventory-collection-stale",severity:"warning",title:"库存正在更新"
    }));
  });

  it("treats inventory and recent orders as valid for two hours",() => {
    const result = buildOperationalReminders({
      now:"2026-08-04T07:00:00.000Z",
      latestInventoryAt:"2026-08-04T05:00:00.000Z",
      latestOrderAt:"2026-08-04T05:00:00.000Z",
      productCount:74,freshProductCount:74,scheduleCount:1,
      incidents:[],backtest:buildStoreDemandBacktest([])
    });
    expect(result.map((reminder) => reminder.id)).not.toContain("inventory-collection-stale");
    expect(result.map((reminder) => reminder.id)).not.toContain("recent-orders-stale");
  });
});
