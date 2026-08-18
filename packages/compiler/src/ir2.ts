import {
  formatValidationErrors,
  validateNode,
  validateNodeV1Alpha2,
  validateWorkflow,
  validateWorkflowV1Alpha2,
  validateWorkflowV1Alpha3,
  type NodeDefinition,
  type NodeDefinitionV1Alpha2,
  type WorkflowDefinition,
  type WorkflowDefinitionV1Alpha2,
  type WorkflowDefinitionV1Alpha3
} from "@bpa/schemas";
import {
  mergeTimingPolicy,
  timingOverrideIssues,
  timingPolicyIssues
} from "@bpa/node-runtime";
import {
  createExecutionPlan,
  type ArtifactRef,
  type BindingValue,
  type BrowserResourceRequirementSnapshot,
  type CallRoutes,
  type Condition,
  type ExecutionBlock,
  type ExecutionPlan,
  type ExecutionStep,
  type ForeachStep,
  type JsonValue,
  type PermissionSnapshot,
  type ResolvedRetryPolicy,
  type ResolvedTimingPolicy,
  type RuntimeNodeSchemaContract,
  type ResourceSlotMappingSnapshot,
  type TerminalStep
} from "@bpa/workflow-ir";
import {
  contentDigest,
  compileWorkflow,
  WorkflowCompileError
} from "./index.js";

type CanonicalWorkflow =
  | WorkflowDefinitionV1Alpha2
  | WorkflowDefinitionV1Alpha3;
type PublishedNodeDefinition = NodeDefinition | NodeDefinitionV1Alpha2;
type SourceBlock = CanonicalWorkflow["spec"]["root"];
type SourceStep = SourceBlock["steps"][number];
type SourceCall = Extract<SourceStep, { kind: "call" }>;
type SourceAssistance = Extract<
  SourceStep,
  { kind: "wait.assistance" }
>;

export interface CatalogNodeExecution {
  readonly providerId: string;
  readonly adapters: readonly (ArtifactRef & { kind: "adapter" })[];
  readonly policies: readonly (ArtifactRef & { kind: "policy" })[];
  readonly datasetProfiles: readonly (ArtifactRef & {
    kind: "dataset_profile";
  })[];
  readonly grantDigest?: string;
}

export interface CatalogAssistanceProfile {
  readonly artifact: ArtifactRef & { kind: "assistance_profile" };
  readonly taskKind: "ai_review" | "human_confirm" | "human_action";
}

/**
 * Catalog data is injected and must already represent published immutable
 * assets. Compiler code never reads a repository, database, or current clock.
 */
export interface CatalogResolver {
  getNode(id: string, version: string): PublishedNodeDefinition | undefined;
  getNodeExecution?(
    id: string,
    version: string
  ): CatalogNodeExecution | undefined;
  getAssistanceProfile?(
    id: string,
    version: string
  ): CatalogAssistanceProfile | undefined;
}

const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const;
const AUTHENTICATION_RANK = {
  anonymous: 0,
  optional: 1,
  authenticated: 2,
  membership: 3
} as const;
const FORBIDDEN_AUTHORING_KEYS = new Set([
  "selector",
  "xpath",
  "coordinates",
  "javascript",
  "script",
  "cssselector",
  "screenx",
  "screeny"
]);
const BINDING_PATTERN =
  /^\$\{(input|item|index|steps\.([a-z][a-z0-9_]*)\.(output|evidence))((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}$/;

function splitRef(reference: string): [string, string] {
  const at = reference.lastIndexOf("@");
  if (at <= 0 || at === reference.length - 1) {
    throw new WorkflowCompileError([`asset reference is not fixed: ${reference}`]);
  }
  return [reference.slice(0, at), reference.slice(at + 1)];
}

function validatePublishedNode(
  candidate: unknown
): candidate is PublishedNodeDefinition {
  return (
    validateNode(candidate) ||
    validateNodeV1Alpha2(candidate)
  );
}

function publishedNodeValidationErrors(candidate: unknown): string[] {
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha2"
  ) {
    validateNodeV1Alpha2(candidate);
    return formatValidationErrors(validateNodeV1Alpha2.errors);
  }
  validateNode(candidate);
  return formatValidationErrors(validateNode.errors);
}

function toArtifact(
  definition: PublishedNodeDefinition
): ArtifactRef & { kind: "node" } {
  return {
    kind: "node",
    id: definition.metadata.id,
    version: definition.metadata.version,
    digest: contentDigest(definition)
  };
}

function jsonSchema(
  value: Record<string, unknown>
): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<
    Record<string, JsonValue>
  >;
}

function schemaContract(
  definition: PublishedNodeDefinition,
  artifact: ArtifactRef & { kind: "node" }
): RuntimeNodeSchemaContract {
  const inputSchema = jsonSchema(definition.inputSchema);
  const outputSchema = jsonSchema(definition.outputSchema);
  return {
    nodeDigest: artifact.digest,
    inputSchema,
    inputSchemaDigest: contentDigest(inputSchema),
    outputSchema,
    outputSchemaDigest: contentDigest(outputSchema)
  };
}

