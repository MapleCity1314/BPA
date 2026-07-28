import { describe, expect, it } from "vitest";
import {
  MAX_RECONCILE_PRODUCTS,
  buildDeterministicIssueReport,
  reconcilePriorityInspectionResults
} from "./issue-report.js";

function inspection(
  productId: string,
  packagingMatchStatus:
    | "matched"
    | "ambiguous"
    | "unmatched"
    | "not_provided",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    productId,
    status: "complete",
    packagingMatchStatus,
    baselineInspectionPerformed: true,
    issues: [],
    anomalies: [],
    ...overrides
  };
}

const requiredIssue = {
  category: "required_empty",
  severity: "error",
  ruleId: "required.text.empty",
  message: "商品名称为必填项，但当前为空",
  evidence: "来自只读字段值观察",
  field: {
    key: "product_name",
    label: "商品名称",
    section: "基础信息",
    controlKind: "text"
  }
};

const platformReminder = {
  category: "platform_warning",
  severity: "warning",
  ruleId: "platform.fill_check",
  message: "建议补充商品属性",
  evidence: "来自抖店填写检查"
};

const structureAnomaly = {
  code: "FIELD_STRUCTURE_UNKNOWN",
  classification: "structure",
  retryable: false,
  message: "无法确定必填字段的值状态"
};

describe("packaging issue reconciliation", () => {
  it("retains unmatched and ambiguous state without inventing product issues", () => {
    const result = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-2", "ambiguous"),
        inspection("product-1", "unmatched")
      ]
    });
    expect(result.products.map((product) => product.productId)).toEqual([
      "product-1",
      "product-2"
    ]);
    expect(result.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packagingMatchStatus: "unmatched",
          pageIssues: [],
          platformReminders: []
        }),
        expect.objectContaining({
          packagingMatchStatus: "ambiguous",
          pageIssues: [],
          platformReminders: []
        })
      ])
    );
    expect(result.summary).toMatchObject({
      totalProducts: 2,
      affectedProducts: 0,
      pageIssueCount: 0,
      platformReminderCount: 0,
      inspectionAnomalyCount: 0,
      matchStatusCounts: {
        unmatched: 1,
        ambiguous: 1
      }
    });
  });

  it("separates real page issues, platform reminders, and inspection anomalies", () => {
    const result = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "unmatched", {
          issues: [
            platformReminder,
            requiredIssue,
            { ...platformReminder, message: " 建议补充商品属性 " }
          ],
          anomalies: [structureAnomaly, structureAnomaly]
        })
      ]
    });
    expect(result.products[0]).toMatchObject({
      packagingMatchStatus: "unmatched",
      pageIssues: [requiredIssue],
      platformReminders: [platformReminder],
      inspectionAnomalies: [structureAnomaly]
    });
    expect(result.summary).toMatchObject({
      affectedProducts: 1,
      pageIssueCount: 1,
      platformReminderCount: 1,
      inspectionAnomalyCount: 1
    });
  });

  it("keeps adapter anomalies out of the business affected-product count", () => {
    const result = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "matched", {
          status: "structural_anomaly",
          baselineInspectionPerformed: false,
          anomalies: [structureAnomaly]
        })
      ]
    });
    expect(result.summary).toMatchObject({
      affectedProducts: 0,
      pageIssueCount: 0,
      platformReminderCount: 0,
      inspectionAnomalyCount: 1
    });
  });

  it("rejects non-page issue categories and duplicate product identities", () => {
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: [
          inspection("product-1", "unmatched", {
            issues: [
              {
                ...platformReminder,
                category: "packaging_unmatched"
              }
            ]
          })
        ]
      })
    ).toThrow(/category/u);
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: [
          inspection("product-1", "matched"),
          inspection("product-1", "unmatched")
        ]
      })
    ).toThrow(/Duplicate/u);
  });

  it("validates field, status, and aggregate finding bounds", () => {
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: [
          inspection("product-1", "matched", {
            issues: [
              {
                ...requiredIssue,
                field: { ...requiredIssue.field, row: -1 }
              }
            ]
          })
        ]
      })
    ).toThrow(/row/u);
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: [
          inspection("product-1", "matched", {
            baselineInspectionPerformed: "yes"
          })
        ]
      })
    ).toThrow(/boolean/u);
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: Array.from({ length: 11 }, (_, index) =>
          inspection(`product-${index}`, "matched", {
            issues: Array.from({ length: 50 }, (__, findingIndex) => ({
              ...requiredIssue,
              ruleId: `required.${index}.${findingIndex}`
            }))
          })
        )
      })
    ).toThrow(/total findings/u);
  });

  it("enforces a finite product bound", () => {
    expect(() =>
      reconcilePriorityInspectionResults({
        inspections: Array.from(
          { length: MAX_RECONCILE_PRODUCTS + 1 },
          (_, index) => inspection(`product-${index}`, "matched")
        )
      })
    ).toThrow(/at most/u);
  });
});

