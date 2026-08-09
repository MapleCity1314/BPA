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
import type { BrowserGatewayStatus } from "./browser-gateway.js";

export const RUNTIME_RESOURCE_METRICS_SCHEMA =
  "bpa.core-runtime-metrics/1";

export interface RuntimeResourceMetricsSnapshot {
  schema: typeof RUNTIME_RESOURCE_METRICS_SCHEMA;
  sampledAt: string;
  pid: number;
  runtimeIdentity: string | null;
  process: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  browserGateway: BrowserGatewayStatus["resourceUsage"];
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
    processMemoryUsage?: () => NodeJS.MemoryUsage;
    browserGateway: BrowserGatewayStatus["resourceUsage"];
    temporaryIdFactory?: () => string;
  }
): RuntimeResourceMetricsSnapshot {
  const memory = (options.processMemoryUsage ?? process.memoryUsage)();
  const snapshot: RuntimeResourceMetricsSnapshot = {
    schema: RUNTIME_RESOURCE_METRICS_SCHEMA,
    sampledAt: (options.now ?? (() => new Date()))().toISOString(),
    pid: options.processId ?? process.pid,
    runtimeIdentity: options.runtimeIdentity ?? null,
    process: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers
    },
    browserGateway: options.browserGateway,
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
  let primaryError: unknown;
  try {
    file = openSync(temporaryPath, flags, 0o600);
    temporaryCreated = true;
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf8");
    fsyncSync(file);
    const descriptor = file;
    file = undefined;
    closeSync(descriptor);
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    renamed = true;
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (file !== undefined) {
    try {
      const descriptor = file;
      file = undefined;
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryCreated && !renamed) {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Runtime resource metrics write and cleanup failed",
        { cause: primaryError }
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "Runtime resource metrics cleanup failed"
    );
  }
  return snapshot;
}
