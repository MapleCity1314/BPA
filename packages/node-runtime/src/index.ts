import type { RiskSignal, TimingPolicy } from "@bpa/schemas";
import type {
  ArtifactRef,
  ExecutionIdentity,
  InvocationResourceBinding,
  JsonValue,
  PermissionSnapshot,
  ResourceBindingRef,
  ResourceSlotMappingSnapshot,
  RuntimeNodeSchemaContract
} from "@bpa/workflow-ir";
import {
  validateInvocationResourceBinding,
  type ObservedBrowserSession
} from "@bpa/resource-binding";

/**
 * Provider-neutral invocation persisted before dispatch. Engine code selects a
 * provider by id through the registry; it never branches on runtime kind.
 */
export interface RuntimeInvocation {
  readonly invocationId: string;
  readonly identity: ExecutionIdentity;
  readonly node: ArtifactRef & { readonly kind: "node" };
  readonly schemaContract?: RuntimeNodeSchemaContract;
  readonly providerId: string;
  readonly input: JsonValue;
  readonly permissionSnapshot: PermissionSnapshot;
  /**
   * Exact Run-level browser bindings selected before execution. Providers
   * must never derive or replace these references from Node input/output.
   */
  readonly resourceBindings?: Readonly<
    Record<string, InvocationResourceBinding>
  >;
  /** Frozen Call mappings copied directly from IR2. */
  readonly resourceMappings?: Readonly<
    Record<string, ResourceSlotMappingSnapshot>
  >;
  readonly deadlineAt: number;
  readonly idempotencyKey: string;
  readonly fencingToken: number;
  readonly traceId: string;
}

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export interface RuntimeEvidenceRef {
  readonly evidenceId: string;
  readonly digest: string;
  readonly classification: "public" | "internal" | "sensitive";
}

export type RuntimeOutcome =
  | {
      readonly status: "succeeded";
      readonly output: JsonValue;
      readonly evidence: readonly RuntimeEvidenceRef[];
      readonly riskSignals: readonly RiskSignal[];
    }
  | {
      readonly status:
        | "failed"
        | "rejected"
        | "timed_out"
        | "cancelled"
        | "uncertain";
      readonly error: RuntimeError;
      readonly output?: JsonValue;
      readonly evidence: readonly RuntimeEvidenceRef[];
      readonly riskSignals: readonly RiskSignal[];
    };

export interface RuntimeProvider {
  readonly id: string;
  supports(node: ArtifactRef & { readonly kind: "node" }): boolean;
  invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome>;
  cancel?(invocationId: string, fencingToken: number): Promise<void>;
}

export interface RuntimeBrowserSessionResolver {
  getBrowserSession(
    binding: ResourceBindingRef
  ): ObservedBrowserSession | undefined | Promise<ObservedBrowserSession | undefined>;
}

/**
 * Dispatch adapter for resource-bound invocations. It rejects stale or
 * changed sessions before any provider code can observe the invocation.
 */
export class ResourceValidatedRuntimeDispatcher {
  constructor(
    private readonly registry: RuntimeProviderRegistry,
    private readonly sessions: RuntimeBrowserSessionResolver
  ) {}

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    const mappings = invocation.resourceMappings ?? {};
    const bindings = invocation.resourceBindings ?? {};
    for (const name of Object.keys(bindings)) {
      if (!mappings[name]) {
        return rejectedResourceOutcome(
          "RESOURCE_BINDING_UNEXPECTED",
          `Resource binding ${name} has no immutable Call mapping.`
        );
      }
    }
    for (const [name, mapping] of Object.entries(mappings)) {
      const resource = bindings[name];
      if (!resource) {
        return rejectedResourceOutcome(
          "RESOURCE_BINDING_MISSING",
          `Required resource binding ${name} is missing.`
        );
      }
      if (name !== resource.requirementName) {
        return rejectedResourceOutcome(
          "RESOURCE_BINDING_NAME_MISMATCH",
          `Resource binding key ${name} does not match ${resource.requirementName}.`
        );
      }
      if (
        mapping.requirementName !== resource.requirementName ||
        mapping.slotName !== resource.slotName ||
        mapping.requirementDigest !== resource.requirementDigest
      ) {
        return rejectedResourceOutcome(
          "RESOURCE_MAPPING_MISMATCH",
          `Resource binding ${name} differs from the immutable Call mapping.`
        );
      }
      const session = await this.sessions.getBrowserSession(
        resource.binding
      );
      if (!session) {
        return rejectedResourceOutcome(
          "RESOURCE_SESSION_MISSING",
          `Frozen browser session ${resource.binding.sessionId} is unavailable.`
        );
      }
      const issues = validateInvocationResourceBinding(resource, session);
      if (issues.length > 0) {
        return rejectedResourceOutcome(
          "RESOURCE_BINDING_INVALID",
          issues.map((issue) => `${issue.code}: ${issue.message}`).join(" "),
          issues.map((issue) => issue.code)
        );
      }
    }
    const provider = this.registry.resolve(
      invocation.providerId,
      invocation.node
    );
    return provider.invoke(invocation, signal);
  }
}

