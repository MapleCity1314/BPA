import { describe, expect, it } from "vitest";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  aggregateInventoryProductionCycle,
  InventorySourceShopResolutionError,
  resolveInventoryProductionCycleSourceShop
} from "./inventory-production-cycle-aggregate.js";

const observedAt = "2026-08-10T00:00:00.000Z";
const shops = Array.from({ length: 13 }, (_, index) => ({
  id: String(10_001 + index),
  name: `测试店铺${index + 1}`
}));

describe("inventory production-cycle source shop resolution",() => {
  it("resolves the adapter name hash to the configured numeric shop identity",() => {
    expect(resolveInventoryProductionCycleSourceShop({
      id:"name:c1640f37",name:"测试店铺1",identity_confirmed:true
    },shops)).toEqual({ status:"resolved",shop:shops[0] });
  });

  it("accepts an exact configured numeric identity",() => {
    expect(resolveInventoryProductionCycleSourceShop({
      id:"10001",name:"测试店铺1（当前店铺）",identity_confirmed:true
    },shops)).toEqual({ status:"resolved",shop:shops[0] });
  });

  it.each([
    {
      observed:{ id:"name:c1640f37",name:"测试店铺1",identity_confirmed:false },
      code:"INVENTORY_SOURCE_SHOP_INPUT_INVALID"
    },
    {
      observed:{ id:"name:00000000",name:"测试店铺1",identity_confirmed:true },
      code:"INVENTORY_SOURCE_SHOP_INPUT_INVALID"
    },
    {
      observed:{ id:"10002",name:"测试店铺1",identity_confirmed:true },
      code:"INVENTORY_SOURCE_SHOP_NOT_CONFIGURED"
    }
  ] as const)("rejects unsafe observed source identity as $code",({ observed,code }) => {
    expect(() => resolveInventoryProductionCycleSourceShop(observed,shops))
      .toThrowError(expect.objectContaining<Partial<InventorySourceShopResolutionError>>({ code }));
  });

  it("rejects configured names that collide after browser normalization",() => {
    const ambiguous = shops.map((shop,index) => index === 1
      ? { ...shop,name:"测试店铺1（当前）" }
      : shop
    );
    expect(() => resolveInventoryProductionCycleSourceShop({
      id:"name:c1640f37",name:"测试店铺1",identity_confirmed:true
    },ambiguous)).toThrowError(expect.objectContaining<Partial<InventorySourceShopResolutionError>>({
      code:"INVENTORY_SOURCE_SHOP_AMBIGUOUS"
    }));
  });
});

function forecastRisk(input: {
  attempted?: number;
  completed?: number;
  failed?: number;
  warning?: number;
} = {}): JsonValue {
  const attempted = input.attempted ?? 0;
  const completed = input.completed ?? attempted;
  const failed = input.failed ?? 0;
  const warning = input.warning ?? 0;
  const normal = completed - warning;
  return {
    status: failed === 0 ? "complete" : "partial",
    attemptedProducts: attempted,
    completedProducts: completed,
    partialProducts: 0,
    failedProducts: failed,
    forecastWrites: { attempted: completed, persisted: completed },
    riskWrites: { attempted, persisted: completed },
    severities: { normal, warning, critical: 0, unknown: 0 }
  };
}

function shopOutput(index: number, input: {
  ordersStatus?: "fresh_reused" | "refreshed" | "degraded";
  attempted?: number;
  persisted?: number;
  failed?: number;
  unresolved?: number;
  forecastRisk?: JsonValue | null;
  scopeStatus?: "complete" | "inconsistent" | "blocked";
} = {}): JsonValue {
  const attempted = input.attempted ?? 0;
  const persisted = input.persisted ?? attempted;
  const failed = input.failed ?? 0;
  const unresolved = input.unresolved ?? 0;
  const scopeStatus = input.scopeStatus ?? "complete";
  return {
    shop: shops[index]!,
    ordersStatus: input.ordersStatus ?? "fresh_reused",
    scopeStatus,
    snapshots: { attempted, persisted, failed, unresolved },
    forecastRisk: input.forecastRisk === undefined
      ? scopeStatus === "complete"
        ? forecastRisk({ attempted: persisted })
        : null
      : input.forecastRisk
  };
}

function outcome(outputs: readonly JsonValue[]): JsonValue {
  return {
    total: 13,
    succeeded: {
      count: outputs.length,
      items: outputs.map((output, index) => ({ itemKey: shops[index]!.id, output }))
    },
    failed: { count: 0, items: [] },
    unresolved: { count: 0, items: [] }
  };
}

