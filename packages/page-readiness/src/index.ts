export const PAGE_READINESS_API_VERSION =
  "bpa.page-readiness/v1alpha1" as const;

export interface TargetPresentSignal {
  kind: "target-present";
  semanticTargetId: string;
  minimumCount: number;
}

export interface DomQuietSignal {
  kind: "dom-quiet";
  quietWindowMs: number;
}

export interface NetworkQuietSignal {
  kind: "network-quiet";
  quietWindowMs: number;
  maximumInflightRequests: number;
}

export interface AssetCountStableSignal {
  kind: "asset-count-stable";
  semanticCollectionId: string;
  minimumCount: number;
  consecutiveSamples: number;
  sampleIntervalMs: number;
}

export type ReadinessSignal =
  | TargetPresentSignal
  | DomQuietSignal
  | NetworkQuietSignal
  | AssetCountStableSignal;

export interface ReadinessContract {
  apiVersion: typeof PAGE_READINESS_API_VERSION;
  kind: "ReadinessContract";
  metadata: {
    id: string;
    version: string;
  };
  mode: "all";
  signals: ReadinessSignal[];
  limits: {
    timeoutMs: number;
    refresh: {
      maximumAttempts: number;
      cooldownMs: number;
    };
  };
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[]
): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function integerBetween(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function validSignal(value: unknown): value is ReadinessSignal {
  if (!record(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "target-present":
      return (
        exactKeys(value, ["kind", "semanticTargetId", "minimumCount"]) &&
        typeof value.semanticTargetId === "string" &&
        ID_PATTERN.test(value.semanticTargetId) &&
        integerBetween(value.minimumCount, 1, 10_000)
      );
    case "dom-quiet":
      return (
        exactKeys(value, ["kind", "quietWindowMs"]) &&
        integerBetween(value.quietWindowMs, 50, 30_000)
      );
    case "network-quiet":
      return (
        exactKeys(value, [
          "kind",
          "quietWindowMs",
          "maximumInflightRequests"
        ]) &&
        integerBetween(value.quietWindowMs, 50, 30_000) &&
        integerBetween(value.maximumInflightRequests, 0, 100)
      );
    case "asset-count-stable":
      return (
        exactKeys(value, [
          "kind",
          "semanticCollectionId",
          "minimumCount",
          "consecutiveSamples",
          "sampleIntervalMs"
        ]) &&
        typeof value.semanticCollectionId === "string" &&
        ID_PATTERN.test(value.semanticCollectionId) &&
        integerBetween(value.minimumCount, 1, 100_000) &&
        integerBetween(value.consecutiveSamples, 2, 20) &&
        integerBetween(value.sampleIntervalMs, 50, 30_000)
      );
    default:
      return false;
  }
}

export function parseReadinessContract(value: unknown): ReadinessContract {
  if (
    !record(value) ||
    !exactKeys(value, [
      "apiVersion",
      "kind",
      "metadata",
      "mode",
      "signals",
      "limits"
    ]) ||
    value.apiVersion !== PAGE_READINESS_API_VERSION ||
    value.kind !== "ReadinessContract" ||
    !record(value.metadata) ||
    !exactKeys(value.metadata, ["id", "version"]) ||
    typeof value.metadata.id !== "string" ||
    !ID_PATTERN.test(value.metadata.id) ||
    typeof value.metadata.version !== "string" ||
    !SEMVER_PATTERN.test(value.metadata.version) ||
    value.mode !== "all" ||
    !Array.isArray(value.signals) ||
    value.signals.length === 0 ||
    value.signals.length > 20 ||
    !value.signals.every(validSignal) ||
    !value.signals.some((signal) => signal.kind === "target-present") ||
    !record(value.limits) ||
    !exactKeys(value.limits, ["timeoutMs", "refresh"]) ||
    !integerBetween(value.limits.timeoutMs, 100, 300_000) ||
    !record(value.limits.refresh) ||
    !exactKeys(value.limits.refresh, ["maximumAttempts", "cooldownMs"]) ||
    !integerBetween(value.limits.refresh.maximumAttempts, 0, 3) ||
    !integerBetween(value.limits.refresh.cooldownMs, 0, 30_000)
  ) {
    throw new Error("Malformed page readiness contract");
  }
  return value as unknown as ReadinessContract;
}
