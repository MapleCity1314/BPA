import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { executeAllianceRetiredStage } from "./alliance-retired-content.js";

function doc(body: string): Document {
  return new JSDOM(`<body>${body}</body>`).window.document;
}

describe("alliance retired-products content stages", () => {
  it("discovers shops only from a confirmed Doudian list page", async () => {
    const document = doc(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div role="dialog">切换组织/店铺
        <button aria-label="Close"></button>
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
      </div>
    `);
    const close = vi.spyOn(
      document.querySelector<HTMLElement>("button")!,
      "click"
    );
    await expect(
      executeAllianceRetiredStage(
        { stage: "discover-shops" },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).resolves.toMatchObject({
      stage: "discover-shops",
      currentShopName: "甲食品旗舰店",
      shops: [{ id: "10001", name: "甲食品旗舰店" }]
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("continues discovery when the authenticated header classes change", async () => {
    const document = doc(`
      <div class="top-navigation">
        <span>精选联盟</span>
        <div class="account-entry"><span>榆园儿食品专营店</span></div>
      </div>
      <a href="/ffa/w/login/account">账号管理</a>
      <div role="dialog">切换组织/店铺
        <button aria-label="Close"></button>
        <div class="roleItem"><span class="introName">榆园儿食品专营店</span>店铺ID 10001 正常营业</div>
      </div>
    `);
    await expect(
      executeAllianceRetiredStage(
        { stage: "discover-shops" },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).resolves.toMatchObject({
      stage: "discover-shops",
      currentShopName: "榆园儿食品专营店",
      shops: [{ id: "10001", name: "榆园儿食品专营店" }]
    });
  });

  it("discovers shops across a virtualized switcher", async () => {
    const document = doc(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
      </div>
    `);
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    Object.defineProperties(dialog, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 }
    });
    dialog.addEventListener("scroll", () => {
      if (dialog.scrollTop < 1) return;
      dialog.querySelector(".roleItem")!.outerHTML = `
        <div class="roleItem"><span class="introName">乙食品专营店</span>店铺ID 10002 正常营业</div>
      `;
    });
    await expect(
      executeAllianceRetiredStage(
        { stage: "discover-shops" },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).resolves.toMatchObject({
      shops: [
        { id: "10001", name: "甲食品旗舰店" },
        { id: "10002", name: "乙食品专营店" }
      ]
    });
  });

  it("does not silently stop after eight virtualized shop pages", async () => {
    const document = doc(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">店铺0食品店</span></div>
      </div>
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">店铺0食品店</span>店铺ID 10000 正常营业</div>
      </div>
    `);
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    Object.defineProperties(dialog, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 3000 }
    });
    dialog.addEventListener("scroll", () => {
      const index = Math.floor(dialog.scrollTop / 300);
      dialog.querySelector(".roleItem")!.outerHTML = `
        <div class="roleItem"><span class="introName">店铺${index}食品店</span>店铺ID ${10000 + index} 正常营业</div>
      `;
    });
    const result = await executeAllianceRetiredStage(
      { stage: "discover-shops" },
      document,
      "https://fxg.jinritemai.com/ffa/g/list"
    );
    expect(result).toMatchObject({ stage: "discover-shops" });
    if (result.stage !== "discover-shops") throw new Error("wrong stage");
    expect(result.shops).toHaveLength(10);
    expect(result.shops.at(-1)).toMatchObject({
      id: "10009",
      name: "店铺9食品店"
    });
  });

  it("rejects two distinct shop IDs with the same visible name", async () => {
    const document = doc(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">同名食品店</span></div>
      </div>
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10002 正常营业</div>
      </div>
    `);
    await expect(
      executeAllianceRetiredStage(
        { stage: "discover-shops" },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).rejects.toThrow("SHOP_IDENTITY_AMBIGUOUS");
  });

  it("filters the switcher and confirms the selected shop", async () => {
    const document = doc(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div role="dialog">切换组织/店铺
        <input placeholder="搜索店铺" />
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
      </div>
    `);
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => {
      const card = document.querySelector<HTMLElement>(".roleItem")!;
      card.innerHTML = `<span class="introName">${input.value}</span>店铺ID 10002 正常营业`;
      card.addEventListener("click", () => {
        document.querySelector<HTMLElement>(".userName")!.textContent =
          input.value;
      });
    });
    await expect(
      executeAllianceRetiredStage(
        {
          stage: "switch-shop",
          shop: {
            id: "10002",
            name: "乙食品专营店",
            status: "active",
            statusText: "正常营业"
          }
        },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).resolves.toEqual({
      stage: "switch-shop",
      shopName: "乙食品专营店"
    });
  });

  it("collects only when Buyin shop identity matches", async () => {
    const document = doc(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span>店铺ID 10001</header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody><tr><td colspan="5">无搜索结果</td></tr></tbody>
      </table>
    `);
    await expect(
      executeAllianceRetiredStage(
        {
          stage: "collect-retired-products",
          expectedShop: {
            id: "10001",
            name: "甲食品旗舰店",
            status: "active",
            statusText: "正常营业"
          }
        },
        document,
        "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
      )
    ).resolves.toMatchObject({
      page: { shop: { name: "甲食品旗舰店" }, empty: true }
    });
  });

  it("collects every retired-products page before returning", async () => {
    const document = doc(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody><tr><td>T-1</td><td>商品一 商品ID：10001</td><td>已清退</td><td>2026/07/30</td><td>原因一</td></tr></tbody>
      </table>
      <li class="auxo-pagination-next"><button>下一页</button></li>
    `);
    const next = document.querySelector<HTMLElement>(
      ".auxo-pagination-next"
    )!;
    next.querySelector("button")!.addEventListener("click", () => {
      document.querySelector("tbody")!.innerHTML =
        "<tr><td>T-2</td><td>商品二 商品ID：10002</td><td>已清退</td><td>2026/07/31</td><td>原因二</td></tr>";
      next.classList.add("auxo-pagination-disabled");
    });
    await expect(
      executeAllianceRetiredStage(
        {
          stage: "collect-retired-products",
          expectedShop: {
            name: "甲食品旗舰店",
            status: "active",
            statusText: "正常营业"
          }
        },
        document,
        "https://buyin.jinritemai.com/dashboard/regulation/clear-out"
      )
    ).resolves.toMatchObject({
      page: {
        products: [
          { treatmentId: "T-1", productId: "10001" },
          { treatmentId: "T-2", productId: "10002" }
        ]
      }
    });
  });

  it("waits for the promotion submenu after expanding the alliance menu", async () => {
    const document = doc(`<div class="menuTitle">精选联盟</div>`);
    const menu = document.querySelector<HTMLElement>(".menuTitle")!;
    vi.spyOn(menu, "click").mockImplementation(() => {
      const entry = document.createElement("div");
      entry.className = "layerTitle";
      entry.textContent = "去推广";
      document.body.append(entry);
      vi.spyOn(entry, "click");
    });
    await expect(
      executeAllianceRetiredStage(
        { stage: "open-promotion" },
        document,
        "https://fxg.jinritemai.com/ffa/g/list"
      )
    ).resolves.toEqual({ stage: "open-promotion" });
    expect(
      document.querySelector<HTMLElement>(".layerTitle")?.click
    ).toHaveBeenCalledOnce();
  });

  it("opens product promotion from a Buyin landing page", async () => {
    const document = doc(`
      <ul><li role="menuitem"><span>推商品</span></li></ul>
    `);
    const entry = document.querySelector<HTMLElement>("[role='menuitem']")!;
    const click = vi.spyOn(entry, "click");
    await expect(
      executeAllianceRetiredStage(
        { stage: "open-product-promotion" },
        document,
        "https://buyin.jinritemai.com/dashboard?enter_from=doudian_homepage"
      )
    ).resolves.toEqual({ stage: "open-product-promotion" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("dismisses stacked dialogs before opening retired products", async () => {
    const document = doc(`
      <div role="dialog">如何迁移旧版数据？<button aria-label="Close"></button></div>
      <div role="dialog">推广策略支持分层设佣<button aria-label="Close"></button></div>
      <div class="back_old_version"><div><span>已清退商品</span></div></div>
    `);
    for (const dialog of document.querySelectorAll<HTMLElement>(
      "[role='dialog']"
    )) {
      vi.spyOn(
        dialog.querySelector<HTMLElement>("button")!,
        "click"
      ).mockImplementation(() => dialog.remove());
    }
    const entry = document.querySelector<HTMLElement>(".back_old_version")!;
    const click = vi.spyOn(entry, "click");
    await expect(
      executeAllianceRetiredStage(
        { stage: "open-retired-products" },
        document,
        "https://buyin.jinritemai.com/dashboard/product/promote-manage"
      )
    ).resolves.toEqual({
      stage: "open-retired-products",
      dismissedDialogs: 2
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("blocks an unknown dialog instead of clicking its close button", async () => {
    const document = doc(`
      <div role="dialog">需要确认新的账户授权<button aria-label="Close"></button></div>
      <div class="back_old_version"><div><span>已清退商品</span></div></div>
    `);
    const close = vi.spyOn(
      document.querySelector<HTMLElement>("button")!,
      "click"
    );
    await expect(
      executeAllianceRetiredStage(
        { stage: "open-retired-products" },
        document,
        "https://buyin.jinritemai.com/dashboard/product/promote-manage"
      )
    ).rejects.toThrow("PROMOTION_DIALOG_UNRECOGNIZED");
    expect(close).not.toHaveBeenCalled();
  });
});
