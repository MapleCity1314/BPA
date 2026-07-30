/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Timestamp = string;

export interface BPAEvidenceLinkV1Alpha1 {
  apiVersion: "bpa.evidence/v1alpha1";
  kind: "EvidenceLink";
  linkId: Id;
  evidenceId: Id;
  relation: "captures" | "supports" | "contradicts" | "derived_from" | "references";
  /**
   * @minItems 1
   * @maxItems 100
   */
  sourceIds: Id[];
  /**
   * @minItems 1
   * @maxItems 100
   */
  assetIds?: Id[];
  claimRef?: Id;
  createdAt: Timestamp;
}