function aggregate(foreachOutcome: JsonValue): Record<string, JsonValue> {
  return aggregateInventoryProductionCycle({
    expectedShopCount: 13,
    configuredShops: shops,
    sourceShop: { id: "99999", name: "范围外源店铺" },
    foreachOutcome
  }, observedAt) as Record<string, JsonValue>;
}

describe("inventory production-cycle aggregate", () => {
  it("accepts an exact complete 13-shop cycle while the restored source shop is outside the configured set", () => {
    const result = aggregate(outcome(shops.map((_, index) => shopOutput(index))));
    expect(result).toMatchObject({
      status: "complete",
      observedAt,
      sourceShop: { id: "99999", name: "范围外源店铺" },
      coverage: {
        expectedShops: 13,
        succeededShops: 13,
        canaryPassedShops: 13,
        usableInventoryShops: 13
      },
      attentionRequired: false
    });
    expect(result).not.toHaveProperty("operationalAttentionMarker");
  });

  it("keeps snapshot gaps and deterministic forecast failures visible as partial risk coverage", () => {
    const outputs = shops.map((_, index) => index === 0
      ? shopOutput(index, {
          attempted: 2,
          persisted: 1,
          failed: 1,
          forecastRisk: forecastRisk({ attempted: 1, completed: 0, failed: 1 })
        })
      : shopOutput(index));
    const result = aggregate(outcome(outputs));
    expect(result).toMatchObject({
      status: "partial",
      inventory: { attemptedProducts: 2, persistedProducts: 1, failedProducts: 1 },
      risk: { attemptedProducts: 1, succeededProducts: 0, degradedProducts: 1 },
      attentionRequired: true,
      operationalAttentionMarker: {
        version: "1",
        kind: "business-finding",
        code: "inventory-production-cycle-degraded"
      }
    });
    expect((result.shops as JsonValue[])[0]).toMatchObject({
      inventoryStatus: "partial",
      riskStatus: "degraded"
    });
  });

  it("marks risk coverage degraded when orders are degraded even if forecast writes complete", () => {
    const outputs = shops.map((_,index) => index === 0
      ? shopOutput(index,{
          ordersStatus:"degraded",
          attempted:1,
          persisted:1,
          forecastRisk:forecastRisk({ attempted:1 })
        })
      : shopOutput(index));
    const result = aggregate(outcome(outputs));
    expect(result).toMatchObject({ status:"complete_degraded" });
    expect((result.shops as JsonValue[])[0]).toMatchObject({
      ordersStatus:"degraded",
      inventoryStatus:"complete",
      riskStatus:"degraded"
    });
  });

  it("preserves failed and unresolved shops as blocked coverage without claiming no data", () => {
    const succeededOutputs = shops.slice(0, 11).map((_, index) => shopOutput(index, {
      attempted: index === 0 ? 1 : 0,
      persisted: index === 0 ? 1 : 0
    }));
    const result = aggregate({
      total: 13,
      succeeded: {
        count: 11,
        items: succeededOutputs.map((output, index) => ({ itemKey: shops[index]!.id, output }))
      },
      failed: {
        count: 1,
        items: [{ itemKey: shops[11]!.id, error: { code: "INVENTORY_SHOP_FAILED" } }]
      },
      unresolved: { count: 1, items: [{ itemKey: shops[12]!.id }] }
    });
    expect(result).toMatchObject({
      status: "partial",
      coverage: { usableInventoryShops: 11, blockedShops: 2, failedShops: 1, unresolvedShops: 1 },
      inventory: { attemptedProducts: 1, persistedProducts: 1 }
    });
  });

  it("rejects duplicate foreach ownership and non-conserving compact receipts", () => {
    const outputs = shops.map((_, index) => shopOutput(index));
    const duplicate = outcome(outputs) as Record<string, JsonValue>;
    const succeeded = duplicate.succeeded as Record<string, JsonValue>;
    const items = succeeded.items as JsonValue[];
    items[12] = { itemKey: shops[0]!.id, output: outputs[12]! };
    expect(() => aggregate(duplicate)).toThrow("itemKey is invalid");

    outputs[0] = shopOutput(0, { attempted: 2, persisted: 1, failed: 0, unresolved: 0 });
    expect(() => aggregate(outcome(outputs))).toThrow("snapshot counts do not conserve");
  });
});