function assertSafeAuthoringValue(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (typeof value === "string") {
    if (
      /(?:javascript:|document\.querySelector|evaluate\s*\(|<script)/i.test(
        value
      )
    ) {
      issues.push(`${path} contains executable or selector syntax`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeAuthoringValue(entry, `${path}/${index}`, issues)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_AUTHORING_KEYS.has(key.toLowerCase())) {
        issues.push(`${path}/${key} is forbidden in a Workflow`);
      }
      assertSafeAuthoringValue(entry, `${path}/${key}`, issues);
    }
  }
}

function pathSegments(suffix: string): readonly string[] {
  return suffix ? suffix.slice(1).split(".") : [];
}

function compileBindingString(value: string, path: string): BindingValue {
  const match = BINDING_PATTERN.exec(value);
  if (!match) return { kind: "literal", value };
  const root = match[1]!;
  const segments = pathSegments(match[4] ?? "");
  if (root === "index") {
    throw new WorkflowCompileError([
      `${path} uses index binding; IR2 requires stable itemKey data instead`
    ]);
  }
  if (root === "input") {
    return { kind: "reference", source: "run_input", path: segments };
  }
  if (root === "item") {
    return { kind: "reference", source: "scope_item", path: segments };
  }
  return {
    kind: "reference",
    source: match[3] === "evidence" ? "step_evidence" : "step_output",
    stepKey: match[2]!,
    path: segments
  };
}

function compileBinding(value: unknown, path: string): BindingValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { kind: "literal", value };
  }
  if (typeof value === "string") return compileBindingString(value, path);
  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((entry, index) =>
        compileBinding(entry, `${path}/${index}`)
      )
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "object",
      entries: Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          compileBinding(entry, `${path}/${key}`)
        ])
      )
    };
  }
  throw new WorkflowCompileError([`${path} is not a JSON-safe binding value`]);
}

function compileOperand(value: unknown, path: string): BindingValue {
  if (!value || typeof value !== "object") {
    throw new WorkflowCompileError([`${path} is not a condition operand`]);
  }
  const operand = value as { kind?: unknown; binding?: unknown; value?: unknown };
  if (operand.kind === "binding" && typeof operand.binding === "string") {
    const compiled = compileBindingString(operand.binding, `${path}/binding`);
    if (compiled.kind === "literal") {
      throw new WorkflowCompileError([`${path}/binding is not a binding`]);
    }
    return compiled;
  }
  if (operand.kind === "literal") {
    return compileBinding(operand.value, `${path}/value`);
  }
  throw new WorkflowCompileError([`${path} has unsupported operand syntax`]);
}

function compileCondition(value: unknown, path: string): Condition {
  const source = value as {
    kind?: unknown;
    operator?: unknown;
    left?: unknown;
    right?: unknown;
    conditions?: unknown[];
    condition?: unknown;
  };
  if (source.kind === "compare") {
    return {
      kind: "compare",
      operator: source.operator as Extract<
        Condition,
        { kind: "compare" }
      >["operator"],
      left: compileOperand(source.left, `${path}/left`),
      ...(source.right === undefined
        ? {}
        : { right: compileOperand(source.right, `${path}/right`) })
    };
  }
  if (
    (source.kind === "all" || source.kind === "any") &&
    Array.isArray(source.conditions)
  ) {
    return {
      kind: source.kind,
      conditions: source.conditions.map((entry, index) =>
        compileCondition(entry, `${path}/conditions/${index}`)
      )
    };
  }
  if (source.kind === "not") {
    return {
      kind: "not",
      condition: compileCondition(source.condition, `${path}/condition`)
    };
  }
  throw new WorkflowCompileError([`${path} has unsupported condition syntax`]);
}

function timingSnapshot(
  definition: PublishedNodeDefinition,
  source: SourceCall,
  path: string
): {
  timing: ResolvedTimingPolicy;
  retry: ResolvedRetryPolicy;
  timeoutMs: number;
} {
  const base = mergeTimingPolicy(definition.execution.timingPolicy, undefined);
  const resolved = mergeTimingPolicy(
    definition.execution.timingPolicy,
    source.timing
  );
  const issues = [
    ...timingPolicyIssues(resolved, `${path}/timing`),
    ...timingOverrideIssues(base, resolved, `${path}/timing`)
  ];
  const timeoutMs = parseCanonicalDuration(
    source.timeout ?? definition.execution.timeoutDefault
  );
  const maximumWait =
    (resolved?.readiness?.timeoutMs ?? 0) +
    (resolved?.rateLimit?.maxQueueMs ?? 0);
  if (maximumWait > timeoutMs) {
    issues.push(
      `${path}/timing maximum readiness and queue wait exceeds timeout`
    );
  }
  if (issues.length) throw new WorkflowCompileError(issues);
  const configuredBackoff = source.retry?.backoff
    ? parseCanonicalDuration(source.retry.backoff)
    : undefined;
  const retryBackoff = resolved?.retryBackoff;
  const baseDelayMs =
    retryBackoff?.baseMs ?? configuredBackoff ?? 0;
  return {
    timeoutMs,
    timing: {
      ...(resolved?.readiness
        ? { readiness: { ...resolved.readiness } }
        : {}),
      ...(resolved?.dispatchJitter
        ? { dispatchJitter: { ...resolved.dispatchJitter } }
        : {}),
      ...(resolved?.rateLimit
        ? { rateLimit: { ...resolved.rateLimit } }
        : {})
    },
    retry: {
      maxAttempts: source.retry?.maxAttempts ?? 1,
      retryableOutcomes: ["failed", "timed_out"],
      retryableErrorCodes: [
        ...(source.retry?.retryableErrors ??
          definition.execution.retryableErrors ??
          [])
      ].sort(),
      backoff: {
        strategy: retryBackoff?.strategy ?? "fixed",
        baseDelayMs,
        maxDelayMs: retryBackoff?.maxMs ?? baseDelayMs,
        jitterRatio: retryBackoff?.jitterRatio ?? 0
      }
    }
  };
}

