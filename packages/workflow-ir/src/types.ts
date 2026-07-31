export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type StepKey = string;
export type IterationKey = string;
export const WORKFLOW_IR_VERSION = "bpa.workflow-ir/2" as const;

export interface ScopeSegment {
  readonly foreachStepKey: StepKey;
  readonly itemKey: IterationKey;
}

export type ScopePath = readonly ScopeSegment[];

export interface ExecutionIdentity {
  readonly runId: string;
  readonly scopePath: ScopePath;
  readonly iterationKey: IterationKey;
  readonly stepKey: StepKey;
  readonly attempt: number;
}

export const ARTIFACT_KINDS = [
  "node",
  "adapter",
  "policy",
  "assistance_profile",
  "dataset_profile"
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ArtifactClosure {
  /**
   * The complete immutable set of assets required to resume this plan.
   * Entries are normalized into kind/id/version/digest order.
   */
  readonly entries: readonly ArtifactRef[];
}

export interface WorkflowRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ExecutionLimits {
  readonly maxDepth: number;
  readonly maxStepExecutions: number;
}

export interface ForeachLimits extends ExecutionLimits {
  readonly maxItems: number;
  readonly maxDurationMs: number;
}

export interface RiskSnapshotEntry {
  readonly code: string;
  readonly level: "R0" | "R1" | "R2" | "R3" | "R4";
  readonly source: ArtifactRef;
  readonly details?: JsonValue;
}

export interface ValueReference {
  readonly kind: "reference";
  readonly source:
    | "run_input"
    | "previous_output"
    | "scope_item"
    | "step_output";
  readonly path: readonly string[];
  readonly stepKey?: StepKey;
}

export interface LiteralBinding {
  readonly kind: "literal";
  readonly value: JsonValue;
}

export interface ObjectBinding {
  readonly kind: "object";
  readonly entries: Readonly<Record<string, BindingValue>>;
}

export interface ArrayBinding {
  readonly kind: "array";
  readonly items: readonly BindingValue[];
}

export type BindingValue =
  | ValueReference
  | LiteralBinding
  | ObjectBinding
  | ArrayBinding;

export type ComparisonOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "contains"
  | "exists";

export interface CompareCondition {
  readonly kind: "compare";
  readonly operator: ComparisonOperator;
  readonly left: BindingValue;
  readonly right?: BindingValue;
}

export interface AllCondition {
  readonly kind: "all";
  readonly conditions: readonly Condition[];
}

export interface AnyCondition {
  readonly kind: "any";
  readonly conditions: readonly Condition[];
}

export interface NotCondition {
  readonly kind: "not";
  readonly condition: Condition;
}

export type Condition =
  | CompareCondition
  | AllCondition
  | AnyCondition
  | NotCondition;

export interface StepBase {
  readonly key: StepKey;
}

export interface ResolvedRetryPolicy {
  /** Includes the first attempt. */
  readonly maxAttempts: number;
  readonly retryableOutcomes: readonly (
    | "failed"
    | "timed_out"
    | "rejected"
  )[];
  readonly retryableErrorCodes: readonly string[];
  readonly backoff: {
    readonly strategy: "fixed" | "exponential";
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
  };
}

export interface ResolvedTimingPolicy {
  readonly readiness?: {
    readonly timeoutMs: number;
    readonly stableForMs: number;
    readonly pollIntervalMs: number;
  };
  readonly dispatchJitter?: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly distribution: "uniform";
  };
  readonly rateLimit?: {
    readonly scope: "domain" | "authentication_context" | "tab";
    readonly minIntervalMs: number;
    readonly maxQueueMs: number;
  };
}

export interface CallDependencies {
  readonly adapters: readonly (ArtifactRef & {
    readonly kind: "adapter";
  })[];
  readonly policies: readonly (ArtifactRef & {
    readonly kind: "policy";
  })[];
  readonly datasetProfiles: readonly (ArtifactRef & {
    readonly kind: "dataset_profile";
  })[];
}

export interface CallRoutes {
  readonly succeeded: StepKey;
  readonly failed: StepKey;
  readonly timed_out: StepKey;
  readonly rejected: StepKey;
  readonly cancelled: StepKey;
  readonly uncertain: StepKey;
}

