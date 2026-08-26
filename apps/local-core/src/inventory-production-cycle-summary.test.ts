import { describe,expect,it,vi } from "vitest";
import type { RunRecord,TriggeredWorkflowExecutionRecord } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";
import { projectInventoryProductionCycleSummary } from "./inventory-production-cycle-summary.js";

const scheduledAt="2026-08-10T00:00:00.000Z";
const createdAt="2026-08-10T00:00:01.000Z";
const terminalAt="2026-08-10T00:10:00.000Z";

function shop(index:number) {
  return { id:String(10000+index),name:`测试店铺${index}` };
}

function aggregate(status:"complete"|"complete_degraded"|"partial"|"failed") {
  const complete=status==="complete" || status==="complete_degraded";
  const shops=Array.from({ length:13 },(_,index) => {
    const blocked=status==="failed";
    const partial=status==="partial" && index===0;
    const degraded=status==="complete_degraded" && index===0;
    return {
        shop:shop(index+1),
        status:blocked ? "blocked" : partial ? "partial" : degraded ? "degraded" : "complete",
        ordersStatus:blocked || degraded ? "degraded" : "fresh_reused",
        inventoryStatus:blocked ? "blocked" : partial ? "partial" : "complete",
        riskStatus:blocked ? "not_run" : partial || degraded ? "degraded" : "complete",
        discoveredProducts:blocked ? 0 : 1,
        attemptedProducts:blocked ? 0 : 1,
        persistedProducts:blocked || partial ? 0 : 1,
        failedProducts:partial ? 1 : 0,
        skippedProducts:0
      };
  });
  const attentionRequired=status!=="complete";
  return {
    status,
    observedAt:terminalAt,
    sourceShop:shop(1),
    coverage:{
      expectedShops:13,configuredShops:13,
      attemptedShops:status==="failed" ? 0 : 13,
      succeededShops:status==="failed" ? 0 : 13,
      failedShops:status==="failed" ? 13 : 0,
      unresolvedShops:0,canaryPassedShops:status==="failed" ? 0 : 13,
      usableInventoryShops:status==="failed" ? 0 : 13,
      blockedShops:status==="failed" ? 13 : 0,
      partialShops:status==="partial" ? 1 : 0
    },
    orders:{
      freshReusedShops:status==="failed" ? 0 : status==="complete_degraded" ? 12 : 13,
      refreshedShops:0,fallbackShops:0,
      degradedShops:status==="failed" ? 13 : status==="complete_degraded" ? 1 : 0
    },
    inventory:{
      discoveredProducts:status==="failed" ? 0 : 13,
      attemptedProducts:status==="failed" ? 0 : 13,
      persistedProducts:status==="partial" ? 12 : status==="failed" ? 0 : 13,
      failedProducts:status==="partial" ? 1 : 0,
      skippedProducts:0
    },
    risk:{
      attemptedProducts:status==="failed" ? 0 : status==="partial" ? 12 : 13,
      succeededProducts:status==="failed" ? 0 : status==="partial" ? 12 : 13,
      degradedProducts:0,
      normalProducts:status==="failed" ? 0 : status==="partial" ? 12 : 13,
      warningProducts:0,criticalProducts:0,unknownProducts:0
    },
    shops,
    attentionRequired,
    ...(attentionRequired ? { operationalAttentionMarker:{
      version:"1",kind:"business-finding",code:"inventory-production-cycle-degraded"
    } } : {})
  };
}

function record(
  status:RunRecord["status"],
  output?:unknown
):TriggeredWorkflowExecutionRecord {
  return {
    scheduledAt,
    occurrenceStatus:"running",
    run:{
      id:"run:private-identity",
      workflowId:"doudian.inventory.production-cycle",
      workflowVersion:"1.0.11",
      workflowDigest:"sha256:private-digest",
      status,
      revision:7,
      input:{ privatePath:"/private/inventory-input.json" },
      ...(output===undefined ? {} : { output }),
      currentNodeKey:"private-node-key",
      createdAt,
      updatedAt:terminalAt
    }
  };
}