export function parseCanonicalDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value);
  if (!match) throw new WorkflowCompileError([`Invalid duration: ${value}`]);
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "ms"
      ? 1
      : match[2] === "s"
        ? 1_000
        : match[2] === "m"
          ? 60_000
          : 3_600_000;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result)) {
    throw new WorkflowCompileError([`Duration exceeds safe range: ${value}`]);
  }
  return result;
}

function permissionSnapshot(
  definition: PublishedNodeDefinition,
  execution: CatalogNodeExecution
): PermissionSnapshot {
  return {
    riskLevel: definition.risk.level,
    permissions: [...definition.risk.permissions].sort(),
    domains: [...(definition.risk.domains ?? [])].sort(),
    ...(execution.grantDigest ? { grantDigest: execution.grantDigest } : {})
  };
}

function defaultExecution(
  definition: PublishedNodeDefinition
): CatalogNodeExecution {
  if (definition.adapter) {
    throw new WorkflowCompileError([
      `${definition.metadata.id}@${definition.metadata.version} has adapter dependencies but the CatalogResolver did not pin them`
    ]);
  }
  return {
    providerId: definition.runtime.replace(/^engine_/, ""),
    adapters: [],
    policies: [],
    datasetProfiles: []
  };
}

function freezeResourceRequirement(
  requirement: NonNullable<NodeDefinitionV1Alpha2["resources"]>[string] & {
    readonly continuity?: "fixed" | "same_tab_origin";
  }
): BrowserResourceRequirementSnapshot {
  return {
    kind: "browser",
    capabilities: [...requirement.capabilities].sort(),
    allowedOrigins: [...requirement.allowedOrigins].sort(),
    authentication: requirement.authentication,
    ...(requirement.continuity === undefined
      ? {}
      : { continuity: requirement.continuity }),
    purpose: requirement.purpose
  };
}

function workflowResourceSlots(
  workflow: CanonicalWorkflow
): Readonly<Record<string, BrowserResourceRequirementSnapshot>> {
  if (workflow.apiVersion !== "bpa/v1alpha3") return {};
  return Object.fromEntries(
    Object.entries(workflow.spec.resourceSlots ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, slot]) => [name, freezeResourceRequirement(slot)])
  );
}

function compileResourceMappings(
  definition: PublishedNodeDefinition,
  source: SourceCall,
  workflow: CanonicalWorkflow,
  path: string
): {
  resourceRequirements?: Readonly<
    Record<string, BrowserResourceRequirementSnapshot>
  >;
  resourceMappings?: Readonly<
    Record<string, ResourceSlotMappingSnapshot>
  >;
} {
  const rawRequirements =
    definition.apiVersion === "bpa/v1alpha2"
      ? definition.resources ?? {}
      : {};
  const sourceMappings =
    "resourceMappings" in source
      ? (source.resourceMappings ?? {})
      : {};
  const requirementNames = Object.keys(rawRequirements).sort();
  const mappingNames = Object.keys(sourceMappings).sort();
  if (requirementNames.length === 0) {
    if (mappingNames.length > 0) {
      throw new WorkflowCompileError([
        `${path}/resourceMappings cannot map resources not declared by the Node`
      ]);
    }
    return {};
  }
  if (definition.runtime !== "browser") {
    throw new WorkflowCompileError([
      `${path}/use declares browser resources but its runtime is ${definition.runtime}`
    ]);
  }
  const unknown = mappingNames.filter(
    (name) => !(name in rawRequirements)
  );
  const missing = requirementNames.filter(
    (name) => !(name in sourceMappings)
  );
  const issues = [
    ...unknown.map(
      (name) =>
        `${path}/resourceMappings/${name} references an unknown Node requirement`
    ),
    ...missing.map(
      (name) =>
        `${path}/resourceMappings/${name} is required for the Node resource`
    )
  ];
  const slots = workflowResourceSlots(workflow);
  const requirements: Record<
    string,
    BrowserResourceRequirementSnapshot
  > = {};
  const mappings: Record<string, ResourceSlotMappingSnapshot> = {};
  for (const name of requirementNames) {
    const rawRequirement = rawRequirements[name]!;
    const requirement = freezeResourceRequirement(rawRequirement);
    requirements[name] = requirement;
    const riskDomains = new Set(definition.risk.domains ?? []);
    const outsidePermission = requirement.allowedOrigins.filter(
      (origin) => !riskDomains.has(origin)
    );
    if (outsidePermission.length > 0) {
      issues.push(
        `${path}/use resource ${name} expands published risk domains: ${outsidePermission.join(", ")}`
      );
    }
    const slotName = sourceMappings[name];
    if (!slotName) continue;
    const slot = slots[slotName];
    if (!slot) {
      issues.push(
        `${path}/resourceMappings/${name} references missing Workflow resource slot ${slotName}`
      );
      continue;
    }
    const slotCapabilities = new Set(slot.capabilities);
    const missingCapabilities = requirement.capabilities.filter(
      (capability) => !slotCapabilities.has(capability)
    );
    if (missingCapabilities.length > 0) {
      issues.push(
        `${path}/resourceMappings/${name} slot ${slotName} does not include capabilities: ${missingCapabilities.join(", ")}`
      );
    }
    const allowedOrigins = new Set(requirement.allowedOrigins);
    const expandedOrigins = slot.allowedOrigins.filter(
      (origin) => !allowedOrigins.has(origin)
    );
    if (expandedOrigins.length > 0) {
      issues.push(
        `${path}/resourceMappings/${name} slot ${slotName} expands Node allowed origins: ${expandedOrigins.join(", ")}`
      );
    }
    if (
      AUTHENTICATION_RANK[slot.authentication] <
      AUTHENTICATION_RANK[requirement.authentication]
    ) {
      issues.push(
        `${path}/resourceMappings/${name} slot ${slotName} downgrades authentication from ${requirement.authentication} to ${slot.authentication}`
      );
    }
    mappings[name] = {
      requirementName: name,
      slotName,
      requirement,
      requirementDigest: contentDigest(requirement)
    };
  }
  if (issues.length > 0) throw new WorkflowCompileError(issues);
  return {
    resourceRequirements: requirements,
    resourceMappings: mappings
  };
}

