import { createHash } from "node:crypto";
import {
  ARTIFACT_KINDS,
  WORKFLOW_IR_VERSION,
  type ArtifactClosure,
  type ArtifactRef,
  type BindingValue,
  type BrowserResourceRequirementSnapshot,
  type Condition,
  type ExecutionBlock,
  type ExecutionLimits,
  type ExecutionPlan,
  type ExecutionStep,
  type ForeachStep,
  type JsonValue,
  type ResolvedRetryPolicy,
  type ResolvedTimingPolicy,
  type ValidationIssue,
  type ValueReference
} from "./types.js";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const DIGEST_PATTERN = /^(?:sha256:)?[a-fA-F0-9]{64}$/;
const UNSUPPORTED_STEP_KINDS = new Set(["parallel", "paginate", "poll"]);
const FORBIDDEN_BINDING_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor"
]);

function issue(
  code: ValidationIssue["code"],
  path: string,
  message: string
): ValidationIssue {
  return { code, path, message };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function artifactKey(ref: ArtifactRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}\u0000${ref.digest}`;
}

function artifactIdentity(ref: ArtifactRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`;
}

export function normalizeArtifactClosure(
  closure: ArtifactClosure
): ArtifactClosure {
  return {
    entries: [...closure.entries]
      .map((entry) => ({
        kind: entry.kind,
        id: entry.id.trim(),
        version: entry.version.trim(),
        digest: entry.digest.trim().toLowerCase()
      }))
      .sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)))
  };
}

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJsonValue(child)])
    );
  }
  return value;
}

function normalizeReference(reference: ValueReference): ValueReference {
  return {
    kind: "reference",
    source: reference.source,
    path: reference.path.map((segment) => segment.trim()),
    ...(reference.stepKey === undefined
      ? {}
      : { stepKey: reference.stepKey.trim() })
  };
}

function normalizeBinding(binding: BindingValue): BindingValue {
  switch (binding.kind) {
    case "literal":
      return { kind: "literal", value: normalizeJsonValue(binding.value) };
    case "reference":
      return normalizeReference(binding);
    case "array":
      return {
        kind: "array",
        items: binding.items.map(normalizeBinding)
      };
    case "object":
      return {
        kind: "object",
        entries: Object.fromEntries(
          Object.entries(binding.entries)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, normalizeBinding(value)])
        )
      };
  }
}

function normalizeCondition(condition: Condition): Condition {
  switch (condition.kind) {
    case "compare":
      return {
        kind: "compare",
        operator: condition.operator,
        left: normalizeBinding(condition.left),
        ...(condition.right === undefined
          ? {}
          : { right: normalizeBinding(condition.right) })
      };
    case "all":
    case "any":
      return {
        kind: condition.kind,
        conditions: condition.conditions.map(normalizeCondition)
      };
    case "not":
      return { kind: "not", condition: normalizeCondition(condition.condition) };
  }
}

function normalizeArtifactRefs<T extends ArtifactRef>(
  refs: readonly T[]
): readonly T[] {
  return normalizeArtifactClosure({ entries: refs }).entries as readonly T[];
}

function normalizeRetryPolicy(
  retry: ResolvedRetryPolicy
): ResolvedRetryPolicy {
  return {
    maxAttempts: retry.maxAttempts,
    retryableOutcomes: [...retry.retryableOutcomes].sort(),
    retryableErrorCodes: [...retry.retryableErrorCodes]
      .map((code) => code.trim())
      .sort(),
    backoff: { ...retry.backoff }
  };
}

function normalizeTimingPolicy(
  timing: ResolvedTimingPolicy
): ResolvedTimingPolicy {
  return {
    ...(timing.readiness
      ? { readiness: { ...timing.readiness } }
      : {}),
    ...(timing.dispatchJitter
      ? { dispatchJitter: { ...timing.dispatchJitter } }
      : {}),
    ...(timing.rateLimit ? { rateLimit: { ...timing.rateLimit } } : {})
  };
}

