import { describe, expect, it } from "vitest";
import {
  inventoryShopsFromEnvironment,
  prioritizeBrowserBoundShops
} from "./shop-config.js";

describe("inventory shop configuration", () => {
  it("keeps the legacy single-shop environment compatible", () => {
    expect(inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOP_ID: "shop-1",
      BPA_INVENTORY_SHOP_NAME: "一号店"
    })).toEqual([{ id: "shop-1", name: "一号店" }]);
  });

  it("parses isolated browser bindings for multiple shops", () => {
    expect(inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOPS_JSON: JSON.stringify([
        { id: "shop-1", name: "一号店", browserInstanceId: "browser-1" },
        { id: "shop-2", name: "二号店", browserInstanceId: "browser-2" }
      ])
    })).toHaveLength(2);
  });

  it("rejects unsafe shared or missing multi-shop browser sessions", () => {
    expect(() => inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOPS_JSON: JSON.stringify([
        { id: "shop-1", name: "一号店", browserInstanceId: "browser-1" },
        { id: "shop-2", name: "二号店" }
      ])
    },{ requireBrowserBindings:true })).toThrow("MULTI_SHOP_BROWSER_INSTANCE_REQUIRED");
  });

  it("allows the service and dashboard to register multiple shops without browser access", () => {
    expect(inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOPS_JSON: JSON.stringify([
        { id:"shop-1",name:"一号店" },
        { id:"shop-2",name:"二号店" }
      ])
    })).toHaveLength(2);
  });

  it("applies the legacy active browser binding to its matching shop", () => {
    expect(inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOPS_JSON: JSON.stringify([
        { id:"shop-1",name:"一号店" },
        { id:"shop-2",name:"二号店" }
      ]),
      BPA_INVENTORY_SHOP_ID:"shop-2",
      BPA_INVENTORY_BROWSER_INSTANCE_ID:"browser-2"
    })).toEqual([
      { id:"shop-1",name:"一号店" },
      { id:"shop-2",name:"二号店",browserInstanceId:"browser-2" }
    ]);
  });

  it("rejects duplicate configured bindings even when other shops are not connected", () => {
    expect(() => inventoryShopsFromEnvironment({
      BPA_INVENTORY_SHOPS_JSON: JSON.stringify([
        { id:"shop-1",name:"一号店",browserInstanceId:"shared" },
        { id:"shop-2",name:"二号店",browserInstanceId:"shared" },
        { id:"shop-3",name:"三号店" }
      ])
    })).toThrow("MULTI_SHOP_BROWSER_INSTANCE_DUPLICATE");
  });

  it("prioritizes live browser-bound shops without reordering the remaining shops",() => {
    expect(prioritizeBrowserBoundShops([
      { id:"shop-1",name:"一号店" },
      { id:"shop-2",name:"二号店",browserInstanceId:"browser-2" },
      { id:"shop-3",name:"三号店" }
    ])).toEqual([
      { id:"shop-2",name:"二号店",browserInstanceId:"browser-2" },
      { id:"shop-1",name:"一号店" },
      { id:"shop-3",name:"三号店" }
    ]);
  });

});
