import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  collectMarketplaceSearchResults,
  detectMarketplaceRiskSignals
} from "./index.js";

function collect(platform: "DOUYIN" | "TAOBAO" | "JD", url: string, body: string) {
  const document = new JSDOM(`<body>${body}</body>`, { url }).window.document;
  return collectMarketplaceSearchResults(document, {
    platform,
    query: "预包装煎饼",
    maxItems: 10
  }, { observedAt: "2026-08-02T10:00:00.000Z" });
}

describe("marketplace search probe", () => {
  it("extracts a bounded Douyin product card", () => {
    const result = collect(
      "DOUYIN",
      "https://www.douyin.com/search/%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC?type=product",
      `<article><a href="https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?product_id=91001" title="杂粮软煎饼独立包装开袋即食"><img src="https://p.example/douyin.webp" alt="杂粮软煎饼"></a><span>¥29.90</span><span>已售 1.2万件</span><span class="shop">谷物食品旗舰店</span></article>`
    );
    expect(result).toMatchObject({ platform: "DOUYIN", status: "READY" });
    expect(result.items[0]).toMatchObject({
      productId: "91001",
      title: "杂粮软煎饼独立包装开袋即食",
      priceText: "¥29.90",
      salesText: "已售 1.2万件"
    });
  });

  it("extracts Taobao and JD cards with platform identities", () => {
    const taobao = collect(
      "TAOBAO",
      "https://s.taobao.com/search?q=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
      `<div><a href="https://item.taobao.com/item.htm?id=92001" title="东北杂粮煎饼独立包装"><img data-src="//img.example/taobao.jpg"></a><span>￥19.80</span><span>2000人付款</span></div>`
    );
    const jd = collect(
      "JD",
      "https://search.jd.com/Search?keyword=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
      `<li><a href="https://item.jd.com/93001.html" title="全麦软煎饼开袋即食"><img src="https://img.example/jd.jpg"></a><span>¥25.00</span><span>评价 5000</span><span class="shop">京东食品自营店</span></li>`
    );
    expect(taobao.items[0]?.productId).toBe("92001");
    expect(jd.items[0]).toMatchObject({
      productId: "93001",
      shopName: "京东食品自营店"
    });
  });

  it("fails closed when query identity changes", () => {
    const document = new JSDOM("<body></body>", {
      url: "https://search.jd.com/Search?keyword=%E9%9D%A2%E5%8C%85"
    }).window.document;
    expect(() =>
      collectMarketplaceSearchResults(document, {
        platform: "JD",
        query: "预包装煎饼",
        maxItems: 10
      })
    ).toThrow("SEARCH_QUERY_MISMATCH");
  });

  it("returns blocking risk signals instead of bypassing challenges", () => {
    const document = new JSDOM("<body>请完成滑块验证</body>", {
      url: "https://s.taobao.com/search?q=x"
    }).window.document;
    expect(detectMarketplaceRiskSignals(document)).toEqual([
      expect.objectContaining({ code: "CAPTCHA_REQUIRED", severity: "blocking" })
    ]);
  });

  it("accepts zero products only when the platform renders an explicit empty state", () => {
    const result = collect(
      "JD",
      "https://search.jd.com/Search?keyword=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
      "<main><div class='empty'>没有找到相关商品，换个词试试</div></main>"
    );
    expect(result).toMatchObject({ status: "EMPTY_CONFIRMED", items: [] });
  });

  it("fails closed when selectors produce no cards and no explicit empty state", () => {
    expect(() =>
      collect(
        "JD",
        "https://search.jd.com/Search?keyword=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
        "<main><div>页面结构已经变化</div></main>"
      )
    ).toThrow("MARKETPLACE_STRUCTURE_UNCONFIRMED");
  });
});
