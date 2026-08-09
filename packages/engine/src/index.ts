import type {
  RuntimeInvocation,
  RuntimeOutcome
} from "@bpa/node-runtime";
import {
  appendScope,
  executionIdentityKey,
  type BindingValue,
  type CallStep,
  type Condition,
  type ExecutionBlock,
  type ExecutionIdentity,
  type ExecutionPlan,
  type ForeachAggregationResult,
  type ForeachStep,
  type JsonValue,
  type ScopePath,
  type TerminalStep,
  type WaitAssistanceStep
} from "@bpa/workflow-ir";

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(kind: "invocation" | "trace" | "assistance"): string;
}

export interface RandomSource {
  next(): number;
}

export interface EngineDependencies {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly random: RandomSource;
}

export interface Cursor {
  readonly blockPath: readonly string[];
  readonly stepKey: string;
}

export interface ForeachFrame {
  readonly stepKey: string;
  readonly parentBlockPath: readonly string[];
  readonly items: readonly JsonValue[];
  readonly itemKeys: readonly string[];
  readonly index: number;
  readonly startedAt: number;
  readonly succeeded: ForeachAggregationResult["succeeded"]["items"];
  readonly failed: ForeachAggregationResult["failed"]["items"];
  readonly unresolved: ForeachAggregationResult["unresolved"]["items"];
}

export interface ActiveCall {
  readonly kind: "call";
  readonly invocation: RuntimeInvocation;
  readonly notBefore: number;
}

export interface AssistanceRequest {
  readonly taskId: string;
  readonly identity: ExecutionIdentity;
  readonly taskKind: WaitAssistanceStep["taskKind"];
  readonly profile: WaitAssistanceStep["profile"];
  readonly input: JsonValue;
  readonly blocking: boolean;
  readonly deadlineAt: number;
  readonly onUnavailable: WaitAssistanceStep["onUnavailable"];
  readonly fencingToken: number;
}

export interface ActiveAssistance {
  readonly kind: "assistance";
  readonly request: AssistanceRequest;
}

export interface TimerRequest {
  readonly timerId: string;
  readonly identity: ExecutionIdentity;
  readonly wakeAt: number;
  readonly fencingToken: number;
  readonly signal: {
    readonly kind: "assistance.expired";
    readonly taskId: string;
  };
}

export type ActiveExternal = ActiveCall | ActiveAssistance;

export type EngineStatus =
  | "running"
  | "waiting_runtime"
  | "waiting_assistance"
  | "succeeded"
  | "rejected"
  | "failed"
  | "cancelled"
  | "uncertain";

/**
 * Fully serializable interpreter state. The plan itself is persisted separately
 * as the immutable Run plan snapshot.
 */
export interface EngineState {
  readonly stateVersion: "bpa.engine-state/2";
  readonly runId: string;
  readonly workflowDigest: string;
  readonly status: EngineStatus;
  readonly revision: number;
  readonly input: JsonValue;
  readonly cursor: Cursor | undefined;
  readonly previousOutput: JsonValue;
  readonly stepOutputs: Readonly<Record<string, JsonValue>>;
  readonly foreachStack: readonly ForeachFrame[];
  readonly active: ActiveExternal | undefined;
  readonly completedExternalIds: readonly string[];
  readonly output: JsonValue | undefined;
  readonly error:
    | { readonly code: string; readonly message: string }
    | undefined;
}

export type EngineEffect =
  | {
      readonly kind: "runtime.invoke";
      readonly invocation: RuntimeInvocation;
      readonly notBefore: number;
    }
  | {
      readonly kind: "assistance.create";
      readonly request: AssistanceRequest;
    }
  | {
      readonly kind: "timer.schedule";
      readonly timer: TimerRequest;
    };

export interface EngineTransition {
  readonly state: EngineState;
  readonly effects: readonly EngineEffect[];
  readonly disposition: "advanced" | "duplicate" | "stale";
}

export type AssistanceOutcome =
  | { readonly status: "resolved"; readonly output: JsonValue }
  | {
      readonly status: "escalated" | "expired" | "unavailable";
      readonly output?: JsonValue;
    };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function valueAtPath(value: JsonValue, path: readonly string[]): JsonValue {
  let current: JsonValue = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      throw new Error(`Binding path does not exist: ${path.join(".")}`);
    }
    current = (current as Readonly<Record<string, JsonValue>>)[segment]!;
  }
  return clone(current);
}

