import { describe, expect, it } from "vitest";
import {
  buildMasterMatchKey,
  createPackagingMasterRecord,
  digestPackagingValue,
  extractWeightSignature,
  extractWeightSignatures,
  matchPackagingBatch,
  matchPackagingProduct,
  normalizeProductName,
  packagingDecisionReuseContext,
  type PackagingMasterRecord
} from "./index.js";

const digest = (value: string): string => `sha256:${value.repeat(64)}`;

function record(
  overrides: Partial<{
    id: string;
    sourceRow: number;
    productName: string;
    brand: string;
    weight: string;
    packagingShape: string;
    recordDigest: string;
  }> = {}
): PackagingMasterRecord {
  return createPackagingMasterRecord({
    id: overrides.id ?? "record-1",
    sourceRow: overrides.sourceRow ?? 2,
    productName: overrides.productName ?? "东北酸菜丝500g [榆园]",
    brand: overrides.brand ?? "榆园",
    weight: overrides.weight ?? "500g",
    packagingShape: overrides.packagingShape ?? "正反面包装",
    recordDigest: overrides.recordDigest ?? digest("a")
  });
}

describe("packaging normalization", () => {
  it("normalizes product names and weight units deterministically", () => {
    expect(normalizeProductName("【榆园】东北酸菜丝500g", "榆园")).toBe(
      "东北酸菜丝"
    );
    expect(extractWeightSignature("500G x 5袋")).toBe("500g×5");
    expect(extractWeightSignature("2.5kg")).toBe("2500g");
    expect(extractWeightSignatures("500g/1kg两种规格")).toEqual([
      "500g",
      "1000g"
    ]);
    expect(
      buildMasterMatchKey({
        productName: "【榆园】东北酸菜丝500g",
        brand: "榆园",
        weight: "500g"
      })
    ).toBe("东北酸菜丝|榆园|500g");
  });
});

describe("packaging matching", () => {
  it("keeps strict and conservative smart matches from the proven plugin", () => {
    const master = record();
    expect(
      matchPackagingProduct(
        {
          shopId: "shop-1",
          productId: "100",
          title: "【榆园】东北酸菜丝500g"
        },
        [master]
      ).status
    ).toBe("matched");
    const packed = matchPackagingProduct(
      {
        shopId: "shop-1",
        productId: "101",
        title: "【榆园】东北酸菜丝500g×5袋"
      },
      [master]
    );
    expect(packed.status).toBe("smart_matched");
    expect(packed.evidence.join("；")).toContain("单件克重一致");
  });

  it("does not auto-select close candidates when weight is absent", () => {
    const records = [
      record({
        id: "cold-350",
        sourceRow: 23,
        productName: "冷面350g [昊七七]",
        brand: "昊七七",
        weight: "350g"
      }),
      record({
        id: "cold-300",
        sourceRow: 25,
        productName: "冷面300g [昊七七]",
        brand: "昊七七",
        weight: "300g"
      })
    ];
    const outcome = matchPackagingProduct(
      {
        shopId: "shop-1",
        productId: "200",
        title: "昊七七东北冷面家庭装"
      },
      records
    );
    expect(outcome.status).toBe("unmatched");
    expect(outcome.candidates).toHaveLength(2);
  });

  it("matches the proven long-title acid-vegetable case but rejects a prepared dish", () => {
    const acid = record({
      id: "acid",
      sourceRow: 35,
      productName: "酸菜丝500g [榆园]",
      brand: "榆园",
      weight: "500g"
    });
    const premium = record({
      id: "premium",
      sourceRow: 9,
      productName: "辽宁优品酸菜500g [榆园]",
      brand: "榆园",
      weight: "500g"
    });
    const matched = matchPackagingProduct(
      {
        shopId: "shop-1",
        productId: "3787892969076556012",
        title: "【榆园】东北乳酸菌酸菜丝500g*5袋"
      },
      [premium, acid]
    );
    expect(matched.status).toBe("smart_matched");
    expect(
      matched.status === "smart_matched" ? matched.record.id : undefined
    ).toBe("acid");

    const unrelated = matchPackagingProduct(
      {
        shopId: "shop-1",
        productId: "3782499443442582131",
        title: "榆园酸菜炖五花肉东北发酵骨汤酸菜汆白肉半成品懒人菜加热即食"
      },
      [premium, acid]
    );
    expect(unrelated.status).toBe("unmatched");
  });

  it("keeps unmatched products in the batch without turning them into issues", () => {
    const result = matchPackagingBatch(
      [
        {
          shopId: "shop-1",
          productId: "matched",
          title: "【榆园】东北酸菜丝500g"
        },
        {
          shopId: "shop-1",
          productId: "unmatched",
          title: "完全无关的商品"
        }
      ],
      [record()]
    );
    expect(result.matched).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
    expect(result).not.toHaveProperty("issues");
  });
});

describe("durable packaging decisions", () => {
  it("reuses a binding only under exact business preconditions", () => {
    const master = record();
    const product = {
      shopId: "shop-1",
      productId: "100",
      title: "【榆园】东北酸菜丝500g"
    };
    const reuse = packagingDecisionReuseContext({
      product,
      targetRecord: master,
      ruleVersion: "rules-v1"
    });
    const bound = matchPackagingProduct(
      product,
      [master],
      { masterRecordId: master.id, reuse },
      reuse
    );
    expect(bound.status).toBe("bound");

    const changedTitle = packagingDecisionReuseContext({
      product: { ...product, title: "【榆园】东北酸菜丝1000g" },
      targetRecord: master,
      ruleVersion: "rules-v1"
    });
    expect(
      matchPackagingProduct(
        product,
        [master],
        { masterRecordId: master.id, reuse },
        changedTitle
      ).status
    ).not.toBe("bound");
  });

  it("does not include the whole workbook digest in reuse identity", () => {
    const master = record();
    const reuse = packagingDecisionReuseContext({
      product: {
        shopId: "shop-1",
        productId: "100",
        title: "【榆园】东北酸菜丝500g"
      },
      targetRecord: master,
      ruleVersion: "rules-v1"
    });
    expect(reuse.preconditions).toEqual({
      normalized_title: digestPackagingValue("榆园东北酸菜丝500g"),
      target_record: master.recordDigest,
      matcher: digestPackagingValue("packaging-smart-v1"),
      rules: digestPackagingValue("rules-v1")
    });
    expect(reuse.preconditions).not.toHaveProperty("dataset");
  });
});
