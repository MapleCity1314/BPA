import { describe, expect, it } from "vitest";
import { createPackagingMasterRecord } from "@bpa/packaging-domain";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  ISSUES_RECONCILE_HANDLER_REF,
  INVENTORY_CHANNEL_ESTIMATE_HANDLER_REF,
  INVENTORY_RISK_EVALUATE_HANDLER_REF,
  PACKAGING_INSPECTION_MATCH_HANDLER_REF,
  PACKAGING_MATCH_HANDLER_REF,
  PACKAGING_PRODUCTS_NORMALIZE_HANDLER_REF,
  REPORT_ISSUE_BUILD_HANDLER_REF,
  SALES_DEMAND_FORECAST_HANDLER_REF,
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS,
  teamHandlerRegistry
} from "./handlers.js";

const workbookBase64 =
  "UEsDBBQAAAAIADyO/FzjZ0sllQAAALcAAAAPAAAAeGwvd29ya2Jvb2sueG1sNU7JDYMwEGzFcgEs5JEHAvPJhzIcWGIL7EW7ztEAv3SR2iKljFhReM2lGU3TPcKibsjiKba6KkrdmeZOPJ+JZpXDKDW32qW01gAyOAxWClox5mwiDjZlyRegafIDnmi4BowJDmV5BMbFpjwszq+iTSMOMckfVbQBW/1+bp/XptXP68f8QSuufSbcj5UG08Beg/2X+QJQSwMEFAAAAAgAPI78XPE9z0JQAAAAbAAAABoAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc7Oxr8jNUShLLSrOzM+zVTLUM1Cyt7MJSs1JLAEKFGdkFhSjchU8U2yVijxTDJUUQhKL0lNLbJXK84uyizNSU0uK9cGUoR7QTCV9Oxt9VHMAUEsDBBQAAAAIADyO/FxYs4WyzgAAAAoCAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1ss7GvyM1RKEstKs7Mz7NVMtQzULK3synPL8ouzkhNLbGzAVMuiSWJdjZF+eUKRUA1SnY2ySCGo6GSQomtUmZeTmZeanBJEVA8s9jOpsTuya7lTyc3Pp3Q+3z5Bht9oCH6IHH9ZKg+J1z6gJqed/Zg0eGMU0dr98v2Xiw6XHDq6Gl9sbj16d5FzxoaUfXpA/0H96QR3JNGOAx6uWnO86Zpz9unPl81F5sncel7vmTXk33duL2KS5+5Qfrh6WbYvIrTptmTsPlQHylK9RExDQBQSwECFAAUAAAACAA8jvxc42dLJZUAAAC3AAAADwAAAAAAAAAAAAAAAAAAAAAAeGwvd29ya2Jvb2sueG1sUEsBAhQAFAAAAAgAPI78XPE9z0JQAAAAbAAAABoAAAAAAAAAAAAAAAAAwgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzUEsBAhQAFAAAAAgAPI78XFizhbLOAAAACgIAABgAAAAAAAAAAAAAAAAASgEAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLBQYAAAAAAwADAMsAAABOAgAAAAA=";

async function invoke(
  ref: string,
  input: JsonValue,
  signal = new AbortController().signal
): Promise<JsonValue> {
  const [id, version] = ref.split("@");
  return teamHandlerRegistry
    .get({ id: id!, version: version! })
    .invoke(input, signal);
}

