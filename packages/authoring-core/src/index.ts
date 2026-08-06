export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export interface CapabilityGap {
  gapId: string;
  capabilityId: string;
  summary: string;
  platform?: string;
  requiredInputs: string[];
  requiredOutputs: string[];
  maximumRisk: RiskLevel;
  status: "open" | "resolved";
  resolution?: {
    kind: "catalog-entry" | "recipe" | "candidate";
    reference: string;
    resolvedAt: string;
  };
}

export interface RecipeStep {
  key: string;
  capabilityRef: string;
  inputBindings: JsonObject;
}

export interface Recipe {
  recipeId: string;
  version: string;
  title: string;
  capabilityIds: string[];
  platforms: string[];
  inputTypes: string[];
  outputTypes: string[];
  riskLevel: RiskLevel;
  permissions: string[];
  adapterRefs: string[];
  steps: RecipeStep[];
}

export type CatalogEntryKind = "node" | "workflow" | "recipe";

export interface CatalogEntry {
  kind: CatalogEntryKind;
  id: string;
  version: string;
  title: string;
  capabilityIds: string[];
  aliases: string[];
  platforms: string[];
  runtime: "builtin" | "browser" | "team" | "assistance" | "composite";
  inputTypes: string[];
  outputTypes: string[];
  riskLevel: RiskLevel;
  permissions: string[];
  adapter?: {
    id: string;
    version: string;
  };
  verifiedAt?: string;
}

export interface CatalogQuery {
  capabilityIds: string[];
  platform?: string;
  runtime?: CatalogEntry["runtime"];
  availableInputTypes: string[];
  requiredOutputTypes: string[];
  maximumRisk: RiskLevel;
  allowedPermissions: string[];
  adapter?: {
    id: string;
    version: string;
  };
}

export interface CatalogScore {
  entry: CatalogEntry;
  eligible: boolean;
  score: number;
  components: {
    capability: number;
    platform: number;
    input: number;
    output: number;
    risk: number;
    permission: number;
    adapter: number;
  };
  reasons: string[];
}

export interface DraftStep {
  key: string;
  nodeRef: string;
  config: JsonObject;
  inputBindings: JsonObject;
  exceptionPolicy?: DraftExceptionPolicy;
}

export type DraftExceptionAction =
  | "fail"
  | "collect"
  | "request_assistance"
  | "stop_uncertain";

export interface DraftExceptionPolicy {
  failure: Exclude<DraftExceptionAction, "stop_uncertain">;
  timeout: Exclude<DraftExceptionAction, "stop_uncertain">;
  cancelled: Exclude<DraftExceptionAction, "stop_uncertain">;
  uncertain: "request_assistance" | "stop_uncertain";
}

export type DraftEdgeOutcome =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "uncertain";

export interface DraftEdge {
  from: string;
  outcome: DraftEdgeOutcome;
  to: string;
}

export interface DraftTest {
  testId: string;
  title: string;
  scenario:
    | "success"
    | "failure"
    | "timeout"
    | "cancelled"
    | "uncertain"
    | "business";
  input: JsonValue;
  expected: JsonValue;
}

export interface WorkflowDraft {
  draftId: string;
  revision: number;
  title: string;
  description: string;
  status: "editing";
  steps: Record<string, DraftStep>;
  edges: DraftEdge[];
  tests: Record<string, DraftTest>;
  gaps: Record<string, CapabilityGap>;
  appliedOperationIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface DraftOperationBase {
  operationId: string;
}

export type DraftOperation =
  | (DraftOperationBase & {
      type: "metadata.update";
      patch: { title?: string; description?: string };
    })
  | (DraftOperationBase & {
      type: "step.add";
      step: DraftStep;
    })
  | (DraftOperationBase & {
      type: "step.add-or-replace";
      step: DraftStep;
    })
  | (DraftOperationBase & {
      type: "step.configure";
      stepKey: string;
      patch: { config?: JsonObject; inputBindings?: JsonObject };
    })
  | (DraftOperationBase & {
      type: "binding.set";
      stepKey: string;
      bindingKey: string;
      value: JsonValue;
    })
  | (DraftOperationBase & {
      type: "exception-policy.set";
      stepKey: string;
      policy: DraftExceptionPolicy;
    })
  | (DraftOperationBase & {
      type: "step.remove";
      stepKey: string;
    })
  | (DraftOperationBase & {
      type: "edge.set";
      edge: DraftEdge;
    })
  | (DraftOperationBase & {
      type: "edge.remove";
      from: string;
      outcome: DraftEdge["outcome"];
    })
  | (DraftOperationBase & {
      type: "test.add";
      test: DraftTest;
    })
  | (DraftOperationBase & {
      type: "test.remove";
      testId: string;
    })
  | (DraftOperationBase & {
      type: "gap.record";
      gap: CapabilityGap;
    })
  | (DraftOperationBase & {
      type: "gap.resolve";
      gapId: string;
      resolution: NonNullable<CapabilityGap["resolution"]>;
    });

export interface WorkflowCandidate {
  candidateId: string;
  draftId: string;
  sourceRevision: number;
  status: "candidate";
  content: {
    title: string;
    description: string;
    steps: Record<string, DraftStep>;
    edges: DraftEdge[];
    tests: Record<string, DraftTest>;
  };
  createdAt: string;
}

export interface WorkflowDraftChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: JsonValue;
  after?: JsonValue;
}

