import { describe, expect, it } from "vitest";
import { createPackagingMasterRecord } from "@bpa/packaging-domain";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  PACKAGING_MATCH_HANDLER_REF,
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS,
  teamHandlerRegistry
} from "./handlers.js";

describe("trusted Team Worker handlers", () => {
  it("runs packaging.master.match.batch through packaging-domain", async () => {
    const record = createPackagingMasterRecord({
      id: "record-1",
      sourceRow: 2,
      productName: "鲜炖燕窝",
      brand: "示例品牌",
      weight: "70g×6",
      packagingShape: "盒",
      recordDigest: `sha256:${"a".repeat(64)}`
    });
    const input = JSON.parse(
      JSON.stringify({
        products: [
          {
            shopId: "shop-1",
            productId: "product-1",
            title: "示例品牌 鲜炖燕窝 70g×6"
          }
        ],
        records: [record]
      })
    ) as JsonValue;
    const output = await teamHandlerRegistry
      .get({ id: "packaging.master.match.batch", version: "1.0.0" })
      .invoke(
        input,
        new AbortController().signal
      );
    expect(output).toMatchObject({
      matcherVersion: "packaging-smart-v1",
      matched: [{ product: { productId: "product-1" } }],
      ambiguous: [],
      unmatched: []
    });
    expect(TEAM_WORKER_HANDLER_REFS).toContain(
      PACKAGING_MATCH_HANDLER_REF
    );
    expect(TEAM_WORKER_CODE_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("fails explicitly for registered skeleton handlers", async () => {
    await expect(
      Promise.resolve().then(() =>
        teamHandlerRegistry
          .get({ id: "issues.reconcile", version: "1.0.0" })
          .invoke({}, new AbortController().signal)
      )
    ).rejects.toMatchObject({
      code: "TEAM_HANDLER_NOT_IMPLEMENTED"
    });
  });
});
