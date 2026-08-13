import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";

describe("Binance Data API OpenAPI contract", () => {
  it("is a static OpenAPI 3.1 GET/HEAD-only contract without sensitive fields", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(Object.keys(openApiDocument.paths)).toContain("/api/v1/binance/readiness");
    for (const path of Object.values(openApiDocument.paths)) {
      expect(Object.keys(path).sort()).toEqual(["get", "head"]);
    }
    const serialized = JSON.stringify(openApiDocument);
    expect(serialized).not.toContain("project_id");
    expect(serialized).not.toContain("payload_json");
    expect(serialized).not.toContain("display_name");
  });
});
