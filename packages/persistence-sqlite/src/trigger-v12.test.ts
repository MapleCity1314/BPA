import { describe,expect,it } from "vitest";
import type { TriggerSpecDefinition } from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const now = "2026-08-05T00:00:00.000Z";
const spec:TriggerSpecDefinition = {
  apiVersion:"bpa.trigger/v1alpha1",
  id:"inventory.refresh.manual",
  version:"1.0.0",
  appId:"inventory-monitor",
  kind:"manual",
  workflow:{ id:"inventory.refresh",version:"1.0.0" },
  enabled:true,
  inputSchemaVersion:"inventory.refresh-input/1",
  input:{ shopId:"10461048" },
  concurrencyKey:"inventory:10461048",
  idempotencyPolicy:"request_key",
  retryPolicy:"none"
};

describe("Trigger and Browser Control Lease persistence",() => {
  it("audits versioned Trigger configuration and enforces CAS enable changes",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    const created = store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    expect(created.revision).toBe(1);
    const disabled = store.setTriggerEnabled({
      id:spec.id,expectedRevision:1,enabled:false,actor:"operator",occurredAt:now
    });
    expect(disabled).toMatchObject({ revision:2,spec:{ enabled:false } });
    expect(() => store.setTriggerEnabled({
      id:spec.id,expectedRevision:1,enabled:true,actor:"operator",occurredAt:now
    })).toThrow("Trigger revision changed");
    expect(store.listAudit(`trigger:${spec.id}`).map((item) => item.action))
      .toEqual(expect.arrayContaining(["trigger.spec.put","trigger.spec.enable"]));
    store.close();
  });

  it("deduplicates occurrences and fences competing browser owners",() => {
    const store = new SqlitePersistence({ path:":memory:" });
    store.putTriggerSpec({ spec,actor:"operator",occurredAt:now });
    const occurrence = {
      triggerRunId:"tr-1",triggerId:spec.id,triggerVersion:spec.version,
      occurrenceKey:"manual:req-1",status:"due" as const,createdAt:now,updatedAt:now
    };
    expect(store.claimTriggerOccurrence(occurrence).status).toBe("accepted");
    expect(store.claimTriggerOccurrence({ ...occurrence,triggerRunId:"tr-2" }).status)
      .toBe("duplicate");
    const first = store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-a",now,ttlSeconds:120
    });
    expect(first?.fencingToken).toBe(1);
    expect(store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-b",now,ttlSeconds:120
    })).toBeUndefined();
    expect(store.releaseBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-a",fencingToken:1,
      releasedAt:"2026-08-05T00:00:01.000Z"
    })).toBe(true);
    const second = store.acquireBrowserControlLease({
      resourceId:"browser:1",ownerId:"owner-b",
      now:"2026-08-05T00:00:02.000Z",ttlSeconds:120
    });
    expect(second?.fencingToken).toBe(2);
    store.close();
  });
});
