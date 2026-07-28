import { createHash } from "node:crypto";
import type { AssistanceTask } from "./index.js";
import type { OutputSchemaValidation } from "./service.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_BATCH_ITEMS = 500;
const MAX_CANDIDATES_PER_ITEM = 10;

export const PACKAGING_MATCH_REVIEW_PROFILE_ID =
  "packaging_match_review";
export const PACKAGING_MATCH_REVIEW_PROFILE_VERSION = "1.0.0";

export const PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY = {
  apiVersion: "bpa.policy/v1alpha1",
  kind: "DeterministicResultValidatorPolicy",
  metadata: {
    id: "packaging_match_review.validator",
    version: "1.0.0",
    title: "Packaging match review deterministic validator"
  },
  implementation: {
    provider: "builtin",
    validator: "packaging_match_review",
    maxBatchItems: MAX_BATCH_ITEMS,
    maxCandidatesPerItem: MAX_CANDIDATES_PER_ITEM,
    constraints: [
      "exact-profile-version",
      "exact-validator-digest",
      "opaque-reference-membership",
      "unique-product-decision",
      "candidate-range-only"
    ]
  }
} as const;

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

export const PACKAGING_MATCH_REVIEW_VALIDATOR_REF = Object.freeze({
  id: PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY.metadata.id,
  version: PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY.metadata.version,
  digest: `sha256:${createHash("sha256")
    .update(canonicalJson(PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY))
    .digest("hex")}`
});

export const PACKAGING_MATCH_REVIEW_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["batchRef", "decisions"],
  properties: {
    batchRef: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    decisions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_BATCH_ITEMS,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "productRef",
              "productId",
              "status",
              "candidateRef",
              "recordId",
              "recordDigest"
            ],
            properties: {
              productRef: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$"
              },
              productId: { type: "string", minLength: 1, maxLength: 200 },
              status: { const: "selected" },
              candidateRef: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$"
              },
              recordId: { type: "string", minLength: 1, maxLength: 200 },
              recordDigest: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$"
              }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "productRef",
              "productId",
              "status",
              "reasonCode"
            ],
            properties: {
              productRef: {
                type: "string",
                pattern: "^sha256:[a-f0-9]{64}$"
              },
              productId: { type: "string", minLength: 1, maxLength: 200 },
              status: { const: "unresolved" },
              reasonCode: {
                enum: [
                  "no_confident_candidate",
                  "insufficient_evidence",
                  "conflicting_evidence"
                ]
              }
            }
          }
        ]
      }
    }
  }
} as const;

interface CandidateInput {
  candidateRef: string;
  recordId: string;
  recordDigest: string;
}

interface ReviewItemInput {
  productRef: string;
  productId: string;
  candidates: CandidateInput[];
}

interface ReviewInput {
  batchRef: string;
  items: ReviewItemInput[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected]
      .sort()
      .every((key, index) => actual[index] === key)
  );
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 200
  );
}

function parseInput(
  value: unknown,
  errors: string[]
): ReviewInput | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, ["batchRef", "items"])) {
    errors.push("Task input must contain only batchRef and items");
    return undefined;
  }
  if (
    typeof input.batchRef !== "string" ||
    !DIGEST_PATTERN.test(input.batchRef)
  ) {
    errors.push("Task input batchRef is not a SHA-256 reference");
  }
  if (
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > MAX_BATCH_ITEMS
  ) {
    errors.push(
      `Task input items must contain 1-${MAX_BATCH_ITEMS} entries`
    );
    return undefined;
  }
  const productIds = new Set<string>();
  const productRefs = new Set<string>();
  const parsedItems: ReviewItemInput[] = [];
  input.items.forEach((rawItem, itemIndex) => {
    const item = record(rawItem);
    if (
      !item ||
      !exactKeys(item, ["productRef", "productId", "candidates"])
    ) {
      errors.push(`Task input item ${itemIndex} has an invalid shape`);
      return;
    }
    if (!validText(item.productId)) {
      errors.push(`Task input item ${itemIndex} has an invalid productId`);
      return;
    }
    if (
      typeof item.productRef !== "string" ||
      !DIGEST_PATTERN.test(item.productRef)
    ) {
      errors.push(`Task input item ${itemIndex} has an invalid productRef`);
      return;
    }
    if (productIds.has(item.productId) || productRefs.has(item.productRef)) {
      errors.push(`Task input contains duplicate product ${item.productId}`);
      return;
    }
    productIds.add(item.productId);
    productRefs.add(item.productRef);
    if (
      !Array.isArray(item.candidates) ||
      item.candidates.length === 0 ||
      item.candidates.length > MAX_CANDIDATES_PER_ITEM
    ) {
      errors.push(
        `Task input product ${item.productId} must have 1-${MAX_CANDIDATES_PER_ITEM} candidates`
      );
      return;
    }
    const candidateRefs = new Set<string>();
    const candidates: CandidateInput[] = [];
    item.candidates.forEach((rawCandidate, candidateIndex) => {
      const candidate = record(rawCandidate);
      if (
        !candidate ||
        !exactKeys(candidate, [
          "candidateRef",
          "recordId",
          "recordDigest"
        ]) ||
        typeof candidate.candidateRef !== "string" ||
        !DIGEST_PATTERN.test(candidate.candidateRef) ||
        !validText(candidate.recordId) ||
        typeof candidate.recordDigest !== "string" ||
        !DIGEST_PATTERN.test(candidate.recordDigest)
      ) {
        errors.push(
          `Task input product ${item.productId} candidate ${candidateIndex} is invalid`
        );
        return;
      }
      if (candidateRefs.has(candidate.candidateRef)) {
        errors.push(
          `Task input product ${item.productId} has duplicate candidateRef`
        );
        return;
      }
      candidateRefs.add(candidate.candidateRef);
      candidates.push({
        candidateRef: candidate.candidateRef,
        recordId: candidate.recordId,
        recordDigest: candidate.recordDigest
      });
    });
    if (candidates.length === item.candidates.length) {
      parsedItems.push({
        productRef: item.productRef,
        productId: item.productId,
        candidates
      });
    }
  });
  if (
    errors.length > 0 ||
    parsedItems.length !== input.items.length ||
    typeof input.batchRef !== "string"
  ) {
    return undefined;
  }
  return {
    batchRef: input.batchRef,
    items: parsedItems
  };
}

