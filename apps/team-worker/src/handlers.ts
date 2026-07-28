import {
  PACKAGING_MATCHER_VERSION,
  matchPackagingBatch,
  type PackagingBinding,
  type PackagingMasterRecord,
  type PackagingProduct
} from "@bpa/packaging-domain";
import {
  TeamHandlerError,
  TeamHandlerRegistry,
  unavailableTeamHandler
} from "@bpa/team-runtime";
import type { DecisionReuseContext } from "@bpa/dataset-core";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_MANIFEST,
  TEAM_WORKER_HANDLER_REFS,
  TEAM_WORKER_VERSION
} from "./manifest.js";

export const PACKAGING_MATCH_HANDLER_REF =
  "packaging.master.match.batch@1.0.0";

if (PACKAGING_MATCHER_VERSION !== "packaging-smart-v1") {
  throw new Error("Team Worker manifest must be updated for the new matcher");
}

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

const manifestDigest = (ref: string): string => {
  const entry = TEAM_WORKER_HANDLER_MANIFEST.find(
    (candidate) => candidate.ref === ref
  );
  if (!entry) throw new Error(`Team Handler manifest entry is missing: ${ref}`);
  return entry.implementationDigest;
};

export const teamHandlerRegistry = new TeamHandlerRegistry([
  {
    node: {
      id: "packaging.master.match.batch",
      version: "1.0.0"
    },
    implementationDigest: manifestDigest(PACKAGING_MATCH_HANDLER_REF),
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
    implementationDigest: manifestDigest("packaging.dataset.parse@1.0.0")
  }),
  unavailableTeamHandler({
    id: "issues.reconcile",
    version: "1.0.0",
    implementationDigest: manifestDigest("issues.reconcile@1.0.0")
  }),
  unavailableTeamHandler({
    id: "report.issue.build",
    version: "1.0.0",
    implementationDigest: manifestDigest("report.issue.build@1.0.0")
  })
]);

if (
  JSON.stringify(teamHandlerRegistry.manifest()) !==
  JSON.stringify(
    [...TEAM_WORKER_HANDLER_MANIFEST].sort((left, right) =>
      left.ref.localeCompare(right.ref)
    )
  )
) {
  throw new Error("Team Worker Handler registry does not match its manifest");
}

export {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS,
  TEAM_WORKER_VERSION
};
