import type {
  DatasetVersionDefinition,
  DecisionRecordDefinition
} from "@bpa/schemas";

/**
 * Authoring input. It deliberately has a different name from the canonical
 * DatasetVersion DTO so callers cannot accidentally persist the wrong shape.
 */
export interface DatasetDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description?: string;
  readonly profile: DatasetVersionDefinition["profile"];
  readonly source: DatasetVersionDefinition["source"];
  readonly recordSchema: DatasetVersionDefinition["recordSchema"];
  readonly recordCount: number;
  readonly recordsDigest: string;
}

export interface PublishedDataset {
  readonly definition: DatasetVersionDefinition;
  readonly publishedAt: string;
}

export interface DatasetRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface DecisionCandidate<TValue = unknown> {
  readonly decisionId: string;
  readonly decisionType: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly preconditions: Readonly<Record<string, string>>;
  readonly value: TValue;
  readonly valueDigest?: string;
  readonly proposedAt: string;
}

export type DecisionRecord<TValue = unknown> = Omit<
  DecisionRecordDefinition,
  "value"
> & {
  readonly value: TValue;
};

export interface DecisionReuseContext {
  readonly scope: Readonly<Record<string, string>>;
  readonly preconditions: Readonly<Record<string, string>>;
}

export type DecisionReuseMismatch =
  | "status"
  | "scope"
  | "preconditions";

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function frozenRecord(
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return Object.freeze({ ...value });
}

function validateStringRecord(
  value: Readonly<Record<string, string>>,
  label: string
): void {
  if (Object.keys(value).length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    requireText(key, `${label} key`);
    requireText(fieldValue, `${label}.${key}`);
  }
}

export function publishDataset(
  descriptor: DatasetDescriptor,
  input: { readonly publishedAt: string }
): PublishedDataset {
  requireText(descriptor.id, "id");
  requireText(descriptor.version, "version");
  requireText(descriptor.title, "title");
  requireText(descriptor.profile.id, "profile.id");
  requireText(descriptor.profile.version, "profile.version");
  requireText(descriptor.source.fileName, "source.fileName");
  requireText(descriptor.source.mediaType, "source.mediaType");
  requireText(descriptor.source.digest, "source.digest");
  requireText(descriptor.recordsDigest, "recordsDigest");
  if (
    !Number.isSafeInteger(descriptor.source.size) ||
    descriptor.source.size < 0 ||
    !Number.isSafeInteger(descriptor.recordCount) ||
    descriptor.recordCount < 0
  ) {
    throw new Error("Dataset sizes and counts must be non-negative integers");
  }
  requireTimestamp(input.publishedAt, "publishedAt");
  const definition: DatasetVersionDefinition = {
    apiVersion: "bpa.data/v1alpha1",
    kind: "DatasetVersion",
    metadata: {
      id: descriptor.id,
      version: descriptor.version,
      title: descriptor.title,
      ...(descriptor.description === undefined
        ? {}
        : { description: descriptor.description })
    },
    profile: Object.freeze({ ...descriptor.profile }),
    source: Object.freeze({ ...descriptor.source }),
    recordSchema: Object.freeze({ ...descriptor.recordSchema }),
    recordCount: descriptor.recordCount,
    recordsDigest: descriptor.recordsDigest
  };
  Object.freeze(definition.metadata);
  Object.freeze(definition);
  return Object.freeze({
    definition,
    publishedAt: input.publishedAt
  });
}

export function publishedDatasetFromDefinition(
  definition: DatasetVersionDefinition,
  input: { readonly publishedAt: string }
): PublishedDataset {
  return publishDataset(
    {
      id: definition.metadata.id,
      version: definition.metadata.version,
      title: definition.metadata.title,
      ...(definition.metadata.description === undefined
        ? {}
        : { description: definition.metadata.description }),
      profile: definition.profile,
      source: definition.source,
      recordSchema: definition.recordSchema,
      recordCount: definition.recordCount,
      recordsDigest: definition.recordsDigest
    },
    input
  );
}

export function toDatasetVersionDefinition(
  published: PublishedDataset
): DatasetVersionDefinition {
  return published.definition;
}

export function datasetRef(published: PublishedDataset): DatasetRef {
  return Object.freeze({
    id: published.definition.metadata.id,
    version: published.definition.metadata.version,
    digest: published.definition.recordsDigest
  });
}

