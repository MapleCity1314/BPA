export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export interface WorkflowMetadata {
  id: string;
  version: string;
  title: string;
  description?: string;
}

export interface WorkflowNode {
  use: string;
  with?: unknown;
  next?: string;
  on?: Partial<
    Record<
      "success" | "failure" | "timeout" | "rejected" | "cancelled" | "uncertain",
      string
    >
  >;
  timeout?: string;
  retry?: {
    maxAttempts: number;
    backoff?: string;
    retryableErrors?: string[];
  };
  condition?: string;
  description?: string;
}

export interface WorkflowDefinition {
  apiVersion: "bpa/v1alpha1";
  kind: "Workflow";
  metadata: WorkflowMetadata;
  spec: {
    riskLevel: RiskLevel;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    start: string;
    nodes: Record<string, WorkflowNode>;
  };
}

export interface NodeDefinition {
  apiVersion: "bpa/v1alpha1";
  kind: "Node";
  metadata: WorkflowMetadata;
  runtime:
    | "engine_builtin"
    | "engine_team"
    | "browser"
    | "human"
    | "composite";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  risk: {
    level: RiskLevel;
    permissions: string[];
    domains?: string[];
  };
  execution: {
    timeoutDefault: string;
    idempotency:
      | "pure"
      | "repeatable_read"
      | "verified_write"
      | "non_repeatable";
    retryableErrors?: string[];
    cancellable?: boolean;
  };
  errors: string[];
  evidence?: {
    required?: Array<"before" | "after" | "result" | "error">;
  };
  adapter?: {
    id: string;
    versions: string[];
  };
}

export interface BrowserProtocolMessage {
  protocol: "bpa.browser/1";
  version: "1.0.0";
  message_id: string;
  session_id: string;
  seq: number;
  sent_at: string;
  type: string;
  trace_id: string;
  payload: Record<string, unknown>;
}
