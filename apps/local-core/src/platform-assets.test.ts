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
    for (const id of [
      "doudian.shop.context.read",
      "doudian.product.scope.collect",
      "doudian.product.editor.open",
      "doudian.editor.priority-items.inspect"
    ]) {
      expect(
        service.handle({
          id: `publish:${id}`,
          method: "asset.publish",
          params: {
            assetType: "node",
            content: asset(`nodes/core/${id}.node.yaml`),
            actor: "test"
          }
        }).ok
      ).toBe(true);
    }

    const adapter = asset("adapters/doudian/doudian.adapter.yaml");
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
        identity: "doudian@1.1.0"
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
          "Adapter capability permissions differ from Node doudian.shop.context.read@1.2.0"
        ]
      }
    });
    persistence.close();
  });
});
