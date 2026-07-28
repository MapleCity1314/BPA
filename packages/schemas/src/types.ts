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
import type {
  BPAWorkflowV1Alpha2
} from "./generated/workflow_v1alpha2.js";
import type {
  BPAAssistanceTaskV1Alpha1
} from "./generated/assistance_task.js";
import type {
  BPADatasetVersionV1Alpha1
} from "./generated/dataset.js";
import type {
  BPADecisionRecordV1Alpha1
} from "./generated/decision_record.js";
import type {
  BPAElementContractV1Alpha1
} from "./generated/element_contract.js";
import type {
  BPAPageModelV1Alpha1
} from "./generated/page_model.js";

export type {
  BPABrowserProtocolV1Message,
  BPAAssistanceTaskV1Alpha1,
  BPADatasetVersionV1Alpha1,
  BPADecisionRecordV1Alpha1,
  BPAElementContractV1Alpha1,
  BPANodeDefinition,
  BPAPageModelV1Alpha1,
  BPASignedPermissionGrant,
  BPAWorkflow,
  BPAWorkflowV1Alpha2
};
export type { BPARiskSignalV1, BPATimingPolicyV1 };

/**
 * Stable public aliases. Their shapes are generated from the canonical JSON
 * Schemas; this module intentionally contains no hand-maintained duplicates.
 */
export type WorkflowDefinition = BPAWorkflow;
export type WorkflowDefinitionV1Alpha2 = BPAWorkflowV1Alpha2;
export type WorkflowMetadata = BPAWorkflow["metadata"];
export type WorkflowNode = GeneratedWorkflowNode;
export type NodeDefinition = BPANodeDefinition;
export type BrowserProtocolMessage = BPABrowserProtocolV1Message;
export type AssistanceTaskDefinition = BPAAssistanceTaskV1Alpha1;
export type DatasetVersionDefinition = BPADatasetVersionV1Alpha1;
export type DecisionRecordDefinition = BPADecisionRecordV1Alpha1;
export type ElementContractDefinition = BPAElementContractV1Alpha1;
export type PageModelDefinition = BPAPageModelV1Alpha1;
export type SignedPermissionGrant = BPASignedPermissionGrant;
export type RiskLevel = BPAWorkflow["spec"]["riskLevel"];
export type TimingPolicy = BPATimingPolicyV1;
export type RiskSignal = BPARiskSignalV1;
