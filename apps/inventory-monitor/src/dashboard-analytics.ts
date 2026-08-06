import {
  INVENTORY_DATA_VALIDITY_MINUTES,
  RECENT_ORDER_DATA_VALIDITY_MINUTES
} from "@bpa/inventory-domain";

export interface DailyDemandPoint {
  readonly date: string;
  readonly actual: number;
}

export interface BacktestPoint extends DailyDemandPoint {
  readonly p50: number;
  readonly p90: number;
}

export interface StoreDemandBacktest {
  readonly status: "ready" | "insufficient_data";
  readonly model: string;
  readonly windowDays: number;
  readonly points: readonly BacktestPoint[];
  readonly metrics: {
    readonly p90Coverage: number | null;
    readonly p50PinballLoss: number | null;
    readonly p90PinballLoss: number | null;
    readonly wape: number | null;
  };
  readonly diagnostics: readonly string[];
}

export interface OperationalReminder {
  readonly id: string;
  readonly severity: "critical" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly source: string;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

function pinball(actual: number, predicted: number, probability: number): number {
  const error = actual - predicted;
  return error >= 0 ? probability * error : (probability - 1) * error;
}

export function buildStoreDemandBacktest(
  dailyDemand: readonly DailyDemandPoint[]
): StoreDemandBacktest {
  const ordered = [...dailyDemand]
    .filter((point) => Number.isFinite(point.actual) && point.actual >= 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (ordered.length < 35) {
    return {
      status: "insufficient_data",
      model: "7/14/28 日加权滚动模型",
      windowDays: ordered.length,
      points: [],
      metrics: {
        p90Coverage: null,
        p50PinballLoss: null,
        p90PinballLoss: null,
        wape: null
      },
      diagnostics: ["至少需要 35 个完整自然日才能形成稳定的滚动回测。"]
    };
  }

  const evaluated: BacktestPoint[] = [];
  const residuals: number[] = [];
  for (let index = 28; index < ordered.length; index += 1) {
    const history = ordered.slice(0,index).map((point) => point.actual);
    const p50 =
      mean(history.slice(-7)) * 0.55 +
      mean(history.slice(-14)) * 0.3 +
      mean(history.slice(-28)) * 0.15;
    const calibration = residuals.length >= 7
      ? Math.max(0,quantile(residuals.slice(-28),0.9))
      : Math.max(1,p50 * 0.25);
    const actual = ordered[index]!.actual;
    evaluated.push({
      date: ordered[index]!.date,
      actual,
      p50: round(Math.max(0,p50)),
      p90: round(Math.max(p50,p50 + calibration))
    });
    residuals.push(actual - p50);
  }

  const actualTotal = evaluated.reduce((sum, point) => sum + point.actual,0);
  return {
    status: "ready",
    model: "7/14/28 日加权滚动模型",
    windowDays: ordered.length,
    points: evaluated.slice(-35),
    metrics: {
      p90Coverage: round(
        evaluated.filter((point) => point.actual <= point.p90).length / evaluated.length,
        4
      ),
      p50PinballLoss: round(mean(evaluated.map((point) => pinball(point.actual,point.p50,0.5)))),
      p90PinballLoss: round(mean(evaluated.map((point) => pinball(point.actual,point.p90,0.9)))),
      wape: actualTotal === 0 ? 0 : round(
        evaluated.reduce((sum, point) => sum + Math.abs(point.actual - point.p50),0) /
          actualTotal,
        4
      )
    },
    diagnostics: [
      "按自然日执行一步前推回测；P90 使用历史正残差滚动校准。",
      "该曲线衡量店铺总需求基线，SKU 级模型在库存身份映射建立后单独评估。"
    ]
  };
}

export function buildOperationalReminders(input: {
  readonly now: string;
  readonly latestInventoryAt: string | null;
  readonly latestOrderAt: string | null;
  readonly productCount: number;
  readonly freshProductCount: number;
  readonly scheduleCount: number;
  readonly collectionRunning?: boolean;
  readonly incidents: readonly Record<string, unknown>[];
  readonly backtest: StoreDemandBacktest;
}): readonly OperationalReminder[] {
  const reminders: OperationalReminder[] = [];
  const now = Date.parse(input.now);
  const ageMinutes = (value: string | null): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0,(now - parsed) / 60_000) : null;
  };
  const inventoryAge = ageMinutes(input.latestInventoryAt);
  const orderAge = ageMinutes(input.latestOrderAt);

