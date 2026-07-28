import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { PackagingDatasetService } from "./dataset-service.js";
import { DatasetRuntimeProvider } from "./dataset-runtime-provider.js";

const invocation = {
  invocationId: "invocation-1",
  identity: {
    runId: "run-1",
    scopePath: [],
    iterationKey: "root",
    stepKey: "read_dataset",
    attempt: 1
  },
  node: {
    kind: "node" as const,
    id: "dataset.records.read",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`
  },
  providerId: "dataset",
  input: { id: "packaging-master", version: "1.0.0", limit: 1 },
  permissionSnapshot: {
    riskLevel: "R0" as const,
    permissions: ["dataset.records.read"],
    domains: []
  },
  deadlineAt: 2_000,
  idempotencyKey: "dataset-read-1",
  fencingToken: 1,
  traceId: "trace-1"
};

function publishedStore(): SqlitePersistence {
  const store = new SqlitePersistence({ path: ":memory:" });
  store.stageDataset({
    stagingId: "staging-1",
    profileId: "packaging-master-v1",
    profileVersion: "1.0.0",
    sourceDigest: `sha256:${"b".repeat(64)}`,
    state: "staged",
    validationReport: {},
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z"
  });
  store.transitionDatasetStaging({
    stagingId: "staging-1",
    expectedState: "staged",
    nextState: "validated",
    validationReport: { valid: true },
    updatedAt: "2026-07-28T00:00:00.000Z"
  });
  store.publishDataset({
    stagingId: "staging-1",
    expectedState: "validated",
    dataset: {
      apiVersion: "bpa.data/v1alpha1",
      kind: "DatasetVersion",
      metadata: {
        id: "packaging-master",
        version: "1.0.0",
        title: "Packaging master"
      },
      profile: { id: "packaging-master-v1", version: "1.0.0" },
      source: {
        fileName: "packaging.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 100,
        digest: `sha256:${"b".repeat(64)}`
      },
      recordSchema: { type: "object" },
      recordCount: 2,
      recordsDigest: `sha256:${"c".repeat(64)}`
    },
    normalizedRecords: [{ id: "record-1" }, { id: "record-2" }],
    audit: {
      id: "audit-1",
      action: "dataset.publish",
      actor: "test",
      target: "dataset:packaging-master@1.0.0",
      detail: {},
      occurredAt: "2026-07-28T00:00:00.000Z"
    }
  });
  return store;
}

describe("DatasetRuntimeProvider", () => {
  it("reads one immutable bounded page with an exact permission snapshot", async () => {
    const store = publishedStore();
    const provider = new DatasetRuntimeProvider(
      new PackagingDatasetService(store)
    );
    await expect(
      provider.invoke(invocation, new AbortController().signal)
    ).resolves.toMatchObject({
      status: "succeeded",
      output: {
        dataset: {
          id: "packaging-master",
          version: "1.0.0",
          recordCount: 2
        },
        records: [{ id: "record-1" }],
        hasMore: true,
        nextRecordKey: "id:record-1"
      }
    });
    store.close();
  });

  it("fails closed for permission expansion and missing datasets", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const provider = new DatasetRuntimeProvider(
      new PackagingDatasetService(store)
    );
    await expect(
      provider.invoke(
        {
          ...invocation,
          permissionSnapshot: {
            ...invocation.permissionSnapshot,
            permissions: ["dataset.records.read", "dataset.records.write"]
          }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DATASET_PERMISSION_MISMATCH" }
    });
    await expect(
      provider.invoke(invocation, new AbortController().signal)
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "DATASET_NOT_FOUND" }
    });
    store.close();
  });
});