interface CompileContext {
  readonly scope: "plan" | "foreach";
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxStepExecutions: number;
}

class IrBuilder {
  readonly artifacts = new Map<string, ArtifactRef>();
  readonly risks: ExecutionPlan["riskSnapshot"][number][] = [];
  readonly compiledSourceKeys = new Set<string>();
  #generated = 0;

  constructor(
    readonly workflow: CanonicalWorkflow,
    readonly catalog: CatalogResolver,
    readonly reservedSourceKeys: ReadonlySet<string>
  ) {}

  addArtifact(ref: ArtifactRef): void {
    this.artifacts.set(
      `${ref.kind}:${ref.id}:${ref.version}:${ref.digest}`,
      ref
    );
  }

  generatedKey(label: string): string {
    let candidate: string;
    do {
      this.#generated += 1;
      candidate = `compiler_${label}_${this.#generated}`;
    } while (this.reservedSourceKeys.has(candidate));
    return candidate;
  }

  terminal(
    steps: Record<string, ExecutionStep>,
    status: TerminalStep["status"],
    scope: CompileContext["scope"]
  ): string {
    const effectiveStatus =
      scope === "foreach" && status === "cancelled" ? "failed" : status;
    const key = this.generatedKey(`terminal_${effectiveStatus}`);
    steps[key] = {
      kind: "terminal",
      key,
      status: effectiveStatus,
      ...(effectiveStatus === "failed"
        ? { errorCode: "STEP_FAILED" }
        : {})
    };
    return key;
  }

  resolveNode(reference: string, path: string): {
    definition: PublishedNodeDefinition;
    artifact: ArtifactRef & { kind: "node" };
    execution: CatalogNodeExecution;
  } {
    const [id, version] = splitRef(reference);
    const definition = this.catalog.getNode(id, version);
    if (!definition) {
      throw new WorkflowCompileError([`${path}/use is not published: ${reference}`]);
    }
    if (!validatePublishedNode(definition)) {
      throw new WorkflowCompileError(
        publishedNodeValidationErrors(definition).map(
          (issue) => `${path}/catalog${issue}`
        )
      );
    }
    if (
      definition.metadata.id !== id ||
      definition.metadata.version !== version
    ) {
      throw new WorkflowCompileError([
        `${path}/use resolved to mismatched node identity ${definition.metadata.id}@${definition.metadata.version}`
      ]);
    }
    if (
      definition.apiVersion === "bpa/v1alpha2" &&
      definition.runtime === "browser" &&
      !definition.resources
    ) {
      throw new WorkflowCompileError([
        `${path}/use Browser Node v1alpha2 must declare at least one resource requirement`
      ]);
    }
    if (
      RISK_RANK[definition.risk.level] >
      RISK_RANK[this.workflow.spec.riskLevel]
    ) {
      throw new WorkflowCompileError([
        `${path}/use risk ${definition.risk.level} exceeds workflow risk ${this.workflow.spec.riskLevel}`
      ]);
    }
    const execution =
      this.catalog.getNodeExecution?.(id, version) ??
      defaultExecution(definition);
    if (
      definition.adapter &&
      (execution.adapters.length === 0 ||
        execution.adapters.some(
          (entry) =>
            entry.id !== definition.adapter!.id ||
            !definition.adapter!.versions.includes(entry.version)
        ))
    ) {
      throw new WorkflowCompileError([
        `${path}/use adapter resolution does not match published node dependencies`
      ]);
    }
    const artifact = toArtifact(definition);
    this.addArtifact(artifact);
    for (const dependency of [
      ...execution.adapters,
      ...execution.policies,
      ...execution.datasetProfiles
    ]) {
      this.addArtifact(dependency);
    }
    this.risks.push({
      code: `NODE_${definition.risk.level}`,
      level: definition.risk.level,
      source: artifact,
      details: permissionSnapshot(
        definition,
        execution
      ) as unknown as JsonValue
    });
    return { definition, artifact, execution };
  }

  compileHandler(
    handler: SourceBlock | undefined,
    continuation: string,
    steps: Record<string, ExecutionStep>,
    context: CompileContext
  ): string {
    return handler
      ? this.compileSequence(handler, continuation, steps, context)
      : continuation;
  }

