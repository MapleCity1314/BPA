import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { InventoryRepository } from "./repository.js";
import type { InventoryShopConfig } from "./shop-config.js";
import { DASHBOARD_CLIENT_CSS, DASHBOARD_CLIENT_JS } from "./dashboard-client.js";

const SESSION_COOKIE = "bpa_inventory_session";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const BODY_LIMIT = 64 * 1024;

interface Session {
  id: string;
  csrf: string;
  lastSeenAt: number;
}

export interface InventoryWebHandle {
  readonly launchUrl: string;
  readonly accessUrl: string | undefined;
  readonly port: number;
  close(): Promise<void>;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function encodeSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeSession(value: string, secret: string): Session | undefined {
  const separator = value.lastIndexOf(".");
  if (separator < 1) return undefined;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Session>;
    if (
      typeof parsed.id !== "string" || !parsed.id ||
      typeof parsed.csrf !== "string" || !parsed.csrf ||
      typeof parsed.lastSeenAt !== "number" || !Number.isFinite(parsed.lastSeenAt)
    ) return undefined;
    return { id: parsed.id, csrf: parsed.csrf, lastSeenAt: parsed.lastSeenAt };
  } catch {
    return undefined;
  }
}

function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`;
}

function headers(response: ServerResponse, contentType: string): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function send(response: ServerResponse, status: number, value: string, contentType: string): void {
  const body = Buffer.from(value);
  response.statusCode = status;
  headers(response, contentType);
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function readRecoveryStatus(path: string | undefined): Promise<Record<string,unknown> | null> {
  if (!path) return null;
  try {
    const body = await readFile(path,"utf8");
    if (body.length > 4_096) return null;
    const parsed = JSON.parse(body) as Record<string,unknown>;
    const states = new Set(["running","succeeded","degraded","auth_required","interrupted"]);
    if (!states.has(String(parsed.state)) || typeof parsed.updatedAt !== "string") return null;
    return {
      state:String(parsed.state),
      updatedAt:parsed.updatedAt,
      ...(typeof parsed.shopId === "string" ? { shopId:parsed.shopId } : {}),
      ...(typeof parsed.shopName === "string" ? { shopName:parsed.shopName } : {}),
      ...(typeof parsed.reason === "string" ? { reason:parsed.reason.slice(0,500) } : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return index < 1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    })
  );
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > BODY_LIMIT) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_JSON");
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function oldestTimestamp(values: readonly unknown[]): string | null {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left,right) => Date.parse(left) - Date.parse(right));
  return timestamps[0] ?? null;
}

function newestTimestamp(values: readonly unknown[]): string | null {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left,right) => Date.parse(right) - Date.parse(left));
  return timestamps[0] ?? null;
}

function aggregateBacktest(overviews: readonly Record<string, unknown>[]): Record<string, unknown> {
  const pointsByDate = new Map<string,{ date: string; actual: number; p50: number; p90: number }>();
  let readyStores = 0;
  for (const overview of overviews) {
    const backtest = record(overview.backtest);
    if (backtest.status !== "ready") continue;
    readyStores += 1;
    for (const point of records(backtest.points)) {
      const date = String(point.date ?? "");
      if (!date) continue;
      const current = pointsByDate.get(date) ?? { date,actual:0,p50:0,p90:0 };
      current.actual += finite(point.actual);
      current.p50 += finite(point.p50);
      current.p90 += finite(point.p90);
      pointsByDate.set(date,current);
    }
  }
  const points = [...pointsByDate.values()].sort((left,right) => left.date.localeCompare(right.date)).slice(-35);
  if (!points.length) return {
    status:"insufficient_data",model:"全店需求汇总模型",windowDays:0,points:[],
    metrics:{ p90Coverage:null,p50PinballLoss:null,p90PinballLoss:null,wape:null },
    diagnostics:["尚无店铺达到回测数据门槛。"]
  };
  const mean = (values: readonly number[]): number => values.reduce((sum,value) => sum + value,0) / Math.max(1,values.length);
  const round = (value: number,digits = 2): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const pinball = (actual: number,predicted: number,probability: number): number => {
    const error = actual - predicted;
    return error >= 0 ? probability * error : (probability - 1) * error;
  };
  const actualTotal = points.reduce((sum,point) => sum + point.actual,0);
  return {
    status:"ready",model:"全店需求汇总模型",windowDays:points.length,points,
    metrics:{
      p90Coverage:round(points.filter((point) => point.actual <= point.p90).length / points.length,4),
      p50PinballLoss:round(mean(points.map((point) => pinball(point.actual,point.p50,0.5)))),
      p90PinballLoss:round(mean(points.map((point) => pinball(point.actual,point.p90,0.9)))),
      wape:actualTotal === 0 ? 0 : round(points.reduce((sum,point) => sum + Math.abs(point.actual - point.p50),0) / actualTotal,4)
    },
    diagnostics:[`已汇总 ${readyStores} 家店铺的滚动回测；没有达到门槛的店铺不进入曲线。`]
  };
}

function aggregateOverviews(entries: readonly {
  readonly shop: InventoryShopConfig;
  readonly overview: Record<string, unknown>;
}[]): Record<string, unknown> {
  const overviews = entries.map((entry) => entry.overview);
  const enriched = entries.map(({ shop,overview }) => {
    const incidents: Record<string,unknown>[] = records(overview.incidents).map((incident) => ({ ...incident,shop_id:shop.id,shop_name:shop.name }));
    const reminders: Record<string,unknown>[] = records(overview.reminders).map((reminder) => ({
      ...reminder,id:`${shop.id}:${String(reminder.id ?? "reminder")}`,shop_id:shop.id,shop_name:shop.name
    }));
    const products: Record<string,unknown>[] = records(overview.products).map((product) => ({ ...product,shop_id:shop.id,shop_name:shop.name }));
    const schedules: Record<string,unknown>[] = records(overview.schedules).map((schedule) => ({ ...schedule,shop_id:shop.id,shop_name:shop.name }));
    return { shop,overview,incidents,reminders,products,schedules };
  });
  const incidents = enriched.flatMap((entry) => entry.incidents).sort((left,right) => {
    const rank = (value: unknown): number => ({ critical:0,warning:1,unknown:2,normal:3 } as Record<string,number>)[String(value)] ?? 4;
    return rank(left.severity) - rank(right.severity) || String(right.last_seen_at ?? "").localeCompare(String(left.last_seen_at ?? ""));
  });
  const counts = overviews.map((overview) => record(overview.counts));
  const cold = overviews.map((overview) => record(overview.coldStart));
  const freshness = overviews.map((overview) => record(overview.freshness));
  const shopStatuses = enriched.map((entry) => {
    const open = entry.incidents.filter((incident) => incident.state === "open");
    const reminders = entry.reminders;
    return {
      id:entry.shop.id,name:entry.shop.name,
      products:finite(record(entry.overview.counts).products),skus:finite(record(entry.overview.counts).skus),
      critical:open.filter((incident) => incident.severity === "critical").length,
      warning:open.filter((incident) => incident.severity === "warning").length,
      unknown:open.filter((incident) => incident.severity === "unknown").length,
      operationalCritical:reminders.filter((reminder) => reminder.severity === "critical").length,
      operationalWarning:reminders.filter((reminder) => reminder.severity === "warning").length,
      latestInventoryAt:record(entry.overview.freshness).latestInventoryAt ?? null,
      latestOrderAt:record(entry.overview.freshness).latestOrderAt ?? null
    };
  });
  return {
    generatedAt:new Date().toISOString(),shopId:"all",
    databaseTime:newestTimestamp(overviews.map((overview) => overview.databaseTime)),
    freshness:{
      latestInventoryAt:oldestTimestamp(freshness.map((item) => item.latestInventoryAt)),
      latestOrderAt:oldestTimestamp(freshness.map((item) => item.latestOrderAt)),
      historicalCompleteThrough:oldestTimestamp(freshness.map((item) => item.historicalCompleteThrough))
    },
    counts:{
      products:counts.reduce((sum,item) => sum + finite(item.products),0),
      freshProducts:counts.reduce((sum,item) => sum + finite(item.freshProducts),0),
      skus:counts.reduce((sum,item) => sum + finite(item.skus),0),
      incidents:incidents.length
    },
    products:enriched.flatMap((entry) => entry.products),incidents,
    reminders:enriched.flatMap((entry) => entry.reminders),
    schedules:enriched.flatMap((entry) => entry.schedules)
      .sort((left,right) => String(right.scheduled_for ?? "").localeCompare(String(left.scheduled_for ?? ""))).slice(0,20),
    backtest:aggregateBacktest(overviews),shopStatuses,
    coldStart:{
      directModel:cold.reduce((sum,item) => sum + finite(item.directModel),0),
      hierarchicalFallback:cold.reduce((sum,item) => sum + finite(item.hierarchicalFallback),0),
      storeBaseline:cold.reduce((sum,item) => sum + finite(item.storeBaseline),0),
      totalOrderSkus:cold.reduce((sum,item) => sum + finite(item.totalOrderSkus),0),
      inventoryMappedSkus:cold.reduce((sum,item) => sum + finite(item.inventoryMappedSkus),0)
    },
    rules:record(overviews[0]?.rules),notifications:{ feishu:{ lastSentAt:newestTimestamp(overviews.map((overview) => record(record(overview.notifications).feishu).lastSentAt)) } }
  };
}

function loopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BPA 库存风险指挥台</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/app-v2.css"></head><body><header><div class="brand"><span class="brand-mark">B</span><div><p>BPA INVENTORY CONTROL</p><h1>抖店库存风险指挥台</h1></div></div><div class="header-actions"><span class="status-chip" id="status"><i></i>正在连接</span><button class="secondary" id="enableNotify">开启桌面提醒</button><button id="reload">刷新数据</button></div></header><main><section class="metrics" id="metrics"></section><section class="priority-grid"><article class="panel incidents-panel"><div class="section-title"><div><p class="eyebrow">RISK WORKBENCH</p><h2>当前风险事件</h2></div><span class="count-badge" id="incidentCount">0</span></div><div id="incidents"></div></article><article class="panel reminders-panel"><div class="section-title"><div><p class="eyebrow">ACTION REQUIRED</p><h2>运营提醒</h2></div><span class="count-badge" id="reminderCount">0</span></div><div id="reminders"></div></article></section><section class="panel readiness-panel compact-panel"><div class="section-title"><div><p class="eyebrow">SYSTEM READINESS</p><h2>数据与冷启动</h2></div><span class="live-dot">在线</span></div><div id="readiness"></div></section><section class="panel backtest-panel"><div class="section-title"><div><p class="eyebrow">QUANTITATIVE BACKTEST</p><h2>需求预测滚动回测</h2></div><div class="legend"><span class="actual">实际销量</span><span class="p50">P50</span><span class="p90">P90</span></div></div><div id="backtest"></div></section><section class="panel inventory-panel"><div class="section-title"><div><p class="eyebrow">INVENTORY & FORECAST</p><h2>商品、SKU 与渠道风险</h2></div><span class="muted" id="inventoryUpdated"></span></div><div id="products"></div></section><section class="details-grid"><article class="panel"><h2>生产规则</h2><div id="rules"></div></article><article class="panel"><div class="section-title"><h2>运行记录</h2><span class="muted">30 分钟租约调度</span></div><div id="schedules"></div></article></section></main><dialog id="review"><form method="dialog"><h3>记录运营判断</h3><input id="incidentId" type="hidden"><label>结论<select id="decision"><option value="valid">有效风险</option><option value="false_positive">误报</option><option value="needs_context">信息不足</option></select></label><label>备注<textarea id="note" maxlength="4000" placeholder="记录处置动作或补充信息"></textarea></label><menu><button class="secondary" value="cancel">取消</button><button id="submit" value="default">保存判断</button></menu></form></dialog><script src="/app.js"></script></body></html>`;