export function validatePackagingMatchReviewResult(
  task: AssistanceTask,
  output: unknown
): OutputSchemaValidation {
  const errors: string[] = [];
  const validator = task.policySnapshot.deterministicValidator;
  if (
    task.profile.id !== PACKAGING_MATCH_REVIEW_PROFILE_ID ||
    task.profile.version !== PACKAGING_MATCH_REVIEW_PROFILE_VERSION ||
    task.mode !== "ai_review" ||
    task.riskLevel !== "R1"
  ) {
    errors.push("Task is not the exact approved packaging review Profile");
  }
  if (
    !validator ||
    validator.id !== PACKAGING_MATCH_REVIEW_VALIDATOR_REF.id ||
    validator.version !== PACKAGING_MATCH_REVIEW_VALIDATOR_REF.version ||
    validator.digest !== PACKAGING_MATCH_REVIEW_VALIDATOR_REF.digest
  ) {
    errors.push("Task does not reference the whitelisted validator asset");
  }
  const input = parseInput(task.input, errors);
  const result = record(output);
  if (
    !result ||
    !exactKeys(result, ["batchRef", "decisions"]) ||
    !Array.isArray(result.decisions)
  ) {
    errors.push("Result must contain only batchRef and decisions");
    return { valid: false, errors };
  }
  if (!input) return { valid: false, errors };
  if (result.batchRef !== input.batchRef) {
    errors.push("Result batchRef does not match the frozen task input");
  }
  if (result.decisions.length !== input.items.length) {
    errors.push("Result must contain exactly one decision per product");
  }
  const itemsByProductRef = new Map(
    input.items.map((item) => [item.productRef, item])
  );
  const decidedProductIds = new Set<string>();
  const decidedProductRefs = new Set<string>();
  result.decisions.forEach((rawDecision, decisionIndex) => {
    const decision = record(rawDecision);
    if (!decision) {
      errors.push(`Decision ${decisionIndex} is not an object`);
      return;
    }
    const status = decision.status;
    const expectedKeys =
      status === "selected"
        ? [
            "productRef",
            "productId",
            "status",
            "candidateRef",
            "recordId",
            "recordDigest"
          ]
        : ["productRef", "productId", "status", "reasonCode"];
    if (!exactKeys(decision, expectedKeys)) {
      errors.push(`Decision ${decisionIndex} has an invalid shape`);
      return;
    }
    if (
      typeof decision.productRef !== "string" ||
      typeof decision.productId !== "string"
    ) {
      errors.push(`Decision ${decisionIndex} has invalid product references`);
      return;
    }
    if (
      decidedProductRefs.has(decision.productRef) ||
      decidedProductIds.has(decision.productId)
    ) {
      errors.push(`Result contains duplicate product ${decision.productId}`);
      return;
    }
    decidedProductRefs.add(decision.productRef);
    decidedProductIds.add(decision.productId);
    const item = itemsByProductRef.get(decision.productRef);
    if (!item || item.productId !== decision.productId) {
      errors.push(
        `Decision ${decisionIndex} does not reference a task product`
      );
      return;
    }
    if (status === "unresolved") {
      if (
        decision.reasonCode !== "no_confident_candidate" &&
        decision.reasonCode !== "insufficient_evidence" &&
        decision.reasonCode !== "conflicting_evidence"
      ) {
        errors.push(`Decision ${decisionIndex} has an invalid reasonCode`);
      }
      return;
    }
    if (status !== "selected") {
      errors.push(`Decision ${decisionIndex} has an invalid status`);
      return;
    }
    const candidate = item.candidates.find(
      (entry) => entry.candidateRef === decision.candidateRef
    );
    if (
      !candidate ||
      candidate.recordId !== decision.recordId ||
      candidate.recordDigest !== decision.recordDigest
    ) {
      errors.push(
        `Decision ${decisionIndex} selects a candidate outside the frozen range`
      );
    }
  });
  return { valid: errors.length === 0, errors };
}