function rejectedResourceOutcome(
  code: string,
  message: string,
  issueCodes: readonly string[] = []
): RuntimeOutcome {
  return {
    status: "rejected",
    error: {
      code,
      message,
      retryable: false,
      details: { issueCodes }
    },
    evidence: [],
    riskSignals: []
  };
}

export class BuiltinRuntimeProvider implements RuntimeProvider {
  readonly id = "builtin";

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return SUPPORTED_BUILTIN_NODE_IDS.includes(
      node.id as SupportedBuiltinNodeId
    );
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) {
      return {
        status: "cancelled",
        error: {
          code: "CANCELLED",
          message: "Builtin invocation was cancelled before execution.",
          retryable: false
        },
        evidence: [],
        riskSignals: []
      };
    }
    const result = executeBuiltinNode({
      nodeId: invocation.node.id,
      nodeInput: invocation.input,
      workflowInput: invocation.input,
      previousOutput: invocation.input
    });
    return result.status === "succeeded"
      ? {
          status: "succeeded",
          output: (result.output ?? null) as JsonValue,
          evidence: [],
          riskSignals: []
        }
      : {
          status: "failed",
          error: result.error,
          ...(result.output === undefined
            ? {}
            : { output: result.output as JsonValue }),
          evidence: [],
          riskSignals: []
        };
  }
}

export class RuntimeProviderRegistry {
  readonly #providers = new Map<string, RuntimeProvider>();

  register(provider: RuntimeProvider): void {
    const id = provider.id.trim();
    if (id.length === 0) {
      throw new Error("Runtime provider id must not be empty");
    }
    if (this.#providers.has(id)) {
      throw new Error(`Runtime provider already registered: ${id}`);
    }
    this.#providers.set(id, provider);
  }

  get(providerId: string): RuntimeProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`Runtime provider is not registered: ${providerId}`);
    }
    return provider;
  }

  resolve(
    providerId: string,
    node: ArtifactRef & { readonly kind: "node" }
  ): RuntimeProvider {
    const provider = this.get(providerId);
    if (!provider.supports(node)) {
      throw new Error(
        `Runtime provider ${providerId} does not support ${node.id}@${node.version}`
      );
    }
    return provider;
  }

  list(): readonly string[] {
    return [...this.#providers.keys()].sort();
  }
}

export interface EffectiveTimingPolicy {
  readiness?: {
    timeoutMs: number;
    stableForMs: number;
    pollIntervalMs: number;
  };
  dispatchJitter?: {
    minMs: number;
    maxMs: number;
    distribution: "uniform";
  };
  retryBackoff?: {
    strategy: "fixed" | "exponential";
    baseMs: number;
    maxMs: number;
    jitterRatio: number;
  };
  rateLimit?: {
    scope: "domain" | "authentication_context" | "tab";
    minIntervalMs: number;
    maxQueueMs: number;
  };
}

export function mergeTimingPolicy(
  base?: TimingPolicy,
  override?: TimingPolicy
): EffectiveTimingPolicy | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base?.readiness || override?.readiness
      ? { readiness: { ...base?.readiness, ...override?.readiness } }
      : {}),
    ...(base?.dispatchJitter || override?.dispatchJitter
      ? {
          dispatchJitter: {
            ...base?.dispatchJitter,
            ...override?.dispatchJitter
          }
        }
      : {}),
    ...(base?.retryBackoff || override?.retryBackoff
      ? {
          retryBackoff: {
            ...base?.retryBackoff,
            ...override?.retryBackoff
          }
        }
      : {}),
    ...(base?.rateLimit || override?.rateLimit
      ? { rateLimit: { ...base?.rateLimit, ...override?.rateLimit } }
      : {})
  } as EffectiveTimingPolicy;
}