const CSS = `:root{font-family:Inter,"SF Pro Display","PingFang SC",sans-serif;color:#162033;background:#f5f7fa;font-synthesis:none;--navy:#142b4a;--blue:#225c9f;--green:#19735a;--red:#c23b33;--amber:#b86a18;--line:#e2e7ee;--muted:#69758a}*{box-sizing:border-box}body{margin:0;min-width:320px}header{height:84px;display:flex;justify-content:space-between;align-items:center;padding:0 max(28px,4vw);background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}.brand,.header-actions,.section-title,.product-head{display:flex;align-items:center;gap:14px}.brand-mark{width:38px;height:38px;border-radius:10px;background:var(--navy);color:#fff;display:grid;place-items:center;font-size:20px;font-weight:800}.brand p,.eyebrow{margin:0 0 4px;color:#718096;font-size:10px;font-weight:700;letter-spacing:.14em}.brand h1{margin:0;font-size:20px;color:var(--navy);letter-spacing:-.02em}.header-actions{gap:9px}.status-chip,.live-dot,.tag{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:7px 11px;background:#eef6f2;color:var(--green);font-size:12px;font-weight:650}.status-chip i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px #19735a18}.status-chip.warning{background:#fff6e9;color:var(--amber)}.status-chip.critical{background:#fff0ef;color:var(--red)}button{border:0;border-radius:8px;background:var(--navy);color:white;padding:9px 14px;font-weight:650;cursor:pointer}button:hover{filter:brightness(1.08)}button.secondary{background:#fff;color:#34445b;border:1px solid #d5dce5}main{max-width:1500px;margin:0 auto;padding:24px 28px 64px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric,.panel,.product{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 7px 22px #16203308}.metric{padding:17px 18px;position:relative;overflow:hidden}.metric:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#cad3df}.metric.critical:before{background:var(--red)}.metric.warning:before{background:var(--amber)}.metric.good:before{background:var(--green)}.metric small{color:var(--muted);font-size:12px}.metric strong{display:block;margin-top:7px;font-size:25px;line-height:1.1;color:var(--navy)}.metric span{display:block;margin-top:6px;color:#8993a4;font-size:11px}.operations-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:14px;margin-top:14px}.panel{padding:20px}.section-title{justify-content:space-between;margin-bottom:16px}.section-title h2,.panel>h2{margin:0;font-size:16px;color:var(--navy)}.count-badge{min-width:29px;height:29px;display:grid;place-items:center;border-radius:8px;background:#edf2f8;color:var(--navy);font-size:13px;font-weight:800}.reminder{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;padding:13px 0;border-top:1px solid #edf0f4}.reminder:first-child{border-top:0}.reminder-icon{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;font-weight:800;background:#eef2f7;color:#627086}.reminder.critical .reminder-icon{background:#fff0ef;color:var(--red)}.reminder.warning .reminder-icon{background:#fff6e9;color:var(--amber)}.reminder h3{margin:0 0 4px;font-size:13px}.reminder p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}.reminder-action{color:var(--blue);font-size:11px;text-align:right;max-width:150px}.readiness-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #edf0f4;font-size:12px}.readiness-row:last-child{border-bottom:0}.readiness-row span{color:var(--muted)}.readiness-row strong{font-size:12px}.cold-block{margin-top:14px;padding-top:13px;border-top:1px solid #edf0f4}.cold-head{display:flex;justify-content:space-between;font-size:12px}.bar{height:7px;background:#edf1f5;border-radius:99px;overflow:hidden;margin:9px 0 7px;display:flex}.bar i:nth-child(1){background:var(--green)}.bar i:nth-child(2){background:#e2a648}.bar i:nth-child(3){background:#9aa6b6}.bar-legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:10px}.backtest-panel,.inventory-panel,.details-grid,.panel+section{margin-top:14px}.legend{display:flex;gap:14px;font-size:11px;color:var(--muted)}.legend span:before{content:"";display:inline-block;width:14px;height:3px;margin-right:5px;vertical-align:middle;border-radius:2px}.legend .actual:before{background:var(--navy)}.legend .p50:before{background:#3b82c4}.legend .p90:before{background:#d7903c}.chart-layout{display:grid;grid-template-columns:1fr 180px;gap:22px;align-items:center}.chart-wrap{height:255px;min-width:0}.chart-wrap svg{width:100%;height:100%;display:block}.chart-metrics{display:grid;gap:9px}.chart-metric{padding:11px;border:1px solid var(--line);border-radius:9px}.chart-metric small{display:block;color:var(--muted);font-size:10px}.chart-metric strong{display:block;margin-top:5px;font-size:18px;color:var(--navy)}.details-grid{display:grid;grid-template-columns:1.35fr .65fr;gap:14px}.rule{padding:10px 0;border-bottom:1px solid #edf0f4}.rule:last-child{border:0}.rule small{display:block;color:var(--muted)}.rule strong{display:block;margin-top:4px;font-size:12px}.muted{color:#7b8799;font-size:11px}.empty{padding:24px;border:1px dashed #d6dde6;border-radius:10px;color:var(--muted);background:#fafbfd;font-size:12px}.product{padding:15px;margin-top:10px;box-shadow:none}.product h3{margin:0 0 4px;font-size:14px}.product-head{justify-content:space-between}.product-stock{text-align:right}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid #edf0f4;font-size:11px;vertical-align:top}th{background:#f8fafc;color:#68758a;font-weight:650;white-space:nowrap}.channels{max-width:260px;line-height:1.65}.severity-critical{color:var(--red);font-weight:750}.severity-warning{color:var(--amber);font-weight:750}.severity-unknown{color:#69758a;font-weight:750}.severity-normal{color:var(--green);font-weight:750}.severity-pill{display:inline-flex;padding:4px 7px;border-radius:6px;background:#f3f5f8}.severity-pill.severity-critical{background:#fff0ef}.severity-pill.severity-warning{background:#fff6e9}dialog{border:0;border-radius:14px;min-width:420px;padding:24px;box-shadow:0 24px 80px #16203333}dialog::backdrop{background:#12213b66}dialog h3{margin-top:0}label{display:block;margin:14px 0;font-size:13px}select,textarea{display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #d5dce5;border-radius:8px;font:inherit}textarea{min-height:100px}menu{display:flex;justify-content:flex-end;gap:10px;padding:0;margin-bottom:0}@media(max-width:1050px){.operations-grid,.details-grid{grid-template-columns:1fr}.chart-layout{grid-template-columns:1fr}.chart-metrics{grid-template-columns:repeat(4,1fr)}}@media(max-width:760px){header{height:auto;padding:16px;align-items:flex-start;gap:12px}.header-actions{flex-wrap:wrap;justify-content:flex-end}.brand p{display:none}.brand h1{font-size:16px}main{padding:14px}.metrics{grid-template-columns:1fr 1fr}.chart-metrics{grid-template-columns:1fr 1fr}.legend{display:none}table{display:block;overflow:auto}.panel{padding:15px}}`;

