import { describe, expect, it } from "vitest";
import {
  validateDataset,
  validateDecisionRecord
} from "@bpa/schemas";
import {
  canReuseDecision,
  confirmDecisionCandidate,
  createDecisionCandidate,
  datasetRef,
  datasetRefEquals,
  decisionReuseMismatches,
  publishDataset,
  publishedDatasetFromDefinition,
  revokeDecision,
  supersedeDecision,
  toDatasetVersionDefinition,
  toDecisionRecordDefinition
} from "./index.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const digestD = `sha256:${"d".repeat(64)}`;
const digestE = `sha256:${"e".repeat(64)}`;
const digestF = `sha256:${"f".repeat(64)}`;

const descriptor = {
  id: "dataset-1",
  version: "1.0.0",
  title: "Reference data",
  profile: { id: "profile-1", version: "1.0.0" },
  source: {
    fileName: "source.data",
    mediaType: "application/octet-stream",
    size: 100,
    digest: digestA
  },
  recordSchema: { type: "object" },
  recordCount: 2,
  recordsDigest: digestB
};

const scope = { tenant: "tenant-1", object: "object-1" };
const preconditions = {
  subject: digestC,
  target: digestD,
  matcher: digestE,
  rules: digestF
};

function candidate(
  decisionId = "decision-1",
  value: unknown = { target: "record-1" }
) {
  return createDecisionCandidate({
    decisionId,
    decisionType: "binding",
    scope,
    preconditions,
    value,
    valueDigest: digestA,
    proposedAt: "2026-07-28T00:00:00.000Z"
  });
}

function active() {
  return confirmDecisionCandidate(candidate(), {
    confirmedBy: "human-1",
    confirmedAt: "2026-07-28T00:00:01.000Z"
  });
}

describe("canonical dataset boundary", () => {
  it("publishes a descriptor as an immutable canonical DTO", () => {
    const published = publishDataset(descriptor, {
      publishedAt: "2026-07-28T00:00:00.000Z"
    });
    expect(Object.isFrozen(published)).toBe(true);
    const definition = toDatasetVersionDefinition(published);
    expect(definition).toMatchObject({
      apiVersion: "bpa.data/v1alpha1",
      kind: "DatasetVersion",
      metadata: { id: "dataset-1", version: "1.0.0" },
      recordsDigest: digestB
    });
    expect(validateDataset(definition)).toBe(true);
    expect(
      publishedDatasetFromDefinition(published.definition, {
        publishedAt: published.publishedAt
      })
    ).toEqual(published);
  });

  it("derives an exact id/version/digest reference", () => {
    const first = datasetRef(
      publishDataset(descriptor, { publishedAt: "2026-07-28T00:00:00Z" })
    );
    expect(first).toEqual({
      id: "dataset-1",
      version: "1.0.0",
      digest: digestB
    });
    expect(datasetRefEquals(first, { ...first })).toBe(true);
    expect(datasetRefEquals(first, { ...first, digest: "changed" })).toBe(
      false
    );
  });

  it("rejects malformed descriptors", () => {
    expect(() =>
      publishDataset(
        { ...descriptor, recordsDigest: "" },
        { publishedAt: "2026-07-28T00:00:00Z" }
      )
    ).toThrow(/recordsDigest/);
    expect(() =>
      publishDataset(
        { ...descriptor, recordCount: -1 },
        { publishedAt: "2026-07-28T00:00:00Z" }
      )
    ).toThrow(/counts/);
    expect(() =>
      publishDataset(descriptor, { publishedAt: "invalid" })
    ).toThrow(/publishedAt/);
  });
});

describe("canonical decision lifecycle", () => {
  it("keeps an unconfirmed proposal as DecisionCandidate", () => {
    const proposed = candidate();
    expect(proposed).not.toHaveProperty("status");
    expect(Object.isFrozen(proposed)).toBe(true);
    expect(() =>
      createDecisionCandidate({
        ...proposed,
        scope: {},
        proposedAt: proposed.proposedAt
      })
    ).toThrow(/scope/);
  });

  it("confirms a candidate into an active canonical DecisionRecord", () => {
    const record = active();
    expect(record).toMatchObject({
      apiVersion: "bpa.decision/v1alpha1",
      status: "active",
      confirmedBy: "human-1"
    });
    expect(toDecisionRecordDefinition(record)).toBe(record);
    expect(validateDecisionRecord(toDecisionRecordDefinition(record))).toBe(
      true
    );
    expect(() =>
      confirmDecisionCandidate(candidate(), {
        confirmedBy: "human-1",
        confirmedAt: "2026-07-27T00:00:00.000Z"
      })
    ).toThrow(/cannot precede/);
  });

  it("revokes an active record and prevents its reuse", () => {
    const revoked = revokeDecision(active(), {
      revokedBy: "human-2",
      revokedAt: "2026-07-28T00:00:02.000Z"
    });
    expect(revoked).toMatchObject({
      status: "revoked",
      revokedBy: "human-2"
    });
    expect(canReuseDecision(revoked, { scope, preconditions })).toBe(false);
    expect(decisionReuseMismatches(revoked, { scope, preconditions })).toEqual(
      ["status"]
    );
    expect(() =>
      revokeDecision(revoked, {
        revokedBy: "human-2",
        revokedAt: "2026-07-28T00:00:03.000Z"
      })
    ).toThrow(/Only an active/);
  });

  it("supersedes an active record with an explicitly confirmed replacement", () => {
    const result = supersedeDecision(
      active(),
      candidate("decision-2", { target: "record-2" }),
      {
        confirmedBy: "human-2",
        confirmedAt: "2026-07-28T00:00:02.000Z"
      }
    );
    expect(result.superseded.status).toBe("superseded");
    expect(result.replacement).toMatchObject({
      status: "active",
      supersedes: "decision-1",
      decisionId: "decision-2"
    });
    expect(
      canReuseDecision(result.superseded, { scope, preconditions })
    ).toBe(false);
    expect(
      canReuseDecision(result.replacement, { scope, preconditions })
    ).toBe(true);
  });

  it("requires exact active scope and preconditions for reuse", () => {
    const record = active();
    expect(canReuseDecision(record, { scope, preconditions })).toBe(true);
    expect(
      decisionReuseMismatches(record, {
        scope: { ...scope, extra: "value" },
        preconditions: { ...preconditions, rules: "changed" }
      })
    ).toEqual(["scope", "preconditions"]);
    expect(
      canReuseDecision(record, {
        scope,
        preconditions: { ...preconditions, unrelatedDatasetDigest: "changed" }
      })
    ).toBe(false);
  });

  it("rejects a replacement for a different type or scope", () => {
    expect(() =>
      supersedeDecision(
        active(),
        createDecisionCandidate({
          ...candidate("decision-2"),
          decisionType: "other-type",
          proposedAt: "2026-07-28T00:00:00.000Z"
        }),
        {
          confirmedBy: "human-2",
          confirmedAt: "2026-07-28T00:00:02.000Z"
        }
      )
    ).toThrow(/same decision type and scope/);
  });
});
