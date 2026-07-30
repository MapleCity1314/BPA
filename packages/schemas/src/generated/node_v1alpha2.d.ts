/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPANodeDefinitionV1Alpha2 = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa/v1alpha2";
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
    /**
     * @maxItems 100
     */
    permissions: string[];
    /**
     * @minItems 1
     * @maxItems 16
     */
    domains?: HttpsOrigin[];
  };
  execution: {
    timeoutDefault: string;
    idempotency: "pure" | "repeatable_read" | "verified_write" | "non_repeatable";
    /**
     * @maxItems 50
     */
    retryableErrors?: string[];
    cancellable?: boolean;
    timingPolicy?: BPATimingPolicyV1;
  };
  /**
   * @maxItems 100
   */
  errors: string[];
  evidence?: {
    /**
     * @maxItems 4
     */
    required?: ("before" | "after" | "result" | "error")[];
  };
  adapter?: {
    id: string;
    /**
     * @minItems 1
     * @maxItems 50
     */
    versions: string[];
  };
  resources?: {
    [k: string]: BrowserResourceRequirement;
  };
};
export type HttpsOrigin = string;
export type Capability = string;

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
    scope: "domain" | "shop" | "tab";
    minIntervalMs: number;
    maxQueueMs: number;
  };
}
export interface BrowserResourceRequirement {
  kind: "browser";
  /**
   * @minItems 1
   * @maxItems 32
   */
  capabilities: Capability[];
  /**
   * @minItems 1
   * @maxItems 16
   */
  allowedOrigins: HttpsOrigin[];
  authentication: "anonymous" | "optional" | "authenticated" | "membership";
  purpose: string;
}
