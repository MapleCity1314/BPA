import { describe, expect, it } from "vitest";
import {
  createDesignModeSession,
  designModeSessionIssues,
  evaluateDesignModeSession,
  isExactOrigin,
  publishPageAssetCandidate,
  stopDesignModeSession,
  validateElementContractDefinition,
  validateElementContractEvidence,
  validatePageAssetCandidate,
  validatePageModel,
  validateSnapshotMetadata,
  type ElementContract,
  type PageAssetCandidate,
  type PageModel,
  type PageSnapshotMetadata
} from "./index.js";

const origin = "https://fxg.jinritemai.com";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const digestD = `sha256:${"d".repeat(64)}`;

const contract: ElementContract = {
  apiVersion: "bpa.page/v1alpha1",
  kind: "ElementContract",
  metadata: {
    id: "product.save",
    version: "1.0.0",
    title: "商品保存"
  },
  intent: "保存当前商品编辑",
  scope: {
    origins: [origin],
    pathPattern: "/ffa/g/create*",
    pageState: "product-edit-ready",
    frame: "top"
  },
  expectedCount: { minimum: 1, maximum: 1 },
  candidates: [
    { strategy: "business-id", value: "product-save" },
    { strategy: "role-name", role: "button", name: "保存" },
    { strategy: "label", label: "保存商品" },
    { strategy: "attribute", name: "data-testid", value: "product-save" },
    {
      strategy: "relative-anchor",
      anchor: "product.form-actions",
      role: "button",
      name: "保存"
    },
    { strategy: "css-diagnostic", selector: "[data-testid='product-save']" }
  ],
  preconditions: ["page-identity-confirmed", "form-not-submitting"],
  postconditions: ["save-result-visible"],
  volatility: "medium",
  validatedSnapshots: [digestA, digestB]
};

const formActionsContract: ElementContract = {
  apiVersion: "bpa.page/v1alpha1",
  kind: "ElementContract",
  metadata: {
    id: "product.form-actions",
    version: "1.0.0",
    title: "商品表单操作区"
  },
  intent: "定位商品表单操作区",
  scope: {
    origins: [origin],
    pathPattern: "/ffa/g/create*",
    pageState: "product-edit-ready",
    frame: "top"
  },
  expectedCount: { minimum: 1, maximum: 1 },
  candidates: [{ strategy: "business-id", value: "product-form-actions" }],
  preconditions: ["page-identity-confirmed"],
  postconditions: [],
  volatility: "low",
  validatedSnapshots: [digestA, digestB]
};

const model: PageModel = {
  apiVersion: "bpa.page/v1alpha1",
  kind: "PageModel",
  metadata: {
    id: "doudian.product-editor",
    version: "1.0.0",
    title: "抖店商品编辑页"
  },
  adapter: { id: "doudian", version: "2.0.0", digest: digestC },
  origins: [origin],
  states: [
    {
      id: "product-edit-ready",
      pathPattern: "/ffa/g/create*",
      fingerprint: digestD
    }
  ],
  elements: [
    {
      id: "product.form-actions",
      contract: {
        id: "product.form-actions",
        version: "1.0.0",
        digest: digestC
      }
    },
    {
      id: "product.save",
      contract: { id: "product.save", version: "1.0.0", digest: digestD }
    }
  ],
  fixtureDigests: [digestA, digestB]
};

function snapshot(
  snapshotId: string,
  contentDigest: string
): PageSnapshotMetadata {
  return {
    snapshotId,
    source: "fixture",
    capturedAt: "2026-07-28T01:00:00.000Z",
    origin,
    path: "/ffa/g/create?product_id=100",
    pageState: "product-edit-ready",
    contentDigest,
    redaction: {
      applied: true,
      policyVersion: "redaction-v1",
      coverage: {
        passwords: true,
        tokens: true,
        cookies: true,
        hiddenInputs: true,
        personalData: true,
        largeText: true
      }
    },
    rawEvidenceExpiresAt: "2026-07-29T00:59:59.000Z"
  };
}

