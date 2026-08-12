import { createHash } from "node:crypto";

export interface InventoryReportOverview {
  readonly generatedAt: string;
  readonly shopId: string;
  readonly counts: { readonly products: number; readonly skus: number };
  readonly freshness?: {
    readonly latestInventoryAt?: string | null;
    readonly latestOrderAt?: string | null;
  };
  readonly incidents?: readonly Record<string, unknown>[];
  readonly reminders?: readonly Record<string, unknown>[];
  readonly backtest?: Record<string, unknown>;
}

export interface ShopInventoryReport {
  readonly shop: { readonly id: string; readonly name: string };
  readonly overview: InventoryReportOverview;
}

export interface InventoryFeishuReport {
  readonly reportKey: string;
  readonly digest: string;
  readonly payload: Record<string, unknown>;
  readonly counts: {
    readonly critical: number;
    readonly warning: number;
    readonly unknown: number;
    readonly products: number;
    readonly skus: number;
  };
}

function text(value: unknown, maximum = 180): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/gu," ")
    .replace(/([\\*_`\[\]])/gu,"\\$1")
    .replace(/\s+/gu," ")
    .trim()
    .slice(0,maximum);
}

function productTitle(value: unknown, fallback: string): string {
  const cleaned = text(value,160)
    .replace(/(?:现货模式|预览|复制链接|奖品商品|非卖赠品)+/gu," ")
    .replace(/\s+/gu," ")
    .trim();
  return cleaned || fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dateInShanghai(at: Date): string {
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(at);
}

function localTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "无数据";
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "无数据";
  return new Intl.DateTimeFormat("zh-CN",{
    timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false
  }).format(at);
}

function localDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "无数据";
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "无数据";
  return new Intl.DateTimeFormat("sv-SE",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hour12:false
  }).format(at);
}

function oldestInventoryUpdate(items: readonly ShopInventoryReport[]): string {
  const timestamps = items
    .map((item) => Date.parse(item.overview.freshness?.latestInventoryAt ?? ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return "无数据";
  return localDateTime(new Date(Math.min(...timestamps)).toISOString());
}

function dashboardUrl(value: string): string {
  const parsed = new URL(value);
  if (
    !new Set(["http:","https:"]).has(parsed.protocol) ||
    parsed.username || parsed.password || parsed.hash || parsed.search
  ) {
    throw new Error("INVENTORY_DASHBOARD_URL_INVALID");
  }
  return parsed.toString();
}

function severityName(value: unknown): string {
  return ({ critical:"严重",warning:"预警",unknown:"待确认",normal:"正常" } as Record<string,string>)[String(value)] ?? "待确认";
}

function riskReason(value: unknown): string {
  const reason = String(value ?? "");
  const exact: Record<string,string> = {
    "Inventory data is stale or incomplete; deterministic risk was suppressed.":"库存快照已过期或不完整，暂不进行确定性风险判断。",
    "Recent orders exceed 120 minutes or the latest complete historical order day exceeds 36 hours; deterministic risk was suppressed.":"订单数据超过 2 小时有效期，暂不进行确定性风险判断。",
    "Channel history has not reached the cold-start coverage gate.":"渠道历史尚未达到冷启动门槛。",
    "Channel consumption estimate is unavailable.":"渠道消耗估算暂不可用。",
    "Channel mapping exists but no reliable consumption share is available.":"渠道映射已建立，但消耗份额仍待积累。",
    "SKU forecast is missing.":"SKU 销量预测尚未建立。",
    "P90 demand exhausts stock":"P90 需求预计将耗尽当前库存。"
  };
  if (exact[reason]) return exact[reason];
  let match = reason.match(/^SKU stock does not cover the (2|6)-hour P90 demand\.$/u);
  if (match) return `SKU 库存无法覆盖未来 ${match[1]} 小时 P90 需求。`;
  match = reason.match(/^Channel stock does not cover the (2|6)-hour allocated P90 demand\.$/u);
  if (match) return `渠道库存无法覆盖未来 ${match[1]} 小时分配后的 P90 需求。`;
  match = reason.match(/^Unoccupied reserve cannot cover all channel top-up deficits for (6|24) hours\.$/u);
  if (match) return `未占用库存无法覆盖全部渠道未来 ${match[1]} 小时补足缺口。`;
  return /[A-Za-z]{4}/u.test(reason) ? "风险证据已记录，请在库存指挥台查看明细。" : text(reason || "等待风险证据",180);
}

function openIncidents(item: ShopInventoryReport): readonly Record<string, unknown>[] {
  return (item.overview.incidents ?? []).filter((candidate) => candidate.state === "open");
}

function reportCounts(items: readonly ShopInventoryReport[]): InventoryFeishuReport["counts"] {
  const incidents = items.flatMap((item) => [...openIncidents(item)]);
  const count = (severity: string): number => incidents.filter((candidate) => candidate.severity === severity).length;
  return {
    critical:count("critical"),warning:count("warning"),unknown:count("unknown"),
    products:items.reduce((sum,item) => sum + Number(item.overview.counts.products ?? 0),0),
    skus:items.reduce((sum,item) => sum + Number(item.overview.counts.skus ?? 0),0)
  };
}

function riskLine(item: ShopInventoryReport,incident: Record<string, unknown>): string {
  const findings = Array.isArray(incident.findings) ? incident.findings : [];
  const finding = record(findings[0]);
  const scope = record(finding.scope);
  const productId = text(scope.productId ?? incident.product_id,80);
  const skuId = text(scope.platformSkuId,80);
  const channelId = text(scope.channelGoodsId,80);
  const marker = incident.severity === "critical" ? "🔴" : incident.severity === "warning" ? "🟠" : "⚪";
  const ids = [productId ? `商品 ${productId}` : "",skuId ? `SKU ${skuId}` : "",channelId ? `渠道 ${channelId}` : ""].filter(Boolean).join("｜");
  return `${marker} **${productTitle(incident.product_title,`商品 ${productId || "待确认"}`)}** · ${severityName(incident.severity)}\n${text(item.shop.name,80)}${ids ? `｜${ids}` : ""}\n${riskReason(finding.reason)}`;
}

function digestPayload(payload: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function buildConsolidatedInventoryFeishuReport(input: {
  readonly shops: readonly ShopInventoryReport[];
  readonly dashboardUrl: string;
  readonly now?: Date;
}): InventoryFeishuReport {
  const now = input.now ?? new Date();
  const counts = reportCounts(input.shops);
  const template = counts.critical > 0 ? "red" : counts.warning > 0 ? "orange" : "green";
  const actionable = input.shops.flatMap((item) => {
    const lines = openIncidents(item)
      .filter((incident) => incident.severity === "critical" || incident.severity === "warning")
      .flatMap((incident) => {
        const findings = Array.isArray(incident.findings) && incident.findings.length
          ? incident.findings
          : [{}];
        return findings.map((candidate) => {
          const finding = record(candidate);
          const scope = record(finding.scope);
          const marker = incident.severity === "critical" ? "🔴" : "🟠";
          const productId = text(scope.productId ?? incident.product_id,80);
          const skuId = text(scope.platformSkuId ?? incident.platform_sku_id,80) || "待确认";
          const title = productTitle(incident.product_title,`商品 ${productId || "待确认"}`);
          return `${marker} ${title}｜SKU_ID：${skuId}｜${riskReason(finding.reason)} 请前往库存看板查看并处理`;
        });
      });
    return lines.length ? [{ shopName:text(item.shop.name,80),lines }] : [];
  });
  const visibleLineLimit = 20;
  let visibleLines = 0;
  const riskSections: string[] = [];
  for (const item of actionable) {
    if (visibleLines >= visibleLineLimit) break;
    const lines = item.lines.slice(0,visibleLineLimit - visibleLines);
    visibleLines += lines.length;
    riskSections.push(`## ${item.shopName}\n${lines.join("\n")}`);
  }
  const totalRiskLines = actionable.reduce((sum,item) => sum + item.lines.length,0);
  if (totalRiskLines > visibleLines) {
    riskSections.push(`另有 ${totalRiskLines - visibleLines} 条风险，请前往库存看板查看并处理`);
  }
  const riskContent = riskSections.length ? riskSections.join("\n\n") : "✅ 暂无风险";
  const cardElements: Record<string,unknown>[] = [
    {
      tag:"div",
      text:{
        tag:"lark_md",
        content:`📅 ${dateInShanghai(now)} ｜ 数据：${oldestInventoryUpdate(input.shops)} 更新\n\n# 确定性风险\n\n${riskContent}`
      }
    }
  ];
  if (riskSections.length) {
    cardElements.push({
      tag:"action",
      actions:[{
        tag:"button",type:"primary",
        text:{ tag:"plain_text",content:"打开库存看板" },
        url:dashboardUrl(input.dashboardUrl)
      }]
    });
  }
  const payload = {
    msg_type:"interactive",
    card:{
      config:{ wide_screen_mode:true },
      header:{ template,title:{ tag:"plain_text",content:`🟢 库存风险报告｜${input.shops.length} 家店铺` } },
      elements:cardElements
    }
  };
  const digest = digestPayload(payload);
  return { reportKey:`inventory-daily:all:${dateInShanghai(now)}`,digest,payload,counts };
}

export function buildInventoryFeishuAlert(input: {
  readonly shops: readonly ShopInventoryReport[];
  readonly now?: Date;
}): InventoryFeishuReport | undefined {
  const now = input.now ?? new Date();
  const active = input.shops.flatMap((item) => openIncidents(item)
    .filter((incident) => incident.severity === "critical" || incident.severity === "warning")
    .map((incident) => ({ item,incident })));
  const operational = input.shops.flatMap((item) => (item.overview.reminders ?? [])
    .filter((reminder) => reminder.severity === "critical" || reminder.severity === "warning")
    .filter((reminder) => String(reminder.id) !== "backtest-p90-coverage")
    .filter((reminder) => !active.some((entry) => entry.item.shop.id === item.shop.id && entry.incident.incident_id === reminder.id))
    .map((reminder) => ({ item,reminder })));
  if (!active.length && !operational.length) return undefined;
  const stateDigest = createHash("sha256").update(JSON.stringify({
    incidents:active.map(({ item,incident }) => [item.shop.id,incident.incident_id,incident.severity]),
    operations:operational.map(({ item,reminder }) => [item.shop.id,reminder.id,reminder.severity])
  })).digest("hex").slice(0,16);
  const counts = reportCounts(input.shops);
  const lines = [
    ...active.map(({ item,incident }) => riskLine(item,incident)),
    ...operational.map(({ item,reminder }) => `${reminder.severity === "critical" ? "🔴" : "🟠"} **${text(reminder.title,80)}**\n${text(item.shop.name,80)}｜${text(reminder.detail,180)}`)
  ].slice(0,16);
  const payload = {
    msg_type:"interactive",
    card:{
      config:{ wide_screen_mode:true },
      header:{ template:counts.critical || operational.some((entry) => entry.reminder.severity === "critical") ? "red" : "orange",title:{ tag:"plain_text",content:"库存风险报告｜异常提醒" } },
      elements:[
        { tag:"div",text:{ tag:"lark_md",content:lines.join("\n\n") } },
        { tag:"hr" },
        { tag:"note",elements:[{ tag:"plain_text",content:`库存风险报告｜监测店铺：${input.shops.map((item) => text(item.shop.name,40)).join("、")}` }] },
        { tag:"note",elements:[{ tag:"plain_text",content:`全店合并提醒｜${localTime(now.toISOString())}｜同一异常状态仅发送一次` }] }
      ]
    }
  };
  const digest = digestPayload(payload);
  return { reportKey:`inventory-alert:${dateInShanghai(now)}:${stateDigest}`,digest,payload,counts };
}

export function buildInventoryFeishuReport(input: {
  readonly shop: { readonly id: string; readonly name: string };
  readonly overview: InventoryReportOverview;
  readonly dashboardUrl: string;
  readonly now?: Date;
}): InventoryFeishuReport {
  return buildConsolidatedInventoryFeishuReport({
    shops:[{ shop:input.shop,overview:input.overview }],dashboardUrl:input.dashboardUrl,
    ...(input.now ? { now:input.now } : {})
  });
}

export async function sendFeishuWebhook(input: {
  readonly webhookUrl: string;
  readonly payload: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly code: number; readonly message: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.webhookUrl,{
    method:"POST",headers:{ "content-type":"application/json; charset=utf-8" },
    body:JSON.stringify(input.payload),signal:AbortSignal.timeout(20_000)
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* provider returned non-JSON */ }
  if (!response.ok) throw new Error(`FEISHU_HTTP_${response.status}`);
  const code = Number(parsed.code ?? parsed.StatusCode ?? 0);
  if (code !== 0) throw new Error(`FEISHU_REJECTED_${code}`);
  return { code,message:text(parsed.msg ?? parsed.StatusMessage ?? "ok",200) || "ok" };
}
