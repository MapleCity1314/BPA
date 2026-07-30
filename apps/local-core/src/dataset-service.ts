import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import {
  listDatasetRecords,
  publishDataset,
  readDatasetRecordPage
} from "@bpa/dataset-core";
import {
  PACKAGING_DATASET_PROFILE,
  parsePackagingDataset,
  type PackagingDatasetImport
} from "@bpa/packaging-dataset";
import type {
  DatasetPublicationUnitOfWork,
  DatasetVersionDefinition,
  JsonValue
} from "@bpa/persistence";

export const MAX_DATASET_SOURCE_BYTES = 50 * 1024 * 1024;

export class DatasetImportPathError extends Error {}
export class DatasetVersionConflictError extends Error {}
export class DatasetNotFoundError extends Error {}

export interface PackagingDatasetImportInput {
  readonly path: string;
  readonly id: string;
  readonly version: string;
  readonly actor: string;
  readonly title?: string;
}

export interface PackagingDatasetBytesImportInput
  extends Omit<PackagingDatasetImportInput, "path"> {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

export type PackagingDatasetImportResult =
  | {
      readonly status: "published";
      readonly stagingId: string;
      readonly dataset: DatasetVersionDefinition;
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "rejected";
      readonly stagingId: string;
      readonly sourceDigest: string;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

export interface DatasetServiceOptions {
  readonly clock?: () => string;
  readonly uuid?: () => string;
  readonly parse?: typeof parsePackagingDataset;
}

interface SafeSource {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly size: number;
  readonly digest: string;
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertRegularFile(stats: BigIntStats, path: string): void {
  if (!stats.isFile()) {
    throw new DatasetImportPathError(
      `Dataset source must be a regular file: ${path}`
    );
  }
  if (stats.size > BigInt(MAX_DATASET_SOURCE_BYTES)) {
    throw new DatasetImportPathError(
      `Dataset source exceeds ${MAX_DATASET_SOURCE_BYTES} bytes`
    );
  }
}

function sameOpenedFile(before: BigIntStats, opened: BigIntStats): boolean {
  return (
    before.dev === opened.dev &&
    before.ino === opened.ino &&
    before.size === opened.size &&
    before.mtimeNs === opened.mtimeNs &&
    before.ctimeNs === opened.ctimeNs
  );
}

async function readSafeXlsx(path: string): Promise<SafeSource> {
  requireText(path, "path");
  if (!isAbsolute(path)) {
    throw new DatasetImportPathError(
      "Dataset source path must be an explicit absolute path"
    );
  }
  if (extname(path).toLowerCase() !== ".xlsx") {
    throw new DatasetImportPathError(
      "Dataset source must use the .xlsx extension"
    );
  }
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()) {
    throw new DatasetImportPathError("Dataset source symbolic links are rejected");
  }
  assertRegularFile(before, path);

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularFile(opened, path);
    if (!sameOpenedFile(before, opened)) {
      throw new DatasetImportPathError(
        "Dataset source changed while it was being opened"
      );
    }
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameOpenedFile(opened, after) ||
      buffer.byteLength !== Number(after.size)
    ) {
      throw new DatasetImportPathError(
        "Dataset source changed while it was being read"
      );
    }
    const bytes = new Uint8Array(buffer);
    return {
      bytes,
      fileName: basename(path),
      size: bytes.byteLength,
      digest: digest(bytes)
    };
  } finally {
    await handle.close();
  }
}

function readSafeBytes(input: {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}): SafeSource {
  requireText(input.fileName, "fileName");
  if (
    basename(input.fileName) !== input.fileName ||
    input.fileName.includes("\0") ||
    extname(input.fileName).toLowerCase() !== ".xlsx"
  ) {
    throw new DatasetImportPathError(
      "Dataset source must use a safe .xlsx file name"
    );
  }
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > MAX_DATASET_SOURCE_BYTES
  ) {
    throw new DatasetImportPathError(
      `Dataset source must contain 1-${MAX_DATASET_SOURCE_BYTES} bytes`
    );
  }
  const bytes = Uint8Array.from(input.bytes);
  return {
    bytes,
    fileName: input.fileName,
    size: bytes.byteLength,
    digest: digest(bytes)
  };
}

