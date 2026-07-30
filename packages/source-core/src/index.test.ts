import { describe, expect, it } from "vitest";
import { assertSourceRecord, SourceRecordValidationError } from "./index.js";

function source() {
  return {
    apiVersion: "bpa.source/v1alpha1",
    kind: "SourceRecord",
    sourceId: "source:test:1",
    sourceType: "third_party_estimate",
    locator: {
      provider: "chanmama",
      metricDefinition: "Estimated orders.",
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-06-30T00:00:00.000Z",
      estimated: true
    },
    observedAt: "2026-07-01T00:00:00.000Z",
    recordedAt: "2026-07-01T00:00:01.000Z",
    accessScope: "membership",
    adapter: {
      id: "chanmama",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`
    },
    rawDigest: `sha256:${"b".repeat(64)}`,
    classification: "internal"
  };
}

describe("SourceRecord", () => {
  it("validates schema and chronology", () => {
    expect(() => assertSourceRecord(source())).not.toThrow();
    expect(() =>
      assertSourceRecord({
        ...source(),
        recordedAt: "2026-06-30T23:59:59.000Z"
      })
    ).toThrow(SourceRecordValidationError);
  });

  it("rejects an estimate window after observation", () => {
    const value = source();
    value.locator.windowEnd = "2026-07-02T00:00:00.000Z";
    expect(() => assertSourceRecord(value)).toThrow(
      "windowEnd must not be later"
    );
  });
});
