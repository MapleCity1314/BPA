import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveSqliteObservabilityExtension } from "./index.js";

const temporaryRoot = mkdtempSync(join(tmpdir(), "bpa-sqlite-observability-"));
const database = new Database(join(temporaryRoot, "probe.db"));
const isolatedDatabase = new Database(":memory:");
try {
  const extension = resolveSqliteObservabilityExtension();
  assert.equal(extension.status, "available");
  if (extension.status !== "available") throw new Error("unreachable");
  assert.throws(
    () => database.prepare("SELECT bpa_sqlite_cache_used()").get(),
    /no such function/
  );
  database.loadExtension(extension.extensionPath);
  database.exec(`
    CREATE TABLE resource_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 2048
    )
    INSERT INTO resource_probe(payload)
    SELECT printf('%.*c', 1024, 'x') FROM counter;
  `);
  assert.throws(
    () => isolatedDatabase.prepare("SELECT bpa_sqlite_cache_used()").get(),
    /no such function/
  );
  assert.throws(
    () => database.prepare("SELECT load_extension(?)").get("untrusted"),
    /not authorized/
  );
  database.pragma("shrink_memory");
  const cacheAfterShrink = database
    .prepare("SELECT bpa_sqlite_cache_used() AS value")
    .get().value;
  database
    .prepare("SELECT count(*), sum(length(payload)) FROM resource_probe")
    .get();
  const cacheAfterScan = database
    .prepare("SELECT bpa_sqlite_cache_used() AS value")
    .get().value;
  assert.equal(
    cacheAfterScan > cacheAfterShrink,
    true,
    "table scan must repopulate the connection-local page cache"
  );
  const metrics = database
    .prepare(`
      SELECT
        bpa_sqlite_cache_used() AS cache_used,
        bpa_sqlite_schema_used() AS schema_used,
        bpa_sqlite_statement_used() AS statement_used
    `)
    .get();
  for (const [name, value] of Object.entries(metrics)) {
    assert.equal(Number.isSafeInteger(value), true, `${name} must be an integer`);
    assert.equal(value > 0, true, `${name} must be positive`);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      cache_after_shrink: cacheAfterShrink,
      cache_after_scan: cacheAfterScan,
      ...metrics
    })}\n`
  );
} finally {
  database.close();
  isolatedDatabase.close();
  rmSync(temporaryRoot, { recursive: true });
}
