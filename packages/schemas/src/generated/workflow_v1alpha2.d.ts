/* Generated from canonical JSON Schema. Do not edit manually. */

export type AssetId = string;
export type Semver = string;
export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";
export type Step = CallStep | DecisionStep | ForeachStep | AssistanceStep | TerminalStep;
export type StepKey = string;
export type NodeRef = string;
export type SafeValue =
  | null
  | boolean
  | number
  | string
  | SafeValue[]
  | {
      [k: string]: SafeValue;
    };
export type Duration = string;
export type Condition =
  | {
      [k: string]: unknown;
    }
  | {
      kind: "all" | "any";
      /**
       * @minItems 1
       * @maxItems 50
       */
      conditions: Condition[];
    }
  | {
      kind: "not";
      condition: Condition;
    };
export type Binding = string;
export type Identifier = string;

export interface BPAWorkflowV1Alpha2 {
  apiVersion: "bpa/v1alpha2";
  kind: "Workflow";
  metadata: Metadata;
  spec: {
    riskLevel: RiskLevel;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    limits: {
      maxDepth: number;
      maxStepExecutions: number;
    };
    root: Block;
  };
}
export interface Metadata {
  id: AssetId;
  version: Semver;
  title: string;
  description?: string;
}
export interface JsonSchema {
  [k: string]: unknown;
}
export interface Block {
  kind: "sequence";
  /**
   * @minItems 1
   * @maxItems 500
   */
  steps: Step[];
}
export interface CallStep {
  key: StepKey;
  kind: "call";
  use: NodeRef;
  with?: SafeValue;
  timeout?: Duration;
  retry?: Retry;
  timing?: BPATimingPolicyV1;
  handlers?: Handlers;
  description?: string;
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
export interface Handlers {
  failure?: Block;
  timeout?: Block;
  rejected?: Block;
  cancelled?: Block;
  uncertain?: Block;
}
export interface DecisionStep {
  key: StepKey;
  kind: "decision";
  condition: Condition;
  then: Block;
  else: Block;
  description?: string;
}
export interface ForeachStep {
  key: StepKey;
  kind: "foreach";
  items: Binding;
  itemName: Identifier;
  indexName: Identifier;
  itemKey: Binding;
  maxItems: number;
  maxDuration: Duration;
  onItemError: "stop" | "collect";
  body: Block;
  description?: string;
}
export interface AssistanceStep {
  key: StepKey;
  kind: "wait.assistance";
  use: NodeRef;
  with?: SafeValue;
  blocking: boolean;
  deadline?: Duration;
  onUnavailable: "continue_unresolved" | "human_action" | "fail";
  handlers?: Handlers;
  description?: string;
}
export interface TerminalStep {
  key: StepKey;
  kind: "terminal";
  status: "succeeded" | "rejected" | "failed" | "cancelled" | "uncertain";
  output?: SafeValue;
  error?: {
    code: string;
    message: string;
  };
  description?: string;
}
