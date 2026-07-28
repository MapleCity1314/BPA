export type CandidateJson =
  | string
  | number
  | boolean
  | null
  | CandidateJson[]
  | { [key: string]: CandidateJson };

export interface CandidateDraftStep {
  key: string;
  nodeRef: string;
  config: Record<string, CandidateJson>;
  inputBindings: Record<string, CandidateJson>;
}

export interface CandidateExceptionPolicy {
  failure: "fail" | "collect" | "request_assistance";
  timeout: "fail" | "collect" | "request_assistance";
  rejected: "fail" | "collect" | "request_assistance";
  cancelled: "fail" | "collect" | "request_assistance";
  uncertain: "request_assistance" | "stop_uncertain";
}

/**
 * MCP only builds small typed protocol payloads. Validation and CAS mutation
 * remain owned by authoring-core behind the Core control boundary.
 */
export function addOrReplaceStepOperation(input: {
  operationId: string;
  step: CandidateDraftStep;
}) {
  return {
    operationId: input.operationId,
    type: "step.add-or-replace" as const,
    step: input.step
  };
}

export function setBindingOperation(input: {
  operationId: string;
  stepKey: string;
  bindingKey: string;
  value: CandidateJson;
}) {
  return {
    operationId: input.operationId,
    type: "binding.set" as const,
    stepKey: input.stepKey,
    bindingKey: input.bindingKey,
    value: input.value
  };
}

export function setExceptionPolicyOperation(input: {
  operationId: string;
  stepKey: string;
  policy: CandidateExceptionPolicy;
}) {
  return {
    operationId: input.operationId,
    type: "exception-policy.set" as const,
    stepKey: input.stepKey,
    policy: input.policy
  };
}

export function parseAdapterRef(
  value: string | undefined
): { id: string; version: string } | undefined {
  if (!value) return undefined;
  const match =
    /^([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)$/.exec(
      value
    );
  if (!match) {
    throw new Error("adapter_ref must pin id@exact-semver");
  }
  return { id: match[1]!, version: match[2]! };
}

export function optionalOperationId(
  operationId: string | undefined
): { operationId?: string } {
  return operationId === undefined ? {} : { operationId };
}