function normalizeResourceRequirement(
  requirement: BrowserResourceRequirementSnapshot
): BrowserResourceRequirementSnapshot {
  return {
    kind: "browser",
    capabilities: [...requirement.capabilities]
      .map((capability) => capability.trim())
      .sort(),
    allowedOrigins: [...requirement.allowedOrigins]
      .map((origin) => origin.trim())
      .sort(),
    authentication: requirement.authentication,
    ...(requirement.continuity === undefined
      ? {}
      : { continuity: requirement.continuity }),
    purpose: requirement.purpose.trim()
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function resourceRequirementDigest(
  requirement: BrowserResourceRequirementSnapshot
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(normalizeResourceRequirement(requirement)))
    .digest("hex")}`;
}

function normalizeStep(step: ExecutionStep): ExecutionStep {
  switch (step.kind) {
    case "call":
      return {
        kind: "call",
        key: step.key.trim(),
        node: normalizeArtifactClosure({ entries: [step.node] })
          .entries[0]! as typeof step.node,
        ...(step.schemaContract === undefined
          ? {}
          : {
              schemaContract: {
                nodeDigest: step.schemaContract.nodeDigest
                  .trim()
                  .toLowerCase(),
                inputSchema: normalizeJsonValue(
                  step.schemaContract.inputSchema
                ) as Readonly<Record<string, JsonValue>>,
                inputSchemaDigest: step.schemaContract.inputSchemaDigest
                  .trim()
                  .toLowerCase(),
                outputSchema: normalizeJsonValue(
                  step.schemaContract.outputSchema
                ) as Readonly<Record<string, JsonValue>>,
                outputSchemaDigest: step.schemaContract.outputSchemaDigest
                  .trim()
                  .toLowerCase()
              }
            }),
        providerId: step.providerId.trim(),
        permissionSnapshot: {
          riskLevel: step.permissionSnapshot.riskLevel,
          permissions: [...step.permissionSnapshot.permissions]
            .map((permission) => permission.trim())
            .sort(),
          domains: [...step.permissionSnapshot.domains]
            .map((domain) => domain.trim())
            .sort(),
          ...(step.permissionSnapshot.grantDigest === undefined
            ? {}
            : {
                grantDigest: step.permissionSnapshot.grantDigest
                  .trim()
                  .toLowerCase()
              })
        },
        ...(step.resourceRequirements === undefined
          ? {}
          : {
              resourceRequirements: Object.fromEntries(
                Object.entries(step.resourceRequirements)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name, requirement]) => [
                    name,
                    normalizeResourceRequirement(requirement)
                  ])
              )
            }),
        ...(step.resourceMappings === undefined
          ? {}
          : {
              resourceMappings: Object.fromEntries(
                Object.entries(step.resourceMappings)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name, mapping]) => [
                    name,
                    {
                      requirementName: mapping.requirementName.trim(),
                      slotName: mapping.slotName.trim(),
                      requirement: normalizeResourceRequirement(
                        mapping.requirement
                      ),
                      requirementDigest: mapping.requirementDigest
                        .trim()
                        .toLowerCase()
                    }
                  ])
              )
            }),
        dependencies: {
          adapters: normalizeArtifactRefs(step.dependencies.adapters),
          policies: normalizeArtifactRefs(step.dependencies.policies),
          datasetProfiles: normalizeArtifactRefs(
            step.dependencies.datasetProfiles
          )
        },
        timeoutMs: step.timeoutMs,
        retry: normalizeRetryPolicy(step.retry),
        timing: normalizeTimingPolicy(step.timing),
        ...(step.input === undefined
          ? {}
          : { input: normalizeBinding(step.input) }),
        routes: {
          succeeded: step.routes.succeeded.trim(),
          failed: step.routes.failed.trim(),
          timed_out: step.routes.timed_out.trim(),
          rejected: step.routes.rejected.trim(),
          cancelled: step.routes.cancelled.trim(),
          uncertain: step.routes.uncertain.trim()
        }
      };
    case "decision":
      return {
        kind: "decision",
        key: step.key.trim(),
        branches: step.branches.map((branch) => ({
          id: branch.id.trim(),
          condition: normalizeCondition(branch.condition),
          target: branch.target.trim()
        })),
        defaultTarget: step.defaultTarget.trim()
      };
    case "foreach":
      return {
        kind: "foreach",
        key: step.key.trim(),
        items: normalizeBinding(step.items),
        itemKey: {
          path: step.itemKey.path.map((segment) => segment.trim()),
          valueType: step.itemKey.valueType
        },
        limits: { ...step.limits },
        onItemError: step.onItemError,
        body: normalizeBlock(step.body),
        aggregation: {
          ...step.aggregation,
          outputKey: step.aggregation.outputKey.trim()
        },
        routes: {
          completed: step.routes.completed.trim(),
          stopped: step.routes.stopped.trim(),
          uncertain: step.routes.uncertain.trim()
        }
      };
    case "wait.assistance":
      return step.blocking
        ? {
            kind: "wait.assistance",
            key: step.key.trim(),
            taskKind: step.taskKind,
            profile: normalizeArtifactClosure({ entries: [step.profile] })
              .entries[0]! as typeof step.profile,
            deadlineMs: step.deadlineMs,
            onUnavailable: step.onUnavailable,
            ...(step.input === undefined
              ? {}
              : { input: normalizeBinding(step.input) }),
            blocking: true,
            routes: {
              resolved: step.routes.resolved.trim(),
              escalated: step.routes.escalated.trim(),
              expired: step.routes.expired.trim(),
              unavailable: step.routes.unavailable.trim()
            }
          }
        : {
            kind: "wait.assistance",
            key: step.key.trim(),
            taskKind: step.taskKind,
            profile: normalizeArtifactClosure({ entries: [step.profile] })
              .entries[0]! as typeof step.profile,
            deadlineMs: step.deadlineMs,
            onUnavailable: step.onUnavailable,
            ...(step.input === undefined
              ? {}
              : { input: normalizeBinding(step.input) }),
            blocking: false,
            next: step.next.trim()
          };
    case "terminal":
      return {
        kind: "terminal",
        key: step.key.trim(),
        status: step.status,
        ...(step.output === undefined
          ? {}
          : { output: normalizeBinding(step.output) }),
        ...(step.errorCode === undefined
          ? {}
          : { errorCode: step.errorCode.trim() })
      };
  }
}

function normalizeBlock(block: ExecutionBlock): ExecutionBlock {
  return {
    entry: block.entry.trim(),
    steps: Object.fromEntries(
      Object.entries(block.steps)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, step]) => [key, normalizeStep(step)])
    )
  };
}

export function normalizeExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  const normalizedBlock = normalizeBlock({
    entry: plan.entry,
    steps: plan.steps
  });
  return {
    irVersion: plan.irVersion,
    workflow: {
      id: plan.workflow.id.trim(),
      version: plan.workflow.version.trim(),
      digest: plan.workflow.digest.trim().toLowerCase()
    },
    artifactClosure: normalizeArtifactClosure(plan.artifactClosure),
    riskSnapshot: plan.riskSnapshot
      .map((entry) => ({
        code: entry.code.trim(),
        level: entry.level,
        source: normalizeArtifactClosure({ entries: [entry.source] })
          .entries[0]!,
        ...(entry.details === undefined
          ? {}
          : { details: normalizeJsonValue(entry.details) })
      }))
      .sort((left, right) =>
        `${left.level}\u0000${left.code}\u0000${artifactKey(left.source)}`.localeCompare(
          `${right.level}\u0000${right.code}\u0000${artifactKey(right.source)}`
        )
      ),
    ...(plan.resourceSlots === undefined
      ? {}
      : {
          resourceSlots: Object.fromEntries(
            Object.entries(plan.resourceSlots)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, requirement]) => [
                name,
                normalizeResourceRequirement(requirement)
              ])
          )
        }),
    limits: { ...plan.limits },
    entry: normalizedBlock.entry,
    steps: normalizedBlock.steps
  };
}

function bindingIssues(binding: BindingValue, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  switch (binding.kind) {
    case "literal":
      break;
    case "reference":
      if (binding.path.some((segment) => !segment || FORBIDDEN_BINDING_KEYS.has(segment))) {
        issues.push(
          issue(
            "INVALID_VALUE",
            `${path}/path`,
            "reference path contains an empty or forbidden segment"
          )
        );
      }
      if (
        (binding.source === "step_output" ||
          binding.source === "step_evidence") &&
        !binding.stepKey
      ) {
        issues.push(
          issue(
            "INVALID_VALUE",
            `${path}/stepKey`,
            `${binding.source} references require stepKey`
          )
        );
      }
      if (
        binding.source !== "step_output" &&
        binding.source !== "step_evidence" &&
        binding.stepKey !== undefined
      ) {
        issues.push(
          issue(
            "INVALID_VALUE",
            `${path}/stepKey`,
            "stepKey is only valid for step output or evidence references"
          )
        );
      }
      break;
    case "array":
      binding.items.forEach((child, index) => {
        issues.push(...bindingIssues(child, `${path}/items/${index}`));
      });
      break;
    case "object":
      for (const [key, child] of Object.entries(binding.entries)) {
        if (FORBIDDEN_BINDING_KEYS.has(key)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${path}/entries/${key}`,
              "binding object contains a forbidden key"
            )
          );
        }
        issues.push(...bindingIssues(child, `${path}/entries/${key}`));
      }
      break;
    default:
      issues.push(
        issue(
          "INVALID_VALUE",
          path,
          `unsupported binding kind ${String((binding as { kind?: unknown }).kind)}`
        )
      );
  }
  return issues;
}

