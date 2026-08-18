import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateTriggerSpec } from "@bpa/schemas";

const inventoryTemplatePath = new URL(
  "../../../config/triggers/doudian-inventory-production-cycle-interval.trigger.yaml",
  import.meta.url
);
const retiredTemplatePath = new URL(
  "../../../config/triggers/doudian-alliance-retired-products-daily.trigger.yaml",
  import.meta.url
);

describe("Doudian inventory and retired-products background scheduling", () => {
  it("keeps both templates disabled and serialized by one browser and account lease", () => {
    const inventory = parse(
      readFileSync(inventoryTemplatePath, "utf8")
    ) as Record<string, unknown>;
    const retired = parse(
      readFileSync(retiredTemplatePath, "utf8")
    ) as Record<string, unknown>;
    expect(
      validateTriggerSpec(inventory),
      JSON.stringify(validateTriggerSpec.errors)
    ).toBe(true);
    expect(
      validateTriggerSpec(retired),
      JSON.stringify(validateTriggerSpec.errors)
    ).toBe(true);
    expect(inventory).toMatchObject({
      enabled: false,
      workflow: {
        id: "doudian.inventory.production-cycle",
        version: "1.0.5"
      },
      concurrencyKey: "doudian-account:company-main",
      retryPolicy: "none",
      missedRunPolicy: "skip",
      externalDomainLease: {
        providerId: "inventory-postgres",
        resourceId: "inventory-production-cycle",
        ttlSeconds: 300
      },
      schedule: {
        type: "interval",
        intervalSeconds: 1800,
        onTimeWindowSeconds: 300
      }
    });
    expect(retired).toMatchObject({
      enabled: false,
      workflow: {
        id: "doudian.alliance-retired-products-monitor",
        version: "3.0.12"
      },
      concurrencyKey: "doudian-account:company-main",
      retryPolicy: "none",
      missedRunPolicy: "run_once",
      schedule: { type: "daily", localTime: "15:00" }
    });
    expect(String(inventory.browserInstanceId)).toMatch(
      /^deployment-placeholder:/u
    );
    expect(String(retired.browserInstanceId)).toMatch(
      /^deployment-placeholder:/u
    );
    expect(inventory.concurrencyKey).toBe(retired.concurrencyKey);
    expect(inventory.browserInstanceId).toBe(retired.browserInstanceId);
  });
});
