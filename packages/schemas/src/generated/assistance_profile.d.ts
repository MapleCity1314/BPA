/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Digest = string;

export interface BPAAssistanceProfileV1Alpha1 {
  apiVersion: "bpa.assistance/v1alpha1";
  kind: "AssistanceProfile";
  metadata: {
    id: Id;
    version: Semver;
    title: string;
    description?: string;
  };
  taskKind: "ai_review" | "human_confirm" | "human_action";
  riskLevel: "R0" | "R1" | "R2" | "R3" | "R4";
  outputSchema: {
    [k: string]: unknown;
  };
  policySnapshot: {
    autoContinue: boolean;
    r1ProfileApproved: boolean;
    durableDecision: boolean;
    deterministicValidator?: AssetRef;
    onUnavailable: "continue_unresolved" | "human_action" | "fail";
  };
  /**
   * @maxItems 100
   */
  instructions?: string[];
}
export interface AssetRef {
  id: Id;
  version: Semver;
  digest: Digest;
}
