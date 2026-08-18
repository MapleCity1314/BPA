import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
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
        <td><a href="/ffa/g/create?product_id=3784577039315632428">东北粘豆包</a> <a>查看渠道品(3)</a></td>
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
    <div role="tooltip">
      <div>渠道品ID</div><div>占用库存</div>
      <div class="detailRow-a"><div>3604190173526530</div><div>498</div></div>
      <div class="detailRow-b"><div>3604688830109698</div><div>4955</div></div>
    </div>
    <div role="tooltip" class="optimus_fems-popover-hidden">
      渠道品ID：9999999999999999 剩余库存：1
    </div>
  </body>`, { url: "https://fxg.jinritemai.com/ffa/g/list" });
  const dialog = dom.window.document.querySelector<HTMLElement>(
    "[role='dialog']"
  )!;
  dialog.querySelector<HTMLElement>("button[aria-label='关闭']")!
    .addEventListener("click", () => dialog.remove());
  return dom.window.document;
}

describe("doudian inventory snapshot", () => {
  it("publishes the exact inventory v2 browser closure", () => {
    const adapter = parseWorkflowYaml(readFileSync(
      new URL("../doudian-inventory.adapter.yaml", import.meta.url),
      "utf8"
    )) as {
      metadata: { version: string };
      extension: { minimumVersion: string };
      capabilities: Array<{
        nodeId: string;
        nodeVersions: string[];
        implementationDigest: string;
      }>;
    };
    const implementationDigest = `sha256:${createHash("sha256")
      .update([
        "apps/extension/src/entrypoints/background.ts",
        "apps/extension/src/entrypoints/content.ts",
        "apps/extension/src/lib/adapter-node-registry.ts",
        "apps/extension/src/lib/alliance-retired-background.ts",
        "apps/extension/src/lib/alliance-retired-content.ts",
        "apps/extension/src/lib/extension-runtime-resources.ts",
        "apps/extension/src/lib/managed-tab-lifecycle.ts",
        "apps/extension/src/lib/native-connection-supervisor.ts",
        "adapters/doudian/src/alliance-retired.ts",
        "adapters/doudian/src/inventory-snapshot.ts",
        "adapters/doudian/src/product-list-guard.ts",
        "adapters/doudian/src/shop-context.ts"
      ].map((path) => readFileSync(new URL(`../../../${path}`, import.meta.url)))
        .join("\n"))
      .digest("hex")}`;
    expect(adapter.metadata.version).toBe("2.0.6");
    expect(adapter.extension.minimumVersion).toBe("0.6.2");
    expect(adapter.capabilities).toHaveLength(2);
    expect(adapter.capabilities.map((capability) => capability.nodeId)).toEqual([
      "doudian.inventory.shop.activate",
      "doudian.inventory.product.snapshot.read"
    ]);
    expect(adapter.capabilities.map((capability) => capability.nodeVersions))
      .toEqual([["1.0.6"], ["2.0.6"]]);
    for (const capability of adapter.capabilities) {
      expect(capability.implementationDigest).toBe(implementationDigest);
    }
  });

  it("reads the current stock API used by the production inventory drawer", async () => {
    const doc = fixture();
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.product_id).toBe("3784577039315632428");
      if (url.pathname === "/stock/manage/get_product_info") {
        return Response.json({
          code: 0,
          data: {
            product_id: "3784577039315632428",
            total_stock_num: 297732
          }
        });
      }
      expect(body.source).toBe("pc");
      return Response.json({
        code: 0,
        data: {
          sku_detail_list: [
            {
              sku_id: "3601928624551938",
              sku_code: "2024103109",
              total_stock_num: 99600,
              total_occupied_stock_num: 5453,
              occupy_items: [
                {
                  stock_occupy_type: "channel",
                  channel_id: "3604190173526530",
                  occupy_stock_num: 498
                },
                {
                  stock_occupy_type: "channel",
                  channel_id: "3604688830109698",
                  occupy_stock_num: 4955
                }
              ]
            },
            {
              sku_id: "3601928624552194",
              sku_code: "2024110403",
              total_stock_num: 99872,
              total_occupied_stock_num: 0,
              occupy_items: null
            },
            {
              sku_id: "3601928624552450",
              sku_code: "2024111318",
              total_stock_num: 98260,
              total_occupied_stock_num: 0,
              occupy_items: null
            }
          ]
        }
      });
    };
    Object.defineProperty(doc.defaultView, "fetch", {
      configurable: true,
      value: fetch
    });
    const result = await collectDoudianProductInventorySnapshot(
      doc,
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      {
        deadline: "2026-08-02T13:00:00Z",
        now: () => Date.parse("2026-08-02T12:00:00Z")
      }
    );
    expect(result.product.totalStock).toBe(297732);
    expect(result.formMutations).toBe(0);
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
    expect(result.diagnostics).toContain("SNAPSHOT_SOURCE:DOUDIAN_STOCK_API");
  });

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
    expect(result.diagnostics).toContain(
      "CHANNEL_LINK_COUNT_DIFF:linked=3:observed=2"
    );
  });

  it("resets a retained channel scroller and collects virtualized rows to the bottom", async () => {
    const doc = fixture();
    const tooltip = doc.querySelector("[role='tooltip']")!;
    tooltip.innerHTML = `
      <div>渠道品ID</div><div>占用库存</div>
      <div class="detailBody-test">
        <div class="detailRow-top"><div>3604190173526530</div><div>498</div></div>
      </div>`;
    const scroller = tooltip.querySelector("[class*='detailBody']") as HTMLElement;
    let scrollTop = 220;
    Object.defineProperties(scroller, {
      clientHeight: { value: 220 },
      scrollHeight: { value: 440 },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Number(value); }
      }
    });
    scroller.addEventListener("scroll", () => {
      scroller.innerHTML = scrollTop === 0
        ? '<div class="detailRow-top"><div>3604190173526530</div><div>498</div></div>'
        : '<div class="detailRow-bottom"><div>3604688830109698</div><div>4955</div></div>';
    });
    const result = await collectDoudianProductInventorySnapshot(
      doc,
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      {
        deadline: "2026-08-02T13:00:00Z",
        now: () => Date.parse("2026-08-02T12:00:00Z"),
        wait: async () => undefined
      }
    );
    expect(result.skus[0]?.channels).toEqual([
      { channelGoodsId: "3604190173526530", stock: 498 },
      { channelGoodsId: "3604688830109698", stock: 4955 }
    ]);
    expect(scrollTop).toBe(0);
  });

  it("rejects unexpected fields and non-numeric product identities", () => {
    expect(() => validateDoudianInventorySnapshotInput({
      shop: { id: "shop-1", name: "店铺" },
      product: { id: "not-an-id", title: "商品" }
    })).toThrow("INVENTORY_INPUT_INVALID");
  });

  it("keeps channel stock with a diagnostic when channels share an occupied pool", async () => {
    const doc = fixture();
    doc.querySelector("[role='tooltip']")!.textContent = "渠道品ID：3604190173526530 剩余库存：1";
    const result = await collectDoudianProductInventorySnapshot(
      doc,
      {
        shop: { id: "shop-1", name: "榆园儿食品专营店" },
        product: { id: "3784577039315632428", title: "东北粘豆包" }
      },
      { deadline: "2026-08-02T13:00:00Z", now: () => Date.parse("2026-08-02T12:00:00Z"), wait: async () => undefined }
    );
    expect(result.skus[0]?.channels).toEqual([
      { channelGoodsId: "3604190173526530", stock: 1 }
    ]);
    expect(result.diagnostics).toContain(
      "CHANNEL_STOCK_TOTAL_DIFF:3601928624551938:occupied=5453:channels=1"
    );
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
