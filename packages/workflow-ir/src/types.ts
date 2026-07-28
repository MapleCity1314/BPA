export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type StepKey = string;
export type IterationKey = string;

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

export type ArtifactKind =
  | "node"
  | "adapter"
  | "policy"
  | "assistance_profile"
  | "dataset_profile";

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
}

export interface RiskSnapshotEntry {
  readonly code: string;
  readonly level: "R0" | "R1" | "R2" | "R3";
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

export interface CallStep extends StepBase {
  readonly kind: "call";
  readonly node: ArtifactRef & { readonly kind: "node" };
  readonly input?: BindingValue;
  readonly next?: StepKey;
  readonly onError?: StepKey;
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
  readonly mode: "collect";
  readonly outputKey: string;
  readonly include: "succeeded" | "all";
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
  readonly body: ExecutionBlock;
  readonly aggregation: ForeachAggregation;
  readonly next?: StepKey;
  readonly onError?: StepKey;
}

export type AssistanceTaskKind =
  | "ai_review"
  | "human_confirm"
  | "human_action";

export interface WaitAssistanceStep extends StepBase {
  readonly kind: "wait.assistance";
  readonly taskKind: AssistanceTaskKind;
  readonly profile: ArtifactRef & { readonly kind: "assistance_profile" };
  readonly input?: BindingValue;
  readonly onResolved: StepKey;
  readonly onEscalated?: StepKey;
  readonly onExpired?: StepKey;
}

export interface TerminalStep extends StepBase {
  readonly kind: "terminal";
  readonly status: "succeeded" | "failed" | "cancelled" | "uncertain";
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
  readonly irVersion: "2.0";
  readonly workflow: WorkflowRef;
  readonly artifactClosure: ArtifactClosure;
  readonly riskSnapshot: readonly RiskSnapshotEntry[];
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
