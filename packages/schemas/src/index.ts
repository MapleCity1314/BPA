import { readFileSync } from "node:fs";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  BrowserProtocolMessage,
  AdapterManifestDefinition,
  AssistanceProfileDefinition,
  AssistanceTaskDefinition,
  DatasetVersionDefinition,
  DecisionRecordDefinition,
  DeterministicResultValidatorPolicyDefinition,
  ElementContractDefinition,
  NodeDefinition,
  NodeDefinitionV1Alpha2,
  PageModelDefinition,
  ScenarioSpecDefinition,
  AuthoringSessionDefinition,
  PageSnapshotDefinition,
  CandidateBundleDefinition,
  SourceRecordDefinition,
  AssetRecordDefinition,
  EvidenceLinkDefinition,
  WorkflowDefinition,
  WorkflowDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha3,
  TriggerSpecDefinition
} from "./types.js";

export * from "./types.js";

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

export const workflowSchema = loadSchema("workflow.schema.json");
export const workflowV1Alpha2Schema = loadSchema(
  "workflow-v1alpha2.schema.json"
);
export const workflowV1Alpha3Schema = loadSchema(
  "workflow-v1alpha3.schema.json"
);
export const nodeSchema = loadSchema("node.schema.json");
export const nodeV1Alpha2Schema = loadSchema("node-v1alpha2.schema.json");
export const sourceRecordSchema = loadSchema("source-record.schema.json");
export const assetRecordSchema = loadSchema("asset-record.schema.json");
export const evidenceLinkSchema = loadSchema("evidence-link.schema.json");
export const adapterManifestSchema = loadSchema(
  "adapter-manifest.schema.json"
);
export const assistanceProfileSchema = loadSchema(
  "assistance-profile.schema.json"
);
export const assistanceTaskSchema = loadSchema("assistance-task.schema.json");
export const deterministicResultValidatorPolicySchema = loadSchema(
  "deterministic-result-validator-policy.schema.json"
);
export const datasetSchema = loadSchema("dataset.schema.json");
export const decisionRecordSchema = loadSchema("decision-record.schema.json");
export const scenarioSpecSchema = loadSchema("scenario-spec.schema.json");
export const authoringSessionSchema = loadSchema(
  "authoring-session.schema.json"
);
export const pageSnapshotSchema = loadSchema("page-snapshot.schema.json");
export const candidateBundleSchema = loadSchema(
  "candidate-bundle.schema.json"
);
export const elementContractSchema = loadSchema(
  "element-contract.schema.json"
);
export const pageModelSchema = loadSchema("page-model.schema.json");
export const eventSchema = loadSchema("event.schema.json");
export const permissionSchema = loadSchema("permission.schema.json");
export const evidenceSchema = loadSchema("evidence.schema.json");
export const timingPolicySchema = loadSchema("timing-policy.schema.json");
export const riskSignalSchema = loadSchema("risk-signal.schema.json");
export const browserProtocolV2Schema = loadSchema(
  "browser-protocol-v2.schema.json"
);
export const triggerSpecSchema = loadSchema("trigger-spec.schema.json");

interface AjvLike {
  compile<T = unknown>(schema: object): ValidateFunction<T>;
  addSchema(schema: object): AjvLike;
  validateSchema(schema: object): boolean;
  errors?: ErrorObject[] | null;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvLike;

const ajv = new (Ajv2020 as unknown as AjvConstructor)({
  allErrors: true,
  strict: true,
  strictRequired: true
});
(addFormats as unknown as (instance: AjvLike) => void)(ajv);
ajv.addSchema(permissionSchema);
ajv.addSchema(timingPolicySchema);
ajv.addSchema(riskSignalSchema);

export const validateWorkflow = ajv.compile(
  workflowSchema
) as ValidateFunction<WorkflowDefinition>;
export const validateWorkflowV1Alpha2 = ajv.compile(
  workflowV1Alpha2Schema
) as ValidateFunction<WorkflowDefinitionV1Alpha2>;
export const validateWorkflowV1Alpha3 = ajv.compile(
  workflowV1Alpha3Schema
) as ValidateFunction<WorkflowDefinitionV1Alpha3>;
export const validateNode = ajv.compile(
  nodeSchema
) as ValidateFunction<NodeDefinition>;
export const validateNodeV1Alpha2 = ajv.compile(
  nodeV1Alpha2Schema
) as ValidateFunction<NodeDefinitionV1Alpha2>;
export const validateSourceRecord = ajv.compile(
  sourceRecordSchema
) as ValidateFunction<SourceRecordDefinition>;
export const validateAssetRecord = ajv.compile(
  assetRecordSchema
) as ValidateFunction<AssetRecordDefinition>;
export const validateEvidenceLink = ajv.compile(
  evidenceLinkSchema
) as ValidateFunction<EvidenceLinkDefinition>;
export const validateAdapterManifest = ajv.compile(
  adapterManifestSchema
) as ValidateFunction<AdapterManifestDefinition>;
export const validateAssistanceProfile = ajv.compile(
  assistanceProfileSchema
) as ValidateFunction<AssistanceProfileDefinition>;
export const validateAssistanceTask = ajv.compile(
  assistanceTaskSchema
) as ValidateFunction<AssistanceTaskDefinition>;
export const validateDeterministicResultValidatorPolicy = ajv.compile(
  deterministicResultValidatorPolicySchema
) as ValidateFunction<DeterministicResultValidatorPolicyDefinition>;
export const validateDataset = ajv.compile(
  datasetSchema
) as ValidateFunction<DatasetVersionDefinition>;
export const validateDecisionRecord = ajv.compile(
  decisionRecordSchema
) as ValidateFunction<DecisionRecordDefinition>;
export const validateScenarioSpec = ajv.compile(
  scenarioSpecSchema
) as ValidateFunction<ScenarioSpecDefinition>;
export const validateAuthoringSession = ajv.compile(
  authoringSessionSchema
) as ValidateFunction<AuthoringSessionDefinition>;
export const validatePageSnapshot = ajv.compile(
  pageSnapshotSchema
) as ValidateFunction<PageSnapshotDefinition>;
export const validateCandidateBundle = ajv.compile(
  candidateBundleSchema
) as ValidateFunction<CandidateBundleDefinition>;
export const validateElementContract = ajv.compile(
  elementContractSchema
) as ValidateFunction<ElementContractDefinition>;
export const validatePageModel = ajv.compile(
  pageModelSchema
) as ValidateFunction<PageModelDefinition>;
export const validateEvent = ajv.compile(eventSchema);
export const validatePermission = ajv.compile(permissionSchema);
export const validateEvidence = ajv.compile(evidenceSchema);
export const validateTimingPolicy = ajv.compile(timingPolicySchema);
export const validateRiskSignal = ajv.compile(riskSignalSchema);
export const validateBrowserProtocolMessage = ajv.compile(
  browserProtocolV2Schema
) as ValidateFunction<BrowserProtocolMessage>;
export const validateTriggerSpec = ajv.compile(
  triggerSpecSchema
) as ValidateFunction<TriggerSpecDefinition>;

export function validateJsonSchemaDefinition(
  schema: Record<string, unknown>
): { valid: true } | { valid: false; errors: string[] } {
  const valid = ajv.validateSchema(schema);
  return valid
    ? { valid: true }
    : { valid: false, errors: formatValidationErrors(ajv.errors) };
}

export function compileDataValidator<T = unknown>(
  schema: Record<string, unknown>
): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined
): string[] {
  return (errors ?? []).map(
    (error) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}