  compileSequence(
    block: SourceBlock,
    continuation: string | undefined,
    steps: Record<string, ExecutionStep>,
    context: CompileContext
  ): string {
    let next = continuation;
    for (let index = block.steps.length - 1; index >= 0; index -= 1) {
      const source = block.steps[index]!;
      if (next === undefined && source.kind !== "terminal") {
        next = this.terminal(steps, "succeeded", context.scope);
      }
      next = this.compileStep(
        source,
        next ?? "",
        steps,
        context,
        `/spec/root/steps/${index}`
      );
    }
    if (!next) {
      throw new WorkflowCompileError(["block did not produce an entry step"]);
    }
    return next;
  }

  compileStep(
    source: SourceStep,
    next: string,
    steps: Record<string, ExecutionStep>,
    context: CompileContext,
    path: string
  ): string {
    const key = source.key;
    if (steps[key] || this.compiledSourceKeys.has(key)) {
      throw new WorkflowCompileError([
        `${path}/key duplicates globally unique step key ${key}`
      ]);
    }
    this.compiledSourceKeys.add(key);
    if (source.kind === "terminal") {
      steps[key] = {
        kind: "terminal",
        key,
        status: source.status,
        ...(source.output === undefined
          ? {}
          : { output: compileBinding(source.output, `${path}/output`) }),
        ...(source.error ? { errorCode: source.error.code } : {})
      };
      return key;
    }
    if (source.kind === "decision") {
      const thenEntry = this.compileSequence(
        source.then,
        next,
        steps,
        context
      );
      const elseEntry = this.compileSequence(
        source.else,
        next,
        steps,
        context
      );
      steps[key] = {
        kind: "decision",
        key,
        branches: [
          {
            id: `${key}.then`,
            condition: compileCondition(source.condition, `${path}/condition`),
            target: thenEntry
          }
        ],
        defaultTarget: elseEntry
      };
      return key;
    }
    if (source.kind === "foreach") {
      if (context.depth >= context.maxDepth) {
        throw new WorkflowCompileError([
          `${path} exceeds maxDepth ${context.maxDepth}`
        ]);
      }
      const itemBinding = compileBindingString(source.itemKey, `${path}/itemKey`);
      if (
        itemBinding.kind !== "reference" ||
        itemBinding.source !== "scope_item"
      ) {
        throw new WorkflowCompileError([
          `${path}/itemKey must be a stable item binding`
        ]);
      }
      const bodySteps: Record<string, ExecutionStep> = {};
      const bodyContext: CompileContext = {
        ...context,
        scope: "foreach",
        depth: context.depth + 1
      };
      const bodyEntry = this.compileSequence(
        source.body,
        undefined,
        bodySteps,
        bodyContext
      );
      const stopped = this.terminal(steps, "failed", context.scope);
      const uncertain = this.terminal(steps, "uncertain", context.scope);
      const foreach: ForeachStep = {
        kind: "foreach",
        key,
        items: compileBindingString(source.items, `${path}/items`),
        itemKey: { path: itemBinding.path, valueType: "string" },
        limits: {
          maxItems: source.maxItems,
          maxDurationMs: parseCanonicalDuration(source.maxDuration),
          maxDepth: Math.max(0, context.maxDepth - context.depth - 1),
          maxStepExecutions: context.maxStepExecutions
        },
        onItemError: source.onItemError,
        body: { entry: bodyEntry, steps: bodySteps },
        aggregation: {
          mode: "outcome_summary",
          outputKey: `${key}.output`
        },
        routes: { completed: next, stopped, uncertain }
      };
      steps[key] = foreach;
      return key;
    }
    if (source.kind === "wait.assistance") {
      const [id, version] = splitRef(source.use);
      const resolved = this.catalog.getAssistanceProfile?.(id, version);
      if (!resolved) {
        throw new WorkflowCompileError([
          `${path}/use assistance profile is not published and fixed: ${source.use}`
        ]);
      }
      if (
        resolved.artifact.id !== id ||
        resolved.artifact.version !== version
      ) {
        throw new WorkflowCompileError([
          `${path}/use resolved to mismatched assistance profile identity`
        ]);
      }
      this.addArtifact(resolved.artifact);
      const deadlineMs = parseCanonicalDuration(source.deadline ?? "10m");
      if (!source.blocking) {
        if (source.handlers) {
          throw new WorkflowCompileError([
            `${path}/handlers cannot route a detached assistance task`
          ]);
        }
        steps[key] = {
          kind: "wait.assistance",
          key,
          taskKind: resolved.taskKind,
          profile: resolved.artifact,
          deadlineMs,
          onUnavailable: source.onUnavailable,
          ...(source.with === undefined
            ? {}
            : { input: compileBinding(source.with, `${path}/with`) }),
          blocking: false,
          next
        };
        return key;
      }
      const failed = this.terminal(steps, "failed", context.scope);
      const unavailable =
        source.onUnavailable === "continue_unresolved"
          ? context.scope === "foreach"
            ? this.terminal(steps, "unresolved", context.scope)
            : next
          : failed;
      const timeout = this.compileHandler(
        source.handlers?.timeout,
        unavailable,
        steps,
        context
      );
      const escalated = this.compileHandler(
        source.handlers?.rejected,
        unavailable,
        steps,
        context
      );
      const failure = this.compileHandler(
        source.handlers?.failure,
        unavailable,
        steps,
        context
      );
      steps[key] = {
        kind: "wait.assistance",
        key,
        taskKind: resolved.taskKind,
        profile: resolved.artifact,
        deadlineMs,
        onUnavailable: source.onUnavailable,
        ...(source.with === undefined
          ? {}
          : { input: compileBinding(source.with, `${path}/with`) }),
        blocking: true,
        routes: {
          resolved: next,
          escalated,
          expired: timeout,
          unavailable: failure
        }
      };
      return key;
    }

    const resolved = this.resolveNode(source.use, path);
    const frozen = timingSnapshot(resolved.definition, source, path);
    const resources = compileResourceMappings(
      resolved.definition,
      source,
      this.workflow,
      path
    );
    const failedDefault = this.terminal(steps, "failed", context.scope);
    const rejectedDefault = this.terminal(
      steps,
      "rejected",
      context.scope
    );
    const cancelledDefault = this.terminal(
      steps,
      "cancelled",
      context.scope
    );
    const uncertainDefault = this.terminal(
      steps,
      "uncertain",
      context.scope
    );
    if (
      source.handlers?.rejected &&
      (source.handlers.rejected.steps.length !== 1 ||
        source.handlers.rejected.steps[0]?.kind !== "terminal" ||
        source.handlers.rejected.steps[0].status !== "rejected")
    ) {
      throw new WorkflowCompileError([
        `${path}/handlers/rejected must be exactly one rejected terminal`
      ]);
    }
    if (
      source.handlers?.uncertain &&
      (source.handlers.uncertain.steps.length !== 1 ||
        source.handlers.uncertain.steps[0]?.kind !== "terminal" ||
        source.handlers.uncertain.steps[0].status !== "uncertain")
    ) {
      throw new WorkflowCompileError([
        `${path}/handlers/uncertain must be exactly one uncertain terminal`
      ]);
    }
    const routes: CallRoutes = {
      succeeded: next,
      failed: this.compileHandler(
        source.handlers?.failure,
        failedDefault,
        steps,
        context
      ),
      timed_out: this.compileHandler(
        source.handlers?.timeout,
        failedDefault,
        steps,
        context
      ),
      rejected: source.handlers?.rejected
        ? this.compileSequence(
            source.handlers.rejected,
            rejectedDefault,
            steps,
            context
          )
        : rejectedDefault,
      cancelled: this.compileHandler(
        source.handlers?.cancelled,
        cancelledDefault,
        steps,
        context
      ),
      uncertain: source.handlers?.uncertain
        ? this.compileSequence(
            source.handlers.uncertain,
            uncertainDefault,
            steps,
            context
          )
        : uncertainDefault
    };
    steps[key] = {
      kind: "call",
      key,
      node: resolved.artifact,
      schemaContract: schemaContract(
        resolved.definition,
        resolved.artifact
      ),
      providerId: resolved.execution.providerId,
      permissionSnapshot: permissionSnapshot(
        resolved.definition,
        resolved.execution
      ),
      ...resources,
      dependencies: {
        adapters: [...resolved.execution.adapters],
        policies: [...resolved.execution.policies],
        datasetProfiles: [...resolved.execution.datasetProfiles]
      },
      ...frozen,
      ...(source.with === undefined
        ? {}
        : { input: compileBinding(source.with, `${path}/with`) }),
      routes
    };
    return key;
  }
}

