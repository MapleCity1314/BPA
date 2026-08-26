import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInventoryWebServer } from "./web-server.js";

const healthyControl = () => ({
  activeCollectionCount:0,
  staleCollectionCount:0,
  oldestStaleStartedAt:null,
  staleAfterMinutes:120
});

describe("inventory review server", () => {
  it("exposes a bounded recovery status without trusting arbitrary fields", async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-recovery-"));
    const recoveryStatusPath = join(directory,"status.json");
    await writeFile(recoveryStatusPath,JSON.stringify({
      state:"auth_required",
      updatedAt:"2026-08-05T05:09:19.041Z",
      shopId:"shop-1",
      shopName:"示例店铺",
      reason:"login required",
      ignored:"must not be exposed"
    }));
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview: vi.fn(async () => ({ counts:{ products:1,skus:1,incidents:0 } })),
      reviewIncident: vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({
      repository,shopId:"shop-1",port:0,recoveryStatusPath
    });
    try {
      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/overview?shopId=shop-1`,
        { headers:{ cookie:cookie! } }
      );
      const body = await response.json() as Record<string,unknown>;
      expect(body.recovery).toEqual({
        state:"auth_required",
        updatedAt:"2026-08-05T05:09:19.041Z",
        shopId:"shop-1",
        shopName:"示例店铺",
        reason:"login required"
      });
    } finally {
      await server.close();
      await rm(directory,{ recursive:true,force:true });
    }
  });

  it("uses a one-time launch token, idle cookie and CSRF boundary", async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview: vi.fn(async () => ({ counts: { products: 0,skus: 0,incidents: 0 } })),
      reviewIncident: vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({ repository,shopId:"10461048",port:0 });
    try {
      const page = await fetch(`http://127.0.0.1:${server.port}/`);
      const pageBody = await page.text();
      expect(pageBody).toContain("库存风险指挥台");
      expect(pageBody).toContain("风险处置队列");
      expect(pageBody.indexOf("风险处置队列")).toBeLessThan(pageBody.indexOf("P90 预测回测"));
      expect(pageBody).toContain("P90 预测回测");
      expect(pageBody).toContain("正式库存周期");
      expect(pageBody).not.toContain("影子");
      const clientScript = await fetch(`http://127.0.0.1:${server.port}/app.js`).then((response) => response.text());
      expect(clientScript).toContain("data-copy-id");
      expect(pageBody).not.toContain('id="shopSelect"');
      expect(clientScript).toContain("selectedShopId='all'");
      expect(clientScript).toContain("incidentTableAllStores");
      expect(() => new Function(clientScript)).not.toThrow();
      const clientStyles = await fetch(`http://127.0.0.1:${server.port}/app-v2.css`).then((response) => response.text());
      expect(clientStyles).toContain(".priority-grid");
      expect(clientStyles).toContain(".sonner-region");
      expect(clientScript).toContain("window.sonner=sonner");
      expect(clientScript).toContain("SESSION_REQUIRED");
      expect(clientScript).toContain("系统将在 5 秒后自动重试");
      expect(clientScript).toContain("scheduleReconnect");
      expect(clientScript).toContain("部分完成");
      expect(clientScript).toContain("未终态前不回显上一轮健康结论");
      expect(clientScript).not.toContain("schedulesHtml");
      expect(clientScript).toContain("dataQualityGroups");
      expect(clientScript).toContain("运行与控制提醒");
      expect(clientScript).toContain("控制记录待核对");
      expect(clientScript).not.toContain("订单数据质量阻断");
      expect(clientScript).toContain("数据待确认");
      expect(clientScript).toContain("影响 '+esc(group.count)+' 个商品");
      expect(clientScript).toContain("item.notificationEligible!==false");
      const launch = new URL(server.launchUrl);
      const launchToken = new URLSearchParams(launch.hash.slice(1)).get("token");
      expect(launch.hostname).toBe("127.0.0.1");
      expect(launchToken).toBeTruthy();
      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },
        body:JSON.stringify({ token:launchToken })
      });
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      expect(session.headers.get("set-cookie")).toContain("HttpOnly");
      expect(session.headers.get("set-cookie")).toContain("SameSite=Strict");
      const { csrf } = await session.json() as { csrf: string };
      const reused = await fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },
        body:JSON.stringify({ token:launchToken })
      });
      expect(reused.status).toBe(403);
      const overview = await fetch(`http://127.0.0.1:${server.port}/api/overview`,{
        headers:{ cookie:cookie! }
      });
      expect(overview.status).toBe(200);
      expect(overview.headers.get("cache-control")).toBe("no-store");
      const rejected = await fetch(`http://127.0.0.1:${server.port}/api/reviews`,{
        method:"POST",headers:{ cookie:cookie!,"content-type":"application/json" },
        body:JSON.stringify({ incidentId:"incident-1",decision:"valid",note:"" })
      });
      expect(rejected.status).toBe(403);
      const accepted = await fetch(`http://127.0.0.1:${server.port}/api/reviews`,{
        method:"POST",headers:{ cookie:cookie!,"content-type":"application/json","x-csrf-token":csrf },
        body:JSON.stringify({ incidentId:"incident-1",decision:"valid",note:"运营确认" })
      });
      expect(accepted.status).toBe(200);
      expect(repository.reviewIncident).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("keeps a signed rolling session across a service restart and enforces idle expiry", async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview: vi.fn(async () => ({ counts: { products: 77,skus: 168,incidents: 0 } })),
      reviewIncident: vi.fn(async () => undefined)
    };
    const sessionSecret = "persistent-test-secret-that-is-long-enough-1234";
    let currentTime = Date.parse("2026-08-03T05:00:00.000Z");
    const first = await startInventoryWebServer({
      repository,shopId:"10461048",port:0,sessionSecret,now:() => currentTime
    });
    const launchToken = new URLSearchParams(new URL(first.launchUrl).hash.slice(1)).get("token");
    const login = await fetch(`http://127.0.0.1:${first.port}/api/session`,{
      method:"POST",headers:{ "content-type":"application/json" },
      body:JSON.stringify({ token:launchToken })
    });
    const cookie = login.headers.get("set-cookie")?.split(";",1)[0];
    await first.close();

    currentTime += 10 * 60 * 1000;
    const restarted = await startInventoryWebServer({
      repository,shopId:"10461048",port:0,sessionSecret,now:() => currentTime
    });
    try {
      const resumed = await fetch(`http://127.0.0.1:${restarted.port}/api/session`,{
        headers:{ cookie:cookie! }
      });
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get("set-cookie")).toContain("Max-Age=1800");

      const renewedCookie = resumed.headers.get("set-cookie")?.split(";",1)[0];
      currentTime += 31 * 60 * 1000;
      const expired = await fetch(`http://127.0.0.1:${restarted.port}/api/overview`,{
        headers:{ cookie:renewedCookie! }
      });
      expect(expired.status).toBe(401);
      await expect(expired.json()).resolves.toEqual({ error:"SESSION_REQUIRED" });
    } finally {
      await restarted.close();
    }
  });

  it("isolates overview queries to the selected configured shop", async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview: vi.fn(async (shopId: string) => ({
        shopId,
        counts:{ products:0,skus:0,incidents:0 },
        schedules:[{ status:"succeeded",scheduled_for:"2026-08-09T07:00:00.000Z" }]
      })),
      reviewIncident: vi.fn(async () => undefined)
    };
      const server = await startInventoryWebServer({
        repository,
        runtimeProductionCycleSummary:vi.fn(async () => ({
          state:"in-progress" as const,
          workflowVersion:"1.0.10" as const,
          scheduledAt:"2026-08-10T07:00:00.000Z",
          observedAt:null,
          reasonCode:null,
          coverage:null,
          inventory:null,
          risk:null,
          attentionRequired:false
        })),
      shops:[
        { id:"shop-1",name:"一号店",browserInstanceId:"browser-1" },
        { id:"shop-2",name:"二号店",browserInstanceId:"browser-2" }
      ],
      port:0
    });
    try {
      const launchToken = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("token");
      const login = await fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },
        body:JSON.stringify({ token:launchToken })
      });
      const cookie = login.headers.get("set-cookie")?.split(";",1)[0];
      const selected = await fetch(`http://127.0.0.1:${server.port}/api/overview?shopId=shop-2`,{
        headers:{ cookie:cookie! }
      });
      expect(selected.status).toBe(200);
      const selectedBody = await selected.json() as Record<string,unknown>;
      expect(selectedBody).toMatchObject({
        shopId:"shop-2",
        selectedShop:{ id:"shop-2",name:"二号店" },
        shops:[{ id:"shop-1",name:"一号店" },{ id:"shop-2",name:"二号店" }],
        productionCycle:{ state:"in-progress",scheduledAt:"2026-08-10T07:00:00.000Z" }
      });
      expect(selectedBody).not.toHaveProperty("schedules");
      expect(repository.overview).toHaveBeenLastCalledWith("shop-2");
      const rejected = await fetch(`http://127.0.0.1:${server.port}/api/overview?shopId=shop-3`,{
        headers:{ cookie:cookie! }
      });
      expect(rejected.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("supports a reusable LAN bootstrap token while retaining isolated sessions", async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview: vi.fn(async () => ({ counts:{ products:0,skus:0,incidents:0 } })),
      reviewIncident: vi.fn(async () => undefined)
    };
    const accessToken = "shared-lan-access-token-that-is-long-enough-1234";
    const server = await startInventoryWebServer({
      repository,shopId:"10461048",port:0,accessToken,publicHost:"192.168.3.135"
    });
    try {
      expect(server.accessUrl).toBe(`http://192.168.3.135:${server.port}/#token=${accessToken}`);
      const login = async (): Promise<Response> => fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ token:accessToken })
      });
      const first = await login();
      const second = await login();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers.get("set-cookie")).not.toBe(second.headers.get("set-cookie"));
    } finally {
      await server.close();
    }
  });

  it("automatically restores a loopback review session without exposing the shared token",async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview:vi.fn(async () => ({ counts:{ products:0,skus:0,incidents:0 } })),
      reviewIncident:vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({ repository,shopId:"shop-1",port:0 });
    try {
      const restored = await fetch(`http://127.0.0.1:${server.port}/api/session`);
      expect(restored.status).toBe(200);
      expect(restored.headers.get("set-cookie")).toContain("HttpOnly");
      await expect(restored.json()).resolves.toEqual({ csrf:expect.any(String) });
    } finally {
      await server.close();
    }
  });

  it("returns an all-store command-center overview by default",async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => ({
        activeCollectionCount:0,
        staleCollectionCount:1,
        oldestStaleStartedAt:"2026-08-07T15:23:46.407Z",
        staleAfterMinutes:120
      })),
      overview:vi.fn(async (shopId: string) => ({
        shopId,counts:{ products:shopId === "shop-1" ? 2 : 3,skus:shopId === "shop-1" ? 4 : 5,freshProducts:1 },
        freshness:{ latestInventoryAt:"2026-08-04T06:00:00.000Z",latestOrderAt:"2026-08-04T06:10:00.000Z" },
        products:[{ product_id:`product-${shopId}`,product_title:`商品-${shopId}`,skus:[] }],
        incidents:[{ incident_id:`incident-${shopId}`,product_id:`product-${shopId}`,state:"open",severity:"warning" }],
        reminders:[],schedules:[],coldStart:{},backtest:{ status:"insufficient_data",points:[] },rules:{}
      })),
      reviewIncident:vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({
      repository,port:0,shops:[
        { id:"shop-1",name:"一号店",browserInstanceId:"browser-1" },
        { id:"shop-2",name:"二号店",browserInstanceId:"browser-2" }
      ]
    });
    try {
      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      const overview = await fetch(`http://127.0.0.1:${server.port}/api/overview`,{ headers:{ cookie:cookie! } });
      expect(overview.status).toBe(200);
      await expect(overview.json()).resolves.toMatchObject({
        shopId:"all",selectedShop:{ id:"all",name:"全店" },counts:{ products:5,skus:9 },
        products:[{ shop_id:"shop-1",shop_name:"一号店" },{ shop_id:"shop-2",shop_name:"二号店" }],
        incidents:[
          { shop_id:"shop-1",shop_name:"一号店" },
          { shop_id:"shop-2",shop_name:"二号店" }
        ],
        controlHealth:{ staleCollectionCount:1 },
        reminders:[{ id:"collection-control-stale",severity:"critical",title:"采集控制记录未收口" }],
        shopStatuses:[{ id:"shop-1",name:"一号店" },{ id:"shop-2",name:"二号店" }]
      });
      expect(repository.overview).toHaveBeenCalledTimes(2);
      expect(repository.collectionControlHealth).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("reads runtime attention only after authentication and appends safe reminders",async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview:vi.fn(async () => ({
        counts:{ products:1,skus:1,incidents:0 },
        reminders:[],products:[],incidents:[],schedules:[],coldStart:{},
        backtest:{ status:"insufficient_data",points:[] },rules:{}
      })),
      reviewIncident:vi.fn(async () => undefined)
    };
    const runtimeAttentionReminders = vi.fn(async () => [{
      id:"bpa-trigger-attention:0123456789abcdef01234567" as const,
      severity:"warning" as const,
      title:"库存采集错过计划时间",
      detail:"该轮采集未在计划窗口内开始。",
      source:"BPA 触发调度",
      action:"检查共享浏览器和调度状态。",
      notificationEligible:false
    }]);
    const server = await startInventoryWebServer({
      repository,shopId:"shop-1",port:0,runtimeAttentionReminders
    });
    try {
      const unauthenticated = await fetch(
        `http://127.0.0.1:${server.port}/api/overview`,
        { headers:{ "x-forwarded-for":"192.0.3.1" } }
      );
      expect(unauthenticated.status).toBe(401);
      expect(runtimeAttentionReminders).not.toHaveBeenCalled();

      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      const overview = await fetch(
        `http://127.0.0.1:${server.port}/api/overview`,
        { headers:{ cookie:cookie! } }
      );
      expect(overview.status).toBe(200);
      await expect(overview.json()).resolves.toMatchObject({
        reminders:[{
          id:"bpa-trigger-attention:0123456789abcdef01234567",
          title:"库存采集错过计划时间",
          notificationEligible:false
        }]
      });
      expect(runtimeAttentionReminders).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("keeps inventory readable and reports a safe warning when Core attention is unavailable",async () => {
    const repository = {
      collectionControlHealth:vi.fn(async () => healthyControl()),
      overview:vi.fn(async () => ({
        counts:{ products:3,skus:7,incidents:0 },
        reminders:[],products:[],incidents:[],schedules:[],coldStart:{},
        backtest:{ status:"insufficient_data",points:[] },rules:{}
      })),
      reviewIncident:vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({
      repository,shopId:"shop-1",port:0,
      runtimeAttentionReminders:vi.fn(async () => {
        throw new Error("socket /private/internal/core.sock unavailable");
      }),
      runtimeProductionCycleSummary:vi.fn(async () => {
        throw new Error("socket /private/internal/core.sock unavailable");
      })
    });
    try {
      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/overview`,
        { headers:{ cookie:cookie! } }
      );
      expect(response.status).toBe(200);
      const overview = await response.json() as Record<string,unknown>;
      expect(overview.counts).toEqual(expect.objectContaining({ products:3,skus:7 }));
      expect(overview.reminders).toEqual(expect.arrayContaining([expect.objectContaining({
        id:"bpa-trigger-attention:unavailable",
        title:"BPA 触发状态暂不可读",
        notificationEligible:false
      })]));
      expect(overview.productionCycle).toEqual({
        state:"unavailable",
        reasonCode:"CORE_UNAVAILABLE"
      });
      expect(JSON.stringify(overview)).not.toContain("/private/internal/core.sock");
    } finally {
      await server.close();
    }
  });
});