export function datasetRefEquals(
  left: DatasetRef,
  right: DatasetRef
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

export function createDecisionCandidate<TValue>(input: {
  readonly decisionId: string;
  readonly decisionType: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly preconditions: Readonly<Record<string, string>>;
  readonly value: TValue;
  readonly valueDigest?: string;
  readonly proposedAt: string;
}): DecisionCandidate<TValue> {
  requireText(input.decisionId, "decisionId");
  requireText(input.decisionType, "decisionType");
  validateStringRecord(input.scope, "scope");
  validateStringRecord(input.preconditions, "preconditions");
  if (input.valueDigest !== undefined) {
    requireText(input.valueDigest, "valueDigest");
  }
  requireTimestamp(input.proposedAt, "proposedAt");
  return Object.freeze({
    ...input,
    scope: frozenRecord(input.scope),
    preconditions: frozenRecord(input.preconditions)
  });
}

export function confirmDecisionCandidate<TValue>(
  candidate: DecisionCandidate<TValue>,
  input: {
    readonly confirmedBy: string;
    readonly confirmedAt: string;
  }
): DecisionRecord<TValue> {
  requireText(input.confirmedBy, "confirmedBy");
  requireTimestamp(input.confirmedAt, "confirmedAt");
  if (Date.parse(input.confirmedAt) < Date.parse(candidate.proposedAt)) {
    throw new Error("confirmedAt cannot precede proposedAt");
  }
  return freezeDecisionRecord({
    apiVersion: "bpa.decision/v1alpha1",
    decisionId: candidate.decisionId,
    decisionType: candidate.decisionType,
    status: "active",
    scope: { ...candidate.scope },
    preconditions: { ...candidate.preconditions },
    value: candidate.value,
    ...(candidate.valueDigest === undefined
      ? {}
      : { valueDigest: candidate.valueDigest }),
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt
  });
}

function freezeDecisionRecord<TValue>(
  record: DecisionRecord<TValue>
): DecisionRecord<TValue> {
  Object.freeze(record.scope);
  Object.freeze(record.preconditions);
  return Object.freeze(record);
}

export function revokeDecision<TValue>(
  record: DecisionRecord<TValue>,
  input: {
    readonly revokedBy: string;
    readonly revokedAt: string;
  }
): DecisionRecord<TValue> {
  if (record.status !== "active") {
    throw new Error("Only an active decision can be revoked");
  }
  requireText(input.revokedBy, "revokedBy");
  requireTimestamp(input.revokedAt, "revokedAt");
  if (Date.parse(input.revokedAt) < Date.parse(record.confirmedAt)) {
    throw new Error("revokedAt cannot precede confirmedAt");
  }
  return freezeDecisionRecord({
    ...record,
    status: "revoked",
    revokedAt: input.revokedAt,
    revokedBy: input.revokedBy
  });
}

export function supersedeDecision<TOld, TNew>(
  record: DecisionRecord<TOld>,
  replacement: DecisionCandidate<TNew>,
  input: {
    readonly confirmedBy: string;
    readonly confirmedAt: string;
  }
): {
  readonly superseded: DecisionRecord<TOld>;
  readonly replacement: DecisionRecord<TNew>;
} {
  if (record.status !== "active") {
    throw new Error("Only an active decision can be superseded");
  }
  if (
    record.decisionType !== replacement.decisionType ||
    !recordsEqual(record.scope, replacement.scope)
  ) {
    throw new Error("Replacement must have the same decision type and scope");
  }
  const activeReplacement = confirmDecisionCandidate(replacement, input);
  return Object.freeze({
    superseded: freezeDecisionRecord({
      ...record,
      status: "superseded"
    }),
    replacement: freezeDecisionRecord({
      ...activeReplacement,
      supersedes: record.decisionId
    })
  });
}

function recordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && left[key] === right[key]
    )
  );
}

export function decisionReuseMismatches(
  record: DecisionRecord,
  current: DecisionReuseContext
): DecisionReuseMismatch[] {
  const mismatches: DecisionReuseMismatch[] = [];
  if (record.status !== "active") mismatches.push("status");
  if (!recordsEqual(record.scope, current.scope)) mismatches.push("scope");
  if (!recordsEqual(record.preconditions, current.preconditions)) {
    mismatches.push("preconditions");
  }
  return mismatches;
}

export function canReuseDecision(
  record: DecisionRecord,
  current: DecisionReuseContext
): boolean {
  return decisionReuseMismatches(record, current).length === 0;
}

export function toDecisionRecordDefinition(
  record: DecisionRecord
): DecisionRecordDefinition {
  return record;
}
