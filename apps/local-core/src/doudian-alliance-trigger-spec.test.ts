import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateTriggerSpec } from "@bpa/schemas";

const templatePath = new URL(
  "../../../config/triggers/doudian-alliance-retired-products-daily.trigger.yaml",
  import.meta.url
);

describe("Doudian alliance retired-products TriggerSpec template", () => {
  it("is schema-valid, disabled, version-pinned, and unable to bind a real browser", () => {
    const template = parse(readFileSync(templatePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(
      validateTriggerSpec(template),
      JSON.stringify(validateTriggerSpec.errors)
    ).toBe(true);
    expect(template).toMatchObject({
      apiVersion: "bpa.trigger/v1alpha2",
      id: "doudian-alliance-retired-products-daily",
      version: "1.0.0",
      appId: "retired-products-monitor",
      kind: "schedule",
      workflow: {
        id: "doudian.alliance-retired-products-monitor",
        version: "3.0.4"
      },
      enabled: false,
      input: { maxShops: 100 },
      concurrencyKey: "doudian-account:company-main",
      idempotencyPolicy: "occurrence",
      retryPolicy: "none",
      missedRunPolicy: "run_once",
      schedule: {
        type: "daily",
        timezone: "Asia/Shanghai",
        localTime: "15:00",
        onTimeWindowSeconds: 300
      }
    });
    expect(String(template.browserInstanceId)).toMatch(
      /^deployment-placeholder:/u
    );
  });
});
