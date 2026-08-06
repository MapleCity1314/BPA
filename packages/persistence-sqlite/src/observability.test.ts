import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSqliteObservabilityExtension } from "@bpa/sqlite-observability";
import { SqlitePersistence } from "./index.js";

const extension = resolveSqliteObservabilityExtension();
const nativeExtensionAvailable =
  extension.status === "available" && existsSync(extension.extensionPath);

describe("SQLite resource observability", () => {
  it("fails closed when metrics are requested without the native extension", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    try {
      expect(() => persistence.readSqliteResourceMetrics()).toThrow(
        /no such function/
      );
    } finally {
      persistence.close();
    }
  });

  it("fails closed when the configured native extension cannot load", () => {
    expect(
      () =>
        new SqlitePersistence({
          path: ":memory:",
          sqliteObservabilityExtensionPath: "/missing/bpa-observability"
        })
    ).toThrow();
  });

  it.runIf(nativeExtensionAvailable)(
    "reads configuration and usage from its own connection",
    () => {
      if (extension.status !== "available") throw new Error("unreachable");
      const persistence = new SqlitePersistence({
        path: ":memory:",
        sqliteObservabilityExtensionPath: extension.extensionPath
      });
      try {
        const metrics = persistence.readSqliteResourceMetrics();
        expect(metrics.pageSizeBytes).toBe(4096);
        expect(metrics.cacheSizeSetting).toBe(-16000);
        expect(metrics.configuredCacheBytes).toBe(16_384_000);
        expect(metrics.cacheUsedBytes).toBeGreaterThan(0);
        expect(metrics.schemaUsedBytes).toBeGreaterThan(0);
        expect(metrics.statementUsedBytes).toBeGreaterThan(0);
      } finally {
        persistence.close();
      }
    }
  );
});