function conditionIssues(condition: Condition, path: string): ValidationIssue[] {
  switch (condition.kind) {
    case "compare":
      return [
        ...bindingIssues(condition.left, `${path}/left`),
        ...(condition.right
          ? bindingIssues(condition.right, `${path}/right`)
          : []),
        ...(condition.operator !== "exists" && condition.right === undefined
          ? [
              issue(
                "INVALID_VALUE" as const,
                `${path}/right`,
                `${condition.operator} requires a right operand`
              )
            ]
          : []),
        ...(condition.operator === "exists" && condition.right !== undefined
          ? [
              issue(
                "INVALID_VALUE" as const,
                `${path}/right`,
                "exists does not accept a right operand"
              )
            ]
          : [])
      ];
    case "all":
    case "any":
      if (condition.conditions.length === 0) {
        return [
          issue(
            "INVALID_VALUE",
            `${path}/conditions`,
            `${condition.kind} requires at least one condition`
          )
        ];
      }
      return condition.conditions.flatMap((child, index) =>
        conditionIssues(child, `${path}/conditions/${index}`)
      );
    case "not":
      return conditionIssues(condition.condition, `${path}/condition`);
    default:
      return [
        issue(
          "INVALID_VALUE",
          path,
          `unsupported condition kind ${String((condition as { kind?: unknown }).kind)}`
        )
      ];
  }
}

function stepTargets(step: ExecutionStep): readonly string[] {
  switch (step.kind) {
    case "call":
      return Object.values(step.routes);
    case "decision":
      return [...step.branches.map((branch) => branch.target), step.defaultTarget];
    case "foreach":
      return Object.values(step.routes);
    case "wait.assistance":
      return step.blocking ? Object.values(step.routes) : [step.next];
    case "terminal":
      return [];
    default:
      return [];
  }
}

function validateLimits(
  limits: ExecutionLimits,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isNonNegativeSafeInteger(limits.maxDepth)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/maxDepth`,
        "maxDepth must be a non-negative safe integer"
      )
    );
  }
  if (!isPositiveSafeInteger(limits.maxStepExecutions)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/maxStepExecutions`,
        "maxStepExecutions must be a positive safe integer"
      )
    );
  }
  return issues;
}

