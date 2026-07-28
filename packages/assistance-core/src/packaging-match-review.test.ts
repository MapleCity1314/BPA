import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAssistanceTask,
  PACKAGING_MATCH_REVIEW_OUTPUT_SCHEMA,
  PACKAGING_MATCH_REVIEW_PROFILE_ID,
  PACKAGING_MATCH_REVIEW_PROFILE_VERSION,
  PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY,
  PACKAGING_MATCH_REVIEW_VALIDATOR_REF,
  validatePackagingMatchReviewResult
} from "./index.js";

const digest = (character: string) =>
  `sha256:${character.repeat(64)}`;

function task(input: unknown = validInput()) {
  return createAssistanceTask({
    taskId: "task-packaging-review",
    runId: "run-priority-check",
    stepInstanceId: "step-packaging-review",
    profile: {
      id: PACKAGING_MATCH_REVIEW_PROFILE_ID,
      version: PACKAGING_MATCH_REVIEW_PROFILE_VERSION,
      digest: digest("e")
    },
    mode: "ai_review",
    riskLevel: "R1",
    input,
    outputSchema:
      PACKAGING_MATCH_REVIEW_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
    policySnapshot: {
      autoContinue: true,
      r1ProfileApproved: true,
      durableDecision: false,
      deterministicValidator: PACKAGING_MATCH_REVIEW_VALIDATOR_REF,
      onUnavailable: "human_action"
    },
    deadline: "2026-07-29T00:00:00.000Z",
    now: "2026-07-28T00:00:00.000Z"
  });
}

function validInput() {
  return {
    batchRef: digest("a"),
    items: [
      {
        productRef: digest("b"),
        productId: "product-1",
        candidates: [
          {
            candidateRef: digest("c"),
            recordId: "record-1",
            recordDigest: digest("d")
          }
        ]
      },
      {
        productRef: digest("5"),
        productId: "product-2",
        candidates: [
          {
            candidateRef: digest("6"),
            recordId: "record-2",
            recordDigest: digest("7")
          }
        ]
      }
    ]
  };
}

function validOutput() {
  return {
    batchRef: digest("a"),
    decisions: [
      {
        productRef: digest("b"),
        productId: "product-1",
        status: "selected",
        candidateRef: digest("c"),
        recordId: "record-1",
        recordDigest: digest("d")
      },
      {
        productRef: digest("5"),
        productId: "product-2",
        status: "unresolved",
        reasonCode: "insufficient_evidence"
      }
    ]
  };
}

describe("packaging_match_review deterministic validator", () => {
  it("accepts one exact bounded decision for each frozen product", () => {
    expect(
      validatePackagingMatchReviewResult(task(), validOutput())
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects forged candidates and duplicate product decisions", () => {
    const forged = validOutput();
    const firstDecision = forged.decisions[0];
    if (
      !firstDecision ||
      typeof firstDecision.recordId !== "string" ||
      typeof firstDecision.recordDigest !== "string"
    ) {
      throw new Error("Selected decision fixture is missing");
    }
    forged.decisions[0] = {
      productRef: firstDecision.productRef,
      productId: firstDecision.productId,
      status: "selected",
      candidateRef: digest("8"),
      recordId: firstDecision.recordId,
      recordDigest: firstDecision.recordDigest
    };
    expect(
      validatePackagingMatchReviewResult(task(), forged)
    ).toMatchObject({
      valid: false,
      errors: [
        "Decision 0 selects a candidate outside the frozen range"
      ]
    });

    const duplicate = validOutput();
    duplicate.decisions[1] = {
      productRef: digest("b"),
      productId: "product-1",
      status: "unresolved",
      reasonCode: "conflicting_evidence"
    };
    expect(
      validatePackagingMatchReviewResult(task(), duplicate)
    ).toMatchObject({
      valid: false,
      errors: ["Result contains duplicate product product-1"]
    });
  });

  it("rejects malformed frozen ranges and non-whitelisted validator refs", () => {
    const duplicatedInput = validInput();
    const secondItem = duplicatedInput.items[1];
    if (!secondItem) throw new Error("Second input fixture is missing");
    duplicatedInput.items[1] = {
      ...secondItem,
      productId: "product-1"
    };
    expect(
      validatePackagingMatchReviewResult(
        task(duplicatedInput),
        validOutput()
      )
    ).toMatchObject({
      valid: false,
      errors: ["Task input contains duplicate product product-1"]
    });

    const wrongValidatorTask = {
      ...task(),
      policySnapshot: {
        ...task().policySnapshot,
        deterministicValidator: {
          ...PACKAGING_MATCH_REVIEW_VALIDATOR_REF,
          digest: digest("f")
        }
      }
    };
    expect(
      validatePackagingMatchReviewResult(
        wrongValidatorTask,
        validOutput()
      )
    ).toMatchObject({
      valid: false,
      errors: [
        "Task does not reference the whitelisted validator asset"
      ]
    });
  });

  it("keeps the checked-in policy and Profile assets synchronized", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const policy = JSON.parse(
      readFileSync(
        resolve(
          root,
          "policies/core/packaging_match_review.validator.policy.json"
        ),
        "utf8"
      )
    );
    expect(policy).toEqual(PACKAGING_MATCH_REVIEW_VALIDATOR_POLICY);

    const profile = JSON.parse(
      readFileSync(
        resolve(
          root,
          "assistance-profiles/core/packaging_match_review.assistance-profile.json"
        ),
        "utf8"
      )
    );
    expect(profile.metadata).toMatchObject({
      id: PACKAGING_MATCH_REVIEW_PROFILE_ID,
      version: PACKAGING_MATCH_REVIEW_PROFILE_VERSION
    });
    expect(profile.outputSchema).toEqual(
      PACKAGING_MATCH_REVIEW_OUTPUT_SCHEMA
    );
    expect(
      profile.policySnapshot.deterministicValidator
    ).toEqual(PACKAGING_MATCH_REVIEW_VALIDATOR_REF);
  });
});
