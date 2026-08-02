import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  collectDoudianProductInventorySnapshot,
  validateDoudianInventorySnapshotInput
} from "./inventory-snapshot.js";

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <table id="products">
      <thead><tr><th>商品信息</th><th>总库存</th></tr></thead>
      <tbody><tr data-row-key="3784577039315632428">
        <td><a href="/ffa/g/create?product_id=3784577039315632428">东北粘豆包</a></td>
        <td>297732 <button title="编辑库存">编辑</button></td>
      </tr></tbody>
    </table>
    <div role="dialog" aria-label="库存详情">
      <button aria-label="关闭">×</button>
      <table>
        <thead><tr><th>SKU ID</th><th>商家编码</th><th>当前库存</th><th>占用库存</th><th>未占用库存</th></tr></thead>
        <tbody>
          <tr data-row-key="3601928624551938"><td>3601928624551938</td><td>2024103109</td><td>99600</td><td><button>5453</button></td><td>94147</td></tr>
          <tr data-row-key="3601928624552194"><td>3601928624552194</td><td>2024110403</td><td>99872</td><td><button>0</button></td><td>99872</td></tr>
          <tr data-row-key="3601928624552450"><td>3601928624552450</td><td>2024111318</td><td>98260</td><td><button>0</button></td><td>98260</td></tr>
        </tbody>
      </table>
    </div>
    <div role="tooltip">渠道品ID：3604190173526530 剩余库存：498 渠道品ID：3604688830109698 剩余库存：4955</div>
  </body>`, { url: "https://fxg.jinritemai.com/ffa/g/list" });
  return dom.window.document;
}

describe("doudian inventory snapshot", () => {
  it("reads SKU and channel stock without changing inventory forms", async () => {
    const result = await collectDoudianProductInventorySnapshot(
      fixture(),
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      { deadline: "2026-08-02T13:00:00Z", now: () => Date.parse("2026-08-02T12:00:00Z"), wait: async () => undefined }
    );
    expect(result).toMatchObject({
      status: "complete",
      formMutations: 0,
      product: { totalStock: 297732 }
    });
    expect(result.skus).toHaveLength(3);
    expect(result.skus[0]).toEqual({
      platformSkuId: "3601928624551938",
      merchantCode: "2024103109",
      currentStock: 99600,
      occupiedStock: 5453,
      unoccupiedStock: 94147,
      channels: [
        { channelGoodsId: "3604190173526530", stock: 498 },
        { channelGoodsId: "3604688830109698", stock: 4955 }
      ]
    });
  });

  it("rejects unexpected fields and non-numeric product identities", () => {
    expect(() => validateDoudianInventorySnapshotInput({
      shop: { id: "shop-1", name: "店铺" },
      product: { id: "not-an-id", title: "商品" }
    })).toThrow("INVENTORY_INPUT_INVALID");
  });

  it("fails closed when channel totals do not match occupied stock", async () => {
    const doc = fixture();
    doc.querySelector("[role='tooltip']")!.textContent = "渠道品ID：3604190173526530 剩余库存：1";
    await expect(collectDoudianProductInventorySnapshot(
      doc,
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      { deadline: "2026-08-02T13:00:00Z", now: () => Date.parse("2026-08-02T12:00:00Z"), wait: async () => undefined }
    )).rejects.toThrow("CHANNEL_STOCK_TOTAL_MISMATCH");
  });

  it("fails closed when the drawer exposes another SKU page", async () => {
    const doc = fixture();
    doc.querySelector("[role='dialog']")!.insertAdjacentHTML(
      "beforeend",
      "<button aria-label='下一页'>下一页</button>"
    );
    await expect(collectDoudianProductInventorySnapshot(
      doc,
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      { deadline: "2026-08-02T13:00:00Z", now: () => Date.parse("2026-08-02T12:00:00Z"), wait: async () => undefined }
    )).rejects.toThrow("INVENTORY_SKU_LIST_INCOMPLETE");
  });
});