function retryPolicyIssues(
  retry: ResolvedRetryPolicy,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPositiveSafeInteger(retry.maxAttempts)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/maxAttempts`,
        "maxAttempts must be a positive safe integer"
      )
    );
  }
  const allowedOutcomes = new Set(["failed", "timed_out"]);
  const seenOutcomes = new Set<string>();
  retry.retryableOutcomes.forEach((outcome, index) => {
    if (!allowedOutcomes.has(outcome) || seenOutcomes.has(outcome)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/retryableOutcomes/${index}`,
          "retryable outcomes must be unique failed or timed_out values"
        )
      );
    }
    seenOutcomes.add(outcome);
  });
  const seenCodes = new Set<string>();
  retry.retryableErrorCodes.forEach((code, index) => {
    if (!code || seenCodes.has(code)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/retryableErrorCodes/${index}`,
          "retryable error codes must be non-empty and unique"
        )
      );
    }
    seenCodes.add(code);
  });
  const { backoff } = retry;
  if (backoff.strategy !== "fixed" && backoff.strategy !== "exponential") {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/backoff/strategy`,
        "backoff strategy must be fixed or exponential"
      )
    );
  }
  if (
    !Number.isSafeInteger(backoff.baseDelayMs) ||
    backoff.baseDelayMs < 0
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/backoff/baseDelayMs`,
        "baseDelayMs must be a non-negative safe integer"
      )
    );
  }
  if (
    !Number.isSafeInteger(backoff.maxDelayMs) ||
    backoff.maxDelayMs < backoff.baseDelayMs
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/backoff/maxDelayMs`,
        "maxDelayMs must be a safe integer at least baseDelayMs"
      )
    );
  }
  if (
    !Number.isFinite(backoff.jitterRatio) ||
    backoff.jitterRatio < 0 ||
    backoff.jitterRatio > 1
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/backoff/jitterRatio`,
        "jitterRatio must be between 0 and 1"
      )
    );
  }
  return issues;
}

function timingPolicyIssues(
  timing: ResolvedTimingPolicy,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (timing.readiness) {
    const { timeoutMs, stableForMs, pollIntervalMs } = timing.readiness;
    if (
      !isPositiveSafeInteger(timeoutMs) ||
      !isNonNegativeSafeInteger(stableForMs) ||
      !isPositiveSafeInteger(pollIntervalMs) ||
      stableForMs > timeoutMs
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/readiness`,
          "readiness requires positive timeout/poll interval and stableForMs between 0 and timeoutMs"
        )
      );
    }
  }
  if (timing.dispatchJitter) {
    const { minMs, maxMs } = timing.dispatchJitter;
    if (
      !isNonNegativeSafeInteger(minMs) ||
      !isNonNegativeSafeInteger(maxMs) ||
      minMs > maxMs
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/dispatchJitter`,
          "dispatch jitter requires non-negative safe integers with minMs <= maxMs"
        )
      );
    }
    if (timing.dispatchJitter.distribution !== "uniform") {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/dispatchJitter/distribution`,
          "dispatch jitter distribution must be uniform"
        )
      );
    }
  }
  if (timing.rateLimit) {
    const { minIntervalMs, maxQueueMs } = timing.rateLimit;
    if (
      !isNonNegativeSafeInteger(minIntervalMs) ||
      !isNonNegativeSafeInteger(maxQueueMs)
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/rateLimit`,
          "rate-limit durations must be non-negative safe integers"
        )
      );
    }
    if (
      !["domain", "authentication_context", "tab"].includes(
        timing.rateLimit.scope
      )
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/rateLimit/scope`,
          "rate-limit scope must be domain, authentication_context or tab"
        )
      );
    }
  }
  return issues;
}

function artifactDependencyIssues(
  refs: readonly ArtifactRef[],
  expectedKind: ArtifactRef["kind"],
  path: string,
  closure: ReadonlySet<string>,
  closureIdentities: ReadonlyMap<string, string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const refPath = `${path}/${index}`;
    if (ref.kind !== expectedKind) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${refPath}/kind`,
          `dependency must have kind "${expectedKind}"`
        )
      );
    }
    const key = artifactKey(ref);
    if (seen.has(key)) {
      issues.push(
        issue(
          "DUPLICATE_ARTIFACT",
          refPath,
          "call dependency is duplicated"
        )
      );
    }
    seen.add(key);
    if (!closure.has(key)) {
      const closedDigest = closureIdentities.get(artifactIdentity(ref));
      issues.push(
        issue(
          "ARTIFACT_NOT_CLOSED",
          refPath,
          closedDigest
            ? `dependency digest does not match closed digest "${closedDigest}"`
            : "dependency is absent from the artifact closure"
        )
      );
    }
  });
  return issues;
}

function requiredRouteIssues(
  routes: object,
  names: readonly string[],
  path: string
): ValidationIssue[] {
  const record = routes as Readonly<Record<string, unknown>>;
  return names.flatMap((name) =>
    typeof record[name] === "string" && record[name] !== ""
      ? []
      : [
          issue(
            "INVALID_STEP",
            `${path}/${name}`,
            `route "${name}" requires a non-empty target`
          )
        ]
  );
}

function executionCost(block: ExecutionBlock): bigint {
  const memo = new Map<string, bigint>();
  const visiting = new Set<string>();
  const from = (key: string): bigint => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const step = block.steps[key];
    if (!step || visiting.has(key)) return 0n;
    visiting.add(key);
    const bodyCost = step.kind === "foreach"
      ? (isPositiveSafeInteger(step.limits.maxItems)
          ? BigInt(step.limits.maxItems)
          : 0n) * executionCost(step.body)
      : 0n;
    const continuationCost = stepTargets(step).reduce(
      (maximum, target) => {
        const candidate = from(target);
        return candidate > maximum ? candidate : maximum;
      },
      0n
    );
    visiting.delete(key);
    const cost = 1n + bodyCost + continuationCost;
    memo.set(key, cost);
    return cost;
  };
  return from(block.entry);
}

export function estimateMaxStepExecutions(plan: ExecutionPlan): bigint {
  return executionCost({ entry: plan.entry, steps: plan.steps });
}

const AUTHENTICATION_RANK = {
  anonymous: 0,
  optional: 1,
  authenticated: 2,
  membership: 3
} as const;

function resourceRequirementIssues(
  requirement: BrowserResourceRequirementSnapshot,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (requirement.kind !== "browser") {
    issues.push(
      issue("INVALID_VALUE", `${path}/kind`, "resource kind must be browser")
    );
  }
  if (
    requirement.capabilities.length === 0 ||
    new Set(requirement.capabilities).size !== requirement.capabilities.length ||
    requirement.capabilities.some(
      (capability) => !CAPABILITY_PATTERN.test(capability)
    )
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/capabilities`,
        "capabilities must contain unique stable identifiers"
      )
    );
  }
  if (
    requirement.allowedOrigins.length === 0 ||
    new Set(requirement.allowedOrigins).size !==
      requirement.allowedOrigins.length ||
    requirement.allowedOrigins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.protocol !== "https:" ||
          parsed.origin !== origin ||
          parsed.pathname !== "/" ||
          parsed.username !== "" ||
          parsed.password !== "" ||
          parsed.search !== "" ||
          parsed.hash !== ""
        );
      } catch {
        return true;
      }
    })
  ) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/allowedOrigins`,
        "allowedOrigins must contain unique exact HTTPS origins"
      )
    );
  }
  if (!(requirement.authentication in AUTHENTICATION_RANK)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/authentication`,
        "authentication level is not supported"
      )
    );
  }
  if (!requirement.purpose.trim()) {
    issues.push(
      issue(
        "INVALID_VALUE",
        `${path}/purpose`,
        "resource purpose must not be empty"
      )
    );
  }
  return issues;
}