function pageAssetCandidate(): PageAssetCandidate {
  return {
    candidateId: "doudian-product-editor-v1",
    status: "candidate",
    pageModel: structuredClone(model),
    contracts: [
      { definition: structuredClone(formActionsContract), digest: digestC },
      { definition: structuredClone(contract), digest: digestD }
    ],
    implementations: [
      {
        kind: "declarative-read",
        elementId: "product.form-actions",
        projection: { kind: "presence" }
      },
      {
        kind: "adapter-handler",
        elementId: "product.save",
        handler: {
          id: "doudian.product.save-handler",
          version: "1.0.0",
          digest: digestD
        }
      }
    ],
    createdAt: "2026-07-28T01:00:00.000Z"
  };
}

describe("canonical PageModel and ElementContract definitions", () => {
  it("uses the bpa.page/v1alpha1 serialized DTO shape", () => {
    expect(validatePageModel(model)).toEqual([]);
    expect(
      validateElementContractDefinition(contract, {
        allowedOrigins: model.origins,
        knownPageStates: model.states.map((state) => state.id),
        knownElementIds: model.elements.map((element) => element.id)
      })
    ).toEqual([]);
    expect(model).toMatchObject({
      apiVersion: "bpa.page/v1alpha1",
      kind: "PageModel",
      fixtureDigests: [digestA, digestB]
    });
    expect(contract.expectedCount).toEqual({ minimum: 1, maximum: 1 });
  });

  it("rejects origin paths, CSS-only contracts, XPath, coordinates and JS", () => {
    const invalid = structuredClone(contract);
    invalid.scope.origins = [`${origin}/ffa`];
    invalid.candidates = [
      { strategy: "css-diagnostic", selector: "div:nth-child(2)" },
      { strategy: "xpath" } as never,
      { strategy: "coordinate", x: 10, y: 20 } as never,
      {
        strategy: "attribute",
        name: "onclick",
        value: "javascript:window.save()"
      }
    ];
    const issues = validateElementContractDefinition(invalid);
    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "INVALID_ORIGIN",
        "INVALID_LOCATOR",
        "FORBIDDEN_LOCATOR"
      ])
    );

    const cssOnly = structuredClone(contract);
    cssOnly.candidates = [
      { strategy: "css-diagnostic", selector: "[data-testid='save']" }
    ];
    expect(validateElementContractDefinition(cssOnly)).toContainEqual(
      expect.objectContaining({ code: "CSS_DIAGNOSTIC_ONLY" })
    );
  });

  it("requires canonical metadata, state, count range and two snapshots", () => {
    const invalid = structuredClone(contract);
    invalid.metadata.id = "Invalid Element";
    invalid.metadata.version = "latest";
    invalid.metadata.title = "";
    invalid.intent = "";
    invalid.scope.origins = [];
    invalid.scope.pathPattern = "https://example.com/(.*)";
    invalid.scope.pageState = "unknown-state";
    invalid.expectedCount = { minimum: 2, maximum: 1 };
    invalid.candidates = [];
    invalid.validatedSnapshots = [digestA, digestA];
    expect(
      validateElementContractDefinition(invalid, {
        knownPageStates: ["product-edit-ready"]
      }).map((entry) => entry.code)
    ).toEqual(
      expect.arrayContaining([
        "INVALID_IDENTITY",
        "INVALID_ORIGIN",
        "INVALID_PATH_PATTERN",
        "INVALID_PAGE_STATE",
        "INVALID_EXPECTED_COUNT",
        "INVALID_LOCATOR",
        "INSUFFICIENT_EVIDENCE"
      ])
    );
  });

  it("validates each semantic locator and relative anchor closure", () => {
    const invalid = structuredClone(contract);
    invalid.candidates = [
      { strategy: "business-id", value: "" },
      { strategy: "role-name", role: "", name: "" },
      { strategy: "label", label: "" },
      { strategy: "attribute", name: "style", value: "" },
      {
        strategy: "relative-anchor",
        anchor: "missing.anchor",
        role: "",
        name: ""
      }
    ];
    const issues = validateElementContractDefinition(invalid, {
      knownElementIds: ["product.form-actions"]
    });
    expect(
      issues.filter((entry) => entry.code === "INVALID_LOCATOR").length
    ).toBeGreaterThanOrEqual(6);
  });

  it("validates the PageModel Adapter closure, refs and fixtures", () => {
    const invalid = structuredClone(model);
    invalid.metadata.id = "Invalid Model";
    invalid.adapter.version = "latest";
    invalid.adapter.digest = "invalid";
    invalid.origins = ["not a url", "not a url"];
    invalid.states.push({
      id: "product-edit-ready",
      pathPattern: "(invalid)",
      fingerprint: "invalid"
    });
    invalid.elements.push(structuredClone(invalid.elements[0]!));
    invalid.elements[0]!.contract.version = "latest";
    invalid.fixtureDigests = [digestA];
    expect(validatePageModel(invalid).map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "INVALID_IDENTITY",
        "INVALID_ORIGIN",
        "INVALID_PAGE_STATE",
        "DUPLICATE_ID",
        "INSUFFICIENT_EVIDENCE"
      ])
    );
    expect(isExactOrigin("this is not a URL")).toBe(false);
  });
});

