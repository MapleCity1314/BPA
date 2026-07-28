import { contentDigest } from "@bpa/compiler";
import type {
  RuntimeInvocation,
  RuntimeOutcome
} from "@bpa/node-runtime";
import type { Persistence } from "@bpa/persistence";
import {
  compileDataValidator,
  formatValidationErrors,
  validateNode,
  type NodeDefinition
} from "@bpa/schemas";
import type {
  JsonValue,
  RuntimeNodeSchemaContract
} from "@bpa/workflow-ir";

export type RuntimeContractResolution =
  | { readonly ok: true; readonly contract: RuntimeNodeSchemaContract }
  | { readonly ok: false; readonly errors: readonly string[] };

export type RuntimeSchemaFailureCode =
  | "RUNTIME_NODE_CONTRACT_UNAVAILABLE"
  | "RUNTIME_INPUT_SCHEMA_INVALID"
  | "RUNTIME_OUTPUT_SCHEMA_INVALID";

function schemaDefinitionErrors(
  schema: Readonly<Record<string, JsonValue>>,
  label: string
): string[] {
  try {
    compileDataValidator(schema);
    return [];
  } catch (error) {
    return [
      `${label} cannot be compiled: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }
}

function jsonSchema(
  value: Record<string, unknown>
): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<
    Record<string, JsonValue>
  >;
}

function contractErrors(
  invocation: RuntimeInvocation,
  contract: RuntimeNodeSchemaContract
): string[] {
  const errors: string[] = [];
  if (contract.nodeDigest !== invocation.node.digest) {
    errors.push("Schema contract Node digest does not match invocation");
  }
  if (contentDigest(contract.inputSchema) !== contract.inputSchemaDigest) {
    errors.push("Frozen input Schema digest does not match its content");
  }
  if (contentDigest(contract.outputSchema) !== contract.outputSchemaDigest) {
    errors.push("Frozen output Schema digest does not match its content");
  }
  errors.push(
    ...schemaDefinitionErrors(contract.inputSchema, "input Schema"),
    ...schemaDefinitionErrors(contract.outputSchema, "output Schema")
  );
  return errors;
}

/**
 * New invocations carry their immutable contract. Pre-contract snapshots may
 * backfill it only from the exact published Node; no Workflow is recompiled.
 */
export function resolveRuntimeNodeSchemaContract(
  persistence: Pick<Persistence, "getPublished">,
  invocation: RuntimeInvocation
): RuntimeContractResolution {
  if (invocation.schemaContract) {
    const errors = contractErrors(invocation, invocation.schemaContract);
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, contract: invocation.schemaContract };
  }

  const published = persistence.getPublished(
    "node",
    invocation.node.id,
    invocation.node.version
  );
  if (!published) {
    return {
      ok: false,
      errors: [
        `Legacy IR2 Node is not published: ${invocation.node.id}@${invocation.node.version}`
      ]
    };
  }

  const definition = published.content as NodeDefinition;
  const errors: string[] = [];
  if (published.digest !== invocation.node.digest) {
    errors.push("Published legacy Node digest has drifted");
  }
  if (contentDigest(published.content) !== published.digest) {
    errors.push("Published legacy Node content is not digest-consistent");
  }
  const validDefinition = validateNode(definition);
  if (!validDefinition) {
    errors.push(
      ...formatValidationErrors(validateNode.errors).map(
        (error) => `Published legacy Node${error}`
      )
    );
    return { ok: false, errors };
  }
  if (
    definition.metadata.id !== invocation.node.id ||
    definition.metadata.version !== invocation.node.version
  ) {
    errors.push("Published legacy Node identity does not match invocation");
  }
  if (errors.length > 0) return { ok: false, errors };

  const inputSchema = jsonSchema(definition.inputSchema);
  const outputSchema = jsonSchema(definition.outputSchema);
  const contract: RuntimeNodeSchemaContract = {
    nodeDigest: invocation.node.digest,
    inputSchema,
    inputSchemaDigest: contentDigest(inputSchema),
    outputSchema,
    outputSchemaDigest: contentDigest(outputSchema)
  };
  const frozenErrors = contractErrors(invocation, contract);
  return frozenErrors.length > 0
    ? { ok: false, errors: frozenErrors }
    : { ok: true, contract };
}

export function runtimeSchemaErrors(
  schema: Readonly<Record<string, JsonValue>>,
  value: JsonValue
): string[] {
  try {
    const validate = compileDataValidator(schema);
    return validate(value) ? [] : formatValidationErrors(validate.errors);
  } catch (error) {
    return [
      `Schema cannot be compiled: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }
}

export function runtimeSchemaFailure(input: {
  code: RuntimeSchemaFailureCode;
  message: string;
  invocation: RuntimeInvocation;
  schemaDigest?: string;
  errors: readonly string[];
  output?: JsonValue;
}): RuntimeOutcome {
  return {
    status: "failed",
    error: {
      code: input.code,
      message: input.message,
      retryable: false,
      details: {
        node: {
          id: input.invocation.node.id,
          version: input.invocation.node.version,
          digest: input.invocation.node.digest
        },
        ...(input.schemaDigest ? { schemaDigest: input.schemaDigest } : {}),
        valueDigest: contentDigest(
          input.output === undefined
            ? input.invocation.input
            : input.output
        ),
        errors: [...input.errors]
      }
    },
    ...(input.output === undefined ? {} : { output: input.output }),
    evidence: [],
    riskSignals: []
  };
}
