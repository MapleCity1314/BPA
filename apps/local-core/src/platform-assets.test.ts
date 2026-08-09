import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";

function asset(path: string): unknown {
  return parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );
}

describe("Local Core platform assets", () => {
  it("binds the Doudian Adapter to exact published Browser Nodes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    for (const [id, path] of [
      [
        "doudian.shop.context.read",
        "nodes/core/doudian.shop.context.read@1.3.0.node.yaml"
      ],
      [
        "doudian.product.scope.collect",
        "nodes/core/doudian.product.scope.collect@1.1.0.node.yaml"
      ],
      [
        "doudian.product.scope.restore",
        "nodes/core/doudian.product.scope.restore.node.yaml"
      ],
      [
        "doudian.product.editor.open",
        "nodes/core/doudian.product.editor.open@1.1.0.node.yaml"
      ],
      [
        "doudian.editor.priority-items.inspect",
        "nodes/core/doudian.editor.priority-items.inspect@1.1.0.node.yaml"
      ],
      [
        "doudian.inventory.shop.activate",
        "nodes/core/doudian.inventory.shop.activate.node.yaml"
      ],
      [
        "doudian.inventory.product.snapshot.read",
        "nodes/core/doudian.inventory.product.snapshot.read@2.0.0.node.yaml"
      ]
    ] as const) {
      expect(
        service.handle({
          id: `publish:${id}`,
          method: "asset.publish",
          params: {
            assetType: "node",
            content: asset(path),
            actor: "test"
          }
        }).ok
      ).toBe(true);
    }

    const adapter = asset("adapters/doudian/doudian.adapter.yaml");
    expect(adapter).toMatchObject({
      metadata: { id: "doudian", version: "1.2.0" },
      capabilities: expect.arrayContaining([
        {
          nodeId: "doudian.product.scope.collect",
          nodeVersions: ["1.1.0"],
          handlerId: "doudian.product.scope.collect",
          handlerVersion: "1.2.0",
          implementationDigest:
            "sha256:70cb2ad0d566aa2e52de57a59388d58614fc98933fab01571a0bf48bda9c791c",
          permissions: ["browser.dom.read", "browser.tabs.read"]
        },
        {
          nodeId: "doudian.product.scope.restore",
          nodeVersions: ["1.0.0"],
          handlerId: "doudian.product.scope.restore",
          handlerVersion: "1.2.0",
          implementationDigest:
            "sha256:70cb2ad0d566aa2e52de57a59388d58614fc98933fab01571a0bf48bda9c791c",
          permissions: [
            "browser.dom.read",
            "browser.tabs.read",
            "browser.tabs.navigate"
          ]
        }
      ])
    });
    expect(
      service.handle({
        id: "validate:adapter",
        method: "asset.validate",
        params: { assetType: "adapter", content: adapter }
      })
    ).toMatchObject({
      ok: true,
      result: {
        valid: true,
        identity: "doudian@1.2.0"
      }
    });

    const expanded = structuredClone(adapter) as {
      capabilities: Array<{ permissions: string[] }>;
    };
    expanded.capabilities[0]!.permissions.push("browser.dom.write");
    expect(
      service.handle({
        id: "reject:permission-expansion",
        method: "asset.validate",
        params: { assetType: "adapter", content: expanded }
      })
    ).toMatchObject({
      ok: true,
      result: {
        valid: false,
        errors: [
          "Adapter capability permissions differ from Node doudian.shop.context.read@1.3.0"
        ]
      }
    });

    const publishedAdapter = service.handle({
      id: "publish:adapter",
      method: "asset.publish",
      params: { assetType: "adapter", content: adapter, actor: "test" }
    });
    expect(publishedAdapter).toMatchObject({
      ok: true,
      result: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }
    });
    const inventoryAdapter = asset(
      "adapters/doudian/doudian-inventory.adapter.yaml"
    );
    expect(
      service.handle({
        id: "validate:inventory-adapter",
        method: "asset.validate",
        params: { assetType: "adapter", content: inventoryAdapter }
      })
    ).toMatchObject({
      ok: true,
      result: {
        valid: true,
        identity: "doudian-inventory@2.0.0"
      }
    });
    const contract = asset(
      "docs/protocols/examples/element-contract-v1alpha1.example.json"
    );
    const publishedContract = service.handle({
      id: "publish:contract",
      method: "asset.publish",
      params: {
        assetType: "element_contract",
        content: contract,
        actor: "test"
      }
    });
    expect(publishedContract).toMatchObject({
      ok: true,
      result: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }
    });
    const model = {
      apiVersion: "bpa.page/v1alpha1",
      kind: "PageModel",
      metadata: {
        id: "doudian.product-list",
        version: "0.1.0",
        title: "抖店商品列表"
      },
      adapter: {
        id: "doudian",
        version: "1.2.0",
        digest: (publishedAdapter.result as { digest: string }).digest
      },
      origins: ["https://fxg.jinritemai.com"],
      states: [
        {
          id: "product-list-ready",
          pathPattern: "/ffa/g/list",
          fingerprint: `sha256:${"d".repeat(64)}`
        }
      ],
      elements: [
        {
          id: "product-total-count",
          contract: {
            id: "doudian.product-list.total-count",
            version: "0.1.0",
            digest: (publishedContract.result as { digest: string }).digest
          }
        }
      ],
      fixtureDigests: [
        `sha256:${"e".repeat(64)}`,
        `sha256:${"f".repeat(64)}`
      ]
    };
    expect(
      service.handle({
        id: "candidate:page-model",
        method: "asset.candidate",
        params: { assetType: "page_model", content: model, actor: "codex" }
      })
    ).toMatchObject({
      ok: true,
      result: {
        assetType: "page_model",
        status: "candidate",
        assetId: "doudian.product-list"
      }
    });
    expect(
      service.handle({
        id: "reject:adapter-drift",
        method: "asset.validate",
        params: {
          assetType: "page_model",
          content: {
            ...model,
            adapter: {
              ...model.adapter,
              digest: `sha256:${"0".repeat(64)}`
            }
          }
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        valid: false,
        errors: [
          "/adapter INVALID_IDENTITY: PageModel must pin an exact published Adapter"
        ]
      }
    });
    persistence.close();
  });
});
