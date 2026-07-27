import type {
  BPABrowserProtocolV1Message
} from "./generated/browser_protocol_v1.js";
import type { BPANodeDefinition } from "./generated/node.js";
import type { BPARiskSignalV1 } from "./generated/risk_signal.js";
import type { BPATimingPolicyV1 } from "./generated/timing_policy.js";
import type { BPASignedPermissionGrant } from "./generated/permission.js";
import type {
  BPAWorkflow,
  WorkflowNode as GeneratedWorkflowNode
} from "./generated/workflow.js";

export type {
  BPABrowserProtocolV1Message,
  BPANodeDefinition,
  BPASignedPermissionGrant,
  BPAWorkflow
};
export type { BPARiskSignalV1, BPATimingPolicyV1 };

/**
 * Stable public aliases. Their shapes are generated from the canonical JSON
 * Schemas; this module intentionally contains no hand-maintained duplicates.
 */
export type WorkflowDefinition = BPAWorkflow;
export type WorkflowMetadata = BPAWorkflow["metadata"];
export type WorkflowNode = GeneratedWorkflowNode;
export type NodeDefinition = BPANodeDefinition;
export type BrowserProtocolMessage = BPABrowserProtocolV1Message;
export type SignedPermissionGrant = BPASignedPermissionGrant;
export type RiskLevel = BPAWorkflow["spec"]["riskLevel"];
export type TimingPolicy = BPATimingPolicyV1;
export type RiskSignal = BPARiskSignalV1;