export interface RuntimeNodeSchemaContract {
  /** Binds the copied Schemas to the exact immutable Node artifact. */
  readonly nodeDigest: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly inputSchemaDigest: string;
  readonly outputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchemaDigest: string;
}

export interface PermissionSnapshot {
  readonly riskLevel: "R0" | "R1" | "R2" | "R3" | "R4";
  readonly permissions: readonly string[];
  readonly domains: readonly string[];
  /** Digest of an optional user-approved grant captured at Run creation. */
  readonly grantDigest?: string;
}

export type ResourceAuthentication =
  | "anonymous"
  | "optional"
  | "authenticated"
  | "membership";

export interface BrowserResourceRequirementSnapshot {
  readonly kind: "browser";
  readonly capabilities: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly authentication: ResourceAuthentication;
  readonly purpose: string;
}

export interface ResourceSlotMappingSnapshot {
  /** Name declared by the immutable Node asset. */
  readonly requirementName: string;
  /** Name declared by the immutable Workflow asset. */
  readonly slotName: string;
  /** Exact Node requirement copied into the plan at compilation time. */
  readonly requirement: BrowserResourceRequirementSnapshot;
  readonly requirementDigest: string;
}

export interface ResourceBindingRef {
  readonly bindingId: string;
  /** Exact per-tab observation revision frozen for this Run. */
  readonly revision: number;
  readonly slotName: string;
  readonly sessionId: string;
  readonly browserInstanceId: string;
  readonly tabId: number;
  readonly windowId?: number;
  readonly capabilityDigest: string;
  readonly origin: string;
  readonly pathname: string;
  readonly pageEpoch: string;
  readonly observerCapabilityId?: string;
  readonly authentication: ResourceAuthentication;
  readonly authenticationContextRef?: string;
  readonly frozenAt: number;
  readonly approvedBy: string;
}

export interface ResourceBindingSnapshot {
  readonly snapshotVersion: "bpa.resource-binding/1";
  readonly runId: string;
  readonly resourceSlots: Readonly<
    Record<string, BrowserResourceRequirementSnapshot>
  >;
  readonly bindings: Readonly<Record<string, ResourceBindingRef>>;
}

export interface InvocationResourceBinding {
  readonly requirementName: string;
  readonly slotName: string;
  readonly requirement: BrowserResourceRequirementSnapshot;
  readonly requirementDigest: string;
  /** Immutable reference copied from the Run-level binding snapshot. */
  readonly binding: ResourceBindingRef;
}

export interface CallStep extends StepBase {
  readonly kind: "call";
  readonly node: ArtifactRef & { readonly kind: "node" };
  /**
   * New compilers always freeze this contract. It remains optional only so
   * persisted pre-contract IR2 plans can recover through exact Node backfill.
   */
  readonly schemaContract?: RuntimeNodeSchemaContract;
  readonly providerId: string;
  readonly permissionSnapshot: PermissionSnapshot;
  readonly resourceRequirements?: Readonly<
    Record<string, BrowserResourceRequirementSnapshot>
  >;
  readonly resourceMappings?: Readonly<
    Record<string, ResourceSlotMappingSnapshot>
  >;
  readonly dependencies: CallDependencies;
  readonly timeoutMs: number;
  readonly retry: ResolvedRetryPolicy;
  readonly timing: ResolvedTimingPolicy;
  readonly input?: BindingValue;
  readonly routes: CallRoutes;
}

export interface DecisionBranch {
  readonly id: string;
  readonly condition: Condition;
  readonly target: StepKey;
}

export interface DecisionStep extends StepBase {
  readonly kind: "decision";
  /** Branch order is significant and is never changed by normalization. */
  readonly branches: readonly DecisionBranch[];
  readonly defaultTarget: StepKey;
}

export interface ItemKeySpec {
  /**
   * A stable path within the item. An empty path identifies a primitive item.
   * Array indexes and iteration indexes are intentionally unsupported.
   */
  readonly path: readonly string[];
  readonly valueType: "string" | "number";
}

export interface ForeachAggregation {
  readonly mode: "outcome_summary";
  readonly outputKey: string;
}