describe("redacted fixture evidence", () => {
  it("finds semantic locators stable across both validated snapshots", () => {
    const result = validateElementContractEvidence(contract, [
      {
        snapshot: snapshot("snapshot-a", digestA),
        matchCounts: [1, 1, 1, 1, 1, 1]
      },
      {
        snapshot: snapshot("snapshot-b", digestB),
        matchCounts: [1, 2, 1, 1, 1, 1]
      }
    ]);
    expect(result.valid).toBe(true);
    expect(result.stableCandidateIndexes).toEqual([0, 2, 3, 4]);
  });

  it("fails closed when closure evidence is missing or count drifts", () => {
    const result = validateElementContractEvidence(contract, [
      {
        snapshot: snapshot("snapshot-a", digestA),
        matchCounts: [2, 0, 0, 0, 0, 1]
      }
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "INSUFFICIENT_EVIDENCE",
        "COUNT_MISMATCH"
      ])
    );
  });

  it("rejects malformed context, redaction, retention and match arrays", () => {
    const malformed = snapshot("snapshot-a", digestA);
    malformed.origin = "https://other.example.com";
    malformed.path = "relative";
    malformed.contentDigest = "not-a-digest";
    malformed.capturedAt = "not-a-time";
    malformed.redaction.coverage.tokens = false as never;
    malformed.rawEvidenceExpiresAt = "2026-07-30T01:00:00.000Z";
    const result = validateElementContractEvidence(contract, [
      { snapshot: malformed, matchCounts: [-1] },
      {
        snapshot: snapshot("snapshot-b", digestB),
        matchCounts: [1, 1.5, 1, 1, 1, 1]
      }
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["INVALID_SNAPSHOT", "COUNT_MISMATCH"])
    );
    expect(validateSnapshotMetadata(malformed).length).toBeGreaterThanOrEqual(3);
  });
});