function scopeKey(scopePath: ScopePath): string {
  return JSON.stringify(
    scopePath.map((segment) => [segment.foreachStepKey, segment.itemKey])
  );
}

function outputKey(scopePath: ScopePath, stepKey: string): string {
  return `${scopeKey(scopePath)}:${stepKey}`;
}

function scopeFromOutputKey(key: string): ScopePath | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < key.length; index += 1) {
    const character = key[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[") depth += 1;
    if (character !== "]") continue;
    depth -= 1;
    if (depth !== 0 || key[index + 1] !== ":") continue;
    try {
      const parsed = JSON.parse(key.slice(0, index + 1)) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (segment) =>
            !Array.isArray(segment) ||
            segment.length !== 2 ||
            typeof segment[0] !== "string" ||
            typeof segment[1] !== "string"
        )
      ) {
        return undefined;
      }
      return parsed.map((segment) => ({
        foreachStepKey: segment[0] as string,
        itemKey: segment[1] as string
      }));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scopeStartsWith(scope: ScopePath, prefix: ScopePath): boolean {
  return (
    scope.length >= prefix.length &&
    prefix.every(
      (segment, index) =>
        scope[index]?.foreachStepKey === segment.foreachStepKey &&
        scope[index]?.itemKey === segment.itemKey
    )
  );
}

function withoutCompletedScopeOutputs(
  outputs: EngineState["stepOutputs"],
  completedScope: ScopePath
): EngineState["stepOutputs"] {
  return Object.fromEntries(
    Object.entries(outputs).filter(([key]) => {
      const scope = scopeFromOutputKey(key);
      return !scope || !scopeStartsWith(scope, completedScope);
    })
  );
}

function currentScope(state: EngineState): ScopePath {
  let scope: ScopePath = [];
  for (const frame of state.foreachStack) {
    scope = appendScope(scope, frame.stepKey, frame.itemKeys[frame.index]!);
  }
  return scope;
}

function currentItem(state: EngineState): JsonValue {
  const frame = state.foreachStack.at(-1);
  if (!frame) throw new Error("scope_item binding used outside foreach");
  return clone(frame.items[frame.index]!);
}

function resolveReference(
  binding: Extract<BindingValue, { kind: "reference" }>,
  state: EngineState
): JsonValue {
  if (binding.source === "run_input") {
    return valueAtPath(state.input, binding.path);
  }
  if (binding.source === "previous_output") {
    return valueAtPath(state.previousOutput, binding.path);
  }
  if (binding.source === "scope_item") {
    return valueAtPath(currentItem(state), binding.path);
  }
  const scope = [...currentScope(state)];
  while (true) {
    const value = state.stepOutputs[outputKey(scope, binding.stepKey!)];
    if (value !== undefined) return valueAtPath(value, binding.path);
    if (scope.length === 0) break;
    scope.pop();
  }
  throw new Error(`Step output is unavailable: ${binding.stepKey}`);
}

export function resolveBinding(
  binding: BindingValue,
  state: EngineState
): JsonValue {
  switch (binding.kind) {
    case "literal":
      return clone(binding.value);
    case "reference":
      return resolveReference(binding, state);
    case "array":
      return binding.items.map((item) => resolveBinding(item, state));
    case "object":
      return Object.fromEntries(
        Object.entries(binding.entries).map(([key, value]) => [
          key,
          resolveBinding(value, state)
        ])
      );
  }
}

function compare(
  operator: Extract<Condition, { kind: "compare" }>["operator"],
  left: JsonValue,
  right: JsonValue | undefined
): boolean {
  switch (operator) {
    case "exists":
      return left !== null;
    case "equals":
      return JSON.stringify(left) === JSON.stringify(right);
    case "not_equals":
      return JSON.stringify(left) !== JSON.stringify(right);
    case "greater_than":
      return typeof left === "number" &&
        typeof right === "number" &&
        left > right;
    case "greater_than_or_equal":
      return typeof left === "number" &&
        typeof right === "number" &&
        left >= right;
    case "less_than":
      return typeof left === "number" &&
        typeof right === "number" &&
        left < right;
    case "less_than_or_equal":
      return typeof left === "number" &&
        typeof right === "number" &&
        left <= right;
    case "contains":
      return typeof left === "string" && typeof right === "string"
        ? left.includes(right)
        : Array.isArray(left)
          ? left.some(
              (item) => JSON.stringify(item) === JSON.stringify(right)
            )
          : false;
  }
}

export function evaluateCondition(
  condition: Condition,
  state: EngineState
): boolean {
  switch (condition.kind) {
    case "compare":
      return compare(
        condition.operator,
        resolveBinding(condition.left, state),
        condition.right
          ? resolveBinding(condition.right, state)
          : undefined
      );
    case "all":
      return condition.conditions.every((entry) =>
        evaluateCondition(entry, state)
      );
    case "any":
      return condition.conditions.some((entry) =>
        evaluateCondition(entry, state)
      );
    case "not":
      return !evaluateCondition(condition.condition, state);
  }
}

function blockAt(plan: ExecutionPlan, path: readonly string[]): ExecutionBlock {
  let block: ExecutionBlock = { entry: plan.entry, steps: plan.steps };
  for (const foreachKey of path) {
    const step = block.steps[foreachKey];
    if (step?.kind !== "foreach") {
      throw new Error(`Foreach block not found: ${foreachKey}`);
    }
    block = step.body;
  }
  return block;
}

function immutableState(
  state: Omit<EngineState, "revision">,
  previousRevision: number
): EngineState {
  return clone({ ...state, revision: previousRevision + 1 });
}

function executionIdentity(
  state: EngineState,
  stepKey: string,
  attempt: number
): ExecutionIdentity {
  const scopePath = currentScope(state);
  return {
    runId: state.runId,
    scopePath,
    iterationKey: scopePath.at(-1)?.itemKey ?? "root",
    stepKey,
    attempt
  };
}

function retryDelay(
  step: CallStep,
  attempt: number,
  random: number
): number {
  const exponent =
    step.retry.backoff.strategy === "exponential"
      ? Math.max(0, attempt - 2)
      : 0;
  const uncapped = step.retry.backoff.baseDelayMs * 2 ** exponent;
  const capped = Math.min(uncapped, step.retry.backoff.maxDelayMs);
  const jitter =
    1 + (random * 2 - 1) * step.retry.backoff.jitterRatio;
  return Math.max(0, Math.round(capped * jitter));
}

function scheduleCall(
  plan: ExecutionPlan,
  state: EngineState,
  step: CallStep,
  attempt: number,
  fencingToken: number,
  notBefore: number,
  deps: EngineDependencies
): EngineTransition {
  const identity = executionIdentity(state, step.key, attempt);
  const foreachDeadline = earliestForeachDeadline(plan, state);
  const invocation: RuntimeInvocation = {
    invocationId: deps.ids.next("invocation"),
    identity,
    node: step.node,
    ...(step.schemaContract
      ? { schemaContract: step.schemaContract }
      : {}),
    providerId: step.providerId,
    input: step.input ? resolveBinding(step.input, state) : {},
    permissionSnapshot: step.permissionSnapshot,
    ...(step.resourceMappings
      ? { resourceMappings: clone(step.resourceMappings) }
      : {}),
    deadlineAt: Math.min(
      notBefore + step.timeoutMs,
      foreachDeadline?.deadlineAt ?? Number.POSITIVE_INFINITY
    ),
    idempotencyKey: executionIdentityKey(identity),
    fencingToken,
    traceId: deps.ids.next("trace")
  };
  const nextState = immutableState(
    {
      ...state,
      status: "waiting_runtime",
      active: { kind: "call", invocation, notBefore }
    },
    state.revision
  );
  return {
    state: nextState,
    effects: [{ kind: "runtime.invoke", invocation, notBefore }],
    disposition: "advanced"
  };
}

function assistanceRequest(
  state: EngineState,
  step: WaitAssistanceStep,
  deps: EngineDependencies
): AssistanceRequest {
  return {
    taskId: deps.ids.next("assistance"),
    identity: executionIdentity(state, step.key, 1),
    taskKind: step.taskKind,
    profile: step.profile,
    input: step.input ? resolveBinding(step.input, state) : {},
    blocking: step.blocking,
    deadlineAt: deps.clock.now() + step.deadlineMs,
    onUnavailable: step.onUnavailable,
    fencingToken: 1
  };
}

export function assistanceDeadlineTimerId(taskId: string): string {
  return `${taskId}.deadline`;
}

function assistanceDeadlineTimer(request: AssistanceRequest): TimerRequest {
  return {
    timerId: assistanceDeadlineTimerId(request.taskId),
    identity: request.identity,
    wakeAt: request.deadlineAt,
    fencingToken: request.fencingToken,
    signal: {
      kind: "assistance.expired",
      taskId: request.taskId
    }
  };
}

function itemKey(item: JsonValue, step: ForeachStep): string {
  const value = valueAtPath(item, step.itemKey.path);
  if (
    (step.itemKey.valueType === "string" && typeof value !== "string") ||
    (step.itemKey.valueType === "number" && typeof value !== "number")
  ) {
    throw new Error(`foreach ${step.key} itemKey has the wrong value type`);
  }
  return String(value);
}

function aggregate(frame: ForeachFrame): ForeachAggregationResult {
  return {
    total: frame.items.length,
    succeeded: {
      count: frame.succeeded.length,
      items: frame.succeeded
    },
    failed: { count: frame.failed.length, items: frame.failed },
    unresolved: {
      count: frame.unresolved.length,
      items: frame.unresolved
    }
  };
}

interface ForeachDeadline {
  readonly frameIndex: number;
  readonly deadlineAt: number;
}

function earliestForeachDeadline(
  plan: ExecutionPlan,
  state: EngineState
): ForeachDeadline | undefined {
  let earliest: ForeachDeadline | undefined;
  state.foreachStack.forEach((frame, frameIndex) => {
    const block = blockAt(plan, frame.parentBlockPath);
    const foreach = block.steps[frame.stepKey];
    if (foreach?.kind !== "foreach") {
      throw new Error(`Foreach frame step not found: ${frame.stepKey}`);
    }
    const deadlineAt = frame.startedAt + foreach.limits.maxDurationMs;
    if (!earliest || deadlineAt < earliest.deadlineAt) {
      earliest = { frameIndex, deadlineAt };
    }
  });
  return earliest;
}

function failState(
  state: EngineState,
  code: string,
  message: string
): EngineState {
  return immutableState(
    {
      ...state,
      status: "failed",
      cursor: undefined,
      active: undefined,
      error: { code, message }
    },
    state.revision
  );
}

function stopForeachAtDeadline(
  plan: ExecutionPlan,
  state: EngineState,
  frameIndex: number,
  deps: EngineDependencies
): EngineTransition {
  const frame = state.foreachStack[frameIndex];
  if (!frame) throw new Error(`Foreach frame not found at index ${frameIndex}`);
  const block = blockAt(plan, frame.parentBlockPath);
  const foreach = block.steps[frame.stepKey];
  if (foreach?.kind !== "foreach") {
    throw new Error(`Foreach frame step not found: ${frame.stepKey}`);
  }
  return drive(
    plan,
    immutableState(
      {
        ...state,
        status: "running",
        cursor: {
          blockPath: frame.parentBlockPath,
          stepKey: foreach.routes.stopped
        },
        foreachStack: state.foreachStack.slice(0, frameIndex),
        active: undefined,
        previousOutput: aggregate(frame) as unknown as JsonValue
      },
      state.revision
    ),
    deps
  );
}

function completeItem(
  plan: ExecutionPlan,
  state: EngineState,
  terminal: TerminalStep,
  deps: EngineDependencies
): EngineTransition {
  const completedScope = currentScope(state);
  const retainedStepOutputs = withoutCompletedScopeOutputs(
    state.stepOutputs,
    completedScope
  );
  if (terminal.status === "rejected" || terminal.status === "uncertain") {
    const rejected = terminal.status === "rejected";
    const terminalOutput = terminal.output
      ? resolveBinding(terminal.output,state)
      : undefined;
    return {
      state: immutableState(
        {
          ...state,
          status: terminal.status,
          cursor: undefined,
          active: undefined,
          stepOutputs: retainedStepOutputs,
          ...(terminal.status === "uncertain" && terminalOutput !== undefined
            ? { output:terminalOutput }
            : {}),
          error: {
            code:
              terminal.errorCode ??
              state.error?.code ??
              (rejected ? "ITEM_REJECTED" : "ITEM_UNCERTAIN"),
            message:terminal.errorCode
              ? rejected
                ? "An item outcome was rejected."
                : "An item outcome is uncertain."
              : state.error?.message ?? (rejected
                ? "An item outcome was rejected."
                : "An item outcome is uncertain.")
          }
        },
        state.revision
      ),
      effects: [],
      disposition: "advanced"
    };
  }
  const frame = state.foreachStack.at(-1)!;
  const block = blockAt(plan, frame.parentBlockPath);
  const foreach = block.steps[frame.stepKey];
  if (foreach?.kind !== "foreach") {
    throw new Error(`Foreach frame step not found: ${frame.stepKey}`);
  }
  const output = terminal.output
    ? resolveBinding(terminal.output, state)
    : state.previousOutput;
  const outcome = {
    itemKey: frame.itemKeys[frame.index]!,
    ...(terminal.status === "succeeded" ? { output } : {}),
    ...(terminal.status === "failed"
      ? {
          error: {
            code: terminal.errorCode ?? "ITEM_FAILED",
            message: "The foreach item failed."
          }
        }
      : {})
  };
  const updated: ForeachFrame = {
    ...frame,
    succeeded:
      terminal.status === "succeeded"
        ? [...frame.succeeded, outcome]
        : frame.succeeded,
    failed:
      terminal.status === "failed"
        ? [...frame.failed, outcome]
        : frame.failed,
    unresolved:
      terminal.status === "unresolved"
        ? [...frame.unresolved, outcome]
        : frame.unresolved
  };
  const parentStack = state.foreachStack.slice(0, -1);
  if (
    terminal.status === "failed" &&
    foreach.onItemError === "stop"
  ) {
    return drive(
      plan,
      immutableState(
        {
          ...state,
          status: "running",
          cursor: {
            blockPath: frame.parentBlockPath,
            stepKey: foreach.routes.stopped
          },
          foreachStack: parentStack,
          stepOutputs: retainedStepOutputs,
          previousOutput: aggregate(updated) as unknown as JsonValue
        },
        state.revision
      ),
      deps
    );
  }
  if (deps.clock.now() - frame.startedAt >= foreach.limits.maxDurationMs) {
    return drive(
      plan,
      immutableState(
        {
          ...state,
          status: "running",
          cursor: {
            blockPath: frame.parentBlockPath,
            stepKey: foreach.routes.stopped
          },
          foreachStack: parentStack,
          stepOutputs: retainedStepOutputs,
          previousOutput: aggregate(updated) as unknown as JsonValue
        },
        state.revision
      ),
      deps
    );
  }
  if (frame.index + 1 < frame.items.length) {
    const nextFrame = { ...updated, index: frame.index + 1 };
    return drive(
      plan,
      immutableState(
        {
          ...state,
          status: "running",
          cursor: {
            blockPath: [...frame.parentBlockPath, frame.stepKey],
            stepKey: foreach.body.entry
          },
          foreachStack: [...parentStack, nextFrame],
          stepOutputs: retainedStepOutputs,
          previousOutput: null
        },
        state.revision
      ),
      deps
    );
  }
  const summary = aggregate(updated) as unknown as JsonValue;
  const parentScope = currentScope({ ...state, foreachStack: parentStack });
  return drive(
    plan,
    immutableState(
      {
        ...state,
        status: "running",
        cursor: {
          blockPath: frame.parentBlockPath,
          stepKey: foreach.routes.completed
        },
        foreachStack: parentStack,
        previousOutput: summary,
        stepOutputs: {
          ...retainedStepOutputs,
          [outputKey(parentScope, foreach.key)]: summary
        }
      },
      state.revision
    ),
    deps
  );
}

function drive(
  plan: ExecutionPlan,
  initial: EngineState,
  deps: EngineDependencies,
  initialEffects: readonly EngineEffect[] = []
): EngineTransition {
  let state = initial;
  const effects = [...initialEffects];
  while (state.status === "running" && state.cursor) {
    const block = blockAt(plan, state.cursor.blockPath);
    const step = block.steps[state.cursor.stepKey];
    if (!step) {
      return {
        state: failState(
          state,
          "STEP_NOT_FOUND",
          `Step not found: ${state.cursor.stepKey}`
        ),
        effects,
        disposition: "advanced"
      };
    }
    if (step.kind === "call") {
      const scheduled = scheduleCall(
        plan,
        state,
        step,
        1,
        1,
        deps.clock.now(),
        deps
      );
      return {
        ...scheduled,
        effects: [...effects, ...scheduled.effects]
      };
    }
    if (step.kind === "decision") {
      const branch = step.branches.find((entry) =>
        evaluateCondition(entry.condition, state)
      );
      state = immutableState(
        {
          ...state,
          cursor: {
            ...state.cursor,
            stepKey: branch?.target ?? step.defaultTarget
          }
        },
        state.revision
      );
      continue;
    }
    if (step.kind === "foreach") {
      let items: JsonValue;
      try {
        items = resolveBinding(step.items, state);
      } catch (error) {
        return {
          state: failState(
            state,
            "FOREACH_ITEMS_INVALID",
            error instanceof Error ? error.message : String(error)
          ),
          effects,
          disposition: "advanced"
        };
      }
      if (!Array.isArray(items) || items.length > step.limits.maxItems) {
        state = immutableState(
          {
            ...state,
            cursor: {
              ...state.cursor,
              stepKey: step.routes.stopped
            },
            previousOutput: {
              total: Array.isArray(items) ? items.length : 0,
              succeeded: { count: 0, items: [] },
              failed: { count: 0, items: [] },
              unresolved: { count: 0, items: [] }
            }
          },
          state.revision
        );
        continue;
      }
      const frozenItems = clone(items);
      let keys: string[];
      try {
        keys = frozenItems.map((item) => itemKey(item, step));
      } catch (error) {
        return {
          state: failState(
            state,
            "FOREACH_ITEM_KEY_INVALID",
            error instanceof Error ? error.message : String(error)
          ),
          effects,
          disposition: "advanced"
        };
      }
      if (new Set(keys).size !== keys.length) {
        return {
          state: failState(
            state,
            "FOREACH_ITEM_KEY_DUPLICATE",
            `foreach ${step.key} produced duplicate item keys`
          ),
          effects,
          disposition: "advanced"
        };
      }
      if (frozenItems.length === 0) {
        const summary = {
          total: 0,
          succeeded: { count: 0, items: [] },
          failed: { count: 0, items: [] },
          unresolved: { count: 0, items: [] }
        } as JsonValue;
        state = immutableState(
          {
            ...state,
            cursor: { ...state.cursor, stepKey: step.routes.completed },
            previousOutput: summary,
            stepOutputs: {
              ...state.stepOutputs,
              [outputKey(currentScope(state), step.key)]: summary
            }
          },
          state.revision
        );
        continue;
      }
      const frame: ForeachFrame = {
        stepKey: step.key,
        parentBlockPath: state.cursor.blockPath,
        items: frozenItems,
        itemKeys: keys,
        index: 0,
        startedAt: deps.clock.now(),
        succeeded: [],
        failed: [],
        unresolved: []
      };
      state = immutableState(
        {
          ...state,
          cursor: {
            blockPath: [...state.cursor.blockPath, step.key],
            stepKey: step.body.entry
          },
          foreachStack: [...state.foreachStack, frame],
          previousOutput: null
        },
        state.revision
      );
      continue;
    }
    if (step.kind === "wait.assistance") {
      const request = assistanceRequest(state, step, deps);
      effects.push({ kind: "assistance.create", request });
      if (step.blocking) {
        effects.push({
          kind: "timer.schedule",
          timer: assistanceDeadlineTimer(request)
        });
        return {
          state: immutableState(
            {
              ...state,
              status: "waiting_assistance",
              active: { kind: "assistance", request }
            },
            state.revision
          ),
          effects,
          disposition: "advanced"
        };
      }
      state = immutableState(
        {
          ...state,
          cursor: { ...state.cursor, stepKey: step.next }
        },
        state.revision
      );
      continue;
    }
    if (state.foreachStack.length > 0) {
      const completed = completeItem(plan, state, step, deps);
      return {
        ...completed,
        effects: [...effects, ...completed.effects]
      };
    }
    const output = step.output
      ? resolveBinding(step.output, state)
      : state.previousOutput;
    return {
      state: immutableState(
        {
          ...state,
          status: step.status as Exclude<EngineStatus, "running">,
          cursor: undefined,
          active: undefined,
          output,
          ...(["rejected", "failed", "uncertain"].includes(step.status)
            ? {
                error: {
                  code:
                    step.errorCode ??
                    state.error?.code ??
                    (step.status === "rejected"
                      ? "WORKFLOW_REJECTED"
                      : step.status === "uncertain"
                        ? "WORKFLOW_UNCERTAIN"
                        : "WORKFLOW_FAILED"),
                  message:step.errorCode
                    ? step.status === "rejected"
                      ? "Workflow reached a rejected terminal."
                      : step.status === "uncertain"
                        ? "Workflow reached an uncertain terminal."
                        : "Workflow reached a failed terminal."
                    : state.error?.message ?? (step.status === "rejected"
                      ? "Workflow reached a rejected terminal."
                      : step.status === "uncertain"
                        ? "Workflow reached an uncertain terminal."
                        : "Workflow reached a failed terminal.")
                }
              }
            : {})
        },
        state.revision
      ),
      effects,
      disposition: "advanced"
    };
  }
  return { state, effects, disposition: "advanced" };
}

export class DeterministicWorkflowEngine {
  constructor(
    readonly plan: ExecutionPlan,
    readonly dependencies: EngineDependencies
  ) {}

  start(runId: string, input: JsonValue): EngineTransition {
    const initial: EngineState = {
      stateVersion: "bpa.engine-state/2",
      runId,
      workflowDigest: this.plan.workflow.digest,
      status: "running",
      revision: 0,
      input: clone(input),
      cursor: { blockPath: [], stepKey: this.plan.entry },
      previousOutput: null,
      stepOutputs: {},
      foreachStack: [],
      active: undefined,
      completedExternalIds: [],
      output: undefined,
      error: undefined
    };
    return drive(this.plan, initial, this.dependencies);
  }

  resume(snapshot: EngineState): EngineTransition {
    if (snapshot.workflowDigest !== this.plan.workflow.digest) {
      throw new Error("Engine snapshot does not belong to this plan");
    }
    return drive(this.plan, clone(snapshot), this.dependencies);
  }

  cancel(snapshot: EngineState): EngineTransition {
    if (snapshot.workflowDigest !== this.plan.workflow.digest) {
      throw new Error("Engine snapshot does not belong to this plan");
    }
    const state = clone(snapshot);
    if (state.status === "cancelled") {
      return { state, effects: [], disposition: "duplicate" };
    }
    if (
      ["succeeded", "rejected", "failed", "uncertain"].includes(
        state.status
      )
    ) {
      return { state, effects: [], disposition: "stale" };
    }
    const externalId =
      state.active?.kind === "call"
        ? state.active.invocation.invocationId
        : state.active?.kind === "assistance"
          ? state.active.request.taskId
          : undefined;
    return {
      state: immutableState(
        {
          ...state,
          status: "cancelled",
          cursor: undefined,
          active: undefined,
          completedExternalIds:
            externalId && !state.completedExternalIds.includes(externalId)
              ? [...state.completedExternalIds, externalId]
              : state.completedExternalIds,
          error: {
            code: "RUN_CANCELLED",
            message: "Run was cancelled before completion."
          }
        },
        state.revision
      ),
      effects: [],
      disposition: "advanced"
    };
  }

  acceptRuntimeOutcome(input: {
    state: EngineState;
    invocationId: string;
    fencingToken: number;
    outcome: RuntimeOutcome;
  }): EngineTransition {
    const state = clone(input.state);
    const active = state.active;
    if (
      !active ||
      active.kind !== "call" ||
      active.invocation.invocationId !== input.invocationId ||
      active.invocation.fencingToken !== input.fencingToken
    ) {
      return {
        state,
        effects: [],
        disposition: state.completedExternalIds.includes(input.invocationId)
          ? "duplicate"
          : "stale"
      };
    }
    const completedExternalIds = [
      ...state.completedExternalIds,
      input.invocationId
    ];
    const block = blockAt(this.plan, state.cursor!.blockPath);
    const step = block.steps[state.cursor!.stepKey];
    if (step?.kind !== "call") {
      throw new Error("Active call cursor does not reference a call step");
    }
    if (
      input.outcome.status === "rejected" ||
      input.outcome.status === "uncertain"
    ) {
      return drive(
        this.plan,
        immutableState(
          {
            ...state,
            status:"running",
            cursor:{
              ...state.cursor!,
              stepKey:input.outcome.status === "rejected"
                ? step.routes.rejected
                : step.routes.uncertain
            },
            active:undefined,
            completedExternalIds,
            error:{
              code:input.outcome.error.code,
              message:input.outcome.error.message
            }
          },
          state.revision
        ),
        this.dependencies
      );
    }
    const retryable =
      input.outcome.status !== "succeeded" &&
      input.outcome.error.retryable &&
      step.retry.retryableOutcomes.some(
        (status) => status === input.outcome.status
      ) &&
      (step.retry.retryableErrorCodes.length === 0 ||
        step.retry.retryableErrorCodes.includes(input.outcome.error.code)) &&
      active.invocation.identity.attempt < step.retry.maxAttempts;
    if (retryable) {
      const nextAttempt = active.invocation.identity.attempt + 1;
      const delay = retryDelay(
        step,
        nextAttempt,
        this.dependencies.random.next()
      );
      const retryState = immutableState(
        {
          ...state,
          status: "running",
          active: undefined,
          completedExternalIds
        },
        state.revision
      );
      const notBefore = this.dependencies.clock.now() + delay;
      const foreachDeadline = earliestForeachDeadline(this.plan, retryState);
      if (foreachDeadline && notBefore >= foreachDeadline.deadlineAt) {
        return stopForeachAtDeadline(
          this.plan,
          retryState,
          foreachDeadline.frameIndex,
          this.dependencies
        );
      }
      return scheduleCall(
        this.plan,
        retryState,
        step,
        nextAttempt,
        active.invocation.fencingToken + 1,
        notBefore,
        this.dependencies
      );
    }
    const route =
      input.outcome.status === "succeeded"
        ? step.routes.succeeded
        : step.routes[input.outcome.status];
    const scope = currentScope(state);
    const output =
      input.outcome.output ??
      (input.outcome.status === "succeeded" ? null : state.previousOutput);
    return drive(
      this.plan,
      immutableState(
        {
          ...state,
          status: "running",
          cursor: { ...state.cursor!, stepKey: route },
          active: undefined,
          completedExternalIds,
          previousOutput: output,
          ...(input.outcome.status === "succeeded"
            ? {
                stepOutputs: {
                  ...state.stepOutputs,
                  [outputKey(scope, step.key)]: output
                }
              }
            : {})
        },
        state.revision
      ),
      this.dependencies
    );
  }

  acceptAssistanceOutcome(input: {
    state: EngineState;
    taskId: string;
    fencingToken: number;
    outcome: AssistanceOutcome;
  }): EngineTransition {
    const state = clone(input.state);
    const active = state.active;
    if (
      !active ||
      active.kind !== "assistance" ||
      active.request.taskId !== input.taskId ||
      active.request.fencingToken !== input.fencingToken
    ) {
      return {
        state,
        effects: [],
        disposition: state.completedExternalIds.includes(input.taskId)
          ? "duplicate"
          : "stale"
      };
    }
    const block = blockAt(this.plan, state.cursor!.blockPath);
    const step = block.steps[state.cursor!.stepKey];
    if (step?.kind !== "wait.assistance" || !step.blocking) {
      throw new Error(
        "Active assistance cursor does not reference blocking assistance"
      );
    }
    const output = input.outcome.output ?? null;
    const scope = currentScope(state);
    return drive(
      this.plan,
      immutableState(
        {
          ...state,
          status: "running",
          cursor: {
            ...state.cursor!,
            stepKey: step.routes[input.outcome.status]
          },
          active: undefined,
          completedExternalIds: [
            ...state.completedExternalIds,
            input.taskId
          ],
          previousOutput: output,
          ...(input.outcome.status === "resolved"
            ? {
                stepOutputs: {
                  ...state.stepOutputs,
                  [outputKey(scope, step.key)]: output
                }
              }
            : {})
        },
        state.revision
      ),
      this.dependencies
    );
  }

  acceptTimerFire(input: {
    state: EngineState;
    timer: TimerRequest;
  }): EngineTransition {
    const state = clone(input.state);
    const active = state.active;
    const timer = input.timer;
    if (
      timer.wakeAt > this.dependencies.clock.now() ||
      timer.timerId !== assistanceDeadlineTimerId(timer.signal.taskId) ||
      active?.kind !== "assistance" ||
      active.request.taskId !== timer.signal.taskId ||
      active.request.fencingToken !== timer.fencingToken ||
      executionIdentityKey(active.request.identity) !==
        executionIdentityKey(timer.identity)
    ) {
      return {
        state,
        effects: [],
        disposition: state.completedExternalIds.includes(timer.signal.taskId)
          ? "duplicate"
          : "stale"
      };
    }
    return this.acceptAssistanceOutcome({
      state,
      taskId: timer.signal.taskId,
      fencingToken: timer.fencingToken,
      outcome: { status: "expired" }
    });
  }
}

export interface RuntimeEffectDispatcher {
  invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome>;
}

export async function dispatchRuntimeEffect(
  dispatcher: RuntimeEffectDispatcher,
  effect: Extract<EngineEffect, { kind: "runtime.invoke" }>,
  signal: AbortSignal
): Promise<RuntimeOutcome> {
  return dispatcher.invoke(effect.invocation, signal);
}