const JS = `let csrf='';const q=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const dt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'无数据';const horizon=(f,h)=>((f?.horizons||[]).find(x=>x.hours===h)||{});const pct=v=>v==null?'—':(Number(v)*100).toFixed(1)+'%';const severityName=v=>({critical:'严重',warning:'预警',unknown:'未知',normal:'正常'}[v]||v);async function init(){const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token){const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});history.replaceState(null,'',location.pathname);if(!r.ok)throw Error('会话初始化失败');csrf=(await r.json()).csrf}else{const r=await fetch('/api/session');if(!r.ok)throw Error('请使用服务启动时生成的一次性地址');csrf=(await r.json()).csrf}setNotifyButton();await load();setInterval(()=>{if(document.visibilityState==='visible')load().catch(show)},60000)}function setNotifyButton(){const b=q('#enableNotify');if(!('Notification'in window)){b.textContent='桌面提醒不可用';b.disabled=true;return}if(Notification.permission==='granted')b.textContent='桌面提醒已开启';else if(Notification.permission==='denied')b.textContent='桌面提醒已关闭'}async function enableNotifications(){if(!('Notification'in window))return;const permission=await Notification.requestPermission();setNotifyButton();if(permission==='granted')new Notification('BPA 库存风险指挥台',{body:'桌面提醒已开启。新的严重风险与预警会在此设备通知。'})}function notifyReminders(items){if(!('Notification'in window)||Notification.permission!=='granted')return;(items||[]).filter(x=>x.severity==='critical'||x.severity==='warning').forEach(x=>{const key='bpa-reminder:'+x.id;if(localStorage.getItem(key))return;new Notification(x.title,{body:x.detail,tag:x.id});localStorage.setItem(key,new Date().toISOString())})}function skuRows(p){return(p.skus||[]).map(s=>{const f=s.forecast,h2=horizon(f,2),h6=horizon(f,6),h24=horizon(f,24),channels=(s.channels||[]).map(c=>esc(c.channelGoodsId)+': '+esc(c.stock)).join('<br>')||'无';return'<tr><td>'+esc(s.merchant_code)+'<br><span class="muted">SKU '+esc(s.platform_sku_id)+'</span></td><td>'+esc(s.current_stock)+' / '+esc(s.occupied_stock)+' / '+esc(s.unoccupied_stock)+'</td><td class="channels">'+channels+'</td><td>'+(f?esc(f.daily_p50)+' / '+esc(f.daily_p90):'<span class="severity-unknown">待建模</span>')+'</td><td>'+(f?esc(h2.p50)+'/'+esc(h2.p90)+' · '+esc(h6.p50)+'/'+esc(h6.p90)+' · '+esc(h24.p50)+'/'+esc(h24.p90):'—')+'</td><td>'+(f?esc(f.selected_model)+'<br><span class="muted">'+esc(f.confidence)+' · '+esc(f.algorithm_version)+'</span>':'<span class="muted">等待身份映射与首轮预测</span>')+'</td></tr>'}).join('')}function chart(backtest){if(!backtest||backtest.status!=='ready'||!backtest.points?.length)return'<div class="empty">回测数据不足；积累至少 35 个完整自然日后自动生成。</div>';const points=backtest.points,w=920,h=235,pad={l:46,r:14,t:16,b:30},max=Math.max(...points.flatMap(x=>[x.actual,x.p90]),1)*1.08;const xy=(i,v)=>[(pad.l+i*(w-pad.l-pad.r)/Math.max(1,points.length-1)),pad.t+(max-v)*(h-pad.t-pad.b)/max];const path=key=>points.map((x,i)=>{const a=xy(i,Number(x[key]));return(i?'L':'M')+a[0].toFixed(1)+','+a[1].toFixed(1)}).join(' ');const area=points.map((x,i)=>xy(i,Number(x.p90)).join(',')).join(' ')+' '+[...points].reverse().map((x,i)=>xy(points.length-1-i,Number(x.p50)).join(',')).join(' ');const ticks=[0,.5,1].map(v=>{const y=pad.t+(1-v)*(h-pad.t-pad.b);return'<line x1="'+pad.l+'" y1="'+y+'" x2="'+(w-pad.r)+'" y2="'+y+'" stroke="#e8edf3"/><text x="'+(pad.l-8)+'" y="'+(y+4)+'" text-anchor="end" fill="#8792a4" font-size="10">'+Math.round(max*v)+'</text>'}).join('');const labels=[0,Math.floor((points.length-1)/2),points.length-1].map(i=>{const a=xy(i,0);return'<text x="'+a[0]+'" y="'+(h-8)+'" text-anchor="middle" fill="#8792a4" font-size="10">'+esc(points[i].date.slice(5))+'</text>'}).join('');return'<div class="chart-layout"><div class="chart-wrap"><svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="实际销量与 P50 P90 预测回测曲线">'+ticks+'<polygon points="'+area+'" fill="#d7903c18"/><path d="'+path('p90')+'" fill="none" stroke="#d7903c" stroke-width="2" stroke-dasharray="5 4"/><path d="'+path('p50')+'" fill="none" stroke="#3b82c4" stroke-width="2"/><path d="'+path('actual')+'" fill="none" stroke="#142b4a" stroke-width="2.6"/>'+labels+'</svg></div><div class="chart-metrics"><div class="chart-metric"><small>P90 实际覆盖率</small><strong>'+pct(backtest.metrics.p90Coverage)+'</strong></div><div class="chart-metric"><small>P50 Pinball Loss</small><strong>'+esc(backtest.metrics.p50PinballLoss)+'</strong></div><div class="chart-metric"><small>P90 Pinball Loss</small><strong>'+esc(backtest.metrics.p90PinballLoss)+'</strong></div><div class="chart-metric"><small>WAPE</small><strong>'+pct(backtest.metrics.wape)+'</strong></div></div></div><p class="muted">'+esc(backtest.model)+' · '+esc(backtest.windowDays)+' 天窗口 · '+esc((backtest.diagnostics||[]).join(' '))+'</p>'}function readiness(d){const f=d.freshness||{},c=d.coldStart||{},total=Number(c.totalOrderSkus||0),width=v=>total?Math.max(0,Number(v||0)/total*100):0;return'<div class="readiness-row"><span>库存快照</span><strong class="'+(f.latestInventoryAt?'severity-normal':'severity-critical')+'">'+dt(f.latestInventoryAt)+'</strong></div><div class="readiness-row"><span>近期订单</span><strong>'+dt(f.latestOrderAt)+'</strong></div><div class="readiness-row"><span>历史完整日</span><strong>'+dt(f.historicalCompleteThrough)+'</strong></div><div class="readiness-row"><span>提醒通道</span><strong><span class="tag">站内已启用</span> <span class="tag">桌面可启用</span></strong></div><div class="cold-block"><div class="cold-head"><strong>订单 SKU 冷启动分层</strong><span>'+esc(total)+' 个编码</span></div><div class="bar"><i style="width:'+width(c.directModel)+'%"></i><i style="width:'+width(c.hierarchicalFallback)+'%"></i><i style="width:'+width(c.storeBaseline)+'%"></i></div><div class="bar-legend"><span>直接建模 '+esc(c.directModel||0)+'</span><span>分层回退 '+esc(c.hierarchicalFallback||0)+'</span><span>店铺基线 '+esc(c.storeBaseline||0)+'</span><span>已映射 '+esc(c.inventoryMappedSkus||0)+'</span></div></div>'}function renderReminders(items){q('#reminderCount').textContent=items.length;q('#reminders').innerHTML=items.length?items.map(x=>'<div class="reminder '+esc(x.severity)+'"><span class="reminder-icon">'+(x.severity==='critical'?'!':x.severity==='warning'?'△':'i')+'</span><div><h3>'+esc(x.title)+'</h3><p>'+esc(x.detail)+'</p><p class="muted">'+esc(x.source)+'</p></div><span class="reminder-action">'+esc(x.action)+'</span></div>').join(''):'<div class="empty"><strong class="severity-normal">当前无待处理提醒</strong><br>数据新鲜度、风险事件和模型覆盖均在门槛内。</div>'}async function load(){q('#status').className='status-chip';q('#status').innerHTML='<i></i>读取中';const r=await fetch('/api/overview');if(!r.ok)throw Error('数据读取失败');const d=await r.json(),f=d.freshness||{},reminders=d.reminders||[],critical=reminders.filter(x=>x.severity==='critical').length,warning=reminders.filter(x=>x.severity==='warning').length;q('#status').className='status-chip '+(critical?'critical':warning?'warning':'');q('#status').innerHTML='<i></i>'+(critical?'有严重事项':warning?'有待处理预警':'运行正常');q('#metrics').innerHTML=[['严重提醒',critical,critical?'立即处理':'当前无严重风险',critical?'critical':'good'],['预警事项',warning,warning?'需要运营关注':'当前无预警',warning?'warning':'good'],['在库商品 / SKU',d.counts.products+' / '+d.counts.skus,'全部在售范围',''],['预测回测',pct(d.backtest?.metrics?.p90Coverage),'P90 覆盖目标 85%–95%',d.backtest?.status==='ready'?'good':'warning']].map(x=>'<article class="metric '+x[3]+'"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong><span>'+esc(x[2])+'</span></article>').join('');renderReminders(reminders);q('#readiness').innerHTML=readiness(d);q('#backtest').innerHTML=chart(d.backtest);q('#inventoryUpdated').textContent='最近快照 '+dt(f.latestInventoryAt);q('#products').innerHTML=d.products.length?d.products.map(p=>'<article class="product"><div class="product-head"><div><h3>'+esc(p.product_title)+'</h3><span class="muted">商品 '+esc(p.product_id)+' · '+esc(p.dataset_id)+'@'+esc(p.data_version)+'</span></div><div class="product-stock"><strong>总库存 '+esc(p.total_stock)+'</strong><br><span class="muted">映射 '+esc(p.mapping_confidence)+'</span></div></div><table><thead><tr><th>商家编码 / SKU</th><th>当前 / 占用 / 未占用</th><th>渠道库存</th><th>日 P50 / P90</th><th>2h · 6h · 24h</th><th>模型状态</th></tr></thead><tbody>'+skuRows(p)+'</tbody></table></article>').join(''):'<div class="empty">等待首次库存快照。完成浏览器绑定后，商品、SKU、渠道库存与预测将在这里自动展开。</div>';q('#incidents').innerHTML=d.incidents.length?'<table><thead><tr><th>等级</th><th>商品</th><th>依据</th><th>状态</th><th></th></tr></thead><tbody>'+d.incidents.map(i=>{const finding=(i.findings||[])[0]||{};return'<tr><td><span class="severity-pill severity-'+esc(i.severity)+'">'+esc(severityName(i.severity))+'</span></td><td>'+esc(i.product_id)+'<br><span class="muted">旧 200 对照 '+(finding.legacyBelow200?'命中':'未命中')+'</span></td><td>'+esc(finding.reason||'数据质量检查')+'<br><span class="muted">库存均衡策略 v1.0 · '+dt(i.last_seen_at)+'</span></td><td>'+esc(i.state)+'</td><td><button data-review="'+esc(i.incident_id)+'">处理</button></td></tr>'}).join('')+'</tbody></table>':'<div class="empty">尚无库存风险事件。数据质量问题会进入上方运营提醒。</div>';const rules=d.rules||{},ruleLabels={skuChannelCritical:'严重：SKU / 渠道',skuChannelWarning:'预警：SKU / 渠道',reserveCritical:'严重：未占用库存',reserveWarning:'预警：未占用库存',legacyComparison:'旧规则对照'};q('#rules').innerHTML='<div class="rule"><small>当前策略</small><strong>'+esc(rules.policyVersion)+'</strong></div>'+Object.keys(ruleLabels).map(k=>'<div class="rule"><small>'+esc(ruleLabels[k])+'</small><strong>'+esc(rules[k])+'</strong></div>').join('')+'<p class="muted">普通预警连续两次成立后开启；严重风险单次开启；连续两次健康后关闭。</p>';q('#schedules').innerHTML=(d.schedules||[]).length?'<table><thead><tr><th>计划时间</th><th>状态</th><th>节点数</th><th>诊断</th></tr></thead><tbody>'+d.schedules.map(s=>'<tr><td>'+dt(s.scheduled_for)+'</td><td>'+esc(s.status)+'</td><td>'+esc((s.workflow_runs||[]).length)+'</td><td>'+esc((s.diagnostics||[]).join('；')||'无')+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">尚无调度记录；浏览器绑定就绪后启用 30 分钟自动采集。</div>';document.querySelectorAll('[data-review]').forEach(b=>b.addEventListener('click',()=>{q('#incidentId').value=b.dataset.review;q('#review').showModal()}));notifyReminders(reminders)}q('#reload').addEventListener('click',()=>load().catch(show));q('#enableNotify').addEventListener('click',()=>enableNotifications().catch(show));q('#submit').addEventListener('click',async e=>{e.preventDefault();const r=await fetch('/api/reviews',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({incidentId:q('#incidentId').value,decision:q('#decision').value,note:q('#note').value})});if(!r.ok)throw Error('保存失败');q('#review').close();await load()});function show(e){q('#status').className='status-chip critical';q('#status').textContent=e.message||'加载失败'}init().catch(show);`;

