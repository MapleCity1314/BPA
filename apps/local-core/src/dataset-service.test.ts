import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { PackagingDatasetImport } from "@bpa/packaging-dataset";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatasetImportPathError,
  DatasetNotFoundError,
  DatasetVersionConflictError,
  MAX_DATASET_SOURCE_BYTES,
  PackagingDatasetService
} from "./dataset-service.js";

const cleanups: Array<() => Promise<void>> = [];
const now = "2026-07-28T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixtureSource(bytes = new TextEncoder().encode("xlsx fixture")) {
  const directory = await mkdtemp(join(tmpdir(), "bpa-dataset-service-"));
  const path = join(directory, "packaging.xlsx");
  await writeFile(path, bytes);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return { bytes, directory, path };
}

function validParse(input: {
  bytes: Uint8Array;
  fileName: string;
  datasetId?: string;
  version: string;
  title?: string;
}): PackagingDatasetImport {
  const sourceDigest = sha256(input.bytes);
  const recordDigest = `sha256:${"b".repeat(64)}`;
  const records = [
    {
      id: "pack-one",
      sourceRow: 2,
      productName: "东北酸菜丝500g [榆园]",
      brand: "榆园",
      weight: "500g",
      packagingShape: "正反面包装",
      recordDigest,
      normalizedName: "东北酸菜丝",
      normalizedBrand: "榆园",
      weightSignature: "500g",
      matchKey: "东北酸菜丝|榆园|500g"
    }
  ];
  return {
    status: "valid",
    descriptor: {
      id: input.datasetId ?? "packaging-master",
      version: input.version,
      title: input.title ?? "包装主数据",
      profile: { id: "packaging-master-v1", version: "1.0.0" },
      source: {
        fileName: input.fileName,
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: input.bytes.byteLength,
        digest: sourceDigest
      },
      recordSchema: { type: "object" },
      recordCount: records.length,
      recordsDigest: `sha256:${"c".repeat(64)}`
    },
    records,
    errors: [],
    warnings: ["fixture warning"],
    sourceDigest,
    selectedSheet: "包装主数据"
  };
}