describe("Page asset Candidate boundary", () => {
  it("separates simple declarative reads from reviewed complex handlers", () => {
    const candidate = pageAssetCandidate();
    expect(validatePageAssetCandidate(candidate)).toEqual([]);
    expect(candidate.implementations.map((entry) => entry.kind)).toEqual([
      "declarative-read",
      "adapter-handler"
    ]);
  });

  it("requires complete refs, one implementation and safe projections", () => {
    const candidate = pageAssetCandidate();
    candidate.contracts.pop();
    candidate.implementations[0] = {
      kind: "declarative-read",
      elementId: "unknown.element",
      projection: { kind: "attribute", name: "onclick" }
    };
    candidate.implementations.push({
      kind: "adapter-handler",
      elementId: "product.save",
      handler: { id: "Invalid Handler", version: "latest", digest: "bad" }
    });
    expect(
      validatePageAssetCandidate(candidate).map((entry) => entry.code)
    ).toEqual(
      expect.arrayContaining(["INVALID_CANDIDATE"])
    );
  });

  it("publishes only a valid Candidate after explicit human approval", () => {
    const candidate = pageAssetCandidate();
    const publication = publishPageAssetCandidate({
      asset: candidate,
      approval: {
        actorType: "human",
        actorId: "reviewer-01",
        approvedAt: "2026-07-28T02:00:00.000Z"
      },
      publicationDigest: digestC
    });
    expect(publication).toMatchObject({
      status: "published",
      approvedBy: "reviewer-01"
    });
    expect(publication.pageModel).not.toBe(candidate.pageModel);

    expect(() =>
      publishPageAssetCandidate({
        asset: { ...candidate, status: "published" } as never,
        approval: {
          actorType: "ai" as never,
          actorId: "codex",
          approvedAt: "2026-07-28T02:00:00.000Z"
        },
        publicationDigest: digestC
      })
    ).toThrow(/rejected/);
  });
});

describe("Design Mode lifecycle", () => {
  it("binds an exact read-only session and expires after 15 minutes", () => {
    const session = createDesignModeSession({
      sessionId: "design-session",
      extensionId: "extension-a",
      profileId: "profile-a",
      tabId: 17,
      origin,
      now: "2026-07-28T01:00:00.000Z"
    });
    expect(session.permission).toBe("page-model.design.read");
    expect(
      evaluateDesignModeSession(
        session,
        "2026-07-28T01:14:59.999Z"
      ).state
    ).toBe("active");
    expect(
      evaluateDesignModeSession(
        session,
        "2026-07-28T01:15:00.000Z"
      ).state
    ).toBe("expired");
  });

  it("stops explicitly and rejects invalid binding or excessive TTL", () => {
    const session = createDesignModeSession({
      sessionId: "design-session",
      extensionId: "extension-a",
      profileId: "profile-a",
      tabId: 17,
      origin,
      now: "2026-07-28T01:00:00.000Z",
      ttlMs: 1000
    });
    expect(
      stopDesignModeSession(session, "2026-07-28T01:00:00.500Z")
    ).toMatchObject({ state: "stopped" });
    expect(() =>
      createDesignModeSession({
        sessionId: "design-session",
        extensionId: "extension-a",
        profileId: "profile-a",
        tabId: 17,
        origin: `${origin}/path`,
        now: "2026-07-28T01:00:00.000Z",
        ttlMs: 15 * 60 * 1000 + 1
      })
    ).toThrow(/exact binding/);
  });

  it("reports expired or malformed persisted Design Mode state", () => {
    const session = createDesignModeSession({
      sessionId: "design-session",
      extensionId: "extension-a",
      profileId: "profile-a",
      tabId: 17,
      origin,
      now: "2026-07-28T01:00:00.000Z",
      ttlMs: 1000
    });
    expect(
      designModeSessionIssues(session, "2026-07-28T01:00:01.000Z")
    ).toContainEqual(
      expect.objectContaining({ path: "/designMode/state" })
    );
    const stopped = stopDesignModeSession(
      session,
      "2026-07-28T01:00:00.500Z"
    );
    expect(
      evaluateDesignModeSession(stopped, "2026-07-28T02:00:00.000Z")
    ).toEqual(stopped);
    expect(() =>
      evaluateDesignModeSession(
        { ...stopped, state: "active", expiresAt: "invalid" },
        "also-invalid"
      )
    ).toThrow(/timestamps/);
    expect(
      designModeSessionIssues(
        {
          ...stopped,
          state: "active",
          permission: "invalid" as never,
          expiresAt: "invalid"
        },
        "invalid"
      )
    ).toContainEqual(
      expect.objectContaining({ code: "INVALID_DESIGN_SESSION" })
    );
  });
});