function maxForeachDepth(block: ExecutionBlock): number {
  let depth = 0;
  for (const step of Object.values(block.steps)) {
    if (step.kind === "foreach") {
      depth = Math.max(depth, 1 + maxForeachDepth(step.body));
    }
  }
  return depth;
}

export function estimateMaxDepth(plan: ExecutionPlan): number {
  return maxForeachDepth({ entry: plan.entry, steps: plan.steps });
}

function blockIssues(
  block: ExecutionBlock,
  path: string,
  closure: ReadonlySet<string>,
  closureIdentities: ReadonlyMap<string, string>,
  resourceSlots: Readonly<
    Record<string, BrowserResourceRequirementSnapshot>
  >,
  ancestorStepKeys: ReadonlySet<string>,
  blockScope: "plan" | "foreach"
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entries = Object.entries(block.steps);
  const keys = new Set(entries.map(([key]) => key));

  if (!keys.has(block.entry)) {
    issues.push(
      issue(
        "MISSING_TARGET",
        `${path}/entry`,
        `entry step "${block.entry}" does not exist in this block`
      )
    );
  }

  for (const [recordKey, step] of entries) {
    const stepPath = `${path}/steps/${recordKey}`;
    const rawKind = (step as { kind?: unknown }).kind;
    if (
      typeof rawKind === "string" &&
      (UNSUPPORTED_STEP_KINDS.has(rawKind) ||
        ![
          "call",
          "decision",
          "foreach",
          "wait.assistance",
          "terminal"
        ].includes(rawKind))
    ) {
      issues.push(
        issue(
          "UNSUPPORTED_STEP_KIND",
          `${stepPath}/kind`,
          `step kind "${rawKind}" is not supported by ${WORKFLOW_IR_VERSION}`
        )
      );
      continue;
    }
    if (!KEY_PATTERN.test(recordKey) || !KEY_PATTERN.test(step.key)) {
      issues.push(
        issue(
          "INVALID_STEP",
          stepPath,
          "step keys must be 1-256 safe identifier characters"
        )
      );
    }
    if (recordKey !== step.key) {
      issues.push(
        issue(
          "INVALID_STEP",
          `${stepPath}/key`,
          `record key "${recordKey}" must equal step.key "${step.key}"`
        )
      );
    }
    if (ancestorStepKeys.has(recordKey)) {
      issues.push(
        issue(
          "INVALID_STEP",
          stepPath,
          `step key "${recordKey}" shadows an ancestor scope`
        )
      );
    }

    for (const target of stepTargets(step)) {
      if (!keys.has(target)) {
        issues.push(
          issue(
            "MISSING_TARGET",
            stepPath,
            `target step "${target}" does not exist in this block`
          )
        );
      }
    }

    switch (step.kind) {
      case "call":
        issues.push(
          ...(step.input
            ? bindingIssues(step.input, `${stepPath}/input`)
            : []),
          ...retryPolicyIssues(step.retry, `${stepPath}/retry`),
          ...timingPolicyIssues(step.timing, `${stepPath}/timing`),
          ...artifactDependencyIssues(
            step.dependencies.adapters,
            "adapter",
            `${stepPath}/dependencies/adapters`,
            closure,
            closureIdentities
          ),
          ...artifactDependencyIssues(
            step.dependencies.policies,
            "policy",
            `${stepPath}/dependencies/policies`,
            closure,
            closureIdentities
          ),
          ...artifactDependencyIssues(
            step.dependencies.datasetProfiles,
            "dataset_profile",
            `${stepPath}/dependencies/datasetProfiles`,
            closure,
            closureIdentities
          ),
          ...requiredRouteIssues(
            step.routes,
            [
              "succeeded",
              "failed",
              "timed_out",
              "rejected",
              "cancelled",
              "uncertain"
            ],
            `${stepPath}/routes`
          )
        );
        const resourceRequirements = step.resourceRequirements ?? {};
        for (const [name, requirement] of Object.entries(
          resourceRequirements
        )) {
          if (!RESOURCE_NAME_PATTERN.test(name)) {
            issues.push(
              issue(
                "INVALID_VALUE",
                `${stepPath}/resourceRequirements/${name}`,
                "resource requirement name is not a stable identifier"
              )
            );
          }
          issues.push(
            ...resourceRequirementIssues(
              requirement,
              `${stepPath}/resourceRequirements/${name}`
            )
          );
          const permittedDomains = new Set(
            step.permissionSnapshot.domains
          );
          if (
            requirement.allowedOrigins.some(
              (origin) => !permittedDomains.has(origin)
            )
          ) {
            issues.push(
              issue(
                "INVALID_VALUE",
                `${stepPath}/resourceRequirements/${name}/allowedOrigins`,
                "resource requirement expands the Call permission domains"
              )
            );
          }
          if (!step.resourceMappings?.[name]) {
            issues.push(
              issue(
                "INVALID_VALUE",
                `${stepPath}/resourceMappings/${name}`,
                "every Node resource requirement must be mapped"
              )
            );
          }
        }
        if (step.resourceMappings) {
          for (const [name, mapping] of Object.entries(
            step.resourceMappings
          )) {
            const mappingPath = `${stepPath}/resourceMappings/${name}`;
            const frozenRequirement = resourceRequirements[name];
            if (!frozenRequirement) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  mappingPath,
                  "mapping references an unknown Node resource requirement"
                )
              );
            } else if (
              JSON.stringify(normalizeResourceRequirement(frozenRequirement)) !==
              JSON.stringify(
                normalizeResourceRequirement(mapping.requirement)
              )
            ) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${mappingPath}/requirement`,
                  "mapping requirement differs from the frozen Node requirement"
                )
              );
            }
            if (
              !RESOURCE_NAME_PATTERN.test(name) ||
              mapping.requirementName !== name
            ) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  mappingPath,
                  "mapping key must equal its stable requirementName"
                )
              );
            }
            if (!RESOURCE_NAME_PATTERN.test(mapping.slotName)) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${mappingPath}/slotName`,
                  "slotName must be a stable resource name"
                )
              );
            }
            if (!DIGEST_PATTERN.test(mapping.requirementDigest)) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${mappingPath}/requirementDigest`,
                  "requirementDigest must be a SHA-256 digest"
                )
              );
            }
            if (
              mapping.requirementDigest !==
              resourceRequirementDigest(mapping.requirement)
            ) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${mappingPath}/requirementDigest`,
                  "requirementDigest does not match the frozen requirement"
                )
              );
            }
            issues.push(
              ...resourceRequirementIssues(
                mapping.requirement,
                `${mappingPath}/requirement`
              )
            );
            const slot = resourceSlots[mapping.slotName];
            if (!slot) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${mappingPath}/slotName`,
                  `mapped resource slot "${mapping.slotName}" is absent`
                )
              );
              continue;
            }
            const slotCapabilities = new Set(slot.capabilities);
            if (
              mapping.requirement.capabilities.some(
                (capability) => !slotCapabilities.has(capability)
              )
            ) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  mappingPath,
                  "resource slot does not include every Node capability"
                )
              );
            }
            const nodeOrigins = new Set(mapping.requirement.allowedOrigins);
            if (slot.allowedOrigins.some((origin) => !nodeOrigins.has(origin))) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  mappingPath,
                  "resource slot expands the Node allowed origins"
                )
              );
            }
            if (
              AUTHENTICATION_RANK[slot.authentication] <
              AUTHENTICATION_RANK[mapping.requirement.authentication]
            ) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  mappingPath,
                  "resource slot downgrades the Node authentication requirement"
                )
              );
            }
          }
        }
        if (!KEY_PATTERN.test(step.providerId)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/providerId`,
              "providerId must be a non-empty stable identifier"
            )
          );
        }
        if (step.schemaContract) {
          if (step.schemaContract.nodeDigest !== step.node.digest) {
            issues.push(
              issue(
                "INVALID_VALUE",
                `${stepPath}/schemaContract/nodeDigest`,
                "Schema contract must be bound to the exact Call Node digest"
              )
            );
          }
          for (const [name, digest] of [
            ["inputSchemaDigest", step.schemaContract.inputSchemaDigest],
            ["outputSchemaDigest", step.schemaContract.outputSchemaDigest]
          ] as const) {
            if (!DIGEST_PATTERN.test(digest)) {
              issues.push(
                issue(
                  "INVALID_VALUE",
                  `${stepPath}/schemaContract/${name}`,
                  `${name} must be a SHA-256 digest`
                )
              );
            }
          }
        }
        if (
          new Set(step.permissionSnapshot.permissions).size !==
            step.permissionSnapshot.permissions.length ||
          step.permissionSnapshot.permissions.some(
            (permission) => !KEY_PATTERN.test(permission)
          )
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/permissionSnapshot/permissions`,
              "permissions must contain unique stable identifiers"
            )
          );
        }
        if (
          new Set(step.permissionSnapshot.domains).size !==
            step.permissionSnapshot.domains.length ||
          step.permissionSnapshot.domains.some((domain) => {
            try {
              const parsed = new URL(domain);
              return (
                !["https:", "http:"].includes(parsed.protocol) ||
                parsed.origin !== domain ||
                parsed.pathname !== "/" ||
                parsed.search !== "" ||
                parsed.hash !== ""
              );
            } catch {
              return true;
            }
          })
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/permissionSnapshot/domains`,
              "domains must contain unique exact HTTP(S) origins"
            )
          );
        }
        if (
          step.permissionSnapshot.grantDigest !== undefined &&
          !DIGEST_PATTERN.test(step.permissionSnapshot.grantDigest)
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/permissionSnapshot/grantDigest`,
              "grantDigest must be a SHA-256 digest"
            )
          );
        }
        if (!isPositiveSafeInteger(step.timeoutMs)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/timeoutMs`,
              "timeoutMs must be a positive safe integer"
            )
          );
        }
        if (!closure.has(artifactKey(step.node))) {
          const closedDigest = closureIdentities.get(artifactIdentity(step.node));
          issues.push(
            issue(
              "ARTIFACT_NOT_CLOSED",
              `${stepPath}/node`,
              closedDigest
                ? `node digest does not match closed digest "${closedDigest}"`
                : "node is absent from the artifact closure"
            )
          );
        }
        const rejectedTarget = block.steps[step.routes.rejected];
        if (
          rejectedTarget?.kind !== "terminal" ||
          rejectedTarget.status !== "rejected"
        ) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/routes/rejected`,
              "call rejected must directly target a rejected terminal"
            )
          );
        }
        const uncertainTarget = block.steps[step.routes.uncertain];
        if (
          uncertainTarget?.kind !== "terminal" ||
          uncertainTarget.status !== "uncertain"
        ) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/routes/uncertain`,
              "call uncertain must directly target an uncertain terminal"
            )
          );
        }
        break;
      case "decision": {
        if (step.branches.length === 0) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/branches`,
              "decision requires at least one branch"
            )
          );
        }
        const branchIds = new Set<string>();
        step.branches.forEach((branch, index) => {
          if (!branch.id || branchIds.has(branch.id)) {
            issues.push(
              issue(
                "INVALID_STEP",
                `${stepPath}/branches/${index}/id`,
                "decision branch IDs must be non-empty and unique"
              )
            );
          }
          branchIds.add(branch.id);
          issues.push(
            ...conditionIssues(
              branch.condition,
              `${stepPath}/branches/${index}/condition`
            )
          );
        });
        break;
      }
      case "foreach": {
        issues.push(
          ...bindingIssues(step.items, `${stepPath}/items`),
          ...validateLimits(step.limits, `${stepPath}/limits`),
          ...requiredRouteIssues(
            step.routes,
            ["completed", "stopped", "uncertain"],
            `${stepPath}/routes`
          )
        );
        if (!isPositiveSafeInteger(step.limits.maxItems)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/limits/maxItems`,
              "maxItems must be a positive safe integer"
            )
          );
        }
        if (!isPositiveSafeInteger(step.limits.maxDurationMs)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/limits/maxDurationMs`,
              "maxDurationMs must be a positive safe integer"
            )
          );
        }
        if (
          step.onItemError !== "stop" &&
          step.onItemError !== "collect"
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/onItemError`,
              'onItemError must be "stop" or "collect"'
            )
          );
        }
        if (step.aggregation.mode !== "outcome_summary") {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/aggregation/mode`,
              'aggregation mode must be "outcome_summary"'
            )
          );
        }
        if (
          step.itemKey.path.some(
            (segment) => !segment || FORBIDDEN_BINDING_KEYS.has(segment)
          )
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/itemKey/path`,
              "itemKey path contains an empty or forbidden segment"
            )
          );
        }
        if (!step.aggregation.outputKey) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/aggregation/outputKey`,
              "aggregation outputKey is required"
            )
          );
        }
        const bodyDepth = maxForeachDepth(step.body);
        if (
          isNonNegativeSafeInteger(step.limits.maxDepth) &&
          bodyDepth > step.limits.maxDepth
        ) {
          issues.push(
            issue(
              "LIMIT_EXCEEDED",
              `${stepPath}/limits/maxDepth`,
              `body depth ${bodyDepth} exceeds local maxDepth ${step.limits.maxDepth}`
            )
          );
        }
        const bodyCost = executionCost(step.body);
        const totalBodyCost = isPositiveSafeInteger(step.limits.maxItems)
          ? BigInt(step.limits.maxItems) * bodyCost
          : 0n;
        if (
          isPositiveSafeInteger(step.limits.maxStepExecutions) &&
          totalBodyCost > BigInt(step.limits.maxStepExecutions)
        ) {
          issues.push(
            issue(
              "LIMIT_EXCEEDED",
              `${stepPath}/limits/maxStepExecutions`,
              `foreach body upper bound ${totalBodyCost} exceeds local maxStepExecutions ${step.limits.maxStepExecutions}`
            )
          );
        }
        const uncertainTarget = block.steps[step.routes.uncertain];
        if (
          uncertainTarget?.kind !== "terminal" ||
          uncertainTarget.status !== "uncertain"
        ) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/routes/uncertain`,
              "foreach uncertain must directly target an uncertain terminal"
            )
          );
        }
        issues.push(
          ...blockIssues(
            step.body,
            `${stepPath}/body`,
            closure,
            closureIdentities,
            resourceSlots,
            new Set([...ancestorStepKeys, ...keys]),
            "foreach"
          )
        );
        break;
      }
      case "wait.assistance":
        issues.push(
          ...(step.input
            ? bindingIssues(step.input, `${stepPath}/input`)
            : [])
        );
        const rawAssistanceStep = step as unknown as Readonly<
          Record<string, unknown>
        >;
        if (step.blocking) {
          issues.push(
            ...requiredRouteIssues(
              step.routes,
              ["resolved", "escalated", "expired", "unavailable"],
              `${stepPath}/routes`
            )
          );
          if ("next" in rawAssistanceStep) {
            issues.push(
              issue(
                "INVALID_STEP",
                `${stepPath}/next`,
                "blocking assistance uses completion routes, not next"
              )
            );
          }
        } else {
          issues.push(
            ...requiredRouteIssues(
              { next: step.next },
              ["next"],
              stepPath
            )
          );
          if ("routes" in rawAssistanceStep) {
            issues.push(
              issue(
                "INVALID_STEP",
                `${stepPath}/routes`,
                "detached assistance cannot route the Run on task completion"
              )
            );
          }
        }
        if (!isPositiveSafeInteger(step.deadlineMs)) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/deadlineMs`,
              "deadlineMs must be a positive safe integer"
            )
          );
        }
        if (
          !["continue_unresolved", "human_action", "fail"].includes(
            step.onUnavailable
          )
        ) {
          issues.push(
            issue(
              "INVALID_VALUE",
              `${stepPath}/onUnavailable`,
              "onUnavailable is not supported"
            )
          );
        }
        if (
          step.taskKind === "human_action" &&
          step.onUnavailable === "human_action"
        ) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/onUnavailable`,
              "a human_action task cannot escalate unavailability to itself"
            )
          );
        }
        if (!closure.has(artifactKey(step.profile))) {
          issues.push(
            issue(
              "ARTIFACT_NOT_CLOSED",
              `${stepPath}/profile`,
              "assistance profile is absent from the artifact closure"
            )
          );
        }
        break;
      case "terminal":
        issues.push(
          ...(step.output
            ? bindingIssues(step.output, `${stepPath}/output`)
            : [])
        );
        if (step.status === "failed" && !step.errorCode) {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/errorCode`,
              "failed terminal steps require errorCode"
            )
          );
        }
        if (blockScope === "plan" && step.status === "unresolved") {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/status`,
              "unresolved is only an item outcome inside foreach"
            )
          );
        }
        if (blockScope === "foreach" && step.status === "cancelled") {
          issues.push(
            issue(
              "INVALID_STEP",
              `${stepPath}/status`,
              "cancelled is only a Run outcome outside foreach"
            )
          );
        }
        break;
    }
  }

  // IR2 deliberately accepts DAGs only. Any cycle is a forbidden back edge.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (!keys.has(key)) return;
    reachable.add(key);
    if (visiting.has(key)) {
      issues.push(
        issue(
          "BACK_EDGE",
          `${path}/steps/${key}`,
          `back edge to "${key}" is not supported by ${WORKFLOW_IR_VERSION}`
        )
      );
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const step = block.steps[key];
    if (step) {
      for (const target of stepTargets(step)) visit(target);
    }
    visiting.delete(key);
    visited.add(key);
  };
  visit(block.entry);

  for (const key of keys) {
    if (!reachable.has(key)) {
      issues.push(
        issue(
          "UNREACHABLE_STEP",
          `${path}/steps/${key}`,
          `step "${key}" is unreachable from block entry`
        )
      );
    }
  }
  return issues;
}