void JS;

const MULTI_SHOP_HTML = HTML
  .replace('<p>BPA INVENTORY CONTROL</p><h1>抖店库存风险指挥台</h1>','<p>运营中心</p><h1>库存风险</h1>')
  .replace('<main><section class="metrics"','<main><section class="hero"><div><h1>全店库存风险</h1><p id="heroMeta">正在汇总商品、SKU 与渠道数据</p></div><div class="hero-alert normal" id="heroAlert"><i></i><strong>正在计算风险</strong><span>请稍候</span></div></section><section class="metrics"')
  .replace('<h2>当前风险事件</h2>','<h2>风险处置队列</h2>')
  .replace('<h2>运营提醒</h2>','<h2>店铺状态与运营提醒</h2>')
  .replace('<h2>数据与冷启动</h2>','<h2>数据质量与预测可用性</h2>')
  .replace('<h2>需求预测滚动回测</h2>','<h2>P90 预测回测</h2>');
const MULTI_SHOP_CSS = `${CSS}.shop-picker{display:flex;align-items:center;gap:7px;margin:0;color:var(--muted);font-size:11px;white-space:nowrap}.shop-picker select{width:auto;min-width:180px;margin:0;padding:8px 30px 8px 10px;background:#fff;color:var(--navy);font-weight:650}`;