export interface ForeachOutcomeItem<TOutput extends JsonValue = JsonValue> {
  readonly itemKey: IterationKey;
  readonly output?: TOutput;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ForeachOutcomeBucket<
  TOutput extends JsonValue = JsonValue
> {
  readonly count: number;
  readonly items: readonly ForeachOutcomeItem<TOutput>[];
}

/**
 * The aggregation shape is fixed so downstream bindings never confuse
 * unresolved assistance with a product failure.
 */
export interface ForeachAggregationResult<
  TOutput extends JsonValue = JsonValue
> {
  readonly total: number;
  readonly succeeded: ForeachOutcomeBucket<TOutput>;
  readonly failed: ForeachOutcomeBucket<TOutput>;
  readonly unresolved: ForeachOutcomeBucket<TOutput>;
}

export interface ForeachRoutes {
  readonly completed: StepKey;
  readonly stopped: StepKey;
  /** Must target an `uncertain` terminal directly. */
  readonly uncertain: StepKey;
}

export interface ExecutionBlock {
  readonly entry: StepKey;
  readonly steps: Readonly<Record<StepKey, ExecutionStep>>;
}

export interface ForeachStep extends StepBase {
  readonly kind: "foreach";
  readonly items: BindingValue;
  readonly itemKey: ItemKeySpec;
  readonly limits: ForeachLimits;
  readonly onItemError: "stop" | "collect";
  readonly body: ExecutionBlock;
  readonly aggregation: ForeachAggregation;
  readonly routes: ForeachRoutes;
}

export type AssistanceTaskKind =
  | "ai_review"
  | "human_confirm"
  | "human_action";

export type AssistanceUnavailableAction =
  | "continue_unresolved"
  | "human_action"
  | "fail";

export interface AssistanceStepBase extends StepBase {
  readonly kind: "wait.assistance";
  readonly taskKind: AssistanceTaskKind;
  readonly profile: ArtifactRef & { readonly kind: "assistance_profile" };
  /** Relative duration from task creation; no wall clock is generated by IR. */
  readonly deadlineMs: number;
  readonly onUnavailable: AssistanceUnavailableAction;
  readonly input?: BindingValue;
}

export interface BlockingAssistanceStep extends AssistanceStepBase {
  readonly blocking: true;
  readonly routes: {
    readonly resolved: StepKey;
    readonly escalated: StepKey;
    readonly expired: StepKey;
    readonly unavailable: StepKey;
  };
}

export interface DetachedAssistanceStep extends AssistanceStepBase {
  readonly blocking: false;
  /**
   * Detached tasks never pause or route a Run based on task completion.
   * The Run advances to `next` immediately after durable task creation.
   */
  readonly next: StepKey;
}

export type WaitAssistanceStep =
  | BlockingAssistanceStep
  | DetachedAssistanceStep;

export interface TerminalStep extends StepBase {
  readonly kind: "terminal";
  /**
   * At plan scope this is a Run outcome (`unresolved` is invalid). Within a
   * foreach body it is an item outcome (`cancelled` is invalid).
   */
  readonly status:
    | "succeeded"
    | "failed"
    | "unresolved"
    | "cancelled"
    | "uncertain";
  readonly output?: BindingValue;
  readonly errorCode?: string;
}

export type ExecutionStep =
  | CallStep
  | DecisionStep
  | ForeachStep
  | WaitAssistanceStep
  | TerminalStep;

export interface ExecutionPlan {
  readonly irVersion: typeof WORKFLOW_IR_VERSION;
  readonly workflow: WorkflowRef;
  readonly artifactClosure: ArtifactClosure;
  readonly riskSnapshot: readonly RiskSnapshotEntry[];
  readonly resourceSlots?: Readonly<
    Record<string, BrowserResourceRequirementSnapshot>
  >;
  readonly limits: ExecutionLimits;
  readonly entry: StepKey;
  readonly steps: Readonly<Record<StepKey, ExecutionStep>>;
}

export interface ValidationIssue {
  readonly code:
    | "INVALID_VALUE"
    | "INVALID_STEP"
    | "MISSING_TARGET"
    | "BACK_EDGE"
    | "UNREACHABLE_STEP"
    | "DUPLICATE_ARTIFACT"
    | "ARTIFACT_NOT_CLOSED"
    | "LIMIT_EXCEEDED"
    | "UNSUPPORTED_STEP_KIND";
  readonly path: string;
  readonly message: string;
}
