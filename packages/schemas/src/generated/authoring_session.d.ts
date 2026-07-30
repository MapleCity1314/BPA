/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPAAuthoringSessionV1Alpha1 = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa.authoring/v1alpha1";
  kind: "AuthoringSession";
  sessionId: Id;
  revision: number;
  state:
    "intake" | "catalog" | "discovery" | "modeling" | "assembly" | "validation" | "candidate" | "closed" | "failed";
  scenarioRef: VersionedRef;
  actor: {
    type: "ai" | "human";
    id: string;
  };
  /**
   * @maxItems 500
   */
  catalogSelections: AssetRef[];
  /**
   * @maxItems 200
   */
  capabilityGaps: {
    [k: string]: unknown;
  }[];
  /**
   * @maxItems 20
   */
  designGrantRefs: Id[];
  /**
   * @maxItems 100
   */
  snapshotRefs: ContentRef[];
  candidateBundleRef?: ContentRef;
  /**
   * @maxItems 10000
   */
  appliedOperationIds: Id[];
  createdAt: string;
  updatedAt: string;
};
export type Id = string;
export type Semver = string;
export type Digest = string;

export interface VersionedRef {
  id: Id;
  version: Semver;
  digest: Digest;
}
export interface AssetRef {
  assetType:
    | "node"
    | "workflow"
    | "adapter"
    | "policy"
    | "assistance_profile"
    | "dataset_profile"
    | "page_model"
    | "element_contract";
  id: Id;
  version: Semver;
  digest: Digest;
  status: "candidate" | "published";
}
export interface ContentRef {
  id: Id;
  digest: Digest;
}