export interface WorkflowDraftDiff {
  draftId: string;
  fromRevision: number;
  toRevision: number;
  changes: WorkflowDraftChange[];
  truncated: boolean;
}

export interface WorkflowCandidateValidation {
  draftId: string;
  revision: number;
  valid: boolean;
  issues: string[];
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const EXACT_REF_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const RISK_RANK: Record<RiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4
};

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function requireTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a timestamp`);
  return new Date(timestamp).toISOString();
}

function requireId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a stable identifier`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertWorkflowSafeJson(
  value: JsonValue,
  path: string,
  depth = 0
): void {
  if (depth > 50) {
    throw new InvalidDraftOperationError(
      `Workflow value exceeds maximum depth at ${path}`
    );
  }
  if (typeof value === "string") {
    if (
      /\bjavascript\s*:/i.test(value) ||
      /\b(?:document|window)\s*\./i.test(value) ||
      /^\s*(?:\/{2}|\(\/{2})/.test(value)
    ) {
      throw new InvalidDraftOperationError(
        `Workflow cannot contain JavaScript or XPath at ${path}`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertWorkflowSafeJson(entry, `${path}/${index}`, depth + 1)
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        [
          "__proto__",
          "prototype",
          "constructor",
          "selector",
          "cssSelector",
          "xpath",
          "coordinates",
          "screenCoordinates",
          "javascript",
          "evaluate"
        ].includes(key)
      ) {
        throw new InvalidDraftOperationError(
          `Workflow cannot contain locator or executable field ${path}/${key}`
        );
      }
      assertWorkflowSafeJson(entry, `${path}/${key}`, depth + 1);
    }
  }
}

export class DraftRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Workflow Draft revision conflict: expected ${expectedRevision}, actual ${actualRevision}`
    );
  }
}

export class InvalidDraftOperationError extends Error {}

export function createWorkflowDraft(input: {
  draftId: string;
  title: string;
  description: string;
  now: string;
}): WorkflowDraft {
  requireId(input.draftId, "draftId");
  if (!isNonEmpty(input.title) || !isNonEmpty(input.description)) {
    throw new Error("Workflow Draft requires a title and description");
  }
  const now = requireTimestamp(input.now, "now");
  return {
    draftId: input.draftId,
    revision: 0,
    title: input.title,
    description: input.description,
    status: "editing",
    steps: {},
    edges: [],
    tests: {},
    gaps: {},
    appliedOperationIds: [],
    createdAt: now,
    updatedAt: now
  };
}

function validateStep(step: DraftStep): void {
  requireId(step.key, "step.key");
  if (!EXACT_REF_PATTERN.test(step.nodeRef)) {
    throw new InvalidDraftOperationError(
      "Draft steps must pin an exact capability Node SemVer"
    );
  }
  assertWorkflowSafeJson(step.config, `/steps/${step.key}/config`);
  assertWorkflowSafeJson(
    step.inputBindings,
    `/steps/${step.key}/inputBindings`
  );
  if (step.exceptionPolicy) {
    validateExceptionPolicy(step.exceptionPolicy);
  }
}

function validateExceptionPolicy(policy: DraftExceptionPolicy): void {
  const expectedOutcomes = [
    "failure",
    "timeout",
    "cancelled",
    "uncertain"
  ] as const;
  const actualOutcomes = Object.keys(policy);
  if (
    actualOutcomes.length !== expectedOutcomes.length ||
    expectedOutcomes.some((outcome) => !(outcome in policy))
  ) {
    throw new InvalidDraftOperationError(
      "Exception policy must define exactly failure, timeout, cancelled, and uncertain"
    );
  }
  const ordinary = new Set<DraftExceptionAction>([
    "fail",
    "collect",
    "request_assistance"
  ]);
  for (const [outcome, action] of Object.entries(policy)) {
    const valid =
      outcome === "uncertain"
        ? action === "request_assistance" || action === "stop_uncertain"
        : ordinary.has(action);
    if (!valid) {
      throw new InvalidDraftOperationError(
        `Invalid exception policy action ${String(action)} for ${outcome}`
      );
    }
  }
}

const draftEdgeOutcomes = new Set<DraftEdgeOutcome>([
  "success",
  "failure",
  "timeout",
  "cancelled",
  "uncertain"
]);

function validateDraftEdgeOutcome(outcome: unknown): void {
  if (!draftEdgeOutcomes.has(outcome as DraftEdgeOutcome)) {
    throw new InvalidDraftOperationError(
      `Invalid Draft edge outcome: ${String(outcome)}`
    );
  }
}

function validateGap(gap: CapabilityGap): void {
  requireId(gap.gapId, "gap.gapId");
  requireId(gap.capabilityId, "gap.capabilityId");
  if (!isNonEmpty(gap.summary)) {
    throw new InvalidDraftOperationError("CapabilityGap summary is required");
  }
  if (gap.status === "open" && gap.resolution) {
    throw new InvalidDraftOperationError(
      "Open CapabilityGap cannot contain a resolution"
    );
  }
  if (gap.status === "resolved" && !gap.resolution) {
    throw new InvalidDraftOperationError(
      "Resolved CapabilityGap requires a resolution"
    );
  }
}

function assertMissing<T>(
  record: Record<string, T>,
  key: string,
  label: string
): void {
  if (record[key]) {
    throw new InvalidDraftOperationError(`${label} already exists: ${key}`);
  }
}

function assertPresent<T>(
  record: Record<string, T>,
  key: string,
  label: string
): T {
  const value = record[key];
  if (!value) {
    throw new InvalidDraftOperationError(`${label} does not exist: ${key}`);
  }
  return value;
}

function applyUnchecked(
  draft: WorkflowDraft,
  operation: DraftOperation
): void {
  switch (operation.type) {
    case "metadata.update":
      if (
        operation.patch.title === undefined &&
        operation.patch.description === undefined
      ) {
        throw new InvalidDraftOperationError("Metadata patch cannot be empty");
      }
      if (
        (operation.patch.title !== undefined &&
          !isNonEmpty(operation.patch.title)) ||
        (operation.patch.description !== undefined &&
          !isNonEmpty(operation.patch.description))
      ) {
        throw new InvalidDraftOperationError(
          "Draft title and description cannot be empty"
        );
      }
      draft.title = operation.patch.title ?? draft.title;
      draft.description = operation.patch.description ?? draft.description;
      break;
    case "step.add":
    case "step.add-or-replace":
      validateStep(operation.step);
      if (operation.type === "step.add") {
        assertMissing(draft.steps, operation.step.key, "Step");
      }
      draft.steps[operation.step.key] = clone(operation.step);
      break;
    case "step.configure": {
      const step = assertPresent(draft.steps, operation.stepKey, "Step");
      if (
        operation.patch.config === undefined &&
        operation.patch.inputBindings === undefined
      ) {
        throw new InvalidDraftOperationError("Step patch cannot be empty");
      }
      if (operation.patch.config !== undefined) {
        assertWorkflowSafeJson(
          operation.patch.config,
          `/steps/${operation.stepKey}/config`
        );
      }
      if (operation.patch.inputBindings !== undefined) {
        assertWorkflowSafeJson(
          operation.patch.inputBindings,
          `/steps/${operation.stepKey}/inputBindings`
        );
      }
      draft.steps[operation.stepKey] = {
        ...step,
        ...(operation.patch.config !== undefined
          ? { config: clone(operation.patch.config) }
          : {}),
        ...(operation.patch.inputBindings !== undefined
          ? { inputBindings: clone(operation.patch.inputBindings) }
          : {})
      };
      break;
    }
    case "binding.set": {
      const step = assertPresent(draft.steps, operation.stepKey, "Step");
      requireId(operation.bindingKey, "bindingKey");
      if (
        ["__proto__", "prototype", "constructor"].includes(
          operation.bindingKey
        )
      ) {
        throw new InvalidDraftOperationError(
          `Binding key is reserved: ${operation.bindingKey}`
        );
      }
      assertWorkflowSafeJson(
        operation.value,
        `/steps/${operation.stepKey}/inputBindings/${operation.bindingKey}`
      );
      draft.steps[operation.stepKey] = {
        ...step,
        inputBindings: {
          ...step.inputBindings,
          [operation.bindingKey]: clone(operation.value)
        }
      };
      break;
    }
    case "exception-policy.set": {
      const step = assertPresent(draft.steps, operation.stepKey, "Step");
      validateExceptionPolicy(operation.policy);
      draft.steps[operation.stepKey] = {
        ...step,
        exceptionPolicy: clone(operation.policy)
      };
      break;
    }
    case "step.remove":
      assertPresent(draft.steps, operation.stepKey, "Step");
      if (
        draft.edges.some(
          (edge) =>
            edge.from === operation.stepKey || edge.to === operation.stepKey
        )
      ) {
        throw new InvalidDraftOperationError(
          `Step ${operation.stepKey} is still referenced by an edge`
        );
      }
      delete draft.steps[operation.stepKey];
      break;
    case "edge.set":
      assertPresent(draft.steps, operation.edge.from, "Edge source step");
      assertPresent(draft.steps, operation.edge.to, "Edge target step");
      validateDraftEdgeOutcome(operation.edge.outcome);
      if (operation.edge.from === operation.edge.to) {
        throw new InvalidDraftOperationError(
          "Draft edges cannot create a direct self-loop"
        );
      }
      draft.edges = draft.edges.filter(
        (edge) =>
          !(
            edge.from === operation.edge.from &&
            edge.outcome === operation.edge.outcome
          )
      );
      draft.edges.push(clone(operation.edge));
      break;
    case "edge.remove": {
      validateDraftEdgeOutcome(operation.outcome);
      const nextEdges = draft.edges.filter(
        (edge) =>
          !(
            edge.from === operation.from && edge.outcome === operation.outcome
          )
      );
      if (nextEdges.length === draft.edges.length) {
        throw new InvalidDraftOperationError("Edge does not exist");
      }
      draft.edges = nextEdges;
      break;
    }
    case "test.add":
      requireId(operation.test.testId, "test.testId");
      if (!isNonEmpty(operation.test.title)) {
        throw new InvalidDraftOperationError("Draft test title is required");
      }
      assertWorkflowSafeJson(
        operation.test.input,
        `/tests/${operation.test.testId}/input`
      );
      assertWorkflowSafeJson(
        operation.test.expected,
        `/tests/${operation.test.testId}/expected`
      );
      assertMissing(draft.tests, operation.test.testId, "Test");
      draft.tests[operation.test.testId] = clone(operation.test);
      break;
    case "test.remove":
      assertPresent(draft.tests, operation.testId, "Test");
      delete draft.tests[operation.testId];
      break;
    case "gap.record":
      validateGap(operation.gap);
      assertMissing(draft.gaps, operation.gap.gapId, "CapabilityGap");
      draft.gaps[operation.gap.gapId] = clone(operation.gap);
      break;
    case "gap.resolve": {
      const gap = assertPresent(draft.gaps, operation.gapId, "CapabilityGap");
      if (gap.status === "resolved") {
        throw new InvalidDraftOperationError(
          `CapabilityGap is already resolved: ${operation.gapId}`
        );
      }
      requireTimestamp(operation.resolution.resolvedAt, "resolution.resolvedAt");
      if (!isNonEmpty(operation.resolution.reference)) {
        throw new InvalidDraftOperationError(
          "CapabilityGap resolution reference is required"
        );
      }
      draft.gaps[operation.gapId] = {
        ...gap,
        status: "resolved",
        resolution: clone(operation.resolution)
      };
      break;
    }
  }
}

export function applyDraftOperation(
  current: WorkflowDraft,
  expectedRevision: number,
  operation: DraftOperation,
  now: string
): WorkflowDraft {
  if (current.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(expectedRevision, current.revision);
  }
  requireId(operation.operationId, "operationId");
  if (current.appliedOperationIds.includes(operation.operationId)) {
    throw new InvalidDraftOperationError(
      `Draft operation was already applied: ${operation.operationId}`
    );
  }
  const next = clone(current);
  applyUnchecked(next, operation);
  next.revision += 1;
  next.appliedOperationIds.push(operation.operationId);
  next.updatedAt = requireTimestamp(now, "now");
  return next;
}

export function applyDraftOperations(
  current: WorkflowDraft,
  expectedRevision: number,
  operations: readonly DraftOperation[],
  now: string
): WorkflowDraft {
  if (current.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(expectedRevision, current.revision);
  }
  if (operations.length === 0) return clone(current);
  const timestamp = requireTimestamp(now, "now");
  let next = clone(current);
  for (const operation of operations) {
    next = applyDraftOperation(next, next.revision, operation, timestamp);
  }
  return next;
}

export function workflowDraftIssues(draft: WorkflowDraft): string[] {
  const issues: string[] = [];
  for (const step of Object.values(draft.steps)) {
    if (!EXACT_REF_PATTERN.test(step.nodeRef)) {
      issues.push(`Step ${step.key} does not pin an exact Node SemVer`);
    }
    if (step.exceptionPolicy) {
      try {
        validateExceptionPolicy(step.exceptionPolicy);
      } catch (error) {
        issues.push(
          `Step ${step.key} has an invalid exception policy: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  for (const edge of draft.edges) {
    if (!draftEdgeOutcomes.has(edge.outcome as DraftEdgeOutcome)) {
      issues.push(
        `Edge ${edge.from}:${String(edge.outcome)} has an invalid outcome`
      );
    }
    if (!draft.steps[edge.from] || !draft.steps[edge.to]) {
      issues.push(
        `Edge ${edge.from}:${edge.outcome}->${edge.to} references a missing step`
      );
    }
  }
  if (Object.keys(draft.steps).length === 0) {
    issues.push("Draft must contain at least one step");
  }
  if (Object.keys(draft.tests).length === 0) {
    issues.push("Draft must contain at least one test");
  }
  for (const gap of Object.values(draft.gaps)) {
    if (gap.status === "open") {
      issues.push(`CapabilityGap remains open: ${gap.gapId}`);
    }
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of draft.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const containsCycle = (stepKey: string): boolean => {
    if (visiting.has(stepKey)) return true;
    if (visited.has(stepKey)) return false;
    visiting.add(stepKey);
    for (const target of outgoing.get(stepKey) ?? []) {
      if (containsCycle(target)) return true;
    }
    visiting.delete(stepKey);
    visited.add(stepKey);
    return false;
  };
  if (Object.keys(draft.steps).some((stepKey) => containsCycle(stepKey))) {
    issues.push(
      "Draft contains an arbitrary graph cycle; use a structured bounded iteration"
    );
  }
  return issues;
}

export function createWorkflowCandidate(
  draft: WorkflowDraft,
  expectedRevision: number,
  input: { candidateId: string; now: string }
): WorkflowCandidate {
  if (draft.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(expectedRevision, draft.revision);
  }
  requireId(input.candidateId, "candidateId");
  const issues = workflowDraftIssues(draft);
  if (issues.length > 0) {
    throw new InvalidDraftOperationError(
      `Draft cannot become a Candidate:\n${issues.join("\n")}`
    );
  }
  return {
    candidateId: input.candidateId,
    draftId: draft.draftId,
    sourceRevision: draft.revision,
    status: "candidate",
    content: {
      title: draft.title,
      description: draft.description,
      steps: clone(draft.steps),
      edges: clone(draft.edges),
      tests: clone(draft.tests)
    },
    createdAt: requireTimestamp(input.now, "now")
  };
}

export function validateWorkflowCandidateDraft(
  draft: WorkflowDraft,
  expectedRevision: number
): WorkflowCandidateValidation {
  if (draft.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(expectedRevision, draft.revision);
  }
  const issues = workflowDraftIssues(draft);
  return {
    draftId: draft.draftId,
    revision: draft.revision,
    valid: issues.length === 0,
    issues
  };
}

function escapedPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function semanticDraft(draft: WorkflowDraft): JsonObject {
  return clone({
    title: draft.title,
    description: draft.description,
    steps: draft.steps,
    edges: draft.edges,
    tests: draft.tests,
    gaps: draft.gaps
  }) as unknown as JsonObject;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectDraftChanges(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  changes: WorkflowDraftChange[],
  limit: number
): void {
  if (changes.length >= limit) return;
  if (before === undefined) {
    changes.push({ path, kind: "added", after: clone(after!) });
    return;
  }
  if (after === undefined) {
    changes.push({ path, kind: "removed", before: clone(before) });
    return;
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort();
    for (const key of keys) {
      collectDraftChanges(
        before[key],
        after[key],
        `${path}/${escapedPointerSegment(key)}`,
        changes,
        limit
      );
      if (changes.length >= limit) return;
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({
      path,
      kind: "changed",
      before: clone(before),
      after: clone(after)
    });
  }
}

export function diffWorkflowDrafts(
  before: WorkflowDraft,
  after: WorkflowDraft,
  limit = 200
): WorkflowDraftDiff {
  if (before.draftId !== after.draftId) {
    throw new InvalidDraftOperationError(
      "Workflow Draft diff requires the same draftId"
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new InvalidDraftOperationError(
      "Workflow Draft diff limit must be between 1 and 1000"
    );
  }
  const changes: WorkflowDraftChange[] = [];
  collectDraftChanges(
    semanticDraft(before),
    semanticDraft(after),
    "",
    changes,
    limit + 1
  );
  const truncated = changes.length > limit;
  return {
    draftId: before.draftId,
    fromRevision: before.revision,
    toRevision: after.revision,
    changes: changes.slice(0, limit),
    truncated
  };
}

export interface WorkflowDraftStore {
  create(input: {
    draftId: string;
    title: string;
    description: string;
    now: string;
  }): WorkflowDraft;
  get(draftId: string): WorkflowDraft | undefined;
  apply(
    draftId: string,
    expectedRevision: number,
    operation: DraftOperation,
    now: string
  ): WorkflowDraft;
}

/**
 * Reference CAS store for authoring providers and tests. Production adapters
 * can implement the same contract over a durable transaction boundary.
 */
export class MemoryWorkflowDraftStore implements WorkflowDraftStore {
  readonly #drafts = new Map<string, WorkflowDraft>();

  create(input: {
    draftId: string;
    title: string;
    description: string;
    now: string;
  }): WorkflowDraft {
    if (this.#drafts.has(input.draftId)) {
      throw new InvalidDraftOperationError(
        `Workflow Draft already exists: ${input.draftId}`
      );
    }
    const draft = createWorkflowDraft(input);
    this.#drafts.set(draft.draftId, draft);
    return clone(draft);
  }

  get(draftId: string): WorkflowDraft | undefined {
    const draft = this.#drafts.get(draftId);
    return draft ? clone(draft) : undefined;
  }

  apply(
    draftId: string,
    expectedRevision: number,
    operation: DraftOperation,
    now: string
  ): WorkflowDraft {
    const current = this.#drafts.get(draftId);
    if (!current) {
      throw new InvalidDraftOperationError(
        `Workflow Draft does not exist: ${draftId}`
      );
    }
    const next = applyDraftOperation(
      current,
      expectedRevision,
      operation,
      now
    );
    this.#drafts.set(draftId, next);
    return clone(next);
  }
}

function normalized(values: readonly string[]): Set<string> {
  return new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

function coverage(required: Set<string>, offered: Set<string>): number {
  if (required.size === 0) return 1;
  let matches = 0;
  for (const value of required) {
    if (offered.has(value)) matches += 1;
  }
  return matches / required.size;
}

function containsAll(required: Set<string>, offered: Set<string>): boolean {
  return [...required].every((value) => offered.has(value));
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function scoreCatalogEntry(
  query: CatalogQuery,
  entry: CatalogEntry
): CatalogScore {
  const reasons: string[] = [];
  const queryCapabilities = normalized(query.capabilityIds);
  const entryCapabilities = normalized([
    ...entry.capabilityIds,
    ...entry.aliases
  ]);
  const availableInputs = normalized(query.availableInputTypes);
  const requiredInputs = normalized(entry.inputTypes);
  const requiredOutputs = normalized(query.requiredOutputTypes);
  const entryOutputs = normalized(entry.outputTypes);
  const allowedPermissions = normalized(query.allowedPermissions);
  const entryPermissions = normalized(entry.permissions);

  const platform =
    query.platform === undefined
      ? 1
      : normalized(entry.platforms).has(query.platform.toLowerCase())
        ? 1
        : 0;
  const input = coverage(requiredInputs, availableInputs);
  const output = coverage(requiredOutputs, entryOutputs);
  const capability = coverage(queryCapabilities, entryCapabilities);
  const risk = 1 - RISK_RANK[entry.riskLevel] / 8;
  const permission =
    entryPermissions.size === 0
      ? 1
      : coverage(entryPermissions, allowedPermissions);
  const adapter =
    query.adapter === undefined
      ? 1
      : entry.adapter?.id === query.adapter.id &&
          entry.adapter.version === query.adapter.version
        ? 1
        : 0;

  let eligible = true;
  if (query.runtime !== undefined && entry.runtime !== query.runtime) {
    eligible = false;
    reasons.push(`runtime ${entry.runtime} does not match ${query.runtime}`);
  }
  if (platform === 0) {
    eligible = false;
    reasons.push(`platform ${query.platform} is not supported`);
  }
  if (!containsAll(requiredInputs, availableInputs)) {
    eligible = false;
    reasons.push("required input types are unavailable");
  }
  if (!containsAll(requiredOutputs, entryOutputs)) {
    eligible = false;
    reasons.push("required output types are not produced");
  }
  if (RISK_RANK[entry.riskLevel] > RISK_RANK[query.maximumRisk]) {
    eligible = false;
    reasons.push(
      `risk ${entry.riskLevel} exceeds maximum ${query.maximumRisk}`
    );
  }
  if (!containsAll(entryPermissions, allowedPermissions)) {
    eligible = false;
    reasons.push("entry requires permissions outside the allowed set");
  }
  if (adapter === 0) {
    eligible = false;
    reasons.push("adapter version does not match");
  }
  if (capability === 0 && queryCapabilities.size > 0) {
    eligible = false;
    reasons.push("no requested capability matched");
  }

  const components = {
    capability: roundScore(capability),
    platform: roundScore(platform),
    input: roundScore(input),
    output: roundScore(output),
    risk: roundScore(risk),
    permission: roundScore(permission),
    adapter: roundScore(adapter)
  };
  const score = eligible
    ? roundScore(
        capability * 0.4 +
          platform * 0.15 +
          input * 0.15 +
          output * 0.15 +
          risk * 0.05 +
          permission * 0.05 +
          adapter * 0.05
      )
    : 0;
  return { entry: clone(entry), eligible, score, components, reasons };
}

export function searchCatalog(
  query: CatalogQuery,
  entries: readonly CatalogEntry[]
): CatalogScore[] {
  return entries
    .map((entry) => scoreCatalogEntry(query, entry))
    .filter((result) => result.eligible)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.id.localeCompare(right.entry.id) ||
        left.entry.version.localeCompare(right.entry.version)
    );
}

export function recipeIssues(recipe: Recipe): string[] {
  const issues: string[] = [];
  if (
    !ID_PATTERN.test(recipe.recipeId) ||
    !SEMVER_PATTERN.test(recipe.version) ||
    !isNonEmpty(recipe.title)
  ) {
    issues.push("Recipe requires a stable ID, exact SemVer, and title");
  }
  const stepKeys = new Set<string>();
  for (const step of recipe.steps) {
    if (
      !ID_PATTERN.test(step.key) ||
      !EXACT_REF_PATTERN.test(step.capabilityRef)
    ) {
      issues.push(
        `Recipe step ${step.key} must use a stable key and exact capability reference`
      );
    }
    if (stepKeys.has(step.key)) {
      issues.push(`Recipe step key is duplicated: ${step.key}`);
    }
    stepKeys.add(step.key);
  }
  for (const adapterRef of recipe.adapterRefs) {
    if (!EXACT_REF_PATTERN.test(adapterRef)) {
      issues.push(`Recipe adapter reference must pin SemVer: ${adapterRef}`);
    }
  }
  return issues;
}
