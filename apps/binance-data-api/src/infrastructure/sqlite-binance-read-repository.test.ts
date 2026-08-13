import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { openSqliteBinanceReadRepository } from "./sqlite-binance-read-repository.js";

describe("SQLite Binance read repository", () => {
  it("fails closed and does not create a missing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-binance-read-"));
    const path = join(directory, "missing.sqlite");
    try {
      const repository = openSqliteBinanceReadRepository(path);
      expect(repository).toMatchObject({
        schemaVersion: null,
        errorCode: "DATABASE_UNREADABLE"
      });
      expect(() => new SqlitePersistence({ path, readonly: true })).toThrow(
        "READONLY_SQLITE_REQUIRES_FILE_MUST_EXIST"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens an existing v26 database read-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-binance-read-"));
    const path = join(directory, "bpa.sqlite");
    try {
      const writable = new SqlitePersistence({ path });
      writable.close();
      const repository = openSqliteBinanceReadRepository(path);
      expect(repository.errorCode).toBeUndefined();
      expect(repository.schemaVersion).toBe(26);
      expect(repository.store).toBeDefined();
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
