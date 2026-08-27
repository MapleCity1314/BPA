import { describe,expect,it,vi } from "vitest";
import { buildConsolidatedInventoryFeishuReport,buildInventoryFeishuAlert,sendFeishuWebhook } from "./feishu-report.js";

describe("inventory Feishu report",() => {
  it("builds one restrained operational card with traceable ids",() => {
    const report = buildConsolidatedInventoryFeishuReport({
      now:new Date("2026-08-03T01:30:00.000Z"),
      shops:[{ shop:{ id:"10461048",name:"榆园儿食品专营店" },overview:{
        generatedAt:"2026-08-03T01:29:00.000Z",shopId:"10461048",
        counts:{ products:77,skus:168 },
        freshness:{ latestInventoryAt:"2026-08-03T01:20:00.000Z",latestOrderAt:"2026-08-03T01:10:00.000Z" },
        incidents:[{
          state:"open",severity:"critical",product_id:"3720154950123258166",product_title:"测试商品",
          findings:[{ reason:"P90 demand exhausts stock",scope:{ productId:"3720154950123258166",platformSkuId:"sku-1",merchantCode:"code-1",channelGoodsId:"channel-1" } }]
        }]
      } }]
    });
    expect(report.reportKey).toBe("inventory-daily:all:2026-08-03");
    expect(report.counts).toEqual({ critical:1,warning:0,unknown:0,products:77,skus:168 });
    const body = JSON.stringify(report.payload);
    expect(body).toContain("库存风险报告｜全店日报 · 1 家店铺");
    expect(body).toContain("3720154950123258166");
    expect(body).toContain("channel-1");
    expect(body).toContain("按近期销量偏高情况估算，当前库存可能很快用完");
    expect(body).not.toContain("P90");
    expect(body).not.toContain("P90 demand exhausts stock");
    expect(body).not.toContain("webhook");
  });

  it("builds an idempotent daytime alert only for actionable anomalies",() => {
    const input = {
      now:new Date("2026-08-03T04:00:00.000Z"),
      shops:[{ shop:{ id:"shop-1",name:"测试店铺" },overview:{
        generatedAt:"2026-08-03T03:59:00.000Z",shopId:"shop-1",counts:{ products:1,skus:1 },
        incidents:[{ state:"open",severity:"unknown",incident_id:"cold-1" }],
        reminders:[{ id:"recent-orders-stale",severity:"warning",title:"近期订单热数据需要刷新",detail:"超过 60 分钟" }]
      } }]
    } as const;
    const alert = buildInventoryFeishuAlert(input);
    expect(alert?.reportKey).toMatch(/^inventory-alert:2026-08-03:/u);
    expect(JSON.stringify(alert?.payload)).toContain("近期订单热数据需要刷新");
    expect(JSON.stringify(alert?.payload)).not.toContain("cold-1");
    expect(buildInventoryFeishuAlert({ ...input,now:new Date("2026-08-03T04:30:00.000Z") })?.reportKey).toBe(alert?.reportKey);
    expect(buildInventoryFeishuAlert({ ...input,shops:[{ ...input.shops[0],overview:{ ...input.shops[0].overview,reminders:[] } }] })).toBeUndefined();
  });

  it("accepts a Feishu success response without retrying",async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code:0,msg:"success" }),{
      status:200,headers:{ "content-type":"application/json" }
    }));
    await expect(sendFeishuWebhook({
      webhookUrl:"https://open.feishu.cn/example",payload:{ msg_type:"interactive" },fetchImpl
    })).resolves.toEqual({ code:0,message:"success" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