function collectSourceKeys(
  block: SourceBlock,
  keys: Set<string>,
  issues: string[],
  path: string
): void {
  block.steps.forEach((step, index) => {
    const stepPath = `${path}/steps/${index}`;
    if (keys.has(step.key)) {
      issues.push(`${stepPath}/key duplicates globally unique key ${step.key}`);
    }
    keys.add(step.key);
    if (step.kind === "decision") {
      collectSourceKeys(step.then, keys, issues, `${stepPath}/then`);
      collectSourceKeys(step.else, keys, issues, `${stepPath}/else`);
    } else if (step.kind === "foreach") {
      collectSourceKeys(step.body, keys, issues, `${stepPath}/body`);
    } else if (
      (step.kind === "call" || step.kind === "wait.assistance") &&
      step.handlers
    ) {
      for (const [name, handler] of Object.entries(step.handlers)) {
        if (handler) {
          collectSourceKeys(
            handler,
            keys,
            issues,
            `${stepPath}/handlers/${name}`
          );
        }
      }
    }
  });
}

function targets(step: ExecutionStep): readonly string[] {
  switch (step.kind) {
    case "call":
      return Object.values(step.routes);
    case "decision":
      return [
        ...step.branches.map((branch) => branch.target),
        step.defaultTarget
      ];
    case "foreach":
      return Object.values(step.routes);
    case "wait.assistance":
      return step.blocking ? Object.values(step.routes) : [step.next];
    case "terminal":
      return [];
  }
}

function pruneUnusedGenerated(block: ExecutionBlock): void {
  const mutable = block.steps as Record<string, ExecutionStep>;
  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    const step = mutable[key];
    if (!step) return;
    reachable.add(key);
    for (const target of targets(step)) visit(target);
  };
  visit(block.entry);
  for (const [key, step] of Object.entries(mutable)) {
    if (!reachable.has(key) && key.startsWith("compiler_")) {
      delete mutable[key];
      continue;
    }
    if (step.kind === "foreach") pruneUnusedGenerated(step.body);
  }
}