function jsonRecord(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Dataset record is not JSON serializable");
  }
  return JSON.parse(serialized) as JsonValue;
}

function validationReport(input: {
  readonly status: "staged" | "validated" | "rejected";
  readonly fileName: string;
  readonly size: number;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
  readonly selectedSheet?: string;
}): JsonValue {
  return {
    status: input.status,
    profile: {
      id: PACKAGING_DATASET_PROFILE.id,
      version: PACKAGING_DATASET_PROFILE.version
    },
    source: {
      fileName: input.fileName,
      size: input.size
    },
    errors: [...(input.errors ?? [])],
    warnings: [...(input.warnings ?? [])],
    ...(input.selectedSheet === undefined
      ? {}
      : { selectedSheet: input.selectedSheet })
  };
}

function validateParsedDataset(
  parsed: PackagingDatasetImport,
  source: SafeSource,
  input: Pick<PackagingDatasetImportInput, "id" | "version">
): readonly string[] {
  const errors: string[] = [];
  if (parsed.sourceDigest !== source.digest) {
    errors.push("Parser source digest does not match the opened file");
  }
  if (parsed.status !== "valid" || parsed.descriptor === undefined) {
    return [...parsed.errors, ...errors];
  }
  const descriptor = parsed.descriptor;
  if (descriptor.id !== input.id || descriptor.version !== input.version) {
    errors.push("Parser returned a different dataset identity");
  }
  if (
    descriptor.profile.id !== PACKAGING_DATASET_PROFILE.id ||
    descriptor.profile.version !== PACKAGING_DATASET_PROFILE.version
  ) {
    errors.push("Parser returned an unexpected dataset profile");
  }
  if (
    descriptor.source.fileName !== source.fileName ||
    descriptor.source.size !== source.size ||
    descriptor.source.digest !== source.digest
  ) {
    errors.push("Parser returned source metadata that does not match the file");
  }
  if (descriptor.recordCount !== parsed.records.length) {
    errors.push("Parser record count does not match normalized records");
  }
  return errors;
}

export class PackagingDatasetService {
  readonly #store: DatasetPublicationUnitOfWork;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #parse: typeof parsePackagingDataset;