  if (input.productCount === 0 || inventoryAge === null) {
    reminders.push({
      id: "inventory-collection-missing",
      severity: "critical",
      title: "库存采集尚未建立",
      detail: "当前没有商品、SKU 和渠道库存快照，风险判断保持未知。",
      action: "连接已登录抖店的浏览器并执行首次全量采集",
      source: "库存快照新鲜度规则"
    });
  } else if (inventoryAge > INVENTORY_DATA_VALIDITY_MINUTES) {
    reminders.push({
      id: "inventory-collection-stale",
      severity: input.collectionRunning ? "warning" : "critical",
      title: input.collectionRunning ? "库存正在更新" : "库存快照已过期",
      detail: input.collectionRunning
        ? `定时采集正在运行；上一份库存快照距今 ${Math.round(inventoryAge)} 分钟。风险结果继续保持待确认，完成后自动刷新。`
        : `最新库存距今 ${Math.round(inventoryAge)} 分钟，超过 2 小时有效期。`,
      action: input.collectionRunning ? "等待本轮采集完成" : "检查浏览器会话与采集调度",
      source: "库存快照新鲜度规则"
    });
  } else if (input.freshProductCount < input.productCount) {
    const coverage = input.productCount === 0
      ? 0
      : input.freshProductCount / input.productCount;
    reminders.push({
      id: "inventory-collection-partial",
      severity: coverage < 0.8 ? "critical" : "warning",
      title: "全量库存快照仍在恢复",
      detail: `2 小时内已更新 ${input.freshProductCount} / ${input.productCount} 个商品，尚未达到 95% 生产覆盖门槛。`,
      action: "保持恢复进程运行，完成后自动重新计算风险",
      source: "库存快照覆盖率规则"
    });
  }
  if (orderAge === null || orderAge > RECENT_ORDER_DATA_VALIDITY_MINUTES) {
    reminders.push({
      id: "recent-orders-stale",
      severity: "warning",
      title: "近期订单热数据需要刷新",
      detail: orderAge === null
        ? "尚未发现已支付订单数据。"
        : `最新支付订单距今 ${Math.round(orderAge / 60)} 小时，超过 2 小时有效期。`,
      action: "执行近期订单读取节点",
      source: "订单新鲜度规则"
    });
  }
  if (input.scheduleCount === 0) {
    reminders.push({
      id: "scheduler-not-running",
      severity: "warning",
      title: "30 分钟调度尚未产生运行记录",
      detail: "服务在线，但自动采集计划还未完成首轮执行。",
      action: "确认浏览器绑定后启用调度器",
      source: "调度运行检查"
    });
  }
  for (const incident of input.incidents) {
    if (incident.state !== "open" || (incident.severity !== "critical" && incident.severity !== "warning")) continue;
    reminders.push({
      id: String(incident.incident_id),
      severity: incident.severity,
      title: incident.severity === "critical" ? "库存严重风险" : "库存预警",
      detail: `商品 ${String(incident.product_id ?? "未知")} 的风险事件等待运营处理。`,
      action: "打开风险事件并记录处理结论",
      source: "库存均衡策略 v1.0"
    });
  }
  const coverage = input.backtest.metrics.p90Coverage;
  if (coverage !== null && (coverage < 0.85 || coverage > 0.95)) {
    reminders.push({
      id: "backtest-p90-coverage",
      severity: "warning",
      title: "P90 覆盖率需要校准",
      detail: `当前店铺级滚动回测覆盖率为 ${round(coverage * 100,1)}%，目标区间为 85%–95%。`,
      action: "检查近期突发增长并重新校准残差窗口",
      source: "回测放行门槛"
    });
  }
  return reminders;
}