export function timingPolicyIssues(
  policy: EffectiveTimingPolicy | undefined,
  path = "/timing"
): string[] {
  if (!policy) return [];
  const issues: string[] = [];
  if (
    policy.readiness &&
    policy.readiness.stableForMs > policy.readiness.timeoutMs
  ) {
    issues.push(`${path}/readiness/stableForMs cannot exceed timeoutMs`);
  }
  if (
    policy.dispatchJitter &&
    policy.dispatchJitter.minMs > policy.dispatchJitter.maxMs
  ) {
    issues.push(`${path}/dispatchJitter/minMs cannot exceed maxMs`);
  }
  if (
    policy.retryBackoff &&
    policy.retryBackoff.baseMs > policy.retryBackoff.maxMs
  ) {
    issues.push(`${path}/retryBackoff/baseMs cannot exceed maxMs`);
  }
  return issues;
}

export function timingOverrideIssues(
  base: EffectiveTimingPolicy | undefined,
  resolved: EffectiveTimingPolicy | undefined,
  path: string
): string[] {
  if (!base || !resolved) return [];
  const issues: string[] = [];
  if (
    base.dispatchJitter &&
    resolved.dispatchJitter &&
    resolved.dispatchJitter.minMs < base.dispatchJitter.minMs
  ) {
    issues.push(
      `${path}/dispatchJitter/minMs cannot weaken the published node minimum`
    );
  }
  if (
    base.rateLimit &&
    resolved.rateLimit &&
    resolved.rateLimit.minIntervalMs < base.rateLimit.minIntervalMs
  ) {
    issues.push(
      `${path}/rateLimit/minIntervalMs cannot weaken the published node minimum`
    );
  }
  return issues;
}

