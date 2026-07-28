import { describe, expect, it } from "vitest";
import {
  canReuseDecision,
  confirmDecision,
  createDatasetVersion,
  createUnconfirmedDecision,
  datasetRef,
  datasetRefEquals,
  decisionReuseIdentityEquals,
  decisionReuseMismatches,
  refersToDatasetVersion
} from "./index.js";

const versionInput = {
  datasetId: "dataset-1",
  versionId: "version-1",
  contentDigest: "sha256:content-a",
  recordIndexDigest: "sha256:index-a",
  recordCount: 2,
  profile: {
    profileId: "profile-1",
    profileVersion: "1.0.0"
  },
  publishedAt: 100
};

const identity = {
  shopId: "shop-1",
  productId: "product-1",
  normalizedTitleDigest: "sha256:title-a",
  targetRecordDigest: "sha256:record-a",
  matcherVersion: "matcher-1",
  ruleVersion: "rule-1"
};

function unconfirmed() {
  const version = createDatasetVersion(versionInput);
  return createUnconfirmedDecision({
    decisionId: "decision-1",
    dataset: datasetRef(version),
    reuseIdentity: identity,
    decision: { targetId: "target-1" },
    decidedAt: 120
  });
}

describe("immutable dataset identity", () => {
  it("publishes an immutable version and derives an exact reference", () => {
    const version = createDatasetVersion(versionInput);
    const ref = datasetRef(version);
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.profile)).toBe(true);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(ref).toEqual({
      datasetId: "dataset-1",
      versionId: "version-1",
      contentDigest: "sha256:content-a"
    });
    expect(refersToDatasetVersion(ref, version)).toBe(true);
    expect(
      datasetRefEquals(ref, { ...ref, contentDigest: "sha256:content-b" })
    ).toBe(false);
  });

  it("rejects incomplete or invalid version identities", () => {
    expect(() =>
      createDatasetVersion({ ...versionInput, datasetId: "" })
    ).toThrow(/datasetId/);
    expect(() =>
      createDatasetVersion({ ...versionInput, recordCount: -1 })
    ).toThrow(/recordCount/);
    expect(() =>
      createDatasetVersion({ ...versionInput, publishedAt: Number.NaN })
    ).toThrow(/publishedAt/);
  });
});

describe("decision reuse", () => {
  it("requires human confirmation before exact reuse", () => {
    const proposed = unconfirmed();
    expect(canReuseDecision(proposed, identity)).toBe(false);
    expect(decisionReuseMismatches(proposed, identity)).toEqual([
      "notConfirmed"
    ]);
    const confirmed = confirmDecision(proposed, {
      confirmedBy: "human-1",
      confirmedAt: 130
    });
    expect(Object.isFrozen(confirmed)).toBe(true);
    expect(canReuseDecision(confirmed, identity)).toBe(true);
    expect(
      confirmDecision(confirmed, {
        confirmedBy: "other-human",
        confirmedAt: 140
      })
    ).toBe(confirmed);
  });

  it("compares every required identity component exactly", () => {
    const confirmed = confirmDecision(unconfirmed(), {
      confirmedBy: "human-1",
      confirmedAt: 130
    });
    const expectedFields = [
      "shopId",
      "productId",
      "normalizedTitleDigest",
      "targetRecordDigest",
      "matcherVersion",
      "ruleVersion"
    ] as const;
    for (const field of expectedFields) {
      const changed = { ...identity, [field]: `${identity[field]}-changed` };
      expect(canReuseDecision(confirmed, changed)).toBe(false);
      expect(decisionReuseMismatches(confirmed, changed)).toEqual([field]);
      expect(decisionReuseIdentityEquals(identity, changed)).toBe(false);
    }
    expect(decisionReuseIdentityEquals(identity, { ...identity })).toBe(true);
  });

  it("does not invalidate a confirmed decision for unrelated dataset changes", () => {
    const firstVersion = createDatasetVersion(versionInput);
    const decision = confirmDecision(
      createUnconfirmedDecision({
        decisionId: "decision-1",
        dataset: datasetRef(firstVersion),
        reuseIdentity: identity,
        decision: "target-1",
        decidedAt: 120
      }),
      { confirmedBy: "human-1", confirmedAt: 130 }
    );
    const datasetWithUnrelatedChange = createDatasetVersion({
      ...versionInput,
      versionId: "version-2",
      contentDigest: "sha256:content-b",
      recordIndexDigest: "sha256:index-b",
      recordCount: 3
    });

    expect(
      refersToDatasetVersion(decision.dataset, datasetWithUnrelatedChange)
    ).toBe(false);
    expect(canReuseDecision(decision, identity)).toBe(true);
  });

  it("validates decision and confirmation audit fields", () => {
    expect(() =>
      createUnconfirmedDecision({
        decisionId: "",
        dataset: {
          datasetId: "dataset-1",
          versionId: "version-1",
          contentDigest: "digest"
        },
        reuseIdentity: identity,
        decision: null,
        decidedAt: 1
      })
    ).toThrow(/decisionId/);
    expect(() =>
      createUnconfirmedDecision({
        decisionId: "decision-1",
        dataset: {
          datasetId: "dataset-1",
          versionId: "version-1",
          contentDigest: "digest"
        },
        reuseIdentity: { ...identity, matcherVersion: "" },
        decision: null,
        decidedAt: 1
      })
    ).toThrow(/matcherVersion/);
    expect(() =>
      confirmDecision(unconfirmed(), {
        confirmedBy: "human-1",
        confirmedAt: 110
      })
    ).toThrow(/cannot precede/);
  });
});
