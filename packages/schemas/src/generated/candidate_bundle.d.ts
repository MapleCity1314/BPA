/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Digest = string;
export type Risk = "R0" | "R1" | "R2" | "R3" | "R4";

export interface BPAAuthoringCandidateBundleV1Alpha1 {
  apiVersion: "bpa.authoring/v1alpha1";
  kind: "CandidateBundle";
  metadata: Metadata;
  status: "candidate";
  scenarioRef: VersionedRef;
  authoringSession: {
    id: Id;
    revision: number;
  };
  /**
   * @minItems 1
   * @maxItems 1000
   */
  artifacts: {
    kind:
      | "workflow"
      | "node"
      | "page_model"
      | "element_contract"
      | "adapter_patch"
      | "replay_fixture"
      | "test_manifest"
      | "validation_report"
      | "risk_report";
    id: Id;
    version: Semver;
    digest: Digest;
    status: "candidate" | "published";
  }[];
  /**
   * @maxItems 2000
   */
  files: {
    path: string;
    mediaType: "application/json" | "application/yaml" | "text/typescript" | "text/markdown";
    digest: Digest;
    sizeBytes: number;
    sourceAssetRef: ContentRef;
  }[];
  /**
   * @maxItems 2000
   */
  dependencyClosure: AssetRef[];
  /**
   * @maxItems 200
   */
  capabilityGaps: {
    gapId: Id;
    capabilityId: Id;
    status: "open" | "resolved";
  }[];
  validation: {
    schema: Check;
    contracts: Check;
    replay: Check;
    permissions: Check;
    risk: Check;
  };
  riskReport: {
    ceiling: Risk;
    effective: Risk;
    /**
     * @maxItems 500
     */
    permissions: string[];
    /**
     * @maxItems 200
     */
    manualReviewPoints: string[];
  };
  executionPolicy: {
    autoExecute: false;
    autoPublish: false;
    autoApplySource: false;
  };
  createdAt: string;
}
export interface Metadata {
  id: Id;
  version: Semver;
  title: string;
  description?: string;
}
export interface VersionedRef {
  id: Id;
  version: Semver;
  digest: Digest;
}
export interface ContentRef {
  id: Id;
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
export interface Check {
  valid: boolean;
  issueCount: number;
}
