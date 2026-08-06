import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_RESOURCE_METRICS_SCHEMA,
  writeRuntimeResourceMetrics
} from "./runtime-resource-metrics.js";

const metrics = {
  configuredCacheBytes: 16_384_000,
  pageSizeBytes: 4096,
  cacheSizeSetting: -16000,
  cacheUsedBytes: 8192,
  schemaUsedBytes: 1024,
  statementUsedBytes: 2048
};

describe("Core runtime resource metrics", () => {
  it("atomically publishes only the allowlisted same-connection metrics", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-metrics-"));
    try {
      const path = join(root, "core-runtime-metrics.json");
      const snapshot = writeRuntimeResourceMetrics(path, metrics, {
        now: () => new Date("2026-08-06T12:00:00.000Z"),
        processId: 42,
        runtimeIdentity: "0.6.0-test"
      });
      expect(snapshot).toEqual({
        schema: RUNTIME_RESOURCE_METRICS_SCHEMA,
        sampledAt: "2026-08-06T12:00:00.000Z",
        pid: 42,
        runtimeIdentity: "0.6.0-test",
        sqlite: {
          measurement: "same_connection_db_status64",
          ...metrics
        }
      });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snapshot);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(Object.keys(snapshot).sort()).toEqual([
        "pid",
        "runtimeIdentity",
        "sampledAt",
        "schema",
        "sqlite"
      ]);
      expect(Object.keys(snapshot.sqlite).sort()).toEqual([
        "cacheSizeSetting",
        "cacheUsedBytes",
        "configuredCacheBytes",
        "measurement",
        "pageSizeBytes",
        "schemaUsedBytes",
        "statementUsedBytes"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the last complete snapshot when the temporary write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "bpa-runtime-metrics-fail-"));
    try {
      const path = join(root, "core-runtime-metrics.json");
      writeFileSync(path, "previous\n", { mode: 0o600 });
      mkdirSync(`${path}.42.tmp`);
      expect(() =>
        writeRuntimeResourceMetrics(path, metrics, { processId: 42 })
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe("previous\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
