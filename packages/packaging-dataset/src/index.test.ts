import { existsSync, readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parsePackagingDataset } from "./index.js";

const workbookPath =
  "/Users/yibazhua/Documents/02-internal-systems/重点项检查插件/outputs/feishu_export_20260723/产品索引_产品包装版本_2026-07-23.xlsx";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fixtureWorkbook(rows: readonly (readonly string[])[]): Uint8Array {
  const columns = ["A", "B", "C", "D"];
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (value, columnIndex) =>
              `<c r="${columns[columnIndex]}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`
          )
          .join("")}</row>`
    )
    .join("");
  return zipSync({
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="产品包装版本" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`
    )
  });
}

describe("packaging-master-v1 Excel profile", () => {
  it("imports a portable workbook fixture without retaining a path", () => {
    const bytes = fixtureWorkbook([
      ["产品名称", "品牌", "克重", "包装形态"],
      ["东北酸菜丝500g [榆园]", "榆园", "500g", "正反面包装"],
      ["冷面350g [昊七七]", "昊七七", "350g", "透明袋贴纸"]
    ]);
    const imported = parsePackagingDataset({
      bytes,
      fileName: "产品索引_产品包装版本.xlsx",
      version: "1.0.0"
    });
    expect(imported.errors).toEqual([]);
    expect(imported.status).toBe("valid");
    expect(imported.records).toHaveLength(2);
    expect(imported.descriptor).toMatchObject({
      id: "packaging-master",
      version: "1.0.0",
      recordCount: 2,
      profile: { id: "packaging-master-v1", version: "1.0.0" }
    });
    expect(imported.descriptor).not.toHaveProperty("path");
  });

  it.runIf(existsSync(workbookPath))(
    "keeps the proven 35-row business workbook as a local regression",
    () => {
    const bytes = readFileSync(workbookPath);
    const imported = parsePackagingDataset({
      bytes,
      fileName: "产品索引_产品包装版本_2026-07-23.xlsx",
      version: "1.0.0"
    });
    expect(imported.errors).toEqual([]);
    expect(imported.status).toBe("valid");
    expect(imported.records).toHaveLength(35);
    expect(imported.descriptor).toMatchObject({
      id: "packaging-master",
      version: "1.0.0",
      recordCount: 35,
      profile: { id: "packaging-master-v1", version: "1.0.0" }
    });
    expect(imported.descriptor).not.toHaveProperty("path");
    }
  );

  it("uses content identities so unrelated row insertion does not invalidate a binding", () => {
    const original = fixtureWorkbook([
      ["产品名称", "品牌", "克重", "包装形态"],
      ["东北酸菜丝500g [榆园]", "榆园", "500g", "正反面包装"],
      ["冷面350g [昊七七]", "昊七七", "350g", "透明袋贴纸"]
    ]);
    const first = parsePackagingDataset({
      bytes: original,
      fileName: "master.xlsx",
      version: "1.0.0"
    });
    const changed = parsePackagingDataset({
      bytes: fixtureWorkbook([
        ["产品名称", "品牌", "克重", "包装形态"],
        ["新商品100g [新品牌]", "新品牌", "100g", "纸盒"],
        ["东北酸菜丝500g [榆园]", "榆园", "500g", "正反面包装"],
        ["冷面350g [昊七七]", "昊七七", "350g", "透明袋贴纸"]
      ]),
      fileName: "master.xlsx",
      version: "1.1.0"
    });
    const target = first.records.find(
      (record) => record.productName === "东北酸菜丝500g [榆园]"
    );
    const shifted = changed.records.find(
      (record) => record.productName === target?.productName
    );
    expect(target?.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(target?.recordDigest).not.toBe(first.descriptor?.recordsDigest);
    expect(shifted?.sourceRow).not.toBe(target?.sourceRow);
    expect(shifted?.id).toBe(target?.id);
    expect(shifted?.recordDigest).toBe(target?.recordDigest);
  });

  it("deduplicates exact repeated business records", () => {
    const imported = parsePackagingDataset({
      bytes: fixtureWorkbook([
        ["产品名称", "品牌", "克重", "包装形态"],
        ["东北酸菜丝500g [榆园]", "榆园", "500g", "正反面包装"],
        ["东北酸菜丝500g [榆园]", "榆园", "500g", "正反面包装"]
      ]),
      fileName: "master.xlsx",
      version: "1.0.0"
    });
    expect(imported.status).toBe("valid");
    expect(imported.records).toHaveLength(1);
    expect(imported.warnings).toEqual([
      "第 3 行与第 2 行内容重复，已忽略重复记录"
    ]);
  });

  it("rejects malformed containers and unsafe names", () => {
    const malformed = parsePackagingDataset({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "master.xlsx",
      version: "1.0.0"
    });
    expect(malformed.status).toBe("invalid");
    expect(malformed.errors[0]).toContain("ZIP");
    expect(() =>
      parsePackagingDataset({
        bytes: new Uint8Array([1]),
        fileName: "../master.xlsx",
        version: "1.0.0"
      })
    ).toThrow("safe .xlsx");
  });

  it("rejects unsafe ZIP paths and extreme compression before XML parsing", () => {
    const unsafePath = parsePackagingDataset({
      bytes: zipSync({ "../xl/workbook.xml": strToU8("<workbook/>") }),
      fileName: "master.xlsx",
      version: "1.0.0"
    });
    expect(unsafePath.status).toBe("invalid");
    expect(unsafePath.errors[0]).toContain("不安全路径");

    const compressedBomb = parsePackagingDataset({
      bytes: zipSync(
        {
          "xl/workbook.xml": new Uint8Array(2 * 1024 * 1024).fill(65)
        },
        { level: 9 }
      ),
      fileName: "master.xlsx",
      version: "1.0.0"
    });
    expect(compressedBomb.status).toBe("invalid");
    expect(compressedBomb.errors[0]).toContain("压缩比");
  });
});
