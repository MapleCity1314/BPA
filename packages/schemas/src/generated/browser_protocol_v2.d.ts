/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPABrowserProtocolV2Message =
  | SessionHello
  | SessionWelcome
  | SessionResume
  | CapabilityReport
  | PageObservation
  | PageProbeRequest
  | PageProbeResult
  | Command
  | CommandAck
  | CommandResult
  | ResultAck
  | CancelRequest
  | CancelAck
  | CancelEffective
  | Heartbeat
  | SessionError
  | EvidenceBegin
  | EvidenceChunk
  | EvidenceComplete
  | EvidenceAck;
export type Id = string;
export type Timestamp = string;
/**
 * @minItems 3
 */
export type BrowserFeatures = {
  [k: string]: unknown;
} & BrowserFeatures1;
export type BrowserFeatures1 = ("page_observation_v2" | "exact_tab_binding_v2" | "active_page_probe_v1")[];
export type Digest = string;
export type ResultStatus = "succeeded" | "rejected" | "failed" | "timed_out" | "cancelled" | "uncertain";

export interface SessionHello {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: "new";
  seq: 0;
  sent_at: Timestamp;
  type: "session.hello";
  trace_id: Id;
  payload: {
    browser_instance_id: Id;
    extension_id: Id;
    extension_version: Id;
    bridge_build_id: Id;
    /**
     * @minItems 1
     */
    supported_protocols: "bpa.browser/2"[];
    features: BrowserFeatures;
    last_acked_command_seq: number;
    resume_token?: Id;
  };
}
export interface SessionWelcome {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "session.welcome";
  trace_id: Id;
  payload: {
    selected_protocol: "bpa.browser/2";
    heartbeat_ms: number;
    resume_token: Id;
    resume_token_expires_at: Timestamp;
    core_signing_key: CoreSigningKey;
    max_message_bytes: 524288;
  };
}
export interface CoreSigningKey {
  key_id: Id;
  algorithm: "Ed25519";
  public_key_spki_base64: string;
}
export interface SessionResume {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "session.resume";
  trace_id: Id;
  payload: {
    accepted: boolean;
    replay_from_command_seq: number;
    reason_code?: Id;
  };
}
export interface CapabilityReport {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "capability.report";
  trace_id: Id;
  payload: {
    /**
     * @maxItems 500
     */
    capabilities: Capability[];
    manifest_digest: Digest;
    features: BrowserFeatures;
  };
}
export interface Capability {
  node_id: Id;
  /**
   * @minItems 1
   */
  versions: Id[];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  permissions: Id[];
  /**
   * @minItems 1
   */
  routes: {
    origin: string;
    /**
     * @minItems 1
     */
    pathname_prefixes: string[];
    observer_capability_id: Id;
  }[];
  adapter_id?: Id;
  adapter_version?: Id;
}
export interface PageObservation {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "page.observation";
  trace_id: Id;
  payload: {
    tab_ref: TabRef;
    pathname: string;
    content_script_ready: boolean;
    authentication:
      | {
          state: "unknown" | "anonymous";
        }
      | {
          state: "authenticated" | "membership";
          context_ref: Id;
        };
    observation_state:
      "content_script_missing" | "loading" | "probing" | "auth_required" | "challenge" | "ready" | "departed" | "stale";
    page_epoch: Id;
    observation_revision: number;
    observer_capability_id: Id;
    observed_at: Timestamp;
    reason_code?: Id;
  };
}
export interface TabRef {
  browser_instance_id: Id;
  tab_id: number;
  window_id?: number;
  origin: string;
}
export interface PageProbeRequest {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "page.probe.request";
  trace_id: Id;
  payload: {
    request_id: Id;
    tab_ref: TabRef;
    deadline: Timestamp;
  };
}
export interface PageProbeResult {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "page.probe.result";
  trace_id: Id;
  payload: {
    request_id: Id;
    tab_ref: TabRef;
    accepted: boolean;
    observation_revision: number;
    reason_code?: Id;
  };
}
export interface Command {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "command.dispatch";
  trace_id: Id;
  payload: {
    command_seq: number;
    run_id: Id;
    workflow_id: Id;
    workflow_version: Id;
    node_execution_id: Id;
    command_id: Id;
    idempotency_key: Id;
    fencing_token: number;
    attempt: number;
    node: {
      id: Id;
      version: Id;
    };
    adapter_ref?: {
      id: Id;
      version: Id;
      digest: Digest;
      minimum_extension_version: Id;
    };
    input: unknown;
    permission_grant: BPASignedPermissionGrant;
    deadline: Timestamp;
    timing_policy?: BPATimingPolicyV1;
    tab_ref: TabRef;
    page_epoch: Id;
    observation_revision: number;
    authentication_context_ref?: Id;
    approval_token_ref?: Id;
  };
}
export interface BPASignedPermissionGrant {
  grant_id: Id;
  permissions: Id[];
  domains: string[];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  expires_at: string;
  run_id: Id;
  node_execution_id: Id;
  node_id: Id;
  node_version: Id;
  fencing_token: number;
  approval_ref?: Id;
  key_id: Id;
  grant_digest: string;
  authorization_tag: string;
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
export interface CommandAck {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "command.ack";
  trace_id: Id;
  payload: {
    command_seq: number;
    command_id: Id;
    node_execution_id: Id;
    accepted: boolean;
    fencing_token: number;
    reason_code?: Id;
  };
}
export interface CommandResult {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "command.result";
  trace_id: Id;
  payload: {
    command_seq: number;
    command_id: Id;
    node_execution_id: Id;
    idempotency_key: Id;
    fencing_token: number;
    status: ResultStatus;
    output?: unknown;
    error?: {
      code: Id;
      message: string;
      retryable?: boolean;
    };
    evidence_refs?: Id[];
    page_epoch?: Id;
    /**
     * @maxItems 20
     */
    risk_signals?: BPARiskSignalV1[];
    timing_observation?: {
      rate_limit_wait_ms: number;
      readiness_wait_ms?: number;
      stable_for_ms?: number;
    };
  };
}
export interface BPARiskSignalV1 {
  code:
    "CAPTCHA_REQUIRED" | "RATE_LIMITED" | "RISK_CONTROL" | "SESSION_EXPIRED" | "AUTH_REQUIRED" | "PAGE_CONTEXT_CHANGED";
  category: "challenge" | "throttle" | "session" | "page_context";
  severity: "warning" | "blocking";
  source: "page" | "adapter" | "bridge";
  detected_at: string;
  retry_after_ms?: number;
  detail?: string;
}
export interface ResultAck {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "result.ack";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    accepted: boolean;
    reason_code?: Id;
  };
}
export interface CancelRequest {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "cancel.request";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    fencing_token: number;
    reason_code: Id;
  };
}
export interface CancelAck {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "cancel.ack";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    fencing_token: number;
    acknowledged: boolean;
    action_started?: boolean;
    reason_code?: Id;
  };
}
export interface CancelEffective {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "cancel.effective";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    fencing_token: number;
    status: "cancelled" | "uncertain";
    safe_stop?: boolean;
  };
}
export interface Heartbeat {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "heartbeat.ping" | "heartbeat.pong";
  trace_id: Id;
  payload: {
    nonce: Id;
  };
}
export interface SessionError {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "session.error";
  trace_id: Id;
  payload: {
    code: Id;
    message: string;
    fatal: boolean;
    related_message_id?: Id;
  };
}
export interface EvidenceBegin {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "evidence.begin";
  trace_id: Id;
  payload: {
    evidence_id: Id;
    run_id: Id;
    node_execution_id: Id;
    kind: "dom_summary" | "screenshot" | "file" | "verification" | "error";
    media_type: string;
    size: number;
    digest: Digest;
    chunk_size: 262144;
    chunk_count: number;
  };
}
export interface EvidenceChunk {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "evidence.chunk";
  trace_id: Id;
  payload: {
    evidence_id: Id;
    index: number;
    data_base64: string;
    chunk_digest: Digest;
  };
}
export interface EvidenceComplete {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "evidence.complete";
  trace_id: Id;
  payload: {
    evidence_id: Id;
    digest: Digest;
    chunk_count: number;
  };
}
export interface EvidenceAck {
  protocol: "bpa.browser/2";
  version: "2.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "evidence.ack";
  trace_id: Id;
  payload: {
    evidence_id: Id;
    accepted: boolean;
    next_chunk_index?: number;
    reason_code?: Id;
  };
}
