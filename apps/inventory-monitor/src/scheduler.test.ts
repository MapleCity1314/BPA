import { describe,expect,it } from "vitest";
import {
  shouldEvaluatePersistedSnapshots,
  shouldCollectInventorySnapshot,
  shouldUseRecentOrdersBrowser,
  workflowDegradationDiagnostic
} from "./scheduler.js";

describe("inventory scheduler degradation policy",() => {
  it("does not degrade a successful prerequisite workflow",() => {
    expect(workflowDegradationDiagnostic("ecom.sales-demand.refresh","succeeded"))
      .toBeUndefined();
  });

  it("keeps inventory collection running when demand refresh is unavailable",() => {
    expect(workflowDegradationDiagnostic("ecom.sales-demand.refresh","failed"))
      .toBe(
        "ecom.sales-demand.refresh ended failed; dependent risk results must remain data-quality unknown."
      );
  });

  it("evaluates snapshots persisted before a recoverable collection failure",() => {
    expect(shouldEvaluatePersistedSnapshots("failed",28)).toBe(true);
    expect(shouldEvaluatePersistedSnapshots("failed",0)).toBe(false);
    expect(shouldEvaluatePersistedSnapshots("uncertain",28)).toBe(false);
  });

  it("reuses fresh persisted inventory and collects only when none is fresh",() => {
    expect(shouldCollectInventorySnapshot(74)).toBe(false);
    expect(shouldCollectInventorySnapshot(0)).toBe(true);
  });

  it("never sends an unbound shop into the shared browser session",() => {
    expect(shouldUseRecentOrdersBrowser(true,undefined)).toBe(false);
    expect(shouldUseRecentOrdersBrowser(true,"")).toBe(false);
    expect(shouldUseRecentOrdersBrowser(false,"browser-1")).toBe(false);
    expect(shouldUseRecentOrdersBrowser(true,"browser-1")).toBe(true);
  });
});
