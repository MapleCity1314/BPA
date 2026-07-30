import type {
  BrowserResourceRequirementSnapshot,
  InvocationResourceBinding,
  ResourceAuthentication,
  ResourceBindingRef,
  ResourceBindingSnapshot
} from "@bpa/workflow-ir";

export interface Clock {
  now(): number;
}

export type ResourceBindingState =
  | "requested"
  | "validated"
  | "frozen"
  | "available"
  | "auth_required"
  | "revoked";

export interface ResourceBindingRecord {
  readonly bindingId: string;
  readonly runId: string;
  readonly slotName: string;
  readonly requirement: BrowserResourceRequirementSnapshot;
  readonly state: ResourceBindingState;
  readonly revision: number;
  readonly requestedAt: number;
  readonly updatedAt: number;
  readonly candidate?: ResourceBindingRef;
  readonly frozen?: ResourceBindingRef;
  readonly reason?: string;
}

export interface ResourceBindingEvent {
  readonly bindingId: string;
  readonly revision: number;
  readonly from?: ResourceBindingState;
  readonly to: ResourceBindingState;
  readonly at: number;
  readonly reason?: string;
}

export interface ResourceBindingTransition {
  readonly record: ResourceBindingRecord;
  readonly event: ResourceBindingEvent;
}

export class InvalidResourceBindingTransitionError extends Error {
  constructor(
    readonly from: ResourceBindingState,
    readonly to: ResourceBindingState
  ) {
    super(`Invalid resource binding transition: ${from} -> ${to}`);
    this.name = "InvalidResourceBindingTransitionError";
  }
}

function copyRequirement(
  requirement: BrowserResourceRequirementSnapshot
): BrowserResourceRequirementSnapshot {
  return {
    ...requirement,
    capabilities: [...requirement.capabilities],
    allowedOrigins: [...requirement.allowedOrigins]
  };
}

function copyBinding(binding: ResourceBindingRef): ResourceBindingRef {
  return { ...binding };
}

function transition(
  record: ResourceBindingRecord,
  to: ResourceBindingState,
  clock: Clock,
  changes: Partial<ResourceBindingRecord> = {},
  clearReason = false
): ResourceBindingTransition {
  const at = clock.now();
  const { reason: _previousReason, ...withoutReason } = record;
  const next: ResourceBindingRecord = {
    ...(clearReason ? withoutReason : record),
    ...changes,
    state: to,
    revision: record.revision + 1,
    updatedAt: at
  };
  return {
    record: next,
    event: {
      bindingId: record.bindingId,
      revision: next.revision,
      from: record.state,
      to,
      at,
      ...(next.reason === undefined ? {} : { reason: next.reason })
    }
  };
}

export function requestResourceBinding(
  input: {
    bindingId: string;
    runId: string;
    slotName: string;
    requirement: BrowserResourceRequirementSnapshot;
  },
  clock: Clock
): ResourceBindingTransition {
  const at = clock.now();
  const record: ResourceBindingRecord = {
    ...input,
    requirement: copyRequirement(input.requirement),
    state: "requested",
    revision: 1,
    requestedAt: at,
    updatedAt: at
  };
  return {
    record,
    event: {
      bindingId: input.bindingId,
      revision: 1,
      to: "requested",
      at
    }
  };
}

export function validateResourceBinding(
  record: ResourceBindingRecord,
  candidate: ResourceBindingRef,
  clock: Clock
): ResourceBindingTransition {
  if (record.state !== "requested") {
    throw new InvalidResourceBindingTransitionError(
      record.state,
      "validated"
    );
  }
  if (
    candidate.bindingId !== record.bindingId ||
    candidate.slotName !== record.slotName
  ) {
    throw new Error("Candidate does not match the requested binding identity");
  }
  if (
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    !candidate.approvedBy.trim()
  ) {
    throw new Error("Candidate requires a revision and approving subject");
  }
  if (!record.requirement.allowedOrigins.includes(candidate.origin)) {
    throw new Error("Candidate origin is outside the requested resource");
  }
  if (
    AUTHENTICATION_RANK[candidate.authentication] <
    AUTHENTICATION_RANK[record.requirement.authentication]
  ) {
    throw new Error(
      "Candidate authentication does not satisfy the requested resource"
    );
  }
  return transition(
    record,
    "validated",
    clock,
    { candidate: copyBinding(candidate) },
    true
  );
}

export function freezeResourceBinding(
  record: ResourceBindingRecord,
  clock: Clock
): ResourceBindingTransition {
  if (record.state !== "validated" || !record.candidate) {
    throw new InvalidResourceBindingTransitionError(record.state, "frozen");
  }
  return transition(
    record,
    "frozen",
    clock,
    {
      frozen: {
        ...copyBinding(record.candidate),
        frozenAt: clock.now()
      }
    },
    true
  );
}

export function makeResourceBindingAvailable(
  record: ResourceBindingRecord,
  clock: Clock
): ResourceBindingTransition {
  if (
    !["frozen", "auth_required"].includes(record.state) ||
    !record.frozen
  ) {
    throw new InvalidResourceBindingTransitionError(
      record.state,
      "available"
    );
  }
  return transition(record, "available", clock, {}, true);
}

