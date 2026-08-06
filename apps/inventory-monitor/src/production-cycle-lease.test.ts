import { describe,expect,it,vi } from "vitest";
import {
  acquireBrowserLeaseOrReleaseAppLease,
  evaluateProductionCycleRenewal,
  releaseProductionCycleLeases,
  type ProductionCycleBrowserLease
} from "./production-cycle-lease.js";

const lease:ProductionCycleBrowserLease = {
  resourceId:"browser-instance:test",
  ownerId:"production-cycle:test",
  fencingToken:7,
  expiresAt:"2026-08-06T00:03:00.000Z"
};

function fixture(result:ProductionCycleBrowserLease|null|Error) {
  const request = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const releaseLease = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  return {
    request,releaseLease,end,
    input:{
      core:{ request },
      repository:{ releaseLease },
      pool:{ end },
      browserResourceId:"browser-instance:test",
      holderId:"production-cycle:test",
      appLeaseKey:"inventory-production-cycle",
      appFencingToken:6
    }
  };
}

describe("production cycle lease handoff",() => {
  it("keeps the app lease open after browser control is acquired",async () => {
    const value = fixture(lease);
    await expect(acquireBrowserLeaseOrReleaseAppLease(value.input)).resolves.toEqual(lease);
    expect(value.releaseLease).not.toHaveBeenCalled();
    expect(value.end).not.toHaveBeenCalled();
  });

  it("releases the app lease when browser control is busy",async () => {
    const value = fixture(null);
    await expect(acquireBrowserLeaseOrReleaseAppLease(value.input))
      .rejects.toThrow("BROWSER_CONTROL_LEASE_BUSY");
    expect(value.releaseLease).toHaveBeenCalledOnce();
    expect(value.end).toHaveBeenCalledOnce();
  });

  it("releases the app lease when the control request fails",async () => {
    const value = fixture(new Error("Control request exceeded 30000ms"));
    await expect(acquireBrowserLeaseOrReleaseAppLease(value.input))
      .rejects.toThrow("Control request exceeded 30000ms");
    expect(value.releaseLease).toHaveBeenCalledOnce();
    expect(value.end).toHaveBeenCalledOnce();
  });

  it("releases both leases and closes the pool after setup",async () => {
    const value = fixture(lease);

    await releaseProductionCycleLeases({
      ...value.input,
      browserFencingToken:lease.fencingToken
    });

    expect(value.request).toHaveBeenCalledWith(
      "browser.control-lease.release",{
        resourceId:"browser-instance:test",
        ownerId:"production-cycle:test",
        fencingToken:7
      }
    );
    expect(value.releaseLease).toHaveBeenCalledWith({
      leaseKey:"inventory-production-cycle",
      holderId:"production-cycle:test",
      fencingToken:6
    });
    expect(value.end).toHaveBeenCalledOnce();
  });

  it("tolerates a transient browser renewal error inside the safe window",() => {
    const result = evaluateProductionCycleRenewal({
      appResult:{ status:"fulfilled",value:true },
      browserResult:{ status:"rejected",reason:new Error("Control request exceeded 30000ms") },
      currentBrowserLease:lease,
      appLeaseExpiresAtMs:Date.parse("2026-08-06T00:05:00.000Z"),
      nowMs:Date.parse("2026-08-06T00:01:00.000Z"),
      appTtlSeconds:300
    });
    expect(result.lossReason).toBeUndefined();
    expect(result.diagnostic).toContain("CONTROL_LEASE_RENEW_TRANSIENT");
  });

  it("stops immediately when browser ownership is explicitly lost",() => {
    const result = evaluateProductionCycleRenewal({
      appResult:{ status:"fulfilled",value:true },
      browserResult:{ status:"fulfilled",value:null },
      currentBrowserLease:lease,
      appLeaseExpiresAtMs:Date.parse("2026-08-06T00:05:00.000Z"),
      nowMs:Date.parse("2026-08-06T00:01:00.000Z"),
      appTtlSeconds:300
    });
    expect(result.lossReason).toBe("BROWSER_CONTROL_LEASE_LOST");
  });

  it("stops when a transient renewal remains unconfirmed near expiry",() => {
    const result = evaluateProductionCycleRenewal({
      appResult:{ status:"fulfilled",value:true },
      browserResult:{ status:"rejected",reason:new Error("Control request exceeded 30000ms") },
      currentBrowserLease:{ ...lease,expiresAt:"2026-08-06T00:01:20.000Z" },
      appLeaseExpiresAtMs:Date.parse("2026-08-06T00:05:00.000Z"),
      nowMs:Date.parse("2026-08-06T00:01:00.000Z"),
      appTtlSeconds:300
    });
    expect(result.lossReason).toBe("BROWSER_CONTROL_LEASE_RENEW_UNCONFIRMED");
  });
});
