import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
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
    temporaryIdFactory?: () => string;
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
  const temporaryId = (options.temporaryIdFactory ?? randomUUID)();
  if (!/^[A-Za-z0-9-]+$/u.test(temporaryId)) {
    throw new Error("Runtime resource metrics temporary ID is invalid");
  }
  const temporaryPath = `${path}.${snapshot.pid}.${temporaryId}.tmp`;
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let file: number | undefined;
  let temporaryCreated = false;
  let renamed = false;
  try {
    file = openSync(temporaryPath, flags, 0o600);
    temporaryCreated = true;
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    renamed = true;
  } finally {
    if (file !== undefined) closeSync(file);
    if (temporaryCreated && !renamed) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }
  return snapshot;
}
