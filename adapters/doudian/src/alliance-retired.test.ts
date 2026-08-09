import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  discoverDoudianAllianceShops,
  DOUDIAN_ALLIANCE_RUNTIME_VERSION,
  dismissBuyinPromotionDialogs,
  openBuyinRetiredProducts,
  openDoudianAlliancePromotion,
  readBuyinRetiredProducts,
  readDoudianHeaderShopName,
  selectDoudianAllianceShop
} from "./alliance-retired.js";

function documentOf(body: string): Document {
  const dom = new JSDOM(`<body>${body}</body>`);
  dom.window.Element.prototype.getBoundingClientRect = () =>
    ({ top: 20, bottom: 44, width: 160, height: 24 }) as DOMRect;
  return dom.window.document;
}

describe("Doudian alliance retired-products runtime", () => {
  it("publishes only the exact v2 browser capabilities and implementation", () => {
    const adapter = parseWorkflowYaml(
      readFileSync(
        new URL("../doudian-alliance.adapter.yaml", import.meta.url),
        "utf8"
      )
    ) as {
      metadata: { version: string };
      extension: { minimumVersion: string };
      capabilities: Array<{
        nodeId: string;
        nodeVersions: string[];
        handlerVersion: string;
        implementationDigest: string;
      }>;
    };
    const implementationDigest = `sha256:${createHash("sha256")
      .update(
        [
          "apps/extension/src/entrypoints/background.ts",
          "apps/extension/src/entrypoints/content.ts",
          "apps/extension/src/lib/adapter-node-registry.ts",
          "apps/extension/src/lib/alliance-retired-background.ts",
          "apps/extension/src/lib/alliance-retired-content.ts",
          "apps/extension/src/lib/extension-runtime-resources.ts",
          "apps/extension/src/lib/native-connection-supervisor.ts",
          "adapters/doudian/src/alliance-retired.ts"
        ]
          .map((path) =>
            readFileSync(new URL(`../../../${path}`, import.meta.url))
          )
          .join("\n")
      )
      .digest("hex")}`;

    expect(DOUDIAN_ALLIANCE_RUNTIME_VERSION).toBe("2.0.0");
    expect(adapter.metadata.version).toBe("2.0.0");
    expect(adapter.extension.minimumVersion).toBe("0.6.2");
    expect(adapter.capabilities).toHaveLength(2);
    expect(adapter.capabilities.map((capability) => capability.nodeId)).toEqual([
      "doudian.alliance.shops.discover",
      "doudian.alliance.shop.retired-products.scan"
    ]);
    for (const capability of adapter.capabilities) {
      expect(capability).toMatchObject({
        nodeVersions: ["2.0.0"],
        handlerVersion: "2.0.0",
        implementationDigest
      });
    }
  });

  it("discovers active shops and blocks inactive targets", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName">乙食品专营店</span>店铺ID 10002 停业整顿</div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      {
        id: "10001",
        name: "甲食品旗舰店",
        status: "active",
        statusText: "正常营业"
      },
      {
        id: "10002",
        name: "乙食品专营店",
        status: "blocked",
        statusText: "停业整顿"
      }
    ]);
    expect(() =>
      selectDoudianAllianceShop(doc, {
        id: "10002",
        name: "乙食品专营店",
        status: "blocked",
        statusText: "停业整顿"
      })
    ).toThrow("SHOP_NOT_ACTIVE");
  });

  it("fails closed when a shop list mixes valid and malformed cards", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName"></span>店铺ID 10002 正常营业</div>
      </div>
    `);

    expect(() => discoverDoudianAllianceShops(doc)).toThrow(
      "SHOP_LIST_INCOMPLETE"
    );
  });

  it("keeps same-name shops distinct when both stable IDs are visible", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10002 正常营业</div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toHaveLength(2);
    const cards = Array.from(doc.querySelectorAll<HTMLElement>(".roleItem"));
    const clicks = cards.map((card) => vi.spyOn(card, "click"));
    selectDoudianAllianceShop(doc, {
      id: "10002",
      name: "同名食品店",
      status: "active",
      statusText: "正常营业"
    });
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it("uses exact semantic entries for the Doudian-to-Buyin path", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div class="menuTitle">精选联盟</div>
      <div class="layerTitle">去推广</div>
    `);
    const alliance = doc.querySelector<HTMLElement>(".menuTitle")!;
    const promote = doc.querySelector<HTMLElement>(".layerTitle")!;
    const allianceClick = vi.spyOn(alliance, "click");
    const promoteClick = vi.spyOn(promote, "click");
    expect(readDoudianHeaderShopName(doc)).toBe("甲食品旗舰店");
    openDoudianAlliancePromotion(doc);
    expect(allianceClick).toHaveBeenCalledOnce();
    expect(promoteClick).toHaveBeenCalledOnce();
  });

  it("reads the current shop after Doudian changes header class names", () => {
    const doc = documentOf(`
      <div class="account-entry"><span>榆园儿食品专营店</span></div>
      <a href="/ffa/w/login/account">账号管理</a>
    `);
    expect(readDoudianHeaderShopName(doc)).toBe("榆园儿食品专营店");
  });

  it("closes stacked promotion dialogs from the top and opens clear-out", () => {
    const doc = documentOf(`
      <div role="dialog">如何迁移旧版数据？<button aria-label="Close"></button></div>
      <div role="dialog">推广策略支持分层设佣<button aria-label="Close"></button></div>
      <div class="back_old_version"><div><span>已清退商品</span></div></div>
    `);
    const dialogs = Array.from(
      doc.querySelectorAll<HTMLElement>("[role=dialog]")
    );
    for (const dialog of dialogs) {
      vi.spyOn(
        dialog.querySelector<HTMLElement>("button")!,
        "click"
      ).mockImplementation(() => dialog.remove());
    }
    expect(dismissBuyinPromotionDialogs(doc)).toBe(2);
    const entry = doc.querySelector<HTMLElement>(".back_old_version")!;
    const click = vi.spyOn(entry, "click");
    openBuyinRetiredProducts(doc);
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not close an unrecognized promotion dialog", () => {
    const doc = documentOf(`
      <div role="dialog">请确认新的结算协议<button aria-label="Close"></button></div>
    `);
    expect(() => dismissBuyinPromotionDialogs(doc)).toThrow(
      "PROMOTION_DIALOG_UNRECOGNIZED"
    );
  });

  it("reads an empty page without converting it to an alert", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <div>当前记录更新时间：2026/07/30</div>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody><tr><td colspan="5">无搜索结果</td></tr></tbody>
      </table>
    `);
    expect(readBuyinRetiredProducts(doc)).toEqual({
      shop: { name: "甲食品旗舰店" },
      updatedAt: "2026/07/30",
      empty: true,
      products: []
    });
  });

  it("extracts bounded product evidence by table column contract", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody>
          <tr>
            <td>T-1</td>
            <td>测试商品 商品ID：3566148304733665467</td>
            <td>已清退</td>
            <td>2026/07/31 09:00:00</td>
            <td>体验分不达标</td>
          </tr>
        </tbody>
      </table>
    `);
    expect(readBuyinRetiredProducts(doc).products).toEqual([
      {
        treatmentId: "T-1",
        productId: "3566148304733665467",
        title: "测试商品",
        status: "已清退",
        processedAt: "2026/07/31 09:00:00",
        reason: "体验分不达标"
      }
    ]);
  });

  it("rejects an overlong Chinese DOM field instead of serializing it", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody>
          <tr><td>T-1</td><td>${"商".repeat(501)}</td><td>已清退</td><td>2026/07/31</td><td>原因</td></tr>
        </tbody>
      </table>
    `);

    expect(() => readBuyinRetiredProducts(doc)).toThrow(
      "RETIRED_PRODUCT_ROW_CHANGED"
    );
  });
});
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
