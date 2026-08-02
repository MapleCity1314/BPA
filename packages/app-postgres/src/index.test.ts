import { describe, expect, it } from "vitest";
import { createAppPostgresPool, runAppMigrations } from "./index.js";

describe("application PostgreSQL boundary", () => {
  it("requires a connection string and bounds the pool", async () => {
    expect(() => createAppPostgresPool({ connectionString: "", applicationName: "test" })).toThrow();
    const pool = createAppPostgresPool({
      connectionString: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
      applicationName: "inventory-test",
      maximumConnections: 2
    });
    expect(pool.options.max).toBe(2);
    await pool.end();
  });

  it("rejects unordered migration manifests before connecting", async () => {
    const pool = createAppPostgresPool({
      connectionString: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
      applicationName: "inventory-test"
    });
    await expect(runAppMigrations(pool, [
      { version: 2, name: "later", sql: "SELECT 1" },
      { version: 1, name: "earlier", sql: "SELECT 1" }
    ])).rejects.toThrow("ascending");
    await pool.end();
  });
});
