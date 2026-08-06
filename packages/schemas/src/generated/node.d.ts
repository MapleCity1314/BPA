/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPANodeDefinition = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa/v1alpha1";
  kind: "Node";
  metadata: {
    id: string;
    version: string;
    title: string;
    description?: string;
  };
  runtime: "engine_builtin" | "engine_team" | "browser" | "human" | "composite";
  inputSchema: {
    [k: string]: unknown;
  };
  outputSchema: {
    [k: string]: unknown;
  };
  configSchema?: {
    [k: string]: unknown;
  };
  risk: {
    level: "R0" | "R1" | "R2" | "R3" | "R4";
    permissions: string[];
    /**
     * @minItems 1
     */
    domains?: string[];
  };
  execution: {
    timeoutDefault: string;
    idempotency: "pure" | "repeatable_read" | "verified_write" | "non_repeatable";
    retryableErrors?: string[];
    cancellable?: boolean;
    timingPolicy?: BPATimingPolicyV1;
  };
  errors: string[];
  evidence?: {
    required?: ("before" | "after" | "result" | "error")[];
  };
  adapter?: {
    id: string;
    /**
     * @minItems 1
     */
    versions: string[];
  };
};

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