describe("inventory production-cycle summary projection",() => {
  it("returns only the strict 13-shop allowlist for a succeeded Run",() => {
    const projection=projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:aggregate("complete"),
      notification:{ message:"private notification" },
      sourceRestore:{ path:"/private/browser-profile" },
      privateReceipt:"receipt-secret"
    }));

    expect(projection).toMatchObject({
      state:"available",
      run:{ status:"succeeded",scheduledAt,createdAt,terminalAt },
      summary:{
        state:"available",
        cycle:{
          status:"complete",
          coverage:{ expectedShops:13,succeededShops:13 },
          inventory:{ persistedProducts:13 },
          shops:expect.arrayContaining([
            expect.objectContaining({ shop:shop(1),status:"complete" })
          ])
        }
      }
    });
    const serialized=JSON.stringify(projection);
    expect(serialized).not.toContain("run:private-identity");
    expect(serialized).not.toContain("private-digest");
    expect(serialized).not.toContain("private-node-key");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("receipt-secret");
    expect(serialized).not.toContain("notification");
    expect(serialized).not.toContain("sourceShop");
  });

  it("fails closed when a succeeded Run does not contain an exact aggregate",() => {
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:{ ...aggregate("complete"),unexpected:"private" }
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:{ ...aggregate("complete"),coverage:{ expectedShops:13 } }
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
  });

  it("rejects non-conserving, oversized or marker-inconsistent aggregates",() => {
    const missingShop=aggregate("complete");
    missingShop.shops=missingShop.shops.slice(0,12);
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:missingShop
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");

    const oversized=aggregate("complete");
    oversized.inventory={ ...oversized.inventory,attemptedProducts:3251 };
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:oversized
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");

    const nonConserving=aggregate("complete");
    nonConserving.risk={ ...nonConserving.risk,succeededProducts:12 };
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:nonConserving
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");

    const markerMismatch=aggregate("complete_degraded");
    delete markerMismatch.operationalAttentionMarker;
    expect(() => projectInventoryProductionCycleSummary(record("succeeded",{
      cycle:markerMismatch
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
  });

  it("reports uncertain, failed, rejected and cancelled early stops without raw output",() => {
    const cases=[
      ["uncertain","RUN_UNCERTAIN_BEFORE_AGGREGATE"],
      ["failed","RUN_FAILED_BEFORE_AGGREGATE"],
      ["rejected","RUN_REJECTED"],
      ["cancelled","RUN_CANCELLED_BEFORE_AGGREGATE"]
    ] as const;
    for (const [status,reasonCode] of cases) {
      const projection=projectInventoryProductionCycleSummary(record(status,
        status==="uncertain"
          ? {
              cycle:{
                status:"partial",reason:"forecast-risk-outcome-uncertain",
                shop:shop(1),
                snapshots:{ attempted:1,persisted:1,failed:0,unresolved:0 }
              },
              error:{ message:"socket /private/core.sock" }
            }
          : { error:{ message:"socket /private/core.sock" } }
      ));
      expect(projection).toMatchObject({
        state:"available",run:{ status },
        summary:{ state:"not-produced",reasonCode }
      });
      expect(JSON.stringify(projection)).not.toContain("/private/");
      expect(JSON.stringify(projection)).not.toContain("diagnostic");
    }
    expect(() => projectInventoryProductionCycleSummary(record("uncertain",{
      cycle:{ status:"partial",reason:"unexpected",privatePath:"/private/core.sock" }
    }))).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
  });

  it("keeps a valid partial aggregate visible for uncertain and cancelled Runs",() => {
    for (const status of ["uncertain","cancelled"] as const) {
      expect(projectInventoryProductionCycleSummary(record(status,{
        cycle:aggregate("partial")
      }))).toMatchObject({
        run:{ status },
        summary:{
          state:"available",
          cycle:{ status:"partial",coverage:{ partialShops:1 } }
        }
      });
    }
  });

  it("returns a fixed not-run response without internal identities",() => {
    expect(projectInventoryProductionCycleSummary(undefined)).toEqual({
      projectionVersion:"1",state:"not-run",
      workflow:{ id:"doudian.inventory.production-cycle",version:"1.0.11" },
      expectedShopCount:13
    });
  });

  it("does not fall back to an old terminal summary while the latest execution is active",() => {
    expect(projectInventoryProductionCycleSummary({
      ...record("waiting_browser",{
        cycle:{ privatePath:"/private/active-output-must-not-be-read" }
      }),
      occurrenceStatus:"running"
    })).toEqual({
      projectionVersion:"1",state:"in-progress",
      workflow:{ id:"doudian.inventory.production-cycle",version:"1.0.11" },
      expectedShopCount:13,
      run:{ status:"waiting_browser",scheduledAt,createdAt,updatedAt:terminalAt }
    });
    expect(projectInventoryProductionCycleSummary({
      scheduledAt,occurrenceStatus:"pending"
    })).toEqual({
      projectionVersion:"1",state:"in-progress",
      workflow:{ id:"doudian.inventory.production-cycle",version:"1.0.11" },
      expectedShopCount:13,
      trigger:{ status:"pending",scheduledAt }
    });
  });

  it("keeps a terminal pre-Run occurrence visible without diagnostics",() => {
    expect(projectInventoryProductionCycleSummary({
      scheduledAt,occurrenceStatus:"terminal",occurrenceTerminalOutcome:"blocked"
    })).toEqual({
      projectionVersion:"1",state:"not-produced",
      workflow:{ id:"doudian.inventory.production-cycle",version:"1.0.11" },
      expectedShopCount:13,
      trigger:{ status:"terminal",terminalOutcome:"blocked",scheduledAt },
      reasonCode:"TRIGGER_TERMINATED_BEFORE_RUN"
    });
  });

  it("rejects unreachable pre-Run outcomes and contradictory terminal linkage",() => {
    expect(() => projectInventoryProductionCycleSummary({
      scheduledAt,occurrenceStatus:"terminal",occurrenceTerminalOutcome:"complete"
    })).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
    expect(() => projectInventoryProductionCycleSummary({
      ...record("succeeded",{ cycle:aggregate("complete") }),
      occurrenceStatus:"terminal",
      occurrenceTerminalOutcome:"failed"
    })).toThrow("INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID");
    expect(projectInventoryProductionCycleSummary({
      ...record("succeeded",{ cycle:aggregate("complete") }),
      occurrenceStatus:"terminal",
      occurrenceTerminalOutcome:"complete"
    })).toMatchObject({
      state:"available",run:{ status:"succeeded" },
      summary:{ state:"available",cycle:{ status:"complete" } }
    });
  });
});

describe("inventory production-cycle Control RPC",() => {
  it("accepts no parameters and returns the controlled projection",() => {
    const persistence=new SqlitePersistence({ path:":memory:" });
    vi.spyOn(persistence,"getLatestTriggeredWorkflowExecution")
      .mockReturnValue(record("succeeded",{ cycle:aggregate("complete") }));
    const service=new LocalCoreService(persistence);

    const response=service.handle({
      id:"latest-inventory-cycle",method:"inventory.production-cycle.latest"
    });
    expect(response).toMatchObject({
      ok:true,
      result:{
        state:"available",run:{ status:"succeeded" },
        summary:{ state:"available",cycle:{ coverage:{ expectedShops:13 } } }
      }
    });
    expect(JSON.stringify(response)).not.toContain("run:private-identity");

    expect(service.handle({
      id:"latest-inventory-cycle-with-params",
      method:"inventory.production-cycle.latest",
      params:{ workflowId:"other" }
    })).toMatchObject({
      ok:false,
      error:{ message:"INVENTORY_PRODUCTION_CYCLE_QUERY_PARAMS_NOT_ALLOWED" }
    });
    persistence.close();
  });

  it("returns a controlled error for malformed succeeded output",() => {
    const persistence=new SqlitePersistence({ path:":memory:" });
    vi.spyOn(persistence,"getLatestTriggeredWorkflowExecution")
      .mockReturnValue(record("succeeded",{
        cycle:{ ...aggregate("complete"),privatePath:"/private/core.sock" }
      }));
    const service=new LocalCoreService(persistence);
    const response=service.handle({
      id:"malformed-inventory-cycle",method:"inventory.production-cycle.latest"
    });
    expect(response).toMatchObject({
      ok:false,error:{ message:"INVENTORY_PRODUCTION_CYCLE_SUMMARY_INVALID" }
    });
    expect(JSON.stringify(response)).not.toContain("/private/core.sock");
    persistence.close();
  });
});