export async function startInventoryWebServer(input: {
  repository: Pick<InventoryRepository, "overview" | "reviewIncident">;
  shopId?: string;
  shops?: readonly InventoryShopConfig[];
  port?: number;
  listenHost?: string;
  publicHost?: string;
  accessToken?: string;
  now?: () => number;
  sessionSecret?: string;
  recoveryStatusPath?: string;
}): Promise<InventoryWebHandle> {
  const now = input.now ?? Date.now;
  const shops = input.shops ?? (input.shopId
    ? [{ id:input.shopId,name:input.shopId }]
    : []);
  if (shops.length === 0) throw new Error("WEB_SHOPS_REQUIRED");
  const configuredShop = (shopId: string | null): InventoryShopConfig => {
    const selected = shopId
      ? shops.find((shop) => shop.id === shopId)
      : shops[0];
    if (!selected) throw new Error("SHOP_NOT_CONFIGURED");
    return selected;
  };
  const sessionSecret = input.sessionSecret ?? token();
  if (sessionSecret.length < 32) throw new Error("WEB_SESSION_SECRET_TOO_SHORT");
  let launchToken = token();
  let aggregateCache: { readonly at: number; readonly value: Record<string,unknown> } | undefined;
  let aggregateInFlight: Promise<Record<string,unknown>> | undefined;
  const refreshAggregate = (): Promise<Record<string,unknown>> => {
    if (aggregateInFlight) return aggregateInFlight;
    aggregateInFlight = Promise.all(shops.map(async (shop) => ({
      shop,overview:await input.repository.overview(shop.id)
    }))).then((entries) => {
      const value = aggregateOverviews(entries);
      aggregateCache = { at:now(),value };
      return value;
    }).finally(() => { aggregateInFlight = undefined; });
    return aggregateInFlight;
  };
  const allStoreOverview = async (): Promise<Record<string,unknown>> => {
    if (!aggregateCache) return refreshAggregate();
    if (now() - aggregateCache.at > 30_000) void refreshAggregate().catch(() => undefined);
    return aggregateCache.value;
  };
  void refreshAggregate().catch(() => undefined);
  const authenticate = (request: IncomingMessage): { session: Session; cookie: string } | undefined => {
    const encoded = cookies(request)[SESSION_COOKIE];
    const session = encoded ? decodeSession(encoded, sessionSecret) : undefined;
    if (!session || now() - session.lastSeenAt > SESSION_IDLE_MS) return undefined;
    const renewed = { ...session, lastSeenAt: now() };
    return { session: renewed, cookie: encodeSession(renewed, sessionSecret) };
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://inventory.local");
      if (request.method === "GET" && url.pathname === "/") return send(response,200,MULTI_SHOP_HTML,"text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.css") return send(response,200,MULTI_SHOP_CSS,"text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app-v2.css") return send(response,200,DASHBOARD_CLIENT_CSS,"text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return send(response,200,DASHBOARD_CLIENT_JS,"text/javascript; charset=utf-8");
      if (url.pathname === "/api/session" && request.method === "POST") {
        const payload = await body(request);
        const supplied = typeof payload.token === "string" ? payload.token : "";
        const oneTimeMatch = Boolean(launchToken && supplied && safeEqual(supplied,launchToken));
        const sharedMatch = Boolean(input.accessToken && supplied && safeEqual(supplied,input.accessToken));
        if (!oneTimeMatch && !sharedMatch) return json(response,403,{ error: "SESSION_TOKEN_INVALID" });
        if (oneTimeMatch) launchToken = "";
        const session: Session = { id: token(), csrf: token(), lastSeenAt: now() };
        response.setHeader("Set-Cookie",sessionCookie(encodeSession(session,sessionSecret)));
        return json(response,200,{ csrf: session.csrf });
      }
      let auth = authenticate(request);
      if (!auth && url.pathname === "/api/session" && request.method === "GET" && loopback(request)) {
        const session: Session = { id:token(),csrf:token(),lastSeenAt:now() };
        const cookie = encodeSession(session,sessionSecret);
        response.setHeader("Set-Cookie",sessionCookie(cookie));
        return json(response,200,{ csrf:session.csrf });
      }
      if (!auth) return json(response,401,{ error: "SESSION_REQUIRED" });
      response.setHeader("Set-Cookie",sessionCookie(auth.cookie));
      if (url.pathname === "/api/session" && request.method === "GET") return json(response,200,{ csrf: auth.session.csrf });
      if (url.pathname === "/api/overview" && request.method === "GET") {
        const requestedShopId = url.searchParams.get("shopId");
        if (requestedShopId === null || requestedShopId === "all") {
          return json(response,200,{
            ...await allStoreOverview(),
            recovery:await readRecoveryStatus(input.recoveryStatusPath),
            shops:shops.map(({ id,name }) => ({ id,name })),
            selectedShop:{ id:"all",name:"全店" }
          });
        }
        if (!shops.some((shop) => shop.id === requestedShopId)) {
          return json(response,404,{ error:"SHOP_NOT_CONFIGURED" });
        }
        const shop = configuredShop(requestedShopId);
        return json(response,200,{
          ...await input.repository.overview(shop.id),
          recovery:await readRecoveryStatus(input.recoveryStatusPath),
          shops:shops.map(({ id,name }) => ({ id,name })),
          selectedShop:{ id:shop.id,name:shop.name }
        });
      }
      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const csrf = request.headers["x-csrf-token"];
        if (typeof csrf !== "string" || !safeEqual(csrf,auth.session.csrf)) return json(response,403,{ error: "CSRF_INVALID" });
        const payload = await body(request);
        if (typeof payload.incidentId !== "string" || !["valid","false_positive","needs_context"].includes(String(payload.decision)) || typeof payload.note !== "string" || payload.note.length > 4000) return json(response,400,{ error: "REVIEW_INVALID" });
        await input.repository.reviewIncident({ incidentId: payload.incidentId, decision: payload.decision as "valid"|"false_positive"|"needs_context", note: payload.note, actorId: "operations-reviewer" });
        return json(response,200,{ saved: true });
      }
      return json(response,404,{ error: "NOT_FOUND" });
    })().catch((error) => json(response,500,{ error: error instanceof Error ? error.message.slice(0,500) : "INTERNAL_ERROR" }));
  });
  await new Promise<void>((resolve,reject) => {
    server.once("error",reject);
    server.listen(input.port ?? 17650,input.listenHost ?? "127.0.0.1",() => { server.off("error",reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WEB_SERVER_ADDRESS_INVALID");
  const publicHost = input.publicHost ?? input.listenHost ?? "127.0.0.1";
  const urlHost = publicHost.includes(":") && !publicHost.startsWith("[") ? `[${publicHost}]` : publicHost;
  const baseUrl = `http://${urlHost}:${address.port}/`;
  return {
    port: address.port,
    launchUrl: `${baseUrl}#token=${launchToken}`,
    accessUrl: input.accessToken ? `${baseUrl}#token=${input.accessToken}` : undefined,
    close: () => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
