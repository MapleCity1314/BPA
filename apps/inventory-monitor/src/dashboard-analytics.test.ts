import { describe,expect,it } from "vitest";
import {
  buildOperationalReminders,
  buildSystemOperationalReminders,
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

  it("uses operational language for a prediction calibration reminder",() => {
    const backtest = buildStoreDemandBacktest([]);
    const result = buildOperationalReminders({
      now:"2026-08-04T07:00:00.000Z",
      latestInventoryAt:"2026-08-04T06:30:00.000Z",
      latestOrderAt:"2026-08-04T06:30:00.000Z",
      productCount:1,
      freshProductCount:1,
      scheduleCount:1,
      incidents:[],
      backtest:{
        ...backtest,
        metrics:{ ...backtest.metrics,p90Coverage:0.8 }
      }
    });
    const reminder = result.find((item) => item.id === "backtest-p90-coverage");
    expect(reminder).toEqual(expect.objectContaining({
      title:"偏高销量预测需要校准",
      detail:"当前店铺的偏高销量预测命中率为 80%，正常范围为 85%–95%。"
    }));
    expect(JSON.stringify(reminder)).not.toContain("P90");
  });

  it("shows an in-progress collection as a warning instead of a severe outage",() => {
    const result = buildOperationalReminders({
      now:"2026-08-04T07:00:00.000Z",
      latestInventoryAt:"2026-08-04T04:59:00.000Z",
      latestOrderAt:"2026-08-04T06:45:00.000Z",
      productCount:74,freshProductCount:74,scheduleCount:1,collectionActive:true,
      incidents:[],backtest:buildStoreDemandBacktest([])
    });
    expect(result).toContainEqual(expect.objectContaining({
      id:"inventory-collection-stale",severity:"warning",title:"库存正在更新"
    }));
  });

  it("raises one critical system reminder for stale running collections",() => {
    const result = buildSystemOperationalReminders({
      activeCollectionCount:0,
      staleCollectionCount:1,
      oldestStaleStartedAt:"2026-08-07T15:23:46.407Z",
      staleAfterMinutes:120
    });
    expect(result).toEqual([expect.objectContaining({
      id:"collection-control-stale",
      severity:"critical",
      title:"采集控制记录未收口"
    })]);
    expect(result[0]?.detail).toContain("1 条超过 120 分钟");
    expect(result[0]?.action).toContain("不要补触发");
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
