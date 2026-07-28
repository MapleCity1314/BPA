import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  BrowserProtocolMessage,
  AssistanceTaskDefinition,
  DatasetVersionDefinition,
  DecisionRecordDefinition,
  ElementContractDefinition,
  NodeDefinition,
  PageModelDefinition,
  WorkflowDefinition,
  WorkflowDefinitionV1Alpha2
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
export const nodeSchema = loadSchema("node.schema.json");
export const assistanceTaskSchema = loadSchema("assistance-task.schema.json");
export const datasetSchema = loadSchema("dataset.schema.json");
export const decisionRecordSchema = loadSchema("decision-record.schema.json");
export const elementContractSchema = loadSchema(
  "element-contract.schema.json"
);
export const pageModelSchema = loadSchema("page-model.schema.json");
export const eventSchema = loadSchema("event.schema.json");
export const permissionSchema = loadSchema("permission.schema.json");
export const evidenceSchema = loadSchema("evidence.schema.json");
export const timingPolicySchema = loadSchema("timing-policy.schema.json");
export const riskSignalSchema = loadSchema("risk-signal.schema.json");
export const browserProtocolV1Schema = loadSchema(
  "browser-protocol-v1.schema.json"
);

const require = createRequire(import.meta.url);
interface AjvLike {
  compile<T = unknown>(schema: object): ValidateFunction<T>;
  addSchema(schema: object): AjvLike;
  validateSchema(schema: object): boolean;
  errors?: ErrorObject[] | null;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvLike;
const Ajv2020 = require("ajv/dist/2020").default as AjvConstructor;
const addFormats = require("ajv-formats").default as (
  instance: AjvLike
) => void;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: true
});
addFormats(ajv);
ajv.addSchema(permissionSchema);
ajv.addSchema(timingPolicySchema);
ajv.addSchema(riskSignalSchema);

export const validateWorkflow = ajv.compile(
  workflowSchema
) as ValidateFunction<WorkflowDefinition>;
export const validateWorkflowV1Alpha2 = ajv.compile(
  workflowV1Alpha2Schema
) as ValidateFunction<WorkflowDefinitionV1Alpha2>;
export const validateNode = ajv.compile(
  nodeSchema
) as ValidateFunction<NodeDefinition>;
export const validateAssistanceTask = ajv.compile(
  assistanceTaskSchema
) as ValidateFunction<AssistanceTaskDefinition>;
export const validateDataset = ajv.compile(
  datasetSchema
) as ValidateFunction<DatasetVersionDefinition>;
export const validateDecisionRecord = ajv.compile(
  decisionRecordSchema
) as ValidateFunction<DecisionRecordDefinition>;
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
  browserProtocolV1Schema
) as ValidateFunction<BrowserProtocolMessage>;

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