describe("trusted Team Worker handlers", () => {
  it("runs bounded inventory forecast, channel estimation and risk handlers", async () => {
    const forecast = await invoke(SALES_DEMAND_FORECAST_HANDLER_REF, {
      asOf: "2026-08-02T12:00:00.000Z",
      observations: Array.from({ length: 35 * 24 }, (_, index) => ({
        at: new Date(Date.parse("2026-06-28T12:00:00.000Z") + index * 3_600_000).toISOString(),
        quantity: 1
      }))
    });
    expect(forecast).toMatchObject({
      algorithmVersion: "inventory-demand-ensemble-conformal/1.0.0",
      horizons: [{ hours: 2 }, { hours: 6 }, { hours: 24 }]
    });
    await expect(invoke(INVENTORY_CHANNEL_ESTIMATE_HANDLER_REF, {
      asOf: "2026-08-02T12:00:00.000Z",
      points: []
    })).resolves.toMatchObject({ status: "unknown" });
    await expect(invoke(INVENTORY_RISK_EVALUATE_HANDLER_REF, {
      evaluatedAt: "2026-08-02T12:00:00.000Z",
      envelope: {
        schemaVersion: "bpa.inventory-fact/1",
        observedAt: "2026-08-02T10:00:00.000Z",
        asOf: "2026-08-02T10:00:00.000Z",
        scope: { shopId: "shop-1", productId: "product-1" },
        facts: { productId: "product-1", title: "商品", totalStock: 0, skus: [] },
        quality: { freshness: "stale", completeness: 1, mappingConfidence: "high", diagnostics: [] },
        source: { kind: "test", datasetId: "inventory", datasetVersion: "v1", digest: `sha256:${"a".repeat(64)}` }
      },
      forecasts: {},
      channelEstimates: {}
    })).resolves.toMatchObject({ severity: "unknown" });
  });

  it("normalizes collected scope products and keeps unmatched products inspectable", async () => {
    const normalized = await invoke(PACKAGING_PRODUCTS_NORMALIZE_HANDLER_REF, {
      shopId: "shop-1",
      products: [
        {
          id: "10001",
          title: "示例品牌 鲜炖燕窝 70g×6",
          editorUrl:
            "https://fxg.jinritemai.com/ffa/g/create?product_id=10001"
        },
        {
          id: "10002",
          title: "无关商品 100g",
          editorUrl:
            "https://fxg.jinritemai.com/ffa/g/create?product_id=10002"
        }
      ]
    });
    const record = createPackagingMasterRecord({
      id: "record-1",
      sourceRow: 2,
      productName: "鲜炖燕窝",
      brand: "示例品牌",
      weight: "70g×6",
      packagingShape: "盒",
      recordDigest: `sha256:${"a".repeat(64)}`
    });
    const matched = await invoke(
      PACKAGING_INSPECTION_MATCH_HANDLER_REF,
      JSON.parse(
        JSON.stringify({
          products: (normalized as Record<string, JsonValue>).products!,
          records: [record]
        })
      ) as JsonValue
    );
    expect(matched).toMatchObject({
      matched: [{ product: { productId: "10001" } }],
      unmatched: [{ product: { productId: "10002" } }],
      inspectionQueue: [
        {
          product: { id: "10001" },
          packagingMatch: { status: "matched", recordId: "record-1" }
        },
        {
          product: { id: "10002" },
          packagingMatch: { status: "unmatched" }
        }
      ]
    });
  });

  it("runs packaging.master.match.batch through packaging-domain", async () => {
    const record = createPackagingMasterRecord({
      id: "record-1",
      sourceRow: 2,
      productName: "鲜炖燕窝",
      brand: "示例品牌",
      weight: "70g×6",
      packagingShape: "盒",
      recordDigest: `sha256:${"a".repeat(64)}`
    });
    const input = JSON.parse(
      JSON.stringify({
        products: [
          {
            shopId: "shop-1",
            productId: "product-1",
            title: "示例品牌 鲜炖燕窝 70g×6"
          }
        ],
        records: [record]
      })
    ) as JsonValue;
    const output = await invoke(PACKAGING_MATCH_HANDLER_REF, input);
    expect(output).toMatchObject({
      matcherVersion: "packaging-smart-v1",
      matched: [{ product: { productId: "product-1" } }],
      ambiguous: [],
      unmatched: []
    });
    expect(TEAM_WORKER_HANDLER_REFS).toContain(
      PACKAGING_MATCH_HANDLER_REF
    );
    expect(TEAM_WORKER_CODE_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects malformed and oversized match envelopes", async () => {
    await expect(
      invoke(PACKAGING_MATCH_HANDLER_REF, null)
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
    await expect(
      invoke(PACKAGING_MATCH_HANDLER_REF, {
        products: [],
        records: [],
        bindings: []
      })
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
    await expect(
      invoke(PACKAGING_MATCH_HANDLER_REF, {
        products: Array.from({ length: 501 }, (_, index) => ({
          shopId: "shop-1",
          productId: `product-${index}`,
          title: "商品"
        })),
        records: []
      })
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
  });

  it("parses a bounded base64 Excel payload through packaging-master-v1", async () => {
    await expect(
      invoke("packaging.dataset.parse@1.0.0", {
        contentBase64: workbookBase64,
        fileName: "包装主数据.xlsx",
        version: "1.0.0",
        datasetId: "packaging-master",
        title: "包装主数据"
      })
    ).resolves.toMatchObject({
      status: "valid",
      descriptor: {
        profile: { id: "packaging-master-v1", version: "1.0.0" },
        recordCount: 1
      },
      records: [
        {
          productName: "鲜炖燕窝",
          brand: "示例品牌",
          weight: "70g×6",
          packagingShape: "盒"
        }
      ],
      errors: []
    });
    await expect(
      invoke("packaging.dataset.parse@1.0.0", {
        contentBase64: "not-base64",
        fileName: "包装主数据.xlsx",
        version: "1.0.0"
      })
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
    await expect(
      invoke("packaging.dataset.parse@1.0.0", {
        contentBase64: "",
        fileName: "包装主数据.xlsx",
        version: "1.0.0"
      })
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
    await expect(
      invoke("packaging.dataset.parse@1.0.0", {
        contentBase64: Buffer.alloc(512 * 1024 + 1).toString("base64"),
        fileName: "包装主数据.xlsx",
        version: "1.0.0"
      })
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
  });

  it("reconciles only real page findings while retaining unmatched state", async () => {
    const output = await invoke(ISSUES_RECONCILE_HANDLER_REF, {
      inspections: [
        {
          productId: "product-1",
          status: "complete",
          packagingMatchStatus: "unmatched",
          baselineInspectionPerformed: true,
          issues: [],
          anomalies: []
        },
        {
          productId: "product-2",
          status: "complete",
          packagingMatchStatus: "ambiguous",
          baselineInspectionPerformed: true,
          issues: [
            {
              category: "required_empty",
              severity: "error",
              ruleId: "required.combobox.empty",
              message: "产地为必填项，但当前为空",
              evidence: "来自只读字段值观察"
            },
            {
              category: "platform_warning",
              severity: "warning",
              ruleId: "platform.fill_check",
              message: "建议补充商品属性",
              evidence: "来自抖店填写检查"
            }
          ],
          anomalies: []
        }
      ]
    });
    expect(output).toMatchObject({
      summary: {
        totalProducts: 2,
        affectedProducts: 1,
        pageIssueCount: 1,
        platformReminderCount: 1,
        matchStatusCounts: { unmatched: 1, ambiguous: 1 }
      },
      products: [
        {
          productId: "product-1",
          packagingMatchStatus: "unmatched",
          pageIssues: [],
          platformReminders: []
        },
        {
          productId: "product-2",
          packagingMatchStatus: "ambiguous"
        }
      ]
    });
  });

  it("maps reconciliation contract violations to stable Handler errors", async () => {
    await expect(
      invoke(ISSUES_RECONCILE_HANDLER_REF, {
        inspections: [
          {
            productId: "product-1",
            status: "complete",
            packagingMatchStatus: "unmatched",
            baselineInspectionPerformed: true,
            issues: [
              {
                category: "packaging_unmatched",
                severity: "warning",
                ruleId: "matching.failed",
                message: "未匹配",
                evidence: "包装匹配"
              }
            ],
            anomalies: []
          }
        ]
      })
    ).rejects.toMatchObject({
      code: "TEAM_HANDLER_INPUT_INVALID"
    });
  });

  it("builds a deterministic report and recalculates issue statistics", async () => {
    const reconciliation = await invoke(ISSUES_RECONCILE_HANDLER_REF, {
      inspections: [
        {
          productId: "product-1",
          status: "complete",
          packagingMatchStatus: "unmatched",
          baselineInspectionPerformed: true,
          issues: [],
          anomalies: []
        }
      ]
    });
    const input = {
      context: { runId: "run-1", shopId: "shop-1" },
      reconciliation: {
        ...(reconciliation as Record<string, JsonValue>),
        summary: {
          pageIssueCount: 999,
          platformReminderCount: 999
        }
      }
    } as JsonValue;
    const first = await invoke(REPORT_ISSUE_BUILD_HANDLER_REF, input);
    const second = await invoke(REPORT_ISSUE_BUILD_HANDLER_REF, input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: "bpa.issue-report/1",
      summary: {
        pageIssueCount: 0,
        platformReminderCount: 0,
        matchStatusCounts: { unmatched: 1 }
      },
      products: [
        {
          productId: "product-1",
          packagingMatchStatus: "unmatched"
        }
      ]
    });
  });

  it("honours cancellation before every pure Handler", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoke(
        ISSUES_RECONCILE_HANDLER_REF,
        { inspections: [] },
        controller.signal
      )
    ).rejects.toMatchObject({
      code: "TEAM_HANDLER_CANCELLED"
    });
  });
});
