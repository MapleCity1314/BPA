import type { RiskSignal, TimingPolicy } from "@bpa/schemas";

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
    scope: "domain" | "shop" | "tab";
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
