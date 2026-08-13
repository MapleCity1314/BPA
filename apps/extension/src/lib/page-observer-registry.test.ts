import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { probeObservedPage } from "./page-observer-registry.js";

describe("page observer registry", () => {
  it("authenticates the current Binance shell with a stable local context", async () => {
    const doc = new JSDOM(`
      <body><div id="__APP"><section>
        <div>项目ID: project_1001</div><span>净利润</span><span>25 USDT</span>
        <div><div>展开详情</div></div>
      </section></div></body>
    `).window.document;
    await expect(
      probeObservedPage(
        doc,
        "https://www.binance.com/zh-CN/copy-trading/copy-management"
      )
    ).resolves.toMatchObject({
      observerCapabilityId: "binance.copy-trading.page",
      authentication: {
        state: "authenticated",
        contextRef: expect.stringMatching(/^auth-context-[a-f0-9]{64}$/u)
      },
      observationState: "ready"
    });
  });

  it("authenticates a Doudian product page from shop and shell evidence", async () => {
    const doc = new JSDOM(`
      <body>
        <div class="account-entry"><span>榆园儿食品专营店</span></div>
        <a href="/ffa/w/login/account">账号管理</a>
      </body>
    `).window.document;
    const shop = doc.querySelector("span")!;
    shop.getBoundingClientRect = () => ({
      x: 0, y: 20, top: 20, right: 160, bottom: 44, left: 0,
      width: 160, height: 24, toJSON: () => ({})
    });
    await expect(
      probeObservedPage(doc, "https://fxg.jinritemai.com/ffa/g/list")
    ).resolves.toMatchObject({
      observerCapabilityId: "doudian.page",
      authentication: {
        state: "authenticated",
        contextRef: expect.stringMatching(/^auth-context-[a-f0-9]{64}$/u)
      },
      observationState: "ready"
    });
  });

  it("authenticates a supported Doudian create page from the visible header identity", async () => {
    const doc = new JSDOM(`
      <body><header id="fxg-pc-header">
        <span data-testid="shop-name">榆园儿食品专营店</span>
      </header><main>商品编辑</main></body>
    `).window.document;
    const shop = doc.querySelector("[data-testid='shop-name']")!;
    shop.getBoundingClientRect = () => ({
      x: 0, y: 20, top: 20, right: 160, bottom: 44, left: 0,
      width: 160, height: 24, toJSON: () => ({})
    });
    await expect(
      probeObservedPage(
        doc,
        "https://fxg.jinritemai.com/ffa/g/create?product_id=3818666053253332995"
      )
    ).resolves.toMatchObject({
      authentication: { state: "authenticated" },
      observationState: "ready"
    });
  });

  it("does not authenticate from the Doudian URL without shop evidence", async () => {
    const doc = new JSDOM("<body><div>商品管理</div></body>").window.document;
    await expect(
      probeObservedPage(doc, "https://fxg.jinritemai.com/ffa/g/list")
    ).resolves.toMatchObject({
      authentication: { state: "unknown" },
      observationState: "loading",
      reasonCode: "PAGE_LOADING"
    });
  });

  it("does not mark an empty Buyin dashboard as executable", async () => {
    const doc = new JSDOM("<body><div>加载中</div></body>").window.document;
    await expect(
      probeObservedPage(doc, "https://buyin.jinritemai.com/dashboard")
    ).resolves.toMatchObject({
      observationState: "probing",
      reasonCode: "BUYIN_STRUCTURE_UNCONFIRMED"
    });
  });

  it("marks Buyin ready only after its interactive shell exists", async () => {
    const doc = new JSDOM(
      "<body><main><nav><a href='/dashboard/product/promote-manage'>推商品</a></nav></main></body>"
    ).window.document;
    await expect(
      probeObservedPage(doc, "https://buyin.jinritemai.com/dashboard")
    ).resolves.toMatchObject({ observationState: "ready" });
  });

  it("does not mark an empty Chanmama page as ready", async () => {
    const doc = new JSDOM("<body></body>").window.document;
    await expect(
      probeObservedPage(doc, "https://www.chanmama.com/product/1001")
    ).resolves.toMatchObject({
      observationState: "probing",
      reasonCode: "CHANMAMA_STRUCTURE_UNCONFIRMED"
    });
  });
});