export function compileWorkflowV1Alpha2(
  candidate: unknown,
  catalog: CatalogResolver
): ExecutionPlan {
  if (!validateWorkflowV1Alpha2(candidate)) {
    throw new WorkflowCompileError(
      formatValidationErrors(validateWorkflowV1Alpha2.errors)
    );
  }
  return compileValidatedCanonicalWorkflow(candidate, catalog);
}

function compileValidatedCanonicalWorkflow(
  workflow: CanonicalWorkflow,
  catalog: CatalogResolver
): ExecutionPlan {
  const issues: string[] = [];
  assertSafeAuthoringValue(workflow, "", issues);
  const reservedSourceKeys = new Set<string>();
  collectSourceKeys(
    workflow.spec.root,
    reservedSourceKeys,
    issues,
    "/spec/root"
  );
  if (issues.length) throw new WorkflowCompileError(issues);
  const builder = new IrBuilder(workflow, catalog, reservedSourceKeys);
  const steps: Record<string, ExecutionStep> = {};
  const entry = builder.compileSequence(
    workflow.spec.root,
    undefined,
    steps,
    {
      scope: "plan",
      depth: 0,
      maxDepth: workflow.spec.limits.maxDepth,
      maxStepExecutions: workflow.spec.limits.maxStepExecutions
    }
  );
  pruneUnusedGenerated({ entry, steps });
  try {
    return createExecutionPlan({
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: workflow.metadata.id,
        version: workflow.metadata.version,
        digest: contentDigest(workflow)
      },
      artifactClosure: { entries: [...builder.artifacts.values()] },
      riskSnapshot: builder.risks,
      ...(workflow.apiVersion === "bpa/v1alpha3" &&
      workflow.spec.resourceSlots
        ? { resourceSlots: workflowResourceSlots(workflow) }
        : {}),
      limits: { ...workflow.spec.limits },
      entry,
      steps
    });
  } catch (error) {
    throw new WorkflowCompileError([
      error instanceof Error ? error.message : String(error)
    ]);
  }
}

export function compileWorkflowV1Alpha3(
  candidate: unknown,
  catalog: CatalogResolver
): ExecutionPlan {
  if (!validateWorkflowV1Alpha3(candidate)) {
    throw new WorkflowCompileError(
      formatValidationErrors(validateWorkflowV1Alpha3.errors)
    );
  }
  return compileValidatedCanonicalWorkflow(candidate, catalog);
}

/**
 * Canonical entrypoint. v1alpha1 remains available through compileWorkflow;
 * callers can migrate independently without silently inventing IR2 routes.
 */
export function compileCanonicalWorkflow(
  candidate: unknown,
  catalog: CatalogResolver
): ExecutionPlan {
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha2"
  ) {
    return compileWorkflowV1Alpha2(candidate, catalog);
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha3"
  ) {
    return compileWorkflowV1Alpha3(candidate, catalog);
  }
  return compileWorkflowV1Alpha1ToIr2(candidate, catalog);
}

function compileLegacyBinding(value: unknown, path: string): BindingValue {
  if (typeof value === "string") {
    const match =
      /^\$\{(input|previous)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}$/.exec(
        value
      );
    if (match) {
      return {
        kind: "reference",
        source: match[1] === "input" ? "run_input" : "previous_output",
        path: pathSegments(match[2] ?? "")
      };
    }
    return { kind: "literal", value };
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((entry, index) =>
        compileLegacyBinding(entry, `${path}/${index}`)
      )
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "object",
      entries: Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          compileLegacyBinding(entry, `${path}/${key}`)
        ])
      )
    };
  }
  throw new WorkflowCompileError([`${path} is not JSON safe`]);
}

function compileLegacyCondition(expression: string, path: string): Condition {
  const match =
    /^(input|previous)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(==|!=)\s*(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|"(?:[^"\\]|\\.)*")$/.exec(
      expression
    );
  if (!match) {
    throw new WorkflowCompileError([`${path} has unsupported condition syntax`]);
  }
  return {
    kind: "compare",
    operator: match[3] === "==" ? "equals" : "not_equals",
    left: {
      kind: "reference",
      source: match[1] === "input" ? "run_input" : "previous_output",
      path: pathSegments(match[2] ?? "")
    },
    right: { kind: "literal", value: JSON.parse(match[4]!) as JsonValue }
  };
}