describe("PackagingDatasetService", () => {
  it("publishes immutable normalized records, audit, and bounded read helpers", async () => {
    const source = await fixtureSource(
      new TextEncoder().encode("RAW_EXCEL_BYTES_MUST_NOT_BE_PERSISTED")
    );
    const store = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => store.close());
    const ids = ["staging-1", "audit-1"];
    const service = new PackagingDatasetService(store, {
      clock: () => now,
      uuid: () => ids.shift()!,
      parse: validParse
    });

    const result = await service.import({
      path: source.path,
      id: "packaging-master",
      version: "2026.07.28",
      title: "包装主数据",
      actor: "tester"
    });

    expect(result).toMatchObject({
      status: "published",
      stagingId: "staging-1",
      dataset: {
        metadata: { id: "packaging-master", version: "2026.07.28" },
        recordCount: 1
      },
      warnings: ["fixture warning"]
    });
    expect(store.getDatasetStaging("staging-1")?.state).toBe("published");
    expect(service.get("packaging-master", "2026.07.28")).toMatchObject({
      recordsDigest: `sha256:${"c".repeat(64)}`
    });
    expect(
      service.readPage({
        id: "packaging-master",
        version: "2026.07.28",
        limit: 1
      })
    ).toMatchObject({ hasMore: false, records: [expect.any(Object)] });
    expect(
      service.list({
        id: "packaging-master",
        version: "2026.07.28",
        maxRecords: 10
      })
    ).toHaveLength(1);
    expect(store.listAudit("dataset:packaging-master@2026.07.28")).toEqual([
      expect.objectContaining({
        id: "audit-1",
        action: "dataset.publish",
        actor: "tester"
      })
    ]);
    expect(
      JSON.stringify({
        dataset: service.get("packaging-master", "2026.07.28"),
        staging: store.getDatasetStaging("staging-1"),
        audit: store.listAudit("dataset:packaging-master@2026.07.28")
      })
    ).not.toContain("RAW_EXCEL_BYTES_MUST_NOT_BE_PERSISTED");
  });

  it("transitions invalid profile input to rejected without publication or audit", async () => {
    const source = await fixtureSource();
    const store = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => store.close());
    const service = new PackagingDatasetService(store, {
      clock: () => now,
      uuid: () => "staging-rejected",
      parse(input) {
        return {
          status: "invalid",
          records: [],
          errors: ["第 2 行缺少：包装形态"],
          warnings: [],
          sourceDigest: sha256(input.bytes)
        };
      }
    });

    await expect(
      service.import({
        path: source.path,
        id: "packaging-master",
        version: "bad",
        actor: "tester"
      })
    ).resolves.toEqual({
      status: "rejected",
      stagingId: "staging-rejected",
      sourceDigest: sha256(source.bytes),
      errors: ["第 2 行缺少：包装形态"],
      warnings: []
    });
    expect(store.getDatasetStaging("staging-rejected")?.state).toBe("rejected");
    expect(store.getDataset("packaging-master", "bad")).toBeUndefined();
    expect(store.listAudit()).toEqual([]);
  });

  it("rejects parser failures and inconsistent parser metadata", async () => {
    const source = await fixtureSource();
    const throwingStore = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => throwingStore.close());
    const throwing = new PackagingDatasetService(throwingStore, {
      clock: () => now,
      uuid: () => "staging-throw",
      parse() {
        throw new Error("fixture parser failure");
      }
    });
    await expect(
      throwing.import({
        path: source.path,
        id: "packaging-master",
        version: "throw",
        actor: "tester"
      })
    ).resolves.toMatchObject({
      status: "rejected",
      errors: ["Packaging dataset parser failed: fixture parser failure"]
    });
    expect(throwingStore.getDatasetStaging("staging-throw")?.state).toBe(
      "rejected"
    );

    const inconsistentStore = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => inconsistentStore.close());
    const inconsistent = new PackagingDatasetService(inconsistentStore, {
      clock: () => now,
      uuid: () => "staging-inconsistent",
      parse(input) {
        const parsed = validParse(input);
        return {
          ...parsed,
          sourceDigest: `sha256:${"d".repeat(64)}`,
          descriptor: {
            ...parsed.descriptor!,
            id: "wrong-id",
            title: "",
            profile: { id: "wrong-profile", version: "1.0.0" },
            source: {
              ...parsed.descriptor!.source,
              size: parsed.descriptor!.source.size + 1
            },
            recordCount: 2
          }
        };
      }
    });
    const result = await inconsistent.import({
      path: source.path,
      id: "packaging-master",
      version: "inconsistent",
      actor: "tester"
    });
    expect(result).toMatchObject({
      status: "rejected",
      errors: [
        "Parser source digest does not match the opened file",
        "Parser returned a different dataset identity",
        "Parser returned an unexpected dataset profile",
        "Parser returned source metadata that does not match the file",
        "Parser record count does not match normalized records",
        "Parser output failed canonical validation: title must not be empty"
      ]
    });
    expect(
      inconsistentStore.getDatasetStaging("staging-inconsistent")?.state
    ).toBe("rejected");
  });

  it("rejects relative paths, symlinks, non-files, and oversized files", async () => {
    const source = await fixtureSource();
    const link = join(source.directory, "link.xlsx");
    const directory = join(source.directory, "directory.xlsx");
    const oversized = join(source.directory, "oversized.xlsx");
    await symlink(source.path, link);
    await mkdir(directory);
    await writeFile(oversized, "");
    await truncate(oversized, MAX_DATASET_SOURCE_BYTES + 1);
    const parse = vi.fn(validParse);
    const store = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => store.close());
    const service = new PackagingDatasetService(store, { parse });
    const base = {
      id: "packaging-master",
      version: "1.0.0",
      actor: "tester"
    };

    await expect(
      service.import({ ...base, path: "relative.xlsx" })
    ).rejects.toBeInstanceOf(DatasetImportPathError);
    await expect(
      service.import({ ...base, path: join(source.directory, "wrong.csv") })
    ).rejects.toThrow(/xlsx extension/);
    await expect(
      service.import({ ...base, path: link })
    ).rejects.toThrow(/symbolic links/);
    await expect(
      service.import({ ...base, path: directory })
    ).rejects.toThrow(/regular file/);
    await expect(
      service.import({ ...base, path: oversized })
    ).rejects.toThrow(/exceeds/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing version and reports missing reads", async () => {
    const source = await fixtureSource();
    const store = new SqlitePersistence({ path: ":memory:" });
    cleanups.push(async () => store.close());
    const ids = ["staging-1", "audit-1"];
    const parse = vi.fn(validParse);
    const service = new PackagingDatasetService(store, {
      clock: () => now,
      uuid: () => ids.shift()!,
      parse
    });
    const input = {
      path: source.path,
      id: "packaging-master",
      version: "1.0.0",
      actor: "tester"
    };
    await service.import(input);
    await expect(service.import(input)).rejects.toBeInstanceOf(
      DatasetVersionConflictError
    );
    expect(parse).toHaveBeenCalledTimes(1);
    expect(() => service.get("missing", "1.0.0")).toThrow(
      DatasetNotFoundError
    );
  });
});
