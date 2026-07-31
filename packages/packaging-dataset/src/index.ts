import { createHash } from "node:crypto";
import type { DatasetDescriptor } from "@bpa/dataset-core";
import {
  createPackagingMasterRecord,
  digestPackagingValue,
  type PackagingMasterRecord
} from "@bpa/packaging-domain";
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  strFromU8
} from "fflate";
import { XMLParser } from "fast-xml-parser";

export const PACKAGING_DATASET_PROFILE = Object.freeze({
  id: "packaging-master-v1",
  version: "1.0.0"
});

export const PACKAGING_REQUIRED_COLUMNS = [
  "产品名称",
  "品牌",
  "克重",
  "包装形态"
] as const;

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 200;
const MAX_ZIP_PARSE_MS = 15_000;
const MAX_ZIP_RSS_GROWTH_BYTES = 384 * 1024 * 1024;
const MAX_ROWS = 1_000_000;

export interface PackagingDatasetImport {
  readonly status: "valid" | "invalid";
  readonly descriptor?: DatasetDescriptor;
  readonly records: readonly PackagingMasterRecord[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly sourceDigest: string;
  readonly selectedSheet?: string;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

function richText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const object = value as Record<string, unknown>;
  if (object.t !== undefined) return richText(object.t);
  if (object.r !== undefined) {
    return asArray(object.r).map((part) => richText(part)).join("");
  }
  return "";
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/iu)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function normalizeZipPath(value: string): string {
  const parts: string[] = [];
  const raw = value.startsWith("/") ? value.slice(1) : `xl/${value}`;
  for (const part of raw.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function assertSafeFileName(fileName: string): void {
  if (
    fileName.length < 1 ||
    fileName.length > 500 ||
    /[/\\\u0000-\u001f]/u.test(fileName) ||
    !fileName.toLowerCase().endsWith(".xlsx")
  ) {
    throw new Error("Packaging dataset requires a safe .xlsx file name");
  }
}

interface WorkbookRow {
  readonly sourceRow: number;
  readonly values: Readonly<Record<string, string>>;
}

function boundedUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    !(
      (bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08)
    )
  ) {
    throw new Error("Excel ZIP 容器无法解析");
  }
  const files: Record<string, Uint8Array> = {};
  const startedAt = Date.now();
  const startingRss = process.memoryUsage().rss;
  let entries = 0;
  let totalExpanded = 0;
  let failure: Error | undefined;
  const fail = (message: string): never => {
    failure ??= new Error(message);
    throw failure;
  };
  const checkBudget = (): void => {
    if (Date.now() - startedAt > MAX_ZIP_PARSE_MS) {
      fail("Excel ZIP 解压耗时超过安全上限");
    }
    if (
      process.memoryUsage().rss - startingRss >
      MAX_ZIP_RSS_GROWTH_BYTES
    ) {
      fail("Excel ZIP 解压内存增长超过安全上限");
    }
  };
  const unzip = new Unzip((file) => {
    entries += 1;
    checkBudget();
    if (entries > MAX_ZIP_ENTRIES) {
      fail("Excel ZIP 条目数量超过安全上限");
    }
    if (
      file.name.startsWith("/") ||
      file.name.includes("\\") ||
      file.name.split("/").some((segment) => segment === "..")
    ) {
      fail("Excel ZIP 包含不安全路径");
    }
    if (
      file.originalSize !== undefined &&
      file.originalSize > MAX_ZIP_ENTRY_BYTES
    ) {
      fail("Excel ZIP 单个条目超过安全上限");
    }
    if (
      file.size !== undefined &&
      file.originalSize !== undefined &&
      file.originalSize > 0 &&
      file.originalSize / Math.max(1, file.size) >
        MAX_ZIP_COMPRESSION_RATIO
    ) {
      fail("Excel ZIP 条目压缩比超过安全上限");
    }
    const chunks: Uint8Array[] = [];
    let expanded = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) fail("Excel ZIP 容器无法解析");
      checkBudget();
      expanded += chunk.byteLength;
      totalExpanded += chunk.byteLength;
      if (expanded > MAX_ZIP_ENTRY_BYTES) {
        fail("Excel ZIP 单个条目超过安全上限");
      }
      if (totalExpanded > MAX_UNCOMPRESSED_BYTES) {
        fail("Excel 解压后大小超过安全上限");
      }
      if (
        file.size !== undefined &&
        expanded / Math.max(1, file.size) > MAX_ZIP_COMPRESSION_RATIO
      ) {
        fail("Excel ZIP 条目压缩比超过安全上限");
      }
      if (chunk.byteLength > 0) chunks.push(Uint8Array.from(chunk));
      if (final) {
        const content = new Uint8Array(expanded);
        let offset = 0;
        for (const part of chunks) {
          content.set(part, offset);
          offset += part.byteLength;
        }
        files[file.name] = content;
      }
    };
    file.start();
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    checkBudget();
    const end = Math.min(bytes.byteLength, offset + 64 * 1024);
    unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
    if (failure) throw failure;
  }
  if (failure) throw failure;
  if (entries === 0) throw new Error("Excel ZIP 容器无法解析");
  return files;
}

