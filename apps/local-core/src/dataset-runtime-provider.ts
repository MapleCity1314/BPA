import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import {
  DatasetNotFoundError,
  PackagingDatasetService
} from "./dataset-service.js";

const NODE_ID = "dataset.records.read";
const NODE_VERSION = "1.0.0";
const PERMISSION = "dataset.records.read";

function inputRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function failed(
  code: string,
  message: string,
  retryable = false
): RuntimeOutcome {
  return {
    status: "failed",
    error: { code, message, retryable },
    evidence: [],
    riskSignals: []
  };
}

export class DatasetRuntimeProvider implements RuntimeProvider {
  readonly id = "dataset";

  constructor(readonly datasets: PackagingDatasetService) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return node.id === NODE_ID && node.version === NODE_VERSION;
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) {
      return {
        status: "cancelled",
        error: {
          code: "CANCELLED",
          message: "Dataset read was cancelled before execution.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    if (
      invocation.permissionSnapshot.riskLevel !== "R0" ||
      invocation.permissionSnapshot.domains.length !== 0 ||
      invocation.permissionSnapshot.permissions.length !== 1 ||
      invocation.permissionSnapshot.permissions[0] !== PERMISSION
    ) {
      return {
        status: "rejected",
        error: {
          code: "DATASET_PERMISSION_MISMATCH",
          message: "Dataset read permission snapshot is not exact.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    const input = inputRecord(invocation.input);
    if (!input) {
      return failed("DATASET_PAGE_INVALID", "Dataset input must be an object.");
    }
    const keys = Object.keys(input).sort();
    if (
      keys.some(
        (key) =>
          key !== "id" &&
          key !== "version" &&
          key !== "afterRecordKey" &&
          key !== "limit"
      ) ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      typeof input.version !== "string" ||
      input.version.length === 0 ||
      (input.afterRecordKey !== undefined &&
        (typeof input.afterRecordKey !== "string" ||
          input.afterRecordKey.length === 0)) ||
      (input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) ||
          Number(input.limit) < 1 ||
          Number(input.limit) > 500))
    ) {
      return failed(
        "DATASET_PAGE_INVALID",
        "Dataset id, version, cursor or limit is invalid."
      );
    }
    try {
      const page = this.datasets.readPage({
        id: input.id,
        version: input.version,
        ...(typeof input.afterRecordKey === "string"
          ? { afterRecordKey: input.afterRecordKey }
          : {}),
        limit: input.limit === undefined ? 500 : Number(input.limit)
      });
      return {
        status: "succeeded",
        output: {
          dataset: {
            id: page.dataset.metadata.id,
            version: page.dataset.metadata.version,
            recordsDigest: page.dataset.recordsDigest,
            recordCount: page.dataset.recordCount
          },
          records: [...page.records],
          hasMore: page.hasMore,
          ...(page.nextRecordKey === undefined
            ? {}
            : { nextRecordKey: page.nextRecordKey })
        },
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      if (error instanceof DatasetNotFoundError) {
        return failed("DATASET_NOT_FOUND", error.message);
      }
      return failed(
        "DATASET_PAGE_INVALID",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
