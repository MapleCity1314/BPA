/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Digest = string;
export type Timestamp = string;

export interface BPADecisionRecordV1Alpha1 {
  apiVersion: "bpa.decision/v1alpha1";
  decisionId: Id;
  decisionType: Id;
  status: "active" | "superseded" | "revoked";
  scope: {
    [k: string]: string;
  };
  preconditions: {
    [k: string]: Digest;
  };
  value: unknown;
  valueDigest?: Digest;
  confirmedBy: Id;
  confirmedAt: Timestamp;
  supersedes?: Id;
  revokedAt?: Timestamp;
  revokedBy?: Id;
}
