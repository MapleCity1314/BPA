import {
  PACKAGING_MATCHER_VERSION,
  digestPackagingValue,
  matchPackagingBatch,
  type PackagingBinding,
  type PackagingMasterRecord,
  type PackagingProduct
} from "@bpa/packaging-domain";
import {
  TEAM_PROTOCOL_VERSION,
  TeamHandlerError,
  TeamHandlerRegistry,
  teamCodeDigest,
  unavailableTeamHandler
} from "@bpa/team-runtime";
import type { DecisionReuseContext } from "@bpa/dataset-core";
import type { JsonValue } from "@bpa/workflow-ir";

export const TEAM_WORKER_VERSION = "0.1.0";
export const PACKAGING_MATCH_HANDLER_REF =
  "packaging.master.match.batch@1.0.0";

function objectMap<T>(
  value: unknown,
  label: string
): ReadonlyMap<string, T> {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      `${label} must be an object`
    );
  }
  return new Map(Object.entries(value as Record<string, T>));
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const packagingHandlerDigest = digestPackagingValue({
  handler: PACKAGING_MATCH_HANDLER_REF,
  matcherVersion: PACKAGING_MATCHER_VERSION,
  implementation: "trusted-static-v1"
});

export const teamHandlerRegistry = new TeamHandlerRegistry([
  {
    node: {
      id: "packaging.master.match.batch",
      version: "1.0.0"
    },
    implementationDigest: packagingHandlerDigest,
    invoke(input, signal) {
      if (signal.aborted) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_CANCELLED",
          "Packaging match was cancelled"
        );
      }
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input)
      ) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          "Packaging match input must be an object"
        );
      }
      const candidate = input as Record<string, unknown>;
      if (
        !Array.isArray(candidate.products) ||
        !Array.isArray(candidate.records)
      ) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          "Packaging match requires products and records arrays"
        );
      }
      const result = matchPackagingBatch(
        candidate.products as PackagingProduct[],
        candidate.records as PackagingMasterRecord[],
        objectMap<PackagingBinding>(candidate.bindings, "bindings"),
        objectMap<DecisionReuseContext>(
          candidate.reuseContexts,
          "reuseContexts"
        )
      );
      if (signal.aborted) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_CANCELLED",
          "Packaging match was cancelled"
        );
      }
      return asJsonValue(result);
    }
  },
  unavailableTeamHandler({
    id: "packaging.dataset.parse",
    version: "1.0.0",
    implementationDigest: digestPackagingValue({
      handler: "packaging.dataset.parse@1.0.0",
      implementation: "not-implemented"
    })
  }),
  unavailableTeamHandler({
    id: "issues.reconcile",
    version: "1.0.0",
    implementationDigest: digestPackagingValue({
      handler: "issues.reconcile@1.0.0",
      implementation: "not-implemented"
    })
  }),
  unavailableTeamHandler({
    id: "report.issue.build",
    version: "1.0.0",
    implementationDigest: digestPackagingValue({
      handler: "report.issue.build@1.0.0",
      implementation: "not-implemented"
    })
  })
]);

export const TEAM_WORKER_CODE_DIGEST = teamCodeDigest({
  protocolVersion: TEAM_PROTOCOL_VERSION,
  workerVersion: TEAM_WORKER_VERSION,
  handlers: teamHandlerRegistry.manifest()
});

export const TEAM_WORKER_HANDLER_REFS = teamHandlerRegistry.refs();
