import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { readDoudianExperienceSnapshot } from "./experience-score.js";

function page(content: string): Document {
  const dom = new JSDOM(`<!doctype html><body>
    <header id="fxg-pc-header">
      <div class="headerShopName" data-shop-id="12345678">
        <span class="shopName">测试食品旗舰店</span>
      </div>
    </header>
    <main><h1>商家体验分</h1>${content}</main>
  </body>`, {
    url: "https://fxg.jinritemai.com/ffa/eco/experience-score"
  });
  const element = dom.window.document.querySelector(".shopName")!;
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ width: 120, height: 24, top: 20, left: 1200 })
  });
  return dom.window.document;
}

describe("Doudian experience-score adapter", () => {
  it("normalizes a complete three-dimension snapshot", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div>考核行业：方便食品</div>
      <div>近30天有效订单数：1,234</div>
      <div>更新于 2026/08/07 12:34:56</div>
      <div data-bpa-label="我的体验分">我的体验分 96.5分</div>
      <div data-bpa-label="商品体验得分">商品体验得分 98分</div>
      <div data-bpa-label="商品综合评分">商品综合评分 4.8分 得分98分</div>
      <div data-bpa-label="物流体验得分">物流体验得分 94分</div>
      <div data-bpa-label="揽收时长平均">揽收时长平均 3.2小时 得分94分 权重40%</div>
      <div data-bpa-label="服务体验得分">服务体验得分 97分</div>
      <div data-bpa-label="飞鸽会话不满意率">飞鸽会话不满意率 1.2% 得分97分 12/1000</div>
    `);
    const snapshot = readDoudianExperienceSnapshot(
      doc,
      doc.defaultView!.location.href,
      { id: "12345678", name: "测试食品旗舰店" },
      new Date("2026-08-07T05:00:00.000Z")
    );
    expect(snapshot).toMatchObject({
      status: "complete",
      shop: { id: "12345678", name: "测试食品旗舰店" },
      summary: { totalScore: 96.5, orders30d: 1234 },
      dimensions: [
        { key: "goods", score: 98 },
        { key: "logistics", score: 94 },
        { key: "service", score: 97 }
      ],
      formMutations: 0
    });
    expect(snapshot.dimensions[1]!.metrics[0]).toMatchObject({
      label: "揽收时长平均",
      unit: "小时",
      value: 3.2,
      score: 94,
      weight: 40
    });
    expect(snapshot.dimensions[0]!.metrics[0]).toMatchObject({
      label: "商品综合评分",
      unit: "分",
      value: 4.8,
      score: 98
    });
  });

  it("keeps low-order no-score separate from collection failure", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div>近30天有效订单数：12</div>
      <div>参与分数计算的订单达到30单后向您展示体验分</div>
    `);
    expect(
      readDoudianExperienceSnapshot(doc, doc.defaultView!.location.href, {
        id: "12345678",
        name: "测试食品旗舰店"
      })
    ).toMatchObject({
      status: "no_score",
      summary: { totalScore: null, orders30d: 12 },
      diagnostics: ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"]
    });
  });

  it("fails closed on shop mismatch and incomplete dimensions", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div data-bpa-label="我的体验分">我的体验分 96分</div>
    `);
    expect(() =>
      readDoudianExperienceSnapshot(doc, doc.defaultView!.location.href, {
        id: "87654321",
        name: "测试食品旗舰店"
      })
    ).toThrow("SHOP_IDENTITY_MISMATCH");
    expect(() =>
      readDoudianExperienceSnapshot(doc, doc.defaultView!.location.href, {
        id: "12345678",
        name: "测试食品旗舰店"
      })
    ).toThrow("EXPERIENCE_DIMENSION_INCOMPLETE:goods");
  });
});