function extractWorkbookRows(bytes: Uint8Array): {
  sheetName?: string;
  rows: readonly WorkbookRow[];
  errors: readonly string[];
} {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) {
    return {
      rows: [],
      errors: [`Excel 文件大小必须在 1-${MAX_SOURCE_BYTES} 字节之间`]
    };
  }
  let files: Record<string, Uint8Array>;
  try {
    files = boundedUnzip(bytes);
  } catch (error) {
    return {
      rows: [],
      errors: [
        error instanceof Error
          ? error.message
          : "Excel ZIP 容器无法解析"
      ]
    };
  }
  const entries = Object.entries(files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    return { rows: [], errors: ["Excel ZIP 条目数量超过安全上限"] };
  }
  const totalBytes = entries.reduce((sum, [, value]) => sum + value.byteLength, 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
    return { rows: [], errors: ["Excel 解压后大小超过安全上限"] };
  }
  if (
    entries.some(
      ([path]) =>
        path.startsWith("/") ||
        path.split("/").some((segment) => segment === "..")
    )
  ) {
    return { rows: [], errors: ["Excel ZIP 包含不安全路径"] };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false
  });
  const parse = (path: string): Record<string, unknown> | undefined => {
    const value = files[path];
    if (!value) return undefined;
    try {
      return parser.parse(strFromU8(value)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const workbook = parse("xl/workbook.xml") as
    | {
        workbook?: {
          sheets?: {
            sheet?: Record<string, unknown> | Record<string, unknown>[];
          };
        };
      }
    | undefined;
  const relationships = parse("xl/_rels/workbook.xml.rels") as
    | {
        Relationships?: {
          Relationship?: Record<string, unknown> | Record<string, unknown>[];
        };
      }
    | undefined;
  if (!workbook || !relationships) {
    return { rows: [], errors: ["Excel 缺少 workbook 或 relationship 元数据"] };
  }
  const relationshipMap = new Map(
    asArray<Record<string, unknown>>(
      relationships.Relationships?.Relationship
    ).map((relationship) => [
        String(relationship["@_Id"] ?? ""),
        normalizeZipPath(String(relationship["@_Target"] ?? ""))
      ])
  );
  const shared = parse("xl/sharedStrings.xml") as
    | { sst?: { si?: unknown | unknown[] } }
    | undefined;
  const sharedStrings = asArray(shared?.sst?.si).map(richText);

  for (const sheet of asArray<Record<string, unknown>>(
    workbook.workbook?.sheets?.sheet
  )) {
    const sheetName = normalizeText(sheet["@_name"]);
    const sheetPath = relationshipMap.get(String(sheet["@_id"] ?? ""));
    if (!sheetPath) continue;
    const worksheet = parse(sheetPath) as
      | {
          worksheet?: {
            sheetData?: {
              row?: Record<string, unknown> | Record<string, unknown>[];
            };
          };
        }
      | undefined;
    const matrix: Array<{ sourceRow: number; values: string[] }> = [];
    for (const [index, row] of asArray<Record<string, unknown>>(
      worksheet?.worksheet?.sheetData?.row
    ).entries()) {
      if (index >= MAX_ROWS) {
        return { rows: [], errors: ["Excel 行数超过安全上限"] };
      }
      const values: string[] = [];
      for (const cell of asArray<Record<string, unknown>>(
        row.c as Record<string, unknown> | Record<string, unknown>[] | undefined
      )) {
        const type = String(cell["@_t"] ?? "");
        const raw = type === "inlineStr" ? richText(cell.is) : richText(cell.v);
        values[columnIndex(String(cell["@_r"] ?? ""))] =
          type === "s"
            ? normalizeText(sharedStrings[Number(raw)] ?? "")
            : normalizeText(raw);
      }
      matrix.push({
        sourceRow: Number(row["@_r"] ?? index + 1),
        values
      });
    }
    const headers = matrix[0]?.values ?? [];
    if (!PACKAGING_REQUIRED_COLUMNS.every((column) => headers.includes(column))) {
      continue;
    }
    const rows = matrix.slice(1).map((row) => ({
      sourceRow: row.sourceRow,
      values: Object.fromEntries(
        headers
          .map((header, index) => [normalizeText(header), row.values[index] ?? ""])
          .filter(([header]) => Boolean(header))
      )
    }));
    return { sheetName, rows, errors: [] };
  }
  return {
    rows: [],
    errors: [
      `没有找到同时包含 ${PACKAGING_REQUIRED_COLUMNS.join("、")} 的工作表`
    ]
  };
}

export function parsePackagingDataset(input: {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly datasetId?: string;
  readonly version: string;
  readonly title?: string;
}): PackagingDatasetImport {
  assertSafeFileName(input.fileName);
  const sourceDigest = sha256(input.bytes);
  const extracted = extractWorkbookRows(input.bytes);
  if (extracted.errors.length > 0) {
    return {
      status: "invalid",
      records: [],
      errors: extracted.errors,
      warnings: [],
      sourceDigest
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const records: PackagingMasterRecord[] = [];
  const seenRecordDigests = new Map<string, number>();
  for (const row of extracted.rows) {
    const productName = normalizeText(row.values["产品名称"]);
    const brand = normalizeText(row.values["品牌"]);
    const weight = normalizeText(row.values["克重"]);
    const packagingShape = normalizeText(row.values["包装形态"]);
    if (![productName, brand, weight, packagingShape].some(Boolean)) continue;
    const missing = [
      ["产品名称", productName],
      ["品牌", brand],
      ["克重", weight],
      ["包装形态", packagingShape]
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      errors.push(`第 ${row.sourceRow} 行缺少：${missing.join("、")}`);
      continue;
    }
    try {
      const recordDigest = digestPackagingValue({
        productName,
        brand,
        weight,
        packagingShape
      });
      const duplicateRow = seenRecordDigests.get(recordDigest);
      if (duplicateRow !== undefined) {
        warnings.push(
          `第 ${row.sourceRow} 行与第 ${duplicateRow} 行内容重复，已忽略重复记录`
        );
        continue;
      }
      seenRecordDigests.set(recordDigest, row.sourceRow);
      records.push(
        createPackagingMasterRecord({
          id: `pack-${recordDigest.slice("sha256:".length, 31)}`,
          sourceRow: row.sourceRow,
          productName,
          brand,
          weight,
          packagingShape,
          recordDigest
        })
      );
    } catch (error) {
      errors.push(
        `第 ${row.sourceRow} 行无法生成稳定匹配键：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  const byKey = new Map<string, PackagingMasterRecord[]>();
  for (const record of records) {
    const matches = byKey.get(record.matchKey) ?? [];
    matches.push(record);
    byKey.set(record.matchKey, matches);
  }
  for (const duplicates of byKey.values()) {
    if (duplicates.length > 1) {
      warnings.push(
        `重复匹配键：${duplicates
          .map((record) => `第${record.sourceRow}行`)
          .join("、")}；将进入歧义队列`
      );
    }
  }
  if (records.length === 0) errors.push("Excel 中没有可发布的包装主数据");
  if (errors.length > 0) {
    return {
      status: "invalid",
      records,
      errors,
      warnings,
      sourceDigest,
      ...(extracted.sheetName ? { selectedSheet: extracted.sheetName } : {})
    };
  }
  const descriptor: DatasetDescriptor = {
    id: input.datasetId ?? "packaging-master",
    version: input.version,
    title: input.title ?? "包装主数据",
    profile: PACKAGING_DATASET_PROFILE,
    source: {
      fileName: input.fileName,
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: input.bytes.byteLength,
      digest: sourceDigest
    },
    recordSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "sourceRow",
        "productName",
        "brand",
        "weight",
        "packagingShape",
        "recordDigest",
        "normalizedName",
        "normalizedBrand",
        "weightSignature",
        "matchKey"
      ]
    },
    recordCount: records.length,
    recordsDigest: digestPackagingValue(
      records.map((record) => ({
        id: record.id,
        digest: record.recordDigest
      }))
    )
  };
  return {
    status: "valid",
    descriptor,
    records,
    errors: [],
    warnings,
    sourceDigest,
    ...(extracted.sheetName ? { selectedSheet: extracted.sheetName } : {})
  };
}
