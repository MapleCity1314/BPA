import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync
} from "node:fs";
import type { SqliteResourceMetrics } from "@bpa/persistence-sqlite";

export const RUNTIME_RESOURCE_METRICS_SCHEMA =
  "bpa.core-runtime-metrics/1";

export interface RuntimeResourceMetricsSnapshot {
  schema: typeof RUNTIME_RESOURCE_METRICS_SCHEMA;
  sampledAt: string;
  pid: number;
  runtimeIdentity: string | null;
  sqlite: SqliteResourceMetrics & {
    measurement: "same_connection_db_status64";
  };
}

export function writeRuntimeResourceMetrics(
  path: string,
  metrics: SqliteResourceMetrics,
  options: {
    now?: () => Date;
    processId?: number;
    runtimeIdentity?: string | null;
  } = {}
): RuntimeResourceMetricsSnapshot {
  const snapshot: RuntimeResourceMetricsSnapshot = {
    schema: RUNTIME_RESOURCE_METRICS_SCHEMA,
    sampledAt: (options.now ?? (() => new Date()))().toISOString(),
    pid: options.processId ?? process.pid,
    runtimeIdentity: options.runtimeIdentity ?? null,
    sqlite: {
      measurement: "same_connection_db_status64",
      ...metrics
    }
  };
  const temporaryPath = `${path}.${snapshot.pid}.tmp`;
  const file = openSync(temporaryPath, "w", 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  return snapshot;
}
