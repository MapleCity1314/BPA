/* Generated from canonical JSON Schema. Do not edit manually. */

export type AssetId = string;
export type Semver = string;
export type NodeKey = string;
export type NodeRef = string;
export type Duration = string;

export interface BPAWorkflow {
  apiVersion: "bpa/v1alpha1";
  kind: "Workflow";
  metadata: {
    id: AssetId;
    version: Semver;
    title: string;
    description?: string;
  };
  spec: {
    riskLevel: "R0" | "R1" | "R2" | "R3" | "R4";
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    start: NodeKey;
    nodes: {
      [k: string]: WorkflowNode;
    };
  };
}
export interface JsonSchema {
  [k: string]: unknown;
}
export interface WorkflowNode {
  use: NodeRef;
  with?: unknown;
  next?: NodeKey;
  on?: TransitionMap;
  timeout?: Duration;
  retry?: Retry;
  timing?: BPATimingPolicyV1;
  condition?: string;
  description?: string;
}
export interface TransitionMap {
  success?: NodeKey;
  failure?: NodeKey;
  timeout?: NodeKey;
  cancelled?: NodeKey;
  uncertain?: NodeKey;
}
export interface Retry {
  maxAttempts: number;
  backoff?: Duration;
  /**
   * @maxItems 50
   */
  retryableErrors?: string[];
}
export interface BPATimingPolicyV1 {
  readiness?: {
    timeoutMs: number;
    stableForMs: number;
    pollIntervalMs: number;
  };
  dispatchJitter?: {
    minMs: number;
    maxMs: number;
    distribution: "uniform";
  };
  retryBackoff?: {
    strategy: "fixed" | "exponential";
    baseMs: number;
    maxMs: number;
    jitterRatio: number;
  };
  rateLimit?: {
    scope: "domain" | "authentication_context" | "tab";
    minIntervalMs: number;
    maxQueueMs: number;
  };
}
