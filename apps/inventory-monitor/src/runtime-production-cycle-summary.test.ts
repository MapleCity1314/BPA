import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeProductionCycleSummaryProvider,
  projectRuntimeProductionCycleSummary
} from "./runtime-production-cycle-summary.js";

function available(): Record<string, unknown> {
  return {
    projectionVersion: "1",
    state: "available",
    workflow: {
      id: "doudian.inventory.production-cycle",
      version: "1.0.1"
    },
    expectedShopCount: 13,
    run: {
      status: "succeeded",
      scheduledAt: "2026-08-10T07:00:00.000Z",
      createdAt: "2026-08-10T07:00:01.000Z",
      terminalAt: "2026-08-10T07:20:00.000Z"
    },
    summary: {
      state: "available",
      cycle: {
        status: "complete_degraded",
        observedAt: "2026-08-10T07:19:00.000Z",
        coverage: {
          expectedShops: 13,
          configuredShops: 13,
          attemptedShops: 13,
          succeededShops: 13,
          failedShops: 0,
          unresolvedShops: 0,
          canaryPassedShops: 13,
          usableInventoryShops: 13,
          blockedShops: 0,
          partialShops: 0
        },
        orders: {
          freshReusedShops: 12,
          refreshedShops: 0,
          fallbackShops: 0,
          degradedShops: 1
        },
        inventory: {
          discoveredProducts: 100,
          attemptedProducts: 100,
          persistedProducts: 100,
          failedProducts: 0,
          skippedProducts: 0
        },
        risk: {
          attemptedProducts: 100,
          succeededProducts: 100,
          degradedProducts: 0,
          normalProducts: 98,
          warningProducts: 1,
          criticalProducts: 1,
          unknownProducts: 0
        },
        shops: Array.from({ length: 13 }, (_, index) => {
          const products = index < 9 ? 8 : 7;
          const degraded = index === 0;
          return {
            shop:{ id:String(10001+index),name:`测试店铺${index+1}` },
            status:degraded ? "degraded" : "complete",
            ordersStatus:degraded ? "degraded" : "fresh_reused",
            inventoryStatus:"complete",
            riskStatus:degraded ? "degraded" : "complete",
            discoveredProducts:products,attemptedProducts:products,
            persistedProducts:products,failedProducts:0,skippedProducts:0
          };
        }),
        attentionRequired: true
      }
    }
  };
}

describe("runtime production cycle summary", () => {
  it("projects only the compact formal-cycle fields", async () => {
    const control = { request: vi.fn(async () => available()) };
    const result = await createRuntimeProductionCycleSummaryProvider(control)();

    expect(control.request).toHaveBeenCalledWith(
      "inventory.production-cycle.latest",
      {},
      { timeoutMs: 2_000 }
    );
    expect(result).toEqual({
      state: "degraded",
      workflowVersion: "1.0.1",
      scheduledAt: "2026-08-10T07:00:00.000Z",
      observedAt: "2026-08-10T07:19:00.000Z",
      reasonCode: null,
      coverage: {
        expectedShops: 13,
        attemptedShops: 13,
        succeededShops: 13,
        failedShops: 0,
        unresolvedShops: 0
      },
      inventory: {
        attemptedProducts: 100,
        persistedProducts: 100,
        failedProducts: 0
      },
      risk: {
        attemptedProducts: 100,
        succeededProducts: 100,
        degradedProducts: 0,
        criticalProducts: 1,
        unknownProducts: 0
      },
      attentionRequired: true
    });
    expect(JSON.stringify(result)).not.toContain("shops");
  });

  it("does not fall back to an older success while the latest cycle is running", () => {
    expect(projectRuntimeProductionCycleSummary({
      projectionVersion: "1",
      state: "in-progress",
      workflow: {
        id: "doudian.inventory.production-cycle",
        version: "1.0.1"
      },
      expectedShopCount: 13,
      run: {
        status: "running",
        scheduledAt: "2026-08-10T07:00:00.000Z",
        createdAt: "2026-08-10T07:00:01.000Z",
        updatedAt: "2026-08-10T07:01:00.000Z"
      }
    })).toMatchObject({
      state: "in-progress",
      scheduledAt: "2026-08-10T07:00:00.000Z",
      coverage: null
    });
    expect(() => projectRuntimeProductionCycleSummary({
      projectionVersion:"1",state:"in-progress",
      workflow:{ id:"doudian.inventory.production-cycle",version:"1.0.1" },
      expectedShopCount:13,
      trigger:{ status:"terminal",scheduledAt:"2026-08-10T07:00:00.000Z" }
    })).toThrow("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  });

  it("preserves a valid partial aggregate from a cancelled run", () => {
    const response = available();
    (response.run as Record<string, unknown>).status = "cancelled";
    const cycle = (response.summary as {
      cycle: {
        status: string;
        coverage: Record<string, number>;
        inventory: Record<string, number>;
        risk: Record<string, number>;
        shops: Array<Record<string, unknown>>;
      };
    }).cycle;
    cycle.status = "partial";
    cycle.coverage.partialShops = 1;
    cycle.inventory.persistedProducts = 99;
    cycle.inventory.failedProducts = 1;
    cycle.risk.attemptedProducts = 99;
    cycle.risk.succeededProducts = 99;
    cycle.risk.normalProducts = 97;
    cycle.shops[0] = {
      ...cycle.shops[0],
      status: "partial",
      inventoryStatus: "partial",
      riskStatus: "degraded",
      persistedProducts: 7,
      failedProducts: 1
    };

    expect(projectRuntimeProductionCycleSummary(response)).toMatchObject({
      state: "partial",
      scheduledAt: "2026-08-10T07:00:00.000Z",
      inventory: {
        attemptedProducts: 100,
        persistedProducts: 99,
        failedProducts: 1
      }
    });
  });

  it("rejects envelope drift instead of exposing unknown fields", () => {
    expect(() => projectRuntimeProductionCycleSummary({
      ...available(),
      internalPath: "/private/inventory.sock"
    })).toThrow("INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID");
  });

  it("rejects a malformed 13-shop envelope instead of trusting its totals",() => {
    const malformed = available();
    const cycle = (malformed.summary as {
      cycle:{ shops:Array<Record<string,unknown>>;risk:Record<string,unknown> }
    }).cycle;
    cycle.shops[12] = { ...cycle.shops[12],shop:{ id:"10001",name:"重复店铺" } };
    expect(() => projectRuntimeProductionCycleSummary(malformed)).toThrow(
      "INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID"
    );
    const nonConserving = available();
    (nonConserving.summary as { cycle:{ risk:Record<string,unknown> } })
      .cycle.risk.degradedProducts = 1;
    expect(() => projectRuntimeProductionCycleSummary(nonConserving)).toThrow(
      "INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID"
    );
    const rejectedWithCycle = available();
    (rejectedWithCycle.run as Record<string,unknown>).status = "rejected";
    expect(() => projectRuntimeProductionCycleSummary(rejectedWithCycle)).toThrow(
      "INVENTORY_PRODUCTION_CYCLE_RESPONSE_INVALID"
    );
  });
});
