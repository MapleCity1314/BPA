import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  inspectPriorityItems,
  type EditorObservation,
  type PriorityItemsInspectionReplay
} from "./editor-inspector.js";

interface CompactEditorFixture {
  product: PriorityItemsInspectionReplay["product"];
  packagingMatch: NonNullable<
    PriorityItemsInspectionReplay["packagingMatch"]
  >;
  repeatObservation: number;
  observation: EditorObservation;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/editor-unmatched-basic-check.replay.json",
      import.meta.url
    ),
    "utf8"
  )
) as CompactEditorFixture;

function replay(
  observation: EditorObservation = fixture.observation,
  repeat = fixture.repeatObservation
): PriorityItemsInspectionReplay {
  return {
    product: fixture.product,
    packagingMatch: fixture.packagingMatch,
    observations: Array.from({ length: repeat }, () => observation)
  };
}

describe("doudian editor priority-items deterministic replay", () => {
  it("continues baseline checks for an unmatched product", () => {
    const result = inspectPriorityItems(replay());
    expect(result).toMatchObject({
      status: "complete",
      productId: "3787892969076556012",
      packagingMatchStatus: "unmatched",
      baselineInspectionPerformed: true,
      readiness: { stableSamples: 3 },
      domMutations: 0
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "required_empty",
          ruleId: "required.combobox.empty",
          field: expect.objectContaining({ label: "产地" })
        }),
        expect.objectContaining({
          category: "required_empty",
          ruleId: "required.sku_cell.empty",
          field: expect.objectContaining({ skuId: "sku-redacted-1" })
        }),
        expect.objectContaining({
          category: "platform_warning",
          message: "建议补充商品属性"
        })
      ])
    );
    expect(result.anomalies).toEqual([]);
  });

  it("blocks platform risk and never tries to bypass it", () => {
    const risky: EditorObservation = {
      ...fixture.observation,
      riskSignals: [
        { code: "RISK_CONTROL", severity: "blocking" }
      ]
    };
    expect(inspectPriorityItems(replay(risky))).toMatchObject({
      status: "blocked",
      baselineInspectionPerformed: false,
      issues: [],
      anomalies: [{ code: "RISK_SIGNAL_BLOCKED", classification: "risk" }],
      domMutations: 0
    });
  });

  it("requires product id and both configured/observed editor URLs to align", () => {
    expect(
      inspectPriorityItems({
        ...replay(),
        product: { ...fixture.product, id: "bad" }
      })
    ).toMatchObject({
      status: "structural_anomaly",
      anomalies: [{ code: "PRODUCT_ID_INVALID" }]
    });
    expect(
      inspectPriorityItems(
        replay({
          ...fixture.observation,
          url: fixture.observation.url.replace(
            fixture.product.id,
            "3787892969076556013"
          )
        })
      )
    ).toMatchObject({
      status: "structural_anomaly",
      anomalies: [{ code: "EDITOR_URL_MISMATCH" }]
    });
    expect(
      inspectPriorityItems({
        ...replay(),
        product: {
          ...fixture.product,
          editorUrl: "https://example.com/edit"
        }
      })
    ).toMatchObject({
      anomalies: [{ code: "EDITOR_URL_MISMATCH" }]
    });
  });

  it("requires three stable samples and required-field evidence", () => {
    expect(inspectPriorityItems(replay(fixture.observation, 2))).toMatchObject({
      status: "retryable",
      baselineInspectionPerformed: false,
      anomalies: [{ code: "PAGE_NOT_STABLE" }]
    });
    expect(
      inspectPriorityItems({
        ...replay(),
        observations: []
      })
    ).toMatchObject({
      status: "retryable",
      anomalies: [{ code: "PAGE_NOT_STABLE" }]
    });
    const noMarkers: EditorObservation = {
      ...fixture.observation,
      readiness: {
        ...fixture.observation.readiness,
        requiredMarkers: 0
      }
    };
    expect(inspectPriorityItems(replay(noMarkers))).toMatchObject({
      status: "retryable",
      anomalies: [{ code: "REQUIRED_EVIDENCE_MISSING" }]
    });
  });

  it("classifies unknown or duplicate field structures separately from issues", () => {
    const {
      platformFillCheck: _platformFillCheck,
      ...observationWithoutPlatformCheck
    } = fixture.observation;
    const unknown: EditorObservation = {
      ...observationWithoutPlatformCheck,
      requiredFields: [
        {
          ...fixture.observation.requiredFields[0]!,
          key: "",
          valueState: "unknown"
        },
        {
          ...fixture.observation.requiredFields[0]!,
          key: "duplicate"
        },
        {
          ...fixture.observation.requiredFields[1]!,
          key: "duplicate"
        },
        {
          ...fixture.observation.requiredFields[1]!,
          key: "ignored-hidden",
          visible: false
        }
      ],
      skuRequiredCells: [
        {
          row: 2,
          column: "库存",
          required: true,
          visible: true,
          valueState: "unknown"
        },
        {
          row: 3,
          column: "库存",
          required: false,
          visible: true,
          valueState: "empty"
        }
      ]
    };
    const result = inspectPriorityItems({
      ...replay(unknown),
      packagingMatch: { status: "ambiguous" }
    });
    expect(result).toMatchObject({
      status: "structural_anomaly",
      packagingMatchStatus: "ambiguous",
      baselineInspectionPerformed: true
    });
    expect(result.anomalies.map((anomaly) => anomaly.code)).toEqual([
      "FIELD_STRUCTURE_UNKNOWN",
      "FIELD_STRUCTURE_UNKNOWN",
      "FIELD_STRUCTURE_UNKNOWN"
    ]);
    expect(result.issues).toEqual([]);
  });

  it("keeps optional platform-check availability from erasing baseline results", () => {
    const unavailable: EditorObservation = {
      ...fixture.observation,
      platformFillCheck: {
        requested: true,
        available: false,
        completed: false,
        warnings: []
      }
    };
    const { packagingMatch: _packagingMatch, ...withoutPackagingMatch } =
      replay(unavailable);
    const result = inspectPriorityItems(withoutPackagingMatch);
    expect(result).toMatchObject({
      status: "retryable",
      packagingMatchStatus: "not_provided",
      baselineInspectionPerformed: true,
      anomalies: [{ code: "PLATFORM_CHECK_UNAVAILABLE" }]
    });
    expect(result.issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining([
        "required.combobox.empty",
        "required.sku_cell.empty"
      ])
    );
  });

  it("deduplicates platform warnings and reports a healthy page as complete", () => {
    const healthy: EditorObservation = {
      ...fixture.observation,
      requiredFields: fixture.observation.requiredFields.map((field) => ({
        ...field,
        valueState: "filled"
      })),
      skuRequiredCells: fixture.observation.skuRequiredCells.map((cell) => ({
        ...cell,
        valueState: "filled"
      })),
      platformFillCheck: {
        requested: true,
        available: true,
        completed: true,
        warnings: ["同一提醒", " 同一提醒 ", ""]
      }
    };
    const result = inspectPriorityItems({
      ...replay(healthy),
      packagingMatch: { status: "matched", recordId: "record-redacted" }
    });
    expect(result).toMatchObject({
      status: "complete",
      packagingMatchStatus: "matched",
      baselineInspectionPerformed: true
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        category: "platform_warning",
        message: "同一提醒"
      })
    ]);
  });
});
