import { describe, expect, it } from "vitest";
import { executeRegisteredAdapterNode } from "./adapter-node-registry.js";

const context = {
  sourceTabId: 42,
  deadline: "2026-07-31T23:00:00.000Z"
};

describe("Adapter Node registry", () => {
  it("returns undefined for an unregistered Node without platform branching", async () => {
    await expect(
      executeRegisteredAdapterNode("fictional.site.read", {}, context)
    ).resolves.toBeUndefined();
  });

  it("classifies complete empty, complete items and partial foreach outcomes", async () => {
    const empty = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 1,
          succeeded: {
            count: 1,
            items: [
              {
                itemKey: "id:1",
                output: {
                  shop: { key: "id:1", name: "店铺一" },
                  status: "complete",
                  retiredCount: 0,
                  products: []
                }
              }
            ]
          },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(empty).toMatchObject({
      ok: true,
      output: {
        status: "complete_empty",
        retiredProductCount: 0,
        scannedShopCount: 1
      }
    });

    const withItems = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 1,
          succeeded: {
            count: 1,
            items: [
              {
                itemKey: "id:1",
                output: {
                  shop: { key: "id:1", name: "店铺一" },
                  status: "complete",
                  retiredCount: 2,
                  products: [{}, {}]
                }
              }
            ]
          },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(withItems).toMatchObject({
      output: {
        status: "complete_with_items",
        retiredProductCount: 2,
        affectedShopCount: 1
      }
    });

    const partial = await executeRegisteredAdapterNode(
      "doudian.alliance.retired-products.aggregate",
      {
        foreachOutcome: {
          total: 2,
          succeeded: { count: 1, items: [{ itemKey: "id:1", output: {} }] },
          failed: { count: 1, items: [{ itemKey: "id:2" }] },
          unresolved: { count: 0, items: [] }
        }
      },
      context
    );
    expect(partial).toMatchObject({
      output: { status: "partial", failedShopCount: 1 }
    });
  });
});