export function deterministicFraction(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function computeDispatchDelayMs(
  policy: EffectiveTimingPolicy | undefined,
  seed: string
): number {
  const jitter = policy?.dispatchJitter;
  if (!jitter) return 0;
  const width = jitter.maxMs - jitter.minMs;
  return jitter.minMs + Math.floor(deterministicFraction(seed) * (width + 1));
}

export function computeRetryDelayMs(input: {
  policy?: EffectiveTimingPolicy | undefined;
  nextAttempt: number;
  seed: string;
  fallbackBaseMs?: number;
}): number {
  const configured = input.policy?.retryBackoff;
  const baseMs = configured?.baseMs ?? input.fallbackBaseMs ?? 0;
  const exponent =
    configured?.strategy === "exponential"
      ? Math.max(0, input.nextAttempt - 2)
      : 0;
  const uncapped = baseMs * 2 ** exponent;
  const capped = Math.min(
    uncapped,
    configured?.maxMs ?? Math.max(uncapped, baseMs)
  );
  const ratio = configured?.jitterRatio ?? 0;
  const factor =
    1 + (deterministicFraction(input.seed) * 2 - 1) * ratio;
  return Math.max(0, Math.round(capped * factor));
}

export type ReadinessState =
  | { state: "waiting" }
  | { state: "stabilizing"; stableForMs: number }
  | { state: "ready" }
  | { state: "timed_out" };

export class AdaptiveReadinessGate {
  readonly #startedAt: number;
  readonly #timeoutMs: number;
  readonly #stableForMs: number;
  #stableSince: number | undefined;
  #signature: string | undefined;

  constructor(input: {
    startedAt: number;
    timeoutMs: number;
    stableForMs: number;
  }) {
    this.#startedAt = input.startedAt;
    this.#timeoutMs = input.timeoutMs;
    this.#stableForMs = input.stableForMs;
  }

  observe(input: {
    at: number;
    ready: boolean;
    signature?: string;
  }): ReadinessState {
    if (input.at - this.#startedAt >= this.#timeoutMs) {
      return { state: "timed_out" };
    }
    if (!input.ready) {
      this.#stableSince = undefined;
      this.#signature = undefined;
      return { state: "waiting" };
    }
    const signature = input.signature ?? "ready";
    if (this.#signature !== signature || this.#stableSince === undefined) {
      this.#signature = signature;
      this.#stableSince = input.at;
    }
    const stableForMs = input.at - this.#stableSince;
    return stableForMs >= this.#stableForMs
      ? { state: "ready" }
      : { state: "stabilizing", stableForMs };
  }
}

export function reserveRateLimit(input: {
  now: number;
  lastExecutedAt?: number;
  deadline: number;
  policy?: EffectiveTimingPolicy | undefined;
}):
  | { accepted: true; executeAt: number; waitMs: number }
  | { accepted: false; reason: "RATE_LIMIT_QUEUE_EXCEEDED" | "DEADLINE_EXCEEDED" } {
  const limit = input.policy?.rateLimit;
  const executeAt = Math.max(
    input.now,
    (input.lastExecutedAt ?? 0) + (limit?.minIntervalMs ?? 0)
  );
  const waitMs = executeAt - input.now;
  if (executeAt >= input.deadline) {
    return { accepted: false, reason: "DEADLINE_EXCEEDED" };
  }
  if (limit && waitMs > limit.maxQueueMs) {
    return { accepted: false, reason: "RATE_LIMIT_QUEUE_EXCEEDED" };
  }
  return { accepted: true, executeAt, waitMs };
}

export function firstBlockingRiskSignal(
  signals: RiskSignal[]
): RiskSignal | undefined {
  return signals.find((signal) => signal.severity === "blocking");
}

export const SUPPORTED_BUILTIN_NODE_IDS = [
  "control.start",
  "control.succeed",
  "control.fail",
  "control.noop",
  "control.condition",
  "control.assert",
  "data.constant",
  "data.select",
  "data.merge"
] as const;

export type SupportedBuiltinNodeId =
  (typeof SUPPORTED_BUILTIN_NODE_IDS)[number];

export interface BindingContext {
  input: unknown;
  previous: unknown;
}

const BINDING_PATTERN =
  /^\$\{(input|previous)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}$/;
const SAFE_PATH_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function readPath(root: unknown, path: string): unknown {
  if (!path) return root;
  if (!SAFE_PATH_PATTERN.test(path)) {
    throw new Error(`Unsafe or unsupported data path: ${path}`);
  }
  let current = root;
  for (const segment of path.split(".")) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw new Error(`Forbidden data path segment: ${segment}`);
    }
    current =
      current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return current;
}

export function resolveBindings(
  value: unknown,
  context: BindingContext,
  depth = 0
): unknown {
  if (depth > 50) throw new Error("Binding input exceeds maximum depth");
  if (typeof value === "string") {
    const binding = BINDING_PATTERN.exec(value);
    if (binding) {
      const root = binding[1] === "input" ? context.input : context.previous;
      const path = (binding[2] ?? "").replace(/^\./, "");
      return cloneJsonValue(readPath(root, path));
    }
    if (value.includes("${")) {
      throw new Error(
        `Unsupported binding expression: ${value}. Only exact \${input.path} and \${previous.path} references are allowed.`
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveBindings(entry, context, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`Forbidden object key: ${key}`);
      }
      resolved[key] = resolveBindings(entry, context, depth + 1);
    }
    return resolved;
  }
  return value;
}

export function evaluateConditionExpression(
  expression: string,
  context: BindingContext
): boolean {
  const match =
    /^(input|previous)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(==|!=)\s*(.+)$/.exec(
      expression
    );
  if (!match) throw new Error(`Unsupported condition: ${expression}`);
  const root = match[1] === "input" ? context.input : context.previous;
  const path = (match[2] ?? "").replace(/^\./, "");
  const actual = readPath(root, path);
  const expected = JSON.parse(match[4]!);
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  return match[3] === "==" ? equal : !equal;
}

