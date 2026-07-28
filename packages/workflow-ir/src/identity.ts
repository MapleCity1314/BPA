import type {
  ExecutionIdentity,
  IterationKey,
  ScopePath,
  ScopeSegment,
  StepKey
} from "./types.js";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OPAQUE_KEY_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/;

function requireKey(value: string, name: string): void {
  if (!KEY_PATTERN.test(value)) {
    throw new Error(
      `${name} must be 1-256 characters and contain only letters, numbers, ".", "_", ":" or "-"`
    );
  }
}

function requireOpaqueKey(value: string, name: string): void {
  if (!OPAQUE_KEY_PATTERN.test(value)) {
    throw new Error(
      `${name} must be 1-1024 characters and must not contain control characters`
    );
  }
}

export function normalizeScopePath(scopePath: ScopePath): ScopePath {
  return scopePath.map((segment) => ({
    foreachStepKey: segment.foreachStepKey.trim(),
    itemKey: segment.itemKey
  }));
}

export function createScopePath(
  segments: readonly ScopeSegment[] = []
): ScopePath {
  const normalized = normalizeScopePath(segments);
  for (const [index, segment] of normalized.entries()) {
    requireKey(segment.foreachStepKey, `scopePath[${index}].foreachStepKey`);
    requireOpaqueKey(segment.itemKey, `scopePath[${index}].itemKey`);
  }
  return normalized;
}

export function appendScope(
  scopePath: ScopePath,
  foreachStepKey: StepKey,
  itemKey: IterationKey
): ScopePath {
  return createScopePath([...scopePath, { foreachStepKey, itemKey }]);
}

export function createExecutionIdentity(
  input: ExecutionIdentity
): ExecutionIdentity {
  requireKey(input.runId.trim(), "runId");
  requireOpaqueKey(input.iterationKey, "iterationKey");
  requireKey(input.stepKey.trim(), "stepKey");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("attempt must be a positive safe integer");
  }
  return {
    runId: input.runId.trim(),
    scopePath: createScopePath(input.scopePath),
    iterationKey: input.iterationKey,
    stepKey: input.stepKey.trim(),
    attempt: input.attempt
  };
}

/**
 * Produces a stable, unambiguous identity string without generating any ID.
 */
export function executionIdentityKey(identity: ExecutionIdentity): string {
  const normalized = createExecutionIdentity(identity);
  return JSON.stringify([
    normalized.runId,
    normalized.scopePath.map((segment) => [
      segment.foreachStepKey,
      segment.itemKey
    ]),
    normalized.iterationKey,
    normalized.stepKey,
    normalized.attempt
  ]);
}
