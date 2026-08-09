export type EcommerceEvidenceObject = Record<string, unknown>;
export {
  buildDiscoveryCategorySpace,
  buildDiscoveryComparablePool,
  buildDiscoveryReferencePack,
  evaluateDiscoveryEvidence,
  mergeMarketplaceProbes
} from "./discovery.js";
type JsonObject = EcommerceEvidenceObject;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string, maximum = 2_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${label} must be an array with at most 50 items`);
  }
  return value.map((entry, index) =>
    text(entry, `${label}[${index}]`, 500)
  );
}

export function normalizeProductIntent(input: unknown): JsonObject {
  const candidate = object(input, "Product intent input");
  const boundary = object(candidate.workingBoundary, "workingBoundary");
  return {
    schemaVersion: "product-intent/v0.2",
    intentId: text(candidate.intentId, "intentId", 200),
    researchObject: {
      confirmed: [
        {
          field: "platform",
          value: text(candidate.platform, "platform", 100),
          source: "WORKFLOW_INPUT"
        },
        {
          field: "seed_query",
          value: text(candidate.seedQuery, "seedQuery", 300),
          source: "WORKFLOW_INPUT"
        },
        {
          field: "research_goal",
          value: text(candidate.researchGoal, "researchGoal", 2_000),
          source: "WORKFLOW_INPUT"
        }
      ],
      workingBoundary: {
        productForm: text(boundary.productForm, "workingBoundary.productForm"),
        targetPeople: stringArray(
          boundary.targetPeople,
          "workingBoundary.targetPeople"
        ),
        usageScenes: stringArray(
          boundary.usageScenes,
          "workingBoundary.usageScenes"
        ),
        confidence: text(
          boundary.confidence ?? "MEDIUM",
          "workingBoundary.confidence",
          20
        )
      }
    }
  };
}
