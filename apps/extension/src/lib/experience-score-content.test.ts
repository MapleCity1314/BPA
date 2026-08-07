import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { executeExperienceScoreStage } from "./experience-score-content.js";

describe("experience-score content stage", () => {
  it("returns a no-score snapshot without mutating forms", () => {
    const dom = new JSDOM(`<!doctype html><body>
      <header id="fxg-pc-header"><div class="headerShopName" data-shop-id="12345678"><span class="shopName">测试食品旗舰店</span></div></header>
      <main>商家体验分 店铺ID：12345678 近30天有效订单数：8 订单达到30单后向您展示体验分</main>
    </body>`, { url: "https://fxg.jinritemai.com/ffa/eco/experience-score" });
    const identity = dom.window.document.querySelector(".shopName")!;
    Object.defineProperty(identity, "getBoundingClientRect", {
      value: () => ({ width: 120, height: 24, top: 20, left: 1200 })
    });
    expect(executeExperienceScoreStage({
      stage: "collect-snapshot",
      expectedShop: {
        id: "12345678",
        name: "测试食品旗舰店",
        status: "active",
        statusText: "正常营业"
      }
    }, dom.window.document, dom.window.location.href)).toMatchObject({
      stage: "collect-snapshot",
      snapshot: { status: "no_score", formMutations: 0 }
    });
  });
});
