/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPABrowserProtocolV1Message =
  | SessionHello
  | SessionWelcome
  | SessionResume
  | CapabilityReport
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
export type Digest = string;
export type ResultStatus = "succeeded" | "rejected" | "failed" | "timed_out" | "cancelled" | "uncertain";

export interface SessionHello {
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
    /**
     * @minItems 1
     */
    supported_protocols: ["bpa.browser/1", ..."bpa.browser/1"[]];
    last_acked_command_seq: number;
    resume_token?: Id;
  };
}
export interface SessionWelcome {
  protocol: "bpa.browser/1";
  version: "1.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "session.welcome";
  trace_id: Id;
  payload: {
    selected_protocol: "bpa.browser/1";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  };
}
export interface Capability {
  node_id: Id;
  /**
   * @minItems 1
   */
  versions: [Id, ...Id[]];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  permissions: Id[];
  adapter_id?: Id;
  adapter_version?: Id;
}
export interface Command {
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
    input: unknown;
    permission_grant: PermissionGrant;
    deadline: Timestamp;
    tab_ref?: TabRef;
    page_epoch?: Id;
    approval_token_ref?: Id;
  };
}
export interface PermissionGrant {
  grant_id: Id;
  permissions: Id[];
  domains: string[];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  expires_at: Timestamp;
  run_id: Id;
  node_execution_id: Id;
  node_id: Id;
  node_version: Id;
  fencing_token: number;
  approval_ref?: Id;
  key_id: Id;
  grant_digest: Digest;
  authorization_tag: string;
}
export interface TabRef {
  browser_instance_id: Id;
  tab_id: number;
  window_id?: number;
  origin: string;
}
export interface CommandAck {
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  };
}
export interface ResultAck {
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "cancel.ack";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    acknowledged: boolean;
    action_started?: boolean;
    reason_code?: Id;
  };
}
export interface CancelEffective {
  protocol: "bpa.browser/1";
  version: "1.0.0";
  message_id: Id;
  session_id: Id;
  seq: number;
  sent_at: Timestamp;
  type: "cancel.effective";
  trace_id: Id;
  payload: {
    command_id: Id;
    node_execution_id: Id;
    status: "cancelled" | "uncertain";
    safe_stop?: boolean;
  };
}
export interface Heartbeat {
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
  protocol: "bpa.browser/1";
  version: "1.0.0";
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