  constructor(
    store: DatasetPublicationUnitOfWork,
    options: DatasetServiceOptions = {}
  ) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#uuid = options.uuid ?? randomUUID;
    this.#parse = options.parse ?? parsePackagingDataset;
  }

  async import(
    input: PackagingDatasetImportInput
  ): Promise<PackagingDatasetImportResult> {
    const source = await readSafeXlsx(input.path);
    return this.#importSource(input, source);
  }

  async importBytes(
    input: PackagingDatasetBytesImportInput
  ): Promise<PackagingDatasetImportResult> {
    const source = readSafeBytes(input);
    return this.#importSource(input, source);
  }

  async #importSource(
    input: Omit<PackagingDatasetImportInput, "path">,
    source: SafeSource
  ): Promise<PackagingDatasetImportResult> {
    requireText(input.id, "dataset id");
    requireText(input.version, "dataset version");
    requireText(input.actor, "actor");
    if (this.#store.getDataset(input.id, input.version) !== undefined) {
      throw new DatasetVersionConflictError(
        `Dataset ${input.id}@${input.version} is already published`
      );
    }

    const stagingId = this.#uuid();
    const stagedAt = this.#clock();
    this.#store.stageDataset({
      stagingId,
      profileId: PACKAGING_DATASET_PROFILE.id,
      profileVersion: PACKAGING_DATASET_PROFILE.version,
      sourceDigest: source.digest,
      state: "staged",
      validationReport: validationReport({
        status: "staged",
        fileName: source.fileName,
        size: source.size
      }),
      createdAt: stagedAt,
      updatedAt: stagedAt
    });

    let parsed: PackagingDatasetImport;
    try {
      parsed = this.#parse({
        bytes: source.bytes,
        fileName: source.fileName,
        datasetId: input.id,
        version: input.version,
        ...(input.title === undefined ? {} : { title: input.title })
      });
    } catch (error) {
      const errors = [
        `Packaging dataset parser failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      ];
      this.#store.transitionDatasetStaging({
        stagingId,
        expectedState: "staged",
        nextState: "rejected",
        validationReport: validationReport({
          status: "rejected",
          fileName: source.fileName,
          size: source.size,
          errors
        }),
        updatedAt: this.#clock()
      });
      return {
        status: "rejected",
        stagingId,
        sourceDigest: source.digest,
        errors,
        warnings: []
      };
    }

    const errors = [...validateParsedDataset(parsed, source, input)];
    let published: DatasetVersionDefinition | undefined;
    let normalizedRecords: readonly JsonValue[] | undefined;
    if (parsed.status === "valid" && parsed.descriptor !== undefined) {
      try {
        published = publishDataset(parsed.descriptor, {
          publishedAt: stagedAt
        }).definition;
        normalizedRecords = parsed.records.map(jsonRecord);
      } catch (error) {
        errors.push(
          `Parser output failed canonical validation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (
      parsed.status !== "valid" ||
      parsed.descriptor === undefined ||
      published === undefined ||
      normalizedRecords === undefined ||
      errors.length > 0
    ) {
      this.#store.transitionDatasetStaging({
        stagingId,
        expectedState: "staged",
        nextState: "rejected",
        validationReport: validationReport({
          status: "rejected",
          fileName: source.fileName,
          size: source.size,
          errors,
          warnings: parsed.warnings,
          ...(parsed.selectedSheet === undefined
            ? {}
            : { selectedSheet: parsed.selectedSheet })
        }),
        updatedAt: this.#clock()
      });
      return {
        status: "rejected",
        stagingId,
        sourceDigest: source.digest,
        errors,
        warnings: Object.freeze([...parsed.warnings])
      };
    }

    const validatedAt = this.#clock();
    this.#store.transitionDatasetStaging({
      stagingId,
      expectedState: "staged",
      nextState: "validated",
      validationReport: validationReport({
        status: "validated",
        fileName: source.fileName,
        size: source.size,
        warnings: parsed.warnings,
        ...(parsed.selectedSheet === undefined
          ? {}
          : { selectedSheet: parsed.selectedSheet })
      }),
      updatedAt: validatedAt
    });
    try {
      const dataset = this.#store.publishDataset({
        stagingId,
        expectedState: "validated",
        dataset: published,
        normalizedRecords,
        audit: {
          id: this.#uuid(),
          action: "dataset.publish",
          actor: input.actor,
          target: `dataset:${input.id}@${input.version}`,
          detail: {
            stagingId,
            profile: {
              id: published.profile.id,
              version: published.profile.version
            },
            source: {
              fileName: source.fileName,
              size: source.size,
              digest: source.digest
            },
            recordCount: published.recordCount,
            recordsDigest: published.recordsDigest,
            warnings: [...parsed.warnings]
          },
          occurredAt: this.#clock()
        }
      });
      return {
        status: "published",
        stagingId,
        dataset,
        warnings: Object.freeze([...parsed.warnings])
      };
    } catch (error) {
      if (this.#store.getDataset(input.id, input.version) !== undefined) {
        throw new DatasetVersionConflictError(
          `Dataset ${input.id}@${input.version} was published concurrently`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  get(id: string, version: string): DatasetVersionDefinition {
    requireText(id, "dataset id");
    requireText(version, "dataset version");
    const dataset = this.#store.getDataset(id, version);
    if (dataset === undefined) {
      throw new DatasetNotFoundError(`Dataset ${id}@${version} was not found`);
    }
    return dataset;
  }

  readPage(input: {
    readonly id: string;
    readonly version: string;
    readonly afterRecordKey?: string;
    readonly limit?: number;
  }): {
    readonly dataset: DatasetVersionDefinition;
    readonly records: readonly JsonValue[];
    readonly hasMore: boolean;
    readonly nextRecordKey?: string;
  } {
    const dataset = this.get(input.id, input.version);
    const page = readDatasetRecordPage(this.#store, input);
    return {
      dataset,
      records: page.records,
      hasMore: page.nextRecordKey !== undefined,
      ...(page.nextRecordKey === undefined
        ? {}
        : { nextRecordKey: page.nextRecordKey })
    };
  }

  list(input: {
    readonly id: string;
    readonly version: string;
    readonly maxRecords: number;
    readonly pageSize?: number;
  }): readonly JsonValue[] {
    this.get(input.id, input.version);
    return listDatasetRecords(this.#store, input);
  }
}
