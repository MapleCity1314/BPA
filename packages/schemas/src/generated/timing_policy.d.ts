/* Generated from canonical JSON Schema. Do not edit manually. */

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
