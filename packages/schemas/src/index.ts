import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  BrowserProtocolMessage,
  NodeDefinition,
  WorkflowDefinition
} from "./types.js";

export * from "./types.js";

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

export const workflowSchema = loadSchema("workflow.schema.json");
export const nodeSchema = loadSchema("node.schema.json");
export const eventSchema = loadSchema("event.schema.json");
export const permissionSchema = loadSchema("permission.schema.json");
export const evidenceSchema = loadSchema("evidence.schema.json");
export const browserProtocolV1Schema = loadSchema(
  "browser-protocol-v1.schema.json"
);

const require = createRequire(import.meta.url);
interface AjvLike {
  compile<T = unknown>(schema: object): ValidateFunction<T>;
  addSchema(schema: object): AjvLike;
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

export const validateWorkflow = ajv.compile(
  workflowSchema
) as ValidateFunction<WorkflowDefinition>;
export const validateNode = ajv.compile(
  nodeSchema
) as ValidateFunction<NodeDefinition>;
export const validateEvent = ajv.compile(eventSchema);
export const validatePermission = ajv.compile(permissionSchema);
export const validateEvidence = ajv.compile(evidenceSchema);
export const validateBrowserProtocolMessage = ajv.compile(
  browserProtocolV1Schema
) as ValidateFunction<BrowserProtocolMessage>;

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined
): string[] {
  return (errors ?? []).map(
    (error) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}
