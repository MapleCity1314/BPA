import type {
  BPABrowserProtocolV2Message
} from "./generated/browser_protocol_v2.js";
import type { BPANodeDefinition } from "./generated/node.js";
import type {
  BPANodeDefinitionV1Alpha2
} from "./generated/node_v1alpha2.js";
import type {
  BPASourceRecordV1Alpha1
} from "./generated/source_record.js";
import type {
  BPAAssetRecordV1Alpha1
} from "./generated/asset_record.js";
import type {
  BPAEvidenceLinkV1Alpha1
} from "./generated/evidence_link.js";
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
  BPAWorkflowV1Alpha3
} from "./generated/workflow_v1alpha3.js";
import type {
  BPAAssistanceTaskV1Alpha1
} from "./generated/assistance_task.js";
import type {
  BPAAdapterManifestV1Alpha1
} from "./generated/adapter_manifest.js";
import type {
  BPAAssistanceProfileV1Alpha1
} from "./generated/assistance_profile.js";
import type {
  BPADeterministicResultValidatorPolicyV1Alpha1
} from "./generated/deterministic_result_validator_policy.js";
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
import type {
  BPAAuthoringScenarioSpecV1Alpha1
} from "./generated/scenario_spec.js";
import type {
  BPAAuthoringSessionV1Alpha1
} from "./generated/authoring_session.js";
import type {
  BPAAuthoringPageSnapshotV1Alpha1
} from "./generated/page_snapshot.js";
import type {
  BPAAuthoringCandidateBundleV1Alpha1
} from "./generated/candidate_bundle.js";
import type { BPATriggerSpecV1Alpha1 } from "./generated/trigger_spec.js";

export type {
  BPABrowserProtocolV2Message,
  BPAAdapterManifestV1Alpha1,
  BPAAssistanceProfileV1Alpha1,
  BPAAssistanceTaskV1Alpha1,
  BPADeterministicResultValidatorPolicyV1Alpha1,
  BPADatasetVersionV1Alpha1,
  BPADecisionRecordV1Alpha1,
  BPAElementContractV1Alpha1,
  BPANodeDefinition,
  BPANodeDefinitionV1Alpha2,
  BPAPageModelV1Alpha1,
  BPAAuthoringScenarioSpecV1Alpha1,
  BPAAuthoringSessionV1Alpha1,
  BPAAuthoringPageSnapshotV1Alpha1,
  BPAAuthoringCandidateBundleV1Alpha1,
  BPASourceRecordV1Alpha1,
  BPAAssetRecordV1Alpha1,
  BPAEvidenceLinkV1Alpha1,
  BPATriggerSpecV1Alpha1,
  BPASignedPermissionGrant,
  BPAWorkflow,
  BPAWorkflowV1Alpha2,
  BPAWorkflowV1Alpha3
};
export type { BPARiskSignalV1, BPATimingPolicyV1 };

/**
 * Stable public aliases. Their shapes are generated from the canonical JSON
 * Schemas; this module intentionally contains no hand-maintained duplicates.
 */
export type WorkflowDefinition = BPAWorkflow;
export type WorkflowDefinitionV1Alpha2 = BPAWorkflowV1Alpha2;
export type WorkflowDefinitionV1Alpha3 = BPAWorkflowV1Alpha3;
export type WorkflowMetadata = BPAWorkflow["metadata"];
export type WorkflowNode = GeneratedWorkflowNode;
export type NodeDefinition = BPANodeDefinition;
export type NodeDefinitionV1Alpha2 = BPANodeDefinitionV1Alpha2;
export type SourceRecordDefinition = BPASourceRecordV1Alpha1;
export type AssetRecordDefinition = BPAAssetRecordV1Alpha1;
export type EvidenceLinkDefinition = BPAEvidenceLinkV1Alpha1;
export type BrowserProtocolMessage = BPABrowserProtocolV2Message;
export type AssistanceTaskDefinition = BPAAssistanceTaskV1Alpha1;
export type AdapterManifestDefinition = BPAAdapterManifestV1Alpha1;
export type AssistanceProfileDefinition = BPAAssistanceProfileV1Alpha1;
export type DeterministicResultValidatorPolicyDefinition =
  BPADeterministicResultValidatorPolicyV1Alpha1;
export type DatasetVersionDefinition = BPADatasetVersionV1Alpha1;
export type DecisionRecordDefinition = BPADecisionRecordV1Alpha1;
export type ElementContractDefinition = BPAElementContractV1Alpha1;
export type PageModelDefinition = BPAPageModelV1Alpha1;
export type ScenarioSpecDefinition = BPAAuthoringScenarioSpecV1Alpha1;
export type AuthoringSessionDefinition = BPAAuthoringSessionV1Alpha1;
export type PageSnapshotDefinition = BPAAuthoringPageSnapshotV1Alpha1;
export type CandidateBundleDefinition = BPAAuthoringCandidateBundleV1Alpha1;
export type TriggerSpecDefinition = BPATriggerSpecV1Alpha1;
export type SignedPermissionGrant = BPASignedPermissionGrant;
export type RiskLevel = BPAWorkflow["spec"]["riskLevel"];
export type TimingPolicy = BPATimingPolicyV1;
export type RiskSignal = BPARiskSignalV1;