export function requireResourceAuthentication(
  record: ResourceBindingRecord,
  reason: string,
  clock: Clock
): ResourceBindingTransition {
  if (!["frozen", "available"].includes(record.state)) {
    throw new InvalidResourceBindingTransitionError(
      record.state,
      "auth_required"
    );
  }
  return transition(record, "auth_required", clock, { reason });
}

export function revokeResourceBinding(
  record: ResourceBindingRecord,
  reason: string,
  clock: Clock
): ResourceBindingTransition {
  if (record.state === "revoked") {
    throw new InvalidResourceBindingTransitionError(record.state, "revoked");
  }
  return transition(record, "revoked", clock, { reason });
}

export function createResourceBindingSnapshot(
  runId: string,
  records: readonly ResourceBindingRecord[]
): ResourceBindingSnapshot {
  const bindings: Record<string, ResourceBindingRef> = {};
  const resourceSlots: Record<
    string,
    BrowserResourceRequirementSnapshot
  > = {};
  for (const record of [...records].sort((left, right) =>
    left.slotName.localeCompare(right.slotName)
  )) {
    if (record.runId !== runId) {
      throw new Error("Resource binding belongs to a different Run");
    }
    if (
      !["frozen", "available", "auth_required"].includes(record.state) ||
      !record.frozen
    ) {
      throw new Error(
        `Resource binding ${record.bindingId} is not frozen`
      );
    }
    if (bindings[record.slotName]) {
      throw new Error(
        `Resource slot ${record.slotName} has more than one frozen binding`
      );
    }
    bindings[record.slotName] = copyBinding(record.frozen);
    resourceSlots[record.slotName] = copyRequirement(record.requirement);
  }
  return {
    snapshotVersion: "bpa.resource-binding/1",
    runId,
    resourceSlots,
    bindings
  };
}

export interface ObservedBrowserSession {
  readonly sessionId: string;
  readonly capabilityDigest: string;
  readonly capabilities: readonly string[];
  readonly origin: string;
  readonly authentication: ResourceAuthentication;
  readonly state: "available" | "auth_required" | "revoked";
}

export interface ResourceBindingValidationIssue {
  readonly code:
    | "BINDING_SLOT_MISMATCH"
    | "SESSION_NOT_AVAILABLE"
    | "SESSION_MISMATCH"
    | "CAPABILITY_DIGEST_MISMATCH"
    | "CAPABILITY_MISSING"
    | "ORIGIN_MISMATCH"
    | "ORIGIN_NOT_ALLOWED"
    | "AUTHENTICATION_MISMATCH"
    | "AUTHENTICATION_INSUFFICIENT";
  readonly message: string;
}

const AUTHENTICATION_RANK = {
  anonymous: 0,
  optional: 1,
  authenticated: 2,
  membership: 3
} as const;

export function validateInvocationResourceBinding(
  resource: InvocationResourceBinding,
  session: ObservedBrowserSession
): readonly ResourceBindingValidationIssue[] {
  const issues: ResourceBindingValidationIssue[] = [];
  const binding = resource.binding;
  if (
    binding.slotName !== resource.slotName ||
    resource.requirementName.length === 0
  ) {
    issues.push({
      code: "BINDING_SLOT_MISMATCH",
      message: "Frozen binding does not match the invocation resource slot."
    });
  }
  if (session.state !== "available") {
    issues.push({
      code: "SESSION_NOT_AVAILABLE",
      message: `Browser session is ${session.state}.`
    });
  }
  if (session.sessionId !== binding.sessionId) {
    issues.push({
      code: "SESSION_MISMATCH",
      message: "Browser session differs from the frozen binding."
    });
  }
  if (session.capabilityDigest !== binding.capabilityDigest) {
    issues.push({
      code: "CAPABILITY_DIGEST_MISMATCH",
      message: "Browser capability digest differs from the frozen binding."
    });
  }
  const capabilities = new Set(session.capabilities);
  if (
    resource.requirement.capabilities.some(
      (capability) => !capabilities.has(capability)
    )
  ) {
    issues.push({
      code: "CAPABILITY_MISSING",
      message: "Browser session does not satisfy every required capability."
    });
  }
  if (session.origin !== binding.origin) {
    issues.push({
      code: "ORIGIN_MISMATCH",
      message: "Browser origin differs from the frozen binding."
    });
  }
  if (!resource.requirement.allowedOrigins.includes(session.origin)) {
    issues.push({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Browser origin is outside the immutable Node requirement."
    });
  }
  if (session.authentication !== binding.authentication) {
    issues.push({
      code: "AUTHENTICATION_MISMATCH",
      message: "Authentication level differs from the frozen binding."
    });
  }
  if (
    AUTHENTICATION_RANK[session.authentication] <
    AUTHENTICATION_RANK[resource.requirement.authentication]
  ) {
    issues.push({
      code: "AUTHENTICATION_INSUFFICIENT",
      message: "Browser authentication does not satisfy the Node requirement."
    });
  }
  return issues;
}
