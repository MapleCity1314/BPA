import { JSDOM } from "jsdom";
import { describe,expect,it } from "vitest";
import { readDoudianRecentOrders } from "./recent-orders.js";

describe("doudian recent orders",() => {
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
