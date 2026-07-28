export interface DatasetProfileRef {
  readonly profileId: string;
  readonly profileVersion: string;
}

export interface DatasetVersion {
  readonly datasetId: string;
  readonly versionId: string;
  readonly contentDigest: string;
  readonly recordIndexDigest: string;
  readonly recordCount: number;
  readonly profile: DatasetProfileRef;
  readonly publishedAt: number;
}

export interface DatasetRef {
  readonly datasetId: string;
  readonly versionId: string;
  readonly contentDigest: string;
}

export interface DecisionReuseIdentity {
  readonly shopId: string;
  readonly productId: string;
  readonly normalizedTitleDigest: string;
  readonly targetRecordDigest: string;
  readonly matcherVersion: string;
  readonly ruleVersion: string;
}

interface DecisionRecordBase<TDecision> {
  readonly decisionId: string;
  readonly dataset: DatasetRef;
  readonly reuseIdentity: DecisionReuseIdentity;
  readonly decision: TDecision;
  readonly decidedAt: number;
}

export type UnconfirmedDecisionRecord<TDecision = unknown> =
  DecisionRecordBase<TDecision> & {
    readonly status: "unconfirmed";
  };

export type ConfirmedDecisionRecord<TDecision = unknown> =
  DecisionRecordBase<TDecision> & {
    readonly status: "confirmed";
    readonly confirmedBy: string;
    readonly confirmedAt: number;
  };

export type DecisionRecord<TDecision = unknown> =
  | UnconfirmedDecisionRecord<TDecision>
  | ConfirmedDecisionRecord<TDecision>;

const REUSE_IDENTITY_FIELDS = [
  "shopId",
  "productId",
  "normalizedTitleDigest",
  "targetRecordDigest",
  "matcherVersion",
  "ruleVersion"
] as const satisfies readonly (keyof DecisionReuseIdentity)[];

export type DecisionReuseMismatch =
  (typeof REUSE_IDENTITY_FIELDS)[number] | "notConfirmed";

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite timestamp`);
  }
}

function freezeDatasetRef(ref: DatasetRef): DatasetRef {
  return Object.freeze({ ...ref });
}

function freezeReuseIdentity(
  identity: DecisionReuseIdentity
): DecisionReuseIdentity {
  return Object.freeze({ ...identity });
}

export function createDatasetVersion(input: DatasetVersion): DatasetVersion {
  requireText(input.datasetId, "datasetId");
  requireText(input.versionId, "versionId");
  requireText(input.contentDigest, "contentDigest");
  requireText(input.recordIndexDigest, "recordIndexDigest");
  requireText(input.profile.profileId, "profile.profileId");
  requireText(input.profile.profileVersion, "profile.profileVersion");
  if (!Number.isSafeInteger(input.recordCount) || input.recordCount < 0) {
    throw new Error("recordCount must be a non-negative safe integer");
  }
  requireTimestamp(input.publishedAt, "publishedAt");
  return Object.freeze({
    ...input,
    profile: Object.freeze({ ...input.profile })
  });
}

export function datasetRef(version: DatasetVersion): DatasetRef {
  return freezeDatasetRef({
    datasetId: version.datasetId,
    versionId: version.versionId,
    contentDigest: version.contentDigest
  });
}

export function datasetRefEquals(
  left: DatasetRef,
  right: DatasetRef
): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest
  );
}

export function refersToDatasetVersion(
  ref: DatasetRef,
  version: DatasetVersion
): boolean {
  return datasetRefEquals(ref, datasetRef(version));
}

export function createUnconfirmedDecision<TDecision>(input: {
  readonly decisionId: string;
  readonly dataset: DatasetRef;
  readonly reuseIdentity: DecisionReuseIdentity;
  readonly decision: TDecision;
  readonly decidedAt: number;
}): UnconfirmedDecisionRecord<TDecision> {
  validateDecisionInput(input);
  return Object.freeze({
    ...input,
    dataset: freezeDatasetRef(input.dataset),
    reuseIdentity: freezeReuseIdentity(input.reuseIdentity),
    status: "unconfirmed"
  });
}

function validateDecisionInput(input: {
  readonly decisionId: string;
  readonly dataset: DatasetRef;
  readonly reuseIdentity: DecisionReuseIdentity;
  readonly decidedAt: number;
}): void {
  requireText(input.decisionId, "decisionId");
  requireText(input.dataset.datasetId, "dataset.datasetId");
  requireText(input.dataset.versionId, "dataset.versionId");
  requireText(input.dataset.contentDigest, "dataset.contentDigest");
  for (const field of REUSE_IDENTITY_FIELDS) {
    requireText(input.reuseIdentity[field], `reuseIdentity.${field}`);
  }
  requireTimestamp(input.decidedAt, "decidedAt");
}

export function confirmDecision<TDecision>(
  record: DecisionRecord<TDecision>,
  input: {
    readonly confirmedBy: string;
    readonly confirmedAt: number;
  }
): ConfirmedDecisionRecord<TDecision> {
  requireText(input.confirmedBy, "confirmedBy");
  requireTimestamp(input.confirmedAt, "confirmedAt");
  if (input.confirmedAt < record.decidedAt) {
    throw new Error("confirmedAt cannot precede decidedAt");
  }
  if (record.status === "confirmed") return record;
  return Object.freeze({
    ...record,
    status: "confirmed",
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt
  });
}

export function decisionReuseIdentityEquals(
  left: DecisionReuseIdentity,
  right: DecisionReuseIdentity
): boolean {
  return REUSE_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

export function decisionReuseMismatches(
  record: DecisionRecord,
  current: DecisionReuseIdentity
): DecisionReuseMismatch[] {
  const mismatches: DecisionReuseMismatch[] =
    record.status === "confirmed" ? [] : ["notConfirmed"];
  for (const field of REUSE_IDENTITY_FIELDS) {
    if (record.reuseIdentity[field] !== current[field]) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

export function canReuseDecision(
  record: DecisionRecord,
  current: DecisionReuseIdentity
): boolean {
  return decisionReuseMismatches(record, current).length === 0;
}
