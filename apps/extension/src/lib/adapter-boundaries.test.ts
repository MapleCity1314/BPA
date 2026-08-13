import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("browser adapter runtime boundaries", () => {
  it("keeps Binance page behavior out of the shared non-Binance content entry", () => {
    const sharedContent = source("entrypoints/content.ts");
    expect(sharedContent).not.toContain("@bpa/adapter-binance");
    expect(sharedContent).not.toContain("bpa.binance.detail.stage");
    expect(sharedContent).not.toContain("binance.copy-trading.management");
  });

  it("keeps Binance background handlers out of the Doudian registry", () => {
    const doudianRegistry = source("lib/adapter-node-registry.ts");
    expect(doudianRegistry).not.toContain("binance-detail-background");
    expect(doudianRegistry).not.toContain("binance.copy-trading");
  });
});