export function executionPlanIssues(plan: ExecutionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (plan.irVersion !== WORKFLOW_IR_VERSION) {
    issues.push(
      issue(
        "INVALID_VALUE",
        "/irVersion",
        `irVersion must be "${WORKFLOW_IR_VERSION}"`
      )
    );
  }
  for (const [path, value] of [
    ["/workflow/id", plan.workflow.id],
    ["/workflow/version", plan.workflow.version]
  ] as const) {
    if (!value.trim()) {
      issues.push(issue("INVALID_VALUE", path, "value must not be empty"));
    }
  }
  if (!DIGEST_PATTERN.test(plan.workflow.digest)) {
    issues.push(
      issue(
        "INVALID_VALUE",
        "/workflow/digest",
        "workflow digest must be a SHA-256 digest"
      )
    );
  }
  issues.push(...validateLimits(plan.limits, "/limits"));
  const resourceSlots = plan.resourceSlots ?? {};
  for (const [name, slot] of Object.entries(resourceSlots)) {
    if (!RESOURCE_NAME_PATTERN.test(name)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `/resourceSlots/${name}`,
          "resource slot name is not a stable identifier"
        )
      );
    }
    issues.push(
      ...resourceRequirementIssues(slot, `/resourceSlots/${name}`)
    );
  }

  const closure = normalizeArtifactClosure(plan.artifactClosure);
  const closedKeys = new Set<string>();
  const closedIdentities = new Map<string, string>();
  closure.entries.forEach((entry, index) => {
    const path = `/artifactClosure/entries/${index}`;
    if (!ARTIFACT_KINDS.includes(entry.kind)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `${path}/kind`,
          "artifact kind is not supported"
        )
      );
    }
    if (!entry.id || !entry.version || !DIGEST_PATTERN.test(entry.digest)) {
      issues.push(
        issue(
          "INVALID_VALUE",
          path,
          "artifact requires non-empty id/version and a SHA-256 digest"
        )
      );
    }
    const identity = artifactIdentity(entry);
    const existingDigest = closedIdentities.get(identity);
    if (existingDigest !== undefined) {
      issues.push(
        issue(
          "DUPLICATE_ARTIFACT",
          path,
          existingDigest === entry.digest
            ? "artifact is duplicated"
            : "artifact identity has conflicting digests"
        )
      );
    }
    closedIdentities.set(identity, entry.digest);
    closedKeys.add(artifactKey(entry));
  });

  plan.riskSnapshot.forEach((risk, index) => {
    if (!risk.code) {
      issues.push(
        issue(
          "INVALID_VALUE",
          `/riskSnapshot/${index}/code`,
          "risk code must not be empty"
        )
      );
    }
    if (!closedKeys.has(artifactKey(risk.source))) {
      issues.push(
        issue(
          "ARTIFACT_NOT_CLOSED",
          `/riskSnapshot/${index}/source`,
          "risk source is absent from the artifact closure"
        )
      );
    }
  });

  issues.push(
    ...blockIssues(
      { entry: plan.entry, steps: plan.steps },
      "",
      closedKeys,
      closedIdentities,
      resourceSlots,
      new Set(),
      "plan"
    )
  );

  const depth = estimateMaxDepth(plan);
  if (
    isNonNegativeSafeInteger(plan.limits.maxDepth) &&
    depth > plan.limits.maxDepth
  ) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        "/limits/maxDepth",
        `plan depth ${depth} exceeds maxDepth ${plan.limits.maxDepth}`
      )
    );
  }
  const cost = estimateMaxStepExecutions(plan);
  if (
    isPositiveSafeInteger(plan.limits.maxStepExecutions) &&
    cost > BigInt(plan.limits.maxStepExecutions)
  ) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        "/limits/maxStepExecutions",
        `plan upper bound ${cost} exceeds maxStepExecutions ${plan.limits.maxStepExecutions}`
      )
    );
  }
  return issues;
}

export class InvalidExecutionPlanError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Invalid execution plan: ${issues
        .map((entry) => `${entry.path || "/"}: ${entry.message}`)
        .join("; ")}`
    );
    this.name = "InvalidExecutionPlanError";
    this.issues = issues;
  }
}

export function createExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  const normalized = normalizeExecutionPlan(plan);
  const issues = executionPlanIssues(normalized);
  if (issues.length > 0) {
    throw new InvalidExecutionPlanError(issues);
  }
  return normalized;
}
