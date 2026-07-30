import {
  formatValidationErrors,
  validateSourceRecord,
  type SourceRecordDefinition
} from "@bpa/schemas";

export class SourceRecordValidationError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Invalid SourceRecord: ${reasons.join("; ")}`);
  }
}
export function assertSourceRecord(
  value: unknown
): asserts value is SourceRecordDefinition {
  if (!validateSourceRecord(value)) {
    throw new SourceRecordValidationError(
      formatValidationErrors(validateSourceRecord.errors)
    );
  }
  const source = value as SourceRecordDefinition;
  const observedAt = Date.parse(source.observedAt);
  const recordedAt = Date.parse(source.recordedAt);
  if (observedAt > recordedAt) {
    throw new SourceRecordValidationError([
      "observedAt must not be later than recordedAt"
    ]);
  }
  if (source.sourceType === "third_party_estimate") {
    const locator = source.locator as {
      windowStart: string;
      windowEnd: string;
    };
    if (Date.parse(locator.windowStart) >= Date.parse(locator.windowEnd)) {
      throw new SourceRecordValidationError([
        "third-party estimate windowStart must be earlier than windowEnd"
      ]);
    }
    if (Date.parse(locator.windowEnd) > observedAt) {
      throw new SourceRecordValidationError([
        "third-party estimate windowEnd must not be later than observedAt"
      ]);
    }
  }
}

export function parseSourceRecord(value: unknown): SourceRecordDefinition {
  assertSourceRecord(value);
  return structuredClone(value);
}
