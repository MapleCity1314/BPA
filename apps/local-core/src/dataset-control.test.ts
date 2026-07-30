import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";
import { StagingTransferService } from "./staging-transfer.js";

const timestamp = "2026-07-28T00:00:00.000Z";

function publishFixture(store: SqlitePersistence): void {
  store.stageDataset({
    stagingId: "staging-control",
    profileId: "packaging-master-v1",
    profileVersion: "1.0.0",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    state: "staged",
    validationReport: {},
    createdAt: timestamp,
    updatedAt: timestamp
  });
  store.transitionDatasetStaging({
    stagingId: "staging-control",
    expectedState: "staged",
    nextState: "validated",
    validationReport: { valid: true },
    updatedAt: timestamp
  });
  store.publishDataset({
    stagingId: "staging-control",
    expectedState: "validated",
    dataset: {
      apiVersion: "bpa.data/v1alpha1",
      kind: "DatasetVersion",
      metadata: {
        id: "packaging-master",
        version: "2026.07.28",
        title: "包装主数据"
      },
      profile: { id: "packaging-master-v1", version: "1.0.0" },
      source: {
        fileName: "packaging.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 100,
        digest: `sha256:${"a".repeat(64)}`
      },
      recordSchema: { type: "object" },
      recordCount: 2,
      recordsDigest: `sha256:${"b".repeat(64)}`
    },
    normalizedRecords: [
      { id: "record-1", productName: "酸菜 500g" },
      { id: "record-2", productName: "酸菜 1kg" }
    ],
    audit: {
      id: "audit-control",
      action: "dataset.publish",
      actor: "tester",
      target: "dataset:packaging-master@2026.07.28",
      detail: {},
      occurredAt: timestamp
    }
  });
}

describe("Local Core dataset control", () => {
  it("exposes immutable metadata and bounded record pages", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    publishFixture(persistence);
    const service = new LocalCoreService(persistence);

    expect(
      service.handle({
        id: "inspect",
        method: "dataset.inspect",
        params: { id: "packaging-master", version: "2026.07.28" }
      })
    ).toMatchObject({
      ok: true,
      result: {
        metadata: { id: "packaging-master", version: "2026.07.28" },
        recordCount: 2
      }
    });
    expect(
      service.handle({
        id: "read",
        method: "dataset.read",
        params: {
          id: "packaging-master",
          version: "2026.07.28",
          limit: 1
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        records: [{ id: "record-1", productName: "酸菜 500g" }],
        nextRecordKey: "id:record-1"
      }
    });
    persistence.close();
  });

  it("routes asynchronous imports through the safe dataset service", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    const response = await service.handleAsync({
      id: "import",
      method: "dataset.import",
      params: {
        path: "/definitely/missing/packaging.xlsx",
        id: "packaging-master",
        version: "2026.07.28",
        actor: "tester"
      }
    });

    expect(response).toMatchObject({ id: "import", ok: false });
    expect(response.error?.message).toContain("ENOENT");
    persistence.close();
  });

  it("imports a consumed dataset upload by immutable receipt after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-dataset-control-"));
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const firstTransfers = new StagingTransferService(persistence, directory);
    const body = Buffer.from("invalid-but-trusted-xlsx-container");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const lease = firstTransfers.issue({
      fileName: "packaging.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: body.byteLength,
      sha256,
      purpose: "dataset"
    });
    const receipt = firstTransfers.upload(
      {
        protocol: "bpa.staging/1",
        leaseId: lease.leaseId,
        token: lease.transferToken,
        sizeBytes: body.byteLength,
        expectedSha256: sha256
      },
      body
    );
    const recoveredTransfers = new StagingTransferService(
      persistence,
      directory
    );
    const service = new LocalCoreService(
      persistence,
      undefined,
      undefined,
      recoveredTransfers
    );

    const response = await service.handleAsync({
      id: "staged-import",
      method: "dataset.import.staged",
      params: {
        leaseId: receipt.leaseId,
        digest: receipt.digest,
        id: "packaging-master",
        version: "1.0.0",
        actor: "operator-console"
      }
    });
    expect(response).toMatchObject({
      id: "staged-import",
      ok: true,
      result: {
        status: "rejected",
        sourceDigest: receipt.digest
      }
    });

    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
