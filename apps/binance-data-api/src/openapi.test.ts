import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";

describe("Binance Data API OpenAPI contract", () => {
  it("is a static OpenAPI 3.1 GET/HEAD-only contract without sensitive fields", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(Object.keys(openApiDocument.paths)).toContain("/api/v1/binance/readiness");
    expect(Object.keys(openApiDocument.paths)).toContain("/api/v1/binance/positions");
    expect(Object.keys(openApiDocument.paths)).toContain("/api/v1/binance/account-summary");
    for (const path of Object.values(openApiDocument.paths)) {
      expect(Object.keys(path).sort()).toEqual(["get", "head"]);
      expect(path.get.responses).toHaveProperty("200");
    }
    expect(Object.keys(openApiDocument.paths["/readyz"].get.responses).sort())
      .toEqual(["200", "401"]);
    expect(openApiDocument.paths["/readyz"].get.responses).not.toHaveProperty("503");
    expect(openApiDocument.components.securitySchemes.BearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer"
    });
    expect(openApiDocument.security).toEqual([{ BearerAuth: [] }, {}]);
    expect(openApiDocument.paths["/api/v1/binance/projects/{alias}"].get.parameters)
      .toContainEqual(expect.objectContaining({ name: "alias", in: "path", required: true }));
    expect(openApiDocument.paths["/api/v1/binance/market/candles"].get.parameters)
      .toContainEqual(expect.objectContaining({ name: "symbol", in: "query", required: true }));
    expect(openApiDocument.paths["/api/v1/binance/projects/{alias}/records"].get.parameters)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "source_tab", in: "query" }),
        expect.objectContaining({ name: "from", in: "query" }),
        expect.objectContaining({ name: "cursor", in: "query" })
      ]));
    expect(openApiDocument.paths["/api/v1/binance/projects/{alias}/records"].head.parameters)
      .toEqual(openApiDocument.paths["/api/v1/binance/projects/{alias}/records"].get.parameters);
    expect(openApiDocument.paths["/api/v1/binance/validations"].head.parameters)
      .toEqual(openApiDocument.paths["/api/v1/binance/validations"].get.parameters);
    for (const status of ["400", "401", "403", "404", "405", "500", "503"] as const) {
      expect(openApiDocument.paths["/api/v1/binance/runs"].get.responses)
        .toHaveProperty(status);
    }
    expect(openApiDocument.components.schemas).toMatchObject({
      ResponseMeta: expect.any(Object),
      ErrorEnvelope: expect.any(Object),
      Page: expect.any(Object),
      Candle: expect.any(Object),
      Funding: expect.any(Object),
      AccountSummary: expect.any(Object)
    });
    const serialized = JSON.stringify(openApiDocument);
    expect(serialized).not.toContain("project_id");
    expect(serialized).not.toContain("payload_json");
    expect(serialized).not.toContain("display_name");
  });
});