export function compileWorkflowV1Alpha1ToIr2(
  candidate: unknown,
  catalog: CatalogResolver
): ExecutionPlan {
  if (!validateWorkflow(candidate)) {
    throw new WorkflowCompileError(
      formatValidationErrors(validateWorkflow.errors)
    );
  }
  const workflow: WorkflowDefinition = candidate;
  const unsafeIssues: string[] = [];
  assertSafeAuthoringValue(workflow, "", unsafeIssues);
  if (unsafeIssues.length) throw new WorkflowCompileError(unsafeIssues);
  const legacy = compileWorkflow(workflow, {
    getNode: (id, version) => {
      const definition = catalog.getNode(id, version);
      return definition?.apiVersion === "bpa/v1alpha1"
        ? definition
        : undefined;
    }
  });
  const steps: Record<string, ExecutionStep> = {};
  const artifacts = new Map<string, ArtifactRef>();
  const risks: ExecutionPlan["riskSnapshot"][number][] = [];
  let generated = 0;
  const generatedTerminal = (
    status:
      | "succeeded"
      | "rejected"
      | "failed"
      | "cancelled"
      | "uncertain"
  ): string => {
    let key: string;
    do {
      key = `compiler_legacy_${status}_${++generated}`;
    } while (workflow.spec.nodes[key] || steps[key]);
    steps[key] = {
      kind: "terminal",
      key,
      status,
      ...(status === "failed" ? { errorCode: "STEP_FAILED" } : {})
    };
    return key;
  };
  const fallback = {
    succeeded: generatedTerminal("succeeded"),
    rejected: generatedTerminal("rejected"),
    failed: generatedTerminal("failed"),
    cancelled: generatedTerminal("cancelled"),
    uncertain: generatedTerminal("uncertain")
  };
  for (const [key, compiled] of Object.entries(legacy.nodes)) {
    if (compiled.nodeId === "control.succeed") {
      steps[key] = { kind: "terminal", key, status: "succeeded" };
      continue;
    }
    if (compiled.nodeId === "control.fail") {
      steps[key] = {
        kind: "terminal",
        key,
        status: "failed",
        errorCode: "WORKFLOW_FAILED"
      };
      continue;
    }
    if (compiled.nodeId === "control.condition" && compiled.condition) {
      steps[key] = {
        kind: "decision",
        key,
        branches: [
          {
            id: `${key}.true`,
            condition: compileLegacyCondition(
              compiled.condition,
              `/spec/nodes/${key}/condition`
            ),
            target:
              compiled.next ??
              compiled.on.success ??
              fallback.succeeded
          }
        ],
        defaultTarget: compiled.on.failure ?? fallback.failed
      };
      continue;
    }
    const definition = catalog.getNode(
      compiled.nodeId,
      compiled.nodeVersion
    )!;
    const execution =
      catalog.getNodeExecution?.(
        compiled.nodeId,
        compiled.nodeVersion
      ) ?? defaultExecution(definition);
    const artifact = toArtifact(definition);
    for (const entry of [
      artifact,
      ...execution.adapters,
      ...execution.policies,
      ...execution.datasetProfiles
    ]) {
      artifacts.set(
        `${entry.kind}:${entry.id}:${entry.version}:${entry.digest}`,
        entry
      );
    }
    risks.push({
      code: `NODE_${definition.risk.level}`,
      level: definition.risk.level,
      source: artifact,
      details: permissionSnapshot(
        definition,
        execution
      ) as unknown as JsonValue
    });
    const retryBackoff = compiled.timing?.retryBackoff;
    const routes: CallRoutes = {
      succeeded:
        compiled.next ?? compiled.on.success ?? fallback.succeeded,
      failed: compiled.on.failure ?? fallback.failed,
      timed_out:
        compiled.on.timeout ?? compiled.on.failure ?? fallback.failed,
      rejected: fallback.rejected,
      cancelled: compiled.on.cancelled ?? fallback.cancelled,
      // Legacy rejected and uncertain recovery are deliberately not carried forward.
      uncertain: fallback.uncertain
    };
    steps[key] = {
      kind: "call",
      key,
      node: artifact,
      schemaContract: schemaContract(definition, artifact),
      providerId: execution.providerId,
      permissionSnapshot: permissionSnapshot(definition, execution),
      dependencies: {
        adapters: [...execution.adapters],
        policies: [...execution.policies],
        datasetProfiles: [...execution.datasetProfiles]
      },
      timeoutMs: compiled.timeoutMs,
      retry: {
        maxAttempts: compiled.retry.maxAttempts,
        retryableOutcomes: ["failed", "timed_out"],
        retryableErrorCodes: [...compiled.retry.retryableErrors].sort(),
        backoff: {
          strategy: retryBackoff?.strategy ?? "fixed",
          baseDelayMs:
            retryBackoff?.baseMs ?? compiled.retry.backoffMs,
          maxDelayMs:
            retryBackoff?.maxMs ?? compiled.retry.backoffMs,
          jitterRatio: retryBackoff?.jitterRatio ?? 0
        }
      },
      timing: {
        ...(compiled.timing?.readiness
          ? { readiness: { ...compiled.timing.readiness } }
          : {}),
        ...(compiled.timing?.dispatchJitter
          ? { dispatchJitter: { ...compiled.timing.dispatchJitter } }
          : {}),
        ...(compiled.timing?.rateLimit
          ? { rateLimit: { ...compiled.timing.rateLimit } }
          : {})
      },
      input: compileLegacyBinding(
        compiled.input,
        `/spec/nodes/${key}/with`
      ),
      routes
    };
  }
  const prunable: ExecutionBlock = { entry: legacy.start, steps };
  pruneUnusedGenerated(prunable);
  try {
    return createExecutionPlan({
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: workflow.metadata.id,
        version: workflow.metadata.version,
        digest: legacy.workflowDigest
      },
      artifactClosure: { entries: [...artifacts.values()] },
      riskSnapshot: risks,
      limits: {
        maxDepth: 0,
        maxStepExecutions: Math.max(1, Object.keys(steps).length)
      },
      entry: legacy.start,
      steps
    });
  } catch (error) {
    throw new WorkflowCompileError([
      error instanceof Error ? error.message : String(error)
    ]);
  }
}
