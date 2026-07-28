/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Digest = string;
export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";
export type Timestamp = string;

export interface BPAAssistanceTaskV1Alpha1 {
  apiVersion: "bpa.assistance/v1alpha1";
  taskId: Id;
  runId: Id;
  stepInstanceId: Id;
  profile: AssetRef;
  mode: "ai_review" | "human_confirm" | "human_action";
  riskLevel: RiskLevel;
  status: "queued" | "claimed" | "processing" | "awaiting_human" | "completed" | "expired" | "cancelled" | "failed";
  revision: number;
  input: unknown;
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
  contextRefs: {
    evidenceId: Id;
    classification: "public" | "internal" | "sensitive";
    digest: Digest;
  }[];
  lease?: {
    ownerId: Id;
    fencingToken: number;
    expiresAt: Timestamp;
  };
  resolution?: {
    resolverType: "ai" | "human" | "human_ai";
    resolverId: Id;
    provider?: string;
    model?: string;
    confidence?: number;
    output: unknown;
    submittedAt: Timestamp;
  };
  deadline: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface AssetRef {
  id: Id;
  version: string;
  digest: Digest;
}
