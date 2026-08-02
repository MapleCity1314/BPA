import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { InventoryRepository } from "./repository.js";

const SESSION_COOKIE = "bpa_inventory_session";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const BODY_LIMIT = 64 * 1024;

interface Session {
  csrf: string;
  lastSeenAt: number;
}

export interface InventoryWebHandle {
  readonly launchUrl: string;
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

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BPA 库存影子评审</title><link rel="stylesheet" href="/app.css"></head><body><header><div><p>BPA · 14 天影子运行</p><h1>抖店库存风险评审</h1></div><span id="status">连接中</span></header><main><section class="metrics" id="metrics"></section><section><h2>当前规则与旧规则对照</h2><div id="rules"></div></section><section><div class="section-title"><h2>风险与数据质量事件</h2><button id="reload">刷新</button></div><div id="incidents"></div></section><section><h2>商品、SKU、渠道及预测</h2><div id="products"></div></section><section><h2>最近调度</h2><div id="schedules"></div></section></main><dialog id="review"><form method="dialog"><h3>记录人工判断</h3><input id="incidentId" type="hidden"><label>结论<select id="decision"><option value="valid">有效</option><option value="false_positive">误报</option><option value="needs_context">信息不足</option></select></label><label>备注<textarea id="note" maxlength="4000"></textarea></label><menu><button value="cancel">取消</button><button id="submit" value="default">保存</button></menu></form></dialog><script src="/app.js"></script></body></html>`;

const CSS = `:root{font-family:Inter,"PingFang SC",sans-serif;color:#172033;background:#f4f6fa}*{box-sizing:border-box}body{margin:0}header{display:flex;justify-content:space-between;align-items:center;padding:28px 5vw;background:#172033;color:white}header p{margin:0;color:#8dd8c5;font-size:13px;letter-spacing:.12em}h1{margin:6px 0 0;font-size:28px}header span{padding:8px 12px;border-radius:18px;background:#304057}main{max-width:1440px;margin:24px auto;padding:0 24px 60px}.metrics,.rule-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card,table,.product{background:white;border:1px solid #e2e7f0;border-radius:12px;box-shadow:0 8px 24px #1720330d}.card{padding:18px}.card small{color:#68738a}.card strong{display:block;margin-top:8px;font-size:20px}.section-title,.product-head{display:flex;align-items:center;justify-content:space-between;gap:12px}section{margin-top:26px}button{border:0;border-radius:8px;background:#236d5b;color:white;padding:9px 14px;cursor:pointer}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #edf0f5;font-size:13px;vertical-align:top}th{background:#f8fafc;color:#58647b}.severity-critical{color:#b42318;font-weight:700}.severity-warning{color:#b54708;font-weight:700}.severity-unknown{color:#475467;font-weight:700}.severity-normal{color:#16794b;font-weight:700}.muted{color:#7c879c;font-size:12px}.empty{padding:26px;background:white;border-radius:12px;color:#68738a}.product{padding:16px;margin:12px 0}.product h3{margin:0 0 4px}.product table{margin-top:14px;box-shadow:none}.channels{max-width:300px;line-height:1.7}.rule-grid .card{font-size:13px}.rule-grid strong{font-size:15px}dialog{border:0;border-radius:14px;min-width:420px;padding:24px}label{display:block;margin:14px 0}select,textarea{display:block;width:100%;margin-top:6px;padding:10px}textarea{min-height:100px}menu{display:flex;justify-content:flex-end;gap:10px;padding:0}@media(max-width:900px){.metrics,.rule-grid{grid-template-columns:1fr 1fr}main{padding:0 12px}table{display:block;overflow:auto}}`;

const JS = `let csrf='';const q=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const dt=v=>v?new Date(v).toLocaleString():'无数据';const horizon=(f,h)=>((f?.horizons||[]).find(x=>x.hours===h)||{});async function init(){const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token){const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});history.replaceState(null,'',location.pathname);if(!r.ok)throw Error('会话初始化失败');csrf=(await r.json()).csrf}else{const r=await fetch('/api/session');if(!r.ok)throw Error('请使用服务启动时生成的一次性地址');csrf=(await r.json()).csrf}await load()}function skuRows(p){return (p.skus||[]).map(s=>{const f=s.forecast,h2=horizon(f,2),h6=horizon(f,6),h24=horizon(f,24),channels=(s.channels||[]).map(c=>esc(c.channelGoodsId)+': '+esc(c.stock)).join('<br>')||'无';return '<tr><td>'+esc(s.merchant_code)+'<br><span class="muted">SKU '+esc(s.platform_sku_id)+'</span></td><td>'+esc(s.current_stock)+' / '+esc(s.occupied_stock)+' / '+esc(s.unoccupied_stock)+'</td><td class="channels">'+channels+'</td><td>'+(f?esc(f.daily_p50)+' / '+esc(f.daily_p90):'unknown')+'</td><td>'+(f?esc(h2.p50)+'/'+esc(h2.p90)+' · '+esc(h6.p50)+'/'+esc(h6.p90)+' · '+esc(h24.p50)+'/'+esc(h24.p90):'unknown')+'</td><td>'+(f?esc(f.selected_model)+'<br><span class="muted">'+esc(f.algorithm_version)+'<br>'+esc(f.source_dataset_id)+'@'+esc(f.source_data_version)+'</span>':'<span class="severity-unknown">数据不足</span>')+'</td></tr>'}).join('')}async function load(){q('#status').textContent='读取中';const r=await fetch('/api/overview');if(!r.ok)throw Error('评审数据读取失败');const d=await r.json();q('#status').textContent='影子运行 · 不发通知 · 不改库存';const f=d.freshness||{};q('#metrics').innerHTML=[['商品',d.counts.products],['SKU',d.counts.skus],['事件',d.counts.incidents],['库存 / 订单新鲜度',dt(f.latestInventoryAt)+' / '+dt(f.latestOrderAt)]].map(x=>'<article class="card"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></article>').join('');q('#rules').innerHTML='<div class="rule-grid">'+Object.entries(d.rules||{}).filter(x=>x[0]!=='policyVersion').map(x=>'<article class="card"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></article>').join('')+'</div><p class="muted">策略 '+esc(d.rules?.policyVersion)+'；渠道不足 3 天或 80% 覆盖时只显示 unknown。</p>';q('#incidents').innerHTML=d.incidents.length?'<table><thead><tr><th>等级</th><th>商品 / 范围</th><th>依据</th><th>血缘</th><th>状态</th><th></th></tr></thead><tbody>'+d.incidents.map(i=>{const finding=(i.findings||[])[0]||{};return '<tr><td class="severity-'+esc(i.severity)+'">'+esc(i.severity)+'</td><td>'+esc(i.product_id)+'<br><span class="muted">'+esc(finding.kind)+' · 旧200='+esc(finding.legacyBelow200)+'</span></td><td>'+esc(finding.reason)+'</td><td><span class="muted">'+esc(i.policy_version)+'<br>'+esc(i.dataset_id)+'@'+esc(i.data_version)+'<br>'+esc(i.source_digest)+'</span></td><td>'+esc(i.state)+'<br><span class="muted">'+dt(i.last_seen_at)+'</span></td><td><button data-review="'+esc(i.incident_id)+'">评审</button></td></tr>'}).join('')+'</tbody></table>':'<div class="empty">尚无风险事件；固定 200 不会单独触发事件。</div>';q('#products').innerHTML=d.products.length?d.products.map(p=>'<article class="product"><div class="product-head"><div><h3>'+esc(p.product_title)+'</h3><span class="muted">商品 '+esc(p.product_id)+' · 快照 '+esc(p.snapshot_id)+' · '+esc(p.dataset_id)+'@'+esc(p.data_version)+'</span></div><div><strong>总库存 '+esc(p.total_stock)+'</strong><br><span class="muted">'+dt(p.observed_at)+' · 映射 '+esc(p.mapping_confidence)+'</span></div></div><table><thead><tr><th>商家编码 / SKU</th><th>当前 / 占用 / 未占用</th><th>渠道商品库存</th><th>日 P50 / P90</th><th>2h · 6h · 24h P50/P90</th><th>模型与数据版本</th></tr></thead><tbody>'+skuRows(p)+'</tbody></table></article>').join(''):'<div class="empty">等待首次库存快照。</div>';q('#schedules').innerHTML=(d.schedules||[]).length?'<table><thead><tr><th>计划时间</th><th>状态</th><th>工作流</th><th>诊断</th></tr></thead><tbody>'+d.schedules.map(s=>'<tr><td>'+dt(s.scheduled_for)+'</td><td>'+esc(s.status)+'</td><td>'+esc((s.workflow_runs||[]).join(', '))+'</td><td>'+esc((s.diagnostics||[]).join('；'))+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">尚无调度记录。</div>';document.querySelectorAll('[data-review]').forEach(b=>b.addEventListener('click',()=>{q('#incidentId').value=b.dataset.review;q('#review').showModal()}))}q('#reload').addEventListener('click',()=>load().catch(show));q('#submit').addEventListener('click',async e=>{e.preventDefault();const r=await fetch('/api/reviews',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({incidentId:q('#incidentId').value,decision:q('#decision').value,note:q('#note').value})});if(!r.ok)throw Error('保存失败');q('#review').close();await load()});function show(e){q('#status').textContent=e.message||'加载失败'}init().catch(show);`;

export async function startInventoryWebServer(input: {
  repository: Pick<InventoryRepository, "overview" | "reviewIncident">;
  shopId: string;
  port?: number;
  now?: () => number;
}): Promise<InventoryWebHandle> {
  const now = input.now ?? Date.now;
  let launchToken = token();
  const sessions = new Map<string, Session>();
  const authenticate = (request: IncomingMessage): { id: string; session: Session } | undefined => {
    const id = cookies(request)[SESSION_COOKIE];
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session || now() - session.lastSeenAt > SESSION_IDLE_MS) {
      if (id) sessions.delete(id);
      return undefined;
    }
    session.lastSeenAt = now();
    return { id,session };
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return send(response,200,HTML,"text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.css") return send(response,200,CSS,"text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return send(response,200,JS,"text/javascript; charset=utf-8");
      if (url.pathname === "/api/session" && request.method === "POST") {
        const payload = await body(request);
        if (!launchToken || typeof payload.token !== "string" || !safeEqual(payload.token,launchToken)) return json(response,403,{ error: "SESSION_TOKEN_INVALID" });
        launchToken = "";
        const sessionId = token();
        const session: Session = { csrf: token(), lastSeenAt: now() };
        sessions.set(sessionId,session);
        response.setHeader("Set-Cookie",`${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
        return json(response,200,{ csrf: session.csrf });
      }
      const auth = authenticate(request);
      if (!auth) return json(response,401,{ error: "SESSION_REQUIRED" });
      if (url.pathname === "/api/session" && request.method === "GET") return json(response,200,{ csrf: auth.session.csrf });
      if (url.pathname === "/api/overview" && request.method === "GET") return json(response,200,await input.repository.overview(input.shopId));
      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const csrf = request.headers["x-csrf-token"];
        if (typeof csrf !== "string" || !safeEqual(csrf,auth.session.csrf)) return json(response,403,{ error: "CSRF_INVALID" });
        const payload = await body(request);
        if (typeof payload.incidentId !== "string" || !["valid","false_positive","needs_context"].includes(String(payload.decision)) || typeof payload.note !== "string" || payload.note.length > 4000) return json(response,400,{ error: "REVIEW_INVALID" });
        await input.repository.reviewIncident({ incidentId: payload.incidentId, decision: payload.decision as "valid"|"false_positive"|"needs_context", note: payload.note, actorId: "shadow-reviewer" });
        return json(response,200,{ saved: true });
      }
      return json(response,404,{ error: "NOT_FOUND" });
    })().catch((error) => json(response,500,{ error: error instanceof Error ? error.message.slice(0,500) : "INTERNAL_ERROR" }));
  });
  await new Promise<void>((resolve,reject) => {
    server.once("error",reject);
    server.listen(input.port ?? 17650,"127.0.0.1",() => { server.off("error",reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WEB_SERVER_ADDRESS_INVALID");
  return {
    port: address.port,
    launchUrl: `http://127.0.0.1:${address.port}/#token=${launchToken}`,
    close: () => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