export type BuiltinExecutionResult =
  | { status: "succeeded"; output: unknown; branch?: "success" | "failure" }
  | {
      status: "failed";
      output?: unknown;
      error: { code: string; message: string; retryable: false };
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function executeBuiltinNode(input: {
  nodeId: string;
  nodeInput: unknown;
  workflowInput: unknown;
  previousOutput: unknown;
  condition?: string;
}): BuiltinExecutionResult {
  if (
    !SUPPORTED_BUILTIN_NODE_IDS.includes(
      input.nodeId as SupportedBuiltinNodeId
    )
  ) {
    return {
      status: "failed",
      error: {
        code: "BUILTIN_NOT_SUPPORTED",
        message: `Unknown builtin node: ${input.nodeId}`,
        retryable: false
      }
    };
  }
  const nodeInput = asRecord(input.nodeInput);
  switch (input.nodeId as SupportedBuiltinNodeId) {
    case "control.start":
      return { status: "succeeded", output: cloneJsonValue(input.workflowInput) };
    case "control.succeed":
      return {
        status: "succeeded",
        output: Object.hasOwn(nodeInput, "output")
          ? cloneJsonValue(nodeInput.output)
          : cloneJsonValue(input.previousOutput) ?? {}
      };
    case "control.fail":
      return {
        status: "failed",
        output: {
          code:
            typeof nodeInput.code === "string"
              ? nodeInput.code
              : "WORKFLOW_FAILED",
          ...(Object.hasOwn(nodeInput, "details")
            ? { details: cloneJsonValue(nodeInput.details) }
            : {})
        },
        error: {
          code: "WORKFLOW_FAILED",
          message:
            typeof nodeInput.message === "string"
              ? nodeInput.message
              : "Workflow reached an explicit failure node.",
          retryable: false
        }
      };
    case "control.noop":
      return {
        status: "succeeded",
        output: Object.hasOwn(nodeInput, "value")
          ? cloneJsonValue(nodeInput.value)
          : cloneJsonValue(input.previousOutput) ?? {}
      };
    case "control.condition": {
      if (!input.condition) {
        return {
          status: "failed",
          error: {
            code: "CONDITION_INVALID",
            message: "control.condition requires a condition expression.",
            retryable: false
          }
        };
      }
      const matched = evaluateConditionExpression(input.condition, {
        input: input.workflowInput,
        previous: input.previousOutput
      });
      return {
        status: "succeeded",
        output: { matched },
        branch: matched ? "success" : "failure"
      };
    }
    case "control.assert": {
      if (!input.condition) {
        return {
          status: "failed",
          error: {
            code: "ASSERTION_INVALID",
            message: "control.assert requires a condition expression.",
            retryable: false
          }
        };
      }
      const matched = evaluateConditionExpression(input.condition, {
        input: input.workflowInput,
        previous: input.previousOutput
      });
      return matched
        ? {
            status: "succeeded",
            output: cloneJsonValue(input.previousOutput) ?? {}
          }
        : {
            status: "failed",
            error: {
              code: "ASSERTION_FAILED",
              message:
                typeof nodeInput.message === "string"
                  ? nodeInput.message
                  : "Workflow assertion failed.",
              retryable: false
            }
          };
    }
    case "data.constant":
      return {
        status: "succeeded",
        output: cloneJsonValue(nodeInput.value)
      };
    case "data.select": {
      const source = nodeInput.source;
      const path = typeof nodeInput.path === "string" ? nodeInput.path : "";
      const selected = readPath(source, path);
      if (selected === undefined) {
        if (Object.hasOwn(nodeInput, "default")) {
          return {
            status: "succeeded",
            output: cloneJsonValue(nodeInput.default)
          };
        }
        if (nodeInput.required === true) {
          return {
            status: "failed",
            error: {
              code: "VALUE_NOT_FOUND",
              message: `Required value was not found at path: ${path}`,
              retryable: false
            }
          };
        }
      }
      return { status: "succeeded", output: cloneJsonValue(selected) };
    }
    case "data.merge": {
      const values = Array.isArray(nodeInput.values) ? nodeInput.values : [];
      const output: Record<string, unknown> = {};
      for (const value of values) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return {
            status: "failed",
            error: {
              code: "MERGE_INPUT_INVALID",
              message: "data.merge accepts objects only.",
              retryable: false
            }
          };
        }
        for (const [key, entry] of Object.entries(
          value as Record<string, unknown>
        )) {
          if (FORBIDDEN_KEYS.has(key)) {
            return {
              status: "failed",
              error: {
                code: "MERGE_KEY_FORBIDDEN",
                message: `data.merge rejected forbidden key: ${key}`,
                retryable: false
              }
            };
          }
          output[key] = cloneJsonValue(entry);
        }
      }
      return { status: "succeeded", output };
    }
  }
}
