import { JSDOM } from "jsdom";
import { describe,expect,it } from "vitest";
import {
  collectDoudianRecentOrders,
  readDoudianRecentOrders
} from "./recent-orders.js";

describe("doudian recent orders",() => {
  it("reads a bounded API window and emits only demand whitelist fields", async () => {
    const dom = new JSDOM(`<!doctype html><body><header id="fxg-pc-header">
      <span data-testid="shop-name">榆园儿食品专营店</span></header></body>`,{
      url:"https://fxg.jinritemai.com/ffa/morder/order/list"
    });
    dom.window.document.querySelector("[data-testid='shop-name']")!
      .getBoundingClientRect = () => ({
        x:0,y:20,top:20,right:160,bottom:44,left:0,width:160,height:24,
        toJSON:() => ({})
      });
    const fetchMock = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/order/searchlist");
      expect(url.searchParams.get("create_time_start")).toBeTruthy();
      expect(url.searchParams.get("create_time_end")).toBeTruthy();
      return new Response(JSON.stringify({
        code:0,total:1,page:0,size:100,data:[{
          create_time:1785836775,pay_time:1785836776,logistics_time:0,
          order_status_info:{ order_status_text:"待发货" },
          receiver_info:{ post_receiver:"不应返回",post_tel:"13800000000" },
          product_item:[{
            item_order_id:"6928454407824047918",
            product_id:"3700520734771249214",
            merchant_sku_code:"2025090102*10",
            combo_num:2,
            sku_spec:[{ name:"净含量",value:"1kg" }],
            after_sale_info:{ after_sale_text:"-" }
          }]
        }]
      }),{ status:200,headers:{ "content-type":"application/json" } });
    };
    Object.defineProperty(dom.window,"fetch",{ value:fetchMock,configurable:true });
    const result = await collectDoudianRecentOrders(dom.window.document,{
      shopId:"10461048",shopName:"榆园儿食品专营店",lookbackMinutes:90
    },{ deadline:Date.now()+5_000 });
    expect(result).toMatchObject({ status:"complete",formMutations:0,records:[{
      childOrderId:"6928454407824047918",productId:"3700520734771249214",
      merchantCode:"2025090102*10",quantity:2,orderStatus:"待发货",
      specification:"净含量:1kg"
    }] });
    expect(JSON.stringify(result)).not.toContain("13800000000");
    expect(JSON.stringify(result)).not.toContain("不应返回");
  });

  it("collapses identical rows repeated at a live pagination boundary", async () => {
    const dom = new JSDOM(`<!doctype html><body><header id="fxg-pc-header">
      <span data-testid="shop-name">榆园儿食品专营店</span></header></body>`,{
      url:"https://fxg.jinritemai.com/ffa/morder/order/list"
    });
    dom.window.document.querySelector("[data-testid='shop-name']")!
      .getBoundingClientRect = () => ({
        x:0,y:20,top:20,right:160,bottom:44,left:0,width:160,height:24,
        toJSON:() => ({})
      });
    const line = {
      item_order_id:"6928454407824047918",product_id:"3700520734771249214",
      merchant_sku_code:"sku-1",combo_num:1
    };
    Object.defineProperty(dom.window,"fetch",{ value:async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify({
        code:0,total:101,page,size:100,data:page === 0
          ? Array.from({ length:100 },() => ({
              create_time:1785836775,pay_time:1785836776,logistics_time:0,
              order_status_info:{ order_status_text:"待发货" },product_item:[line]
            }))
          : [{ create_time:1785836775,pay_time:1785836776,logistics_time:0,
              order_status_info:{ order_status_text:"待发货" },product_item:[line] }]
      }),{ status:200 });
    },configurable:true });
    const result = await collectDoudianRecentOrders(dom.window.document,{
      shopId:"10461048",shopName:"榆园儿食品专营店",lookbackMinutes:90
    },{ deadline:Date.now()+5_000 });
    expect(result).toMatchObject({ records:[line && {
      childOrderId:"6928454407824047918",merchantCode:"sku-1"
    }] });
    expect(result.quality).toMatchObject({
      diagnostics:expect.arrayContaining([
        "Collapsed 100 identical row(s) repeated across live pagination boundaries."
      ])
    });
  });

  it("returns only demand fields and never exposes customer PII",() => {
    const dom = new JSDOM(`<!doctype html><body><header id="fxg-pc-header">
      <span data-testid="shop-name">榆园儿食品专营店</span></header>
      <table><thead><tr><th>订单信息</th><th>商品信息</th></tr></thead><tbody><tr>
      <td>子订单编号：123456789012345678 商品ID：3784577039315632428
      商家编码：2024103109 商品规格：原味 | 商品数量：2 |
      订单提交时间：2026-08-02 10:00:00 支付完成时间：2026-08-02 10:01:00
      订单状态：待发货 | 售后状态：无</td>
      <td><a href="/ffa/g/create?product_id=3784577039315632428">商品</a></td>
    </tr></tbody></table></body>`,{ url:"https://fxg.jinritemai.com/ffa/morder/order/list" });
    dom.window.document.querySelector("[data-testid='shop-name']")!
      .getBoundingClientRect = () => ({
        x:0,y:20,top:20,right:160,bottom:44,left:0,width:160,height:24,
        toJSON:() => ({})
      });
    const result = readDoudianRecentOrders(dom.window.document,{
      shopId:"10461048",shopName:"榆园儿食品专营店"
    },"2026-08-02T02:05:00.000Z");
    expect(result).toMatchObject({ status:"complete",formMutations:0,records:[{
      childOrderId:"123456789012345678",productId:"3784577039315632428",
      merchantCode:"2024103109",quantity:2,paidAt:"2026-08-02T02:01:00.000Z"
    }] });
    expect(Object.keys((result.records as Record<string, unknown>[])[0]!)).toEqual([
      "childOrderId","productId","merchantCode","specification","quantity",
      "submittedAt","paidAt","orderStatus","aftersalesStatus"
    ]);
  });

  it("refuses to report complete while another order page is available",() => {
    const dom = new JSDOM(`<!doctype html><body><header id="fxg-pc-header">
      <span data-testid="shop-name">榆园儿食品专营店</span></header>
      <table><thead><tr><th>订单信息</th><th>商品信息</th></tr></thead><tbody></tbody></table>
      <div>暂无订单</div><li class="auxo-pagination-next"><button>下一页</button></li>
    </body>`,{ url:"https://fxg.jinritemai.com/ffa/morder/order/list" });
    dom.window.document.querySelector("[data-testid='shop-name']")!
      .getBoundingClientRect = () => ({
        x:0,y:20,top:20,right:160,bottom:44,left:0,width:160,height:24,
        toJSON:() => ({})
      });
    expect(() => readDoudianRecentOrders(dom.window.document,{
      shopId:"10461048",shopName:"榆园儿食品专营店"
    })).toThrow("RECENT_ORDER_LIST_INCOMPLETE");
  });
});