describe("deterministic issue report", () => {
  it("recomputes issue totals and excludes match failure from the issue fingerprint", () => {
    const unmatched = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "unmatched", {
          issues: [requiredIssue, platformReminder]
        })
      ]
    });
    const ambiguous = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "ambiguous", {
          issues: [requiredIssue, platformReminder]
        })
      ]
    });
    const first = buildDeterministicIssueReport({
      context: { runId: "run-1", shopId: "shop-1" },
      reconciliation: {
        ...unmatched,
        summary: {
          ...unmatched.summary,
          pageIssueCount: 999
        }
      }
    });
    const repeated = buildDeterministicIssueReport({
      context: { runId: "run-1", shopId: "shop-1" },
      reconciliation: unmatched
    });
    const changedMatch = buildDeterministicIssueReport({
      context: { runId: "run-1", shopId: "shop-1" },
      reconciliation: ambiguous
    });
    expect(first).toEqual(repeated);
    expect(first.summary).toMatchObject({
      pageIssueCount: 1,
      platformReminderCount: 1,
      matchStatusCounts: { unmatched: 1 }
    });
    expect(first.products[0]?.packagingMatchStatus).toBe("unmatched");
    expect(changedMatch.products[0]?.packagingMatchStatus).toBe("ambiguous");
    expect(changedMatch.issueFingerprint).toBe(first.issueFingerprint);
    expect(changedMatch.reportDigest).not.toBe(first.reportDigest);
  });

  it("supports a context-free report and preserves bounded SKU field facts", () => {
    const reconciliation = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "matched", {
          issues: [
            {
              ...requiredIssue,
              field: {
                ...requiredIssue.field,
                controlKind: "sku_cell",
                skuId: "sku-1",
                row: 2
              }
            }
          ]
        })
      ]
    });
    const report = buildDeterministicIssueReport({ reconciliation });
    expect(report).not.toHaveProperty("context");
    expect(report.products[0]?.pageIssues[0]?.field).toMatchObject({
      skuId: "sku-1",
      row: 2
    });
  });

  it("excludes adapter diagnostics from the business issue fingerprint", () => {
    const clean = reconcilePriorityInspectionResults({
      inspections: [inspection("product-1", "matched")]
    });
    const anomalous = reconcilePriorityInspectionResults({
      inspections: [
        inspection("product-1", "matched", {
          status: "structural_anomaly",
          baselineInspectionPerformed: false,
          anomalies: [structureAnomaly]
        })
      ]
    });
    const cleanReport = buildDeterministicIssueReport({
      reconciliation: clean
    });
    const anomalyReport = buildDeterministicIssueReport({
      reconciliation: anomalous
    });
    expect(anomalyReport.issueFingerprint).toBe(cleanReport.issueFingerprint);
    expect(anomalyReport.reportDigest).not.toBe(cleanReport.reportDigest);
  });
});
