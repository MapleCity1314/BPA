import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CHUNK_BYTES,
  declareEvidence,
  digestBytes
} from "@bpa/evidence-core";
import {
  type AssetRecordDefinition,
  AuthoringConflictError,
  AuthoringOperationConflictError,
  CandidateBundleConflictError,
  DesignModeGrantConflictError,
  RevisionConflictError,
  type AuthoringScenarioRecord,
  type AuthoringSessionDefinition,
  type BrowserSessionRecord,
  type CandidateBundleDefinition,
  type CandidateBundleValidationRecord,
  type DesignModeGrantRecord,
  type PageSnapshotDefinition,
  type ScenarioSpecDefinition,
  type SourceRecordDefinition
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-07-30T02:00:00.000Z";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function example<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../../docs/protocols/examples/${name}`, import.meta.url),
      "utf8"
    )
  ) as T;
}

function scenarioRecord(): AuthoringScenarioRecord {
  const scenario = example<ScenarioSpecDefinition>(
    "authoring-scenario-spec-v1alpha1.example.json"
  );
  return {
    scenario,
    digest: digest(scenario),
    createdAt: timestamp
  };
}

function session(
  scenario: AuthoringScenarioRecord = scenarioRecord()
): AuthoringSessionDefinition {
  const value = example<AuthoringSessionDefinition>(
    "authoring-session-v1alpha1.example.json"
  );
  return {
    ...value,
    revision: 0,
    state: "intake",
    scenarioRef: {
      id: scenario.scenario.metadata.id,
      version: scenario.scenario.metadata.version,
      digest: scenario.digest
    },
    catalogSelections: [],
    capabilityGaps: [],
    designGrantRefs: [],
    snapshotRefs: [],
    appliedOperationIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function nextSession(
  current: AuthoringSessionDefinition,
  state: AuthoringSessionDefinition["state"],
  operationId: string,
  overrides: Partial<AuthoringSessionDefinition> = {}
): AuthoringSessionDefinition {
  return {
    ...current,
    ...overrides,
    revision: current.revision + 1,
    state,
    appliedOperationIds: [
      ...current.appliedOperationIds,
      operationId
    ],
    updatedAt: new Date(
      Date.parse(current.updatedAt) + 1000
    ).toISOString()
  };
}

function browserSession(id = "browser-session-001"): BrowserSessionRecord {
  return {
    id,
    browserInstanceId: "browser-instance-authoring",
    extensionId: "extension-authoring",
    extensionVersion: "0.4.0",
    protocolVersion: "1.0.0",
    incomingSeq: 0,
    outgoingSeq: 0,
    lastAckedCommandSeq: 0,
    resumeTokenDigest: `sha256:${"b".repeat(64)}`,
    resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
    connectedAt: timestamp
  };
}

function grant(): DesignModeGrantRecord {
  return {
    grantId: "design-grant-001",
    authoringSessionId: "authoring-session-001",
    revision: 0,
    state: "requested",
    approvedBy: "user:local",
    browserSessionId: "browser-session-001",
    profileId: "chrome-profile-research",
    tabId: 42,
    origin: "https://www.chanmama.com",
    pageEpoch: "page-epoch-8",
    allowedOperations: ["semantic_snapshot"],
    issuedAt: "2026-07-30T02:00:00.000Z",
    expiresAt: "2026-07-30T02:15:00.000Z",
    updatedAt: "2026-07-30T02:00:00.000Z"
  };
}

function seedCaptureEvidence(database: SqlitePersistence) {
  const runId = "run-design-capture-001";
  const nodeExecutionId = "node-execution-capture-001";
  const evidenceId = "evidence-page-snapshot-001";
  const assetId = "asset-page-snapshot-001";
  const fencingToken = 3;
  database.createRun({
    run: {
      id: runId,
      workflowId: "authoring.snapshot.capture",
      workflowVersion: "1.0.0",
      workflowDigest: `sha256:${"a".repeat(64)}`,
      status: "running",
      revision: 0,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      id: "event-design-capture-run",
      runId,
      sequence: 1,
      type: "run.created",
      payload: {},
      occurredAt: timestamp
    }
  });
  database.createNodeExecution(
    {
      id: nodeExecutionId,
      runId,
      nodeKey: "capture",
      nodeId: "browser.design.snapshot.capture",
      nodeVersion: "1.0.0",
      status: "dispatched",
      revision: 0,
      attempt: 1,
      idempotencyKey: "idempotency-design-capture",
      fencingToken,
      input: {},
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "event-design-capture-node",
      runId,
      nodeExecutionId,
      sequence: 2,
      type: "node.dispatched",
      payload: {},
      occurredAt: timestamp
    }
  );
  database.enqueueCommand(
    {
      id: "command-design-capture",
      nodeExecutionId,
      commandSeq: database.nextGatewayCommandSequence(),
      idempotencyKey: "command-idempotency-design-capture",
      fencingToken,
      state: "queued",
      payload: {
        run_id: runId,
        node_execution_id: nodeExecutionId,
        fencing_token: fencingToken
      },
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "outbox-design-capture",
      topic: "browser.command",
      aggregateId: "command-design-capture",
      payload: {},
      createdAt: timestamp
    }
  );
  const body = Buffer.from(
    JSON.stringify({ semanticNodes: [{ role: "heading" }] }),
    "utf8"
  );
  const bodyDigest = digestBytes(body);
  database.putStagingLease({
    leaseId: "lease-design-capture",
    runId,
    tokenDigest: `sha256:${"c".repeat(64)}`,
    maxBytes: 5 * 1024 * 1024,
    state: "active",
    createdAt: timestamp,
    expiresAt: "2026-07-31T00:00:00.000Z"
  });
  const transfer = declareEvidence(
    {
      evidenceId,
      runId,
      nodeExecutionId,
      sessionId: grant().browserSessionId,
      fencingToken,
      kind: "dom_summary",
      mediaType: "application/json",
      size: body.length,
      digest: bodyDigest,
      chunkSize: EVIDENCE_CHUNK_BYTES,
      chunkCount: 1,
      classification: "restricted",
      stagingLeaseId: "lease-design-capture"
    },
    { now: () => new Date(timestamp) }
  );
  expect(database.declareEvidence(transfer).status).toBe("accepted");
  expect(
    database.commitEvidenceChunk({
      evidenceId,
      chunk: {
        evidenceId,
        index: 0,
        digest: bodyDigest,
        size: body.length,
        receivedAt: timestamp
      }
    }).status
  ).toBe("accepted");
  database.completeEvidence({
    evidenceId,
    blob: {
      digest: bodyDigest,
      size: body.length,
      mediaType: "application/json",
      storageRef: `asset-store:${bodyDigest}`,
      createdAt: timestamp
    }
  });
  database.acknowledgeEvidence(
    evidenceId,
    "2026-07-30T02:02:00.000Z"
  );
  const source = example<SourceRecordDefinition>(
    "source-record-v1alpha1.example.json"
  );
  database.putSourceRecord({
    ...source,
    sourceId: "source-page-snapshot-001",
    observedAt: "2026-07-30T02:02:00.000Z",
    recordedAt: "2026-07-30T02:02:00.000Z",
    rawDigest: bodyDigest,
    classification: "restricted"
  });
  const asset = example<AssetRecordDefinition>(
    "asset-record-v1alpha1.example.json"
  );
  database.putAssetRecord({
    ...asset,
    assetId,
    digest: bodyDigest,
    size: body.length,
    mediaType: "application/json",
    storageRef: `asset-store:${bodyDigest}`,
    classification: "restricted",
    sourceIds: ["source-page-snapshot-001"],
    createdAt: "2026-07-30T02:02:00.000Z",
    retention: {
      policy: "restricted_24h",
      retainUntil: "2026-07-31T02:02:00.000Z"
    }
  });
  return {
    runId,
    nodeExecutionId,
    evidenceId,
    assetId,
    bodyDigest,
    sizeBytes: body.length
  };
}

function persistence(
  failureInjector?: (point: string) => void
): SqlitePersistence {
  let id = 0;
  return new SqlitePersistence({
    path: ":memory:",
    clock: () => new Date(timestamp),
    idFactory: () => `audit:authoring:${id++}`,
    ...(failureInjector ? { failureInjector } : {})
  });
}

function seedAuthoring(database: SqlitePersistence): AuthoringSessionDefinition {
  const scenario = scenarioRecord();
  database.putAuthoringScenario(scenario);
  const initial = session(scenario);
  database.createAuthoringSession(initial);
  return initial;
}

function advance(
  database: SqlitePersistence,
  current: AuthoringSessionDefinition,
  state: AuthoringSessionDefinition["state"],
  operationId: string
): AuthoringSessionDefinition {
  const next = nextSession(current, state, operationId);
  expect(
    database.applyAuthoringSession({
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      operationId,
      next,
      actor: "codex:local"
    }).status
  ).toBe("accepted");
  return next;
}

function candidateBundle(
  current: AuthoringSessionDefinition
): CandidateBundleDefinition {
  const value = example<CandidateBundleDefinition>(
    "authoring-candidate-bundle-v1alpha1.example.json"
  );
  return {
    ...value,
    scenarioRef: current.scenarioRef,
    authoringSession: {
      id: current.sessionId,
      revision: current.revision
    },
    createdAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString()
  };
}

function validationResults(
  bundle: CandidateBundleDefinition
): CandidateBundleValidationRecord[] {
  return (
    [
      "schema",
      "contracts",
      "replay",
      "permissions",
      "risk"
    ] as const
  ).map((checkType) => ({
    bundleId: bundle.metadata.id,
    checkType,
    valid: bundle.validation[checkType].valid,
    issueCount: bundle.validation[checkType].issueCount,
    createdAt: bundle.createdAt
  }));
}

function prepareValidationSession(database: SqlitePersistence) {
  let current = seedAuthoring(database);
  current = advance(database, current, "catalog", "operation-catalog");
  current = advance(database, current, "assembly", "operation-assembly");
  current = advance(database, current, "validation", "operation-validation");
  return current;
}

function prepareCaptureSession(database: SqlitePersistence) {
  let current = seedAuthoring(database);
  current = advance(database, current, "catalog", "operation-catalog");
  current = advance(database, current, "discovery", "operation-discovery");
  current = advance(database, current, "modeling", "operation-modeling");
  database.openBrowserSession({
    session: browserSession(),
    now: timestamp
  });
  database.putDesignModeGrant(grant());
  database.transitionDesignModeGrant({
    grantId: grant().grantId,
    expectedRevision: 0,
    nextState: "active",
    actor: "user:local",
    occurredAt: "2026-07-30T02:01:00.000Z"
  });
  const provenance = seedCaptureEvidence(database);
  const snapshot = example<PageSnapshotDefinition>(
    "authoring-page-snapshot-v1alpha1.example.json"
  );
  const exactSnapshot: PageSnapshotDefinition = {
    ...snapshot,
    capturedAt: "2026-07-30T02:08:00.000Z",
    captureSource: {
      runId: provenance.runId,
      nodeExecutionId: provenance.nodeExecutionId,
      evidenceId: provenance.evidenceId,
      assetRef: {
        id: provenance.assetId,
        digest: provenance.bodyDigest,
        sizeBytes: provenance.sizeBytes
      }
    },
    contentDigest: digest({
      pageState: snapshot.pageState,
      semanticNodes: snapshot.semanticNodes
    }),
    sizeBytes: provenance.sizeBytes,
    rawEvidenceExpiresAt: "2026-07-31T02:08:00.000Z"
  };
  return { current, snapshot: exactSnapshot };
}

describe("SQLite v9 Authoring Session persistence", () => {
  it("stores immutable ScenarioSpec and CAS revision history with Audit", () => {
    const database = persistence();
    const scenario = scenarioRecord();
    expect(database.putAuthoringScenario(scenario).status).toBe("accepted");
    expect(database.putAuthoringScenario(scenario).status).toBe("duplicate");
    expect(
      database.getAuthoringScenario(
        scenario.scenario.metadata.id,
        scenario.scenario.metadata.version
      )
    ).toEqual(scenario);
    expect(() =>
      database.putAuthoringScenario({
        ...scenario,
        scenario: {
          ...scenario.scenario,
          businessGoal: "changed"
        }
      })
    ).toThrow(AuthoringConflictError);

    const initial = session(scenario);
    expect(database.createAuthoringSession(initial)).toEqual(initial);
    const next = nextSession(initial, "catalog", "operation-catalog");
    const input = {
      sessionId: initial.sessionId,
      expectedRevision: 0,
      operationId: "operation-catalog",
      next,
      actor: "codex:local"
    };
    expect(database.applyAuthoringSession(input).status).toBe("accepted");
    expect(database.applyAuthoringSession(input)).toMatchObject({
      status: "duplicate",
      current: { revision: 1, state: "catalog" }
    });
    expect(
      database.applyAuthoringSession({
        ...input,
        operationId: "operation-stale",
        next: nextSession(initial, "catalog", "operation-stale")
      })
    ).toEqual({ status: "stale", actualRevision: 1 });
    expect(() =>
      database.applyAuthoringSession({
        ...input,
        next: { ...next, updatedAt: "2026-07-30T02:00:02.000Z" }
      })
    ).toThrow(AuthoringOperationConflictError);
    expect(
      database.getAuthoringSessionRevision(initial.sessionId, 0)?.session
    ).toEqual(initial);
    expect(
      database.getAuthoringSessionRevision(initial.sessionId, 1)?.session
    ).toEqual(next);
    expect(
      database
        .listAudit(`authoring-session:${initial.sessionId}`)
        .map((record) => record.action)
    ).toEqual([
      "authoring.session.created",
      "authoring.session.revised"
    ]);
    database.close();
  });

  it("rejects invalid state transitions and missing Scenario provenance", () => {
    const database = persistence();
    const scenario = scenarioRecord();
    const initial = session(scenario);
    expect(() => database.createAuthoringSession(initial)).toThrow(
      AuthoringConflictError
    );
    database.putAuthoringScenario(scenario);
    database.createAuthoringSession(initial);
    const invalid = nextSession(
      initial,
      "candidate",
      "operation-skip"
    );
    expect(() =>
      database.applyAuthoringSession({
        sessionId: initial.sessionId,
        expectedRevision: 0,
        operationId: "operation-skip",
        next: invalid,
        actor: "codex:local"
      })
    ).toThrow();
    expect(database.getAuthoringSession(initial.sessionId)?.revision).toBe(0);
    database.close();
  });

  it.each([
    "authoring.session.create.after_current",
    "authoring.session.create.after_history",
    "authoring.session.create.after_audit"
  ])("rolls back Session creation at %s", (failurePoint) => {
    let crash = false;
    const database = persistence((point) => {
      if (crash && point === failurePoint) throw new Error("crash");
    });
    const scenario = scenarioRecord();
    database.putAuthoringScenario(scenario);
    crash = true;
    expect(() => database.createAuthoringSession(session(scenario))).toThrow(
      "crash"
    );
    expect(
      database.getAuthoringSession("authoring-session-001")
    ).toBeUndefined();
    expect(
      database.getAuthoringSessionRevision("authoring-session-001", 0)
    ).toBeUndefined();
    database.close();
  });

  it.each([
    "authoring.session.apply.after_current",
    "authoring.session.apply.after_history",
    "authoring.session.apply.after_audit"
  ])("rolls back a Session revision at %s", (failurePoint) => {
    let crash = false;
    const database = persistence((point) => {
      if (crash && point === failurePoint) throw new Error("crash");
    });
    const initial = seedAuthoring(database);
    const operationId = "operation-catalog";
    const next = nextSession(initial, "catalog", operationId);
    crash = true;
    expect(() =>
      database.applyAuthoringSession({
        sessionId: initial.sessionId,
        expectedRevision: 0,
        operationId,
        next,
        actor: "codex:local"
      })
    ).toThrow("crash");
    expect(database.getAuthoringSession(initial.sessionId)).toEqual(initial);
    expect(
      database.getAuthoringSessionRevision(initial.sessionId, 1)
    ).toBeUndefined();
    database.close();
  });
});

describe("SQLite v9 Design Mode Grant persistence", () => {
  it("freezes an exact 15-minute binding and enforces terminal transitions", () => {
    const database = persistence();
    seedAuthoring(database);
    const sessionRecord = browserSession();
    database.openBrowserSession({
      session: sessionRecord,
      now: timestamp
    });
    expect(database.putDesignModeGrant(grant())).toEqual(grant());
    const active = database.transitionDesignModeGrant({
      grantId: grant().grantId,
      expectedRevision: 0,
      nextState: "active",
      actor: "user:local",
      occurredAt: "2026-07-30T02:01:00.000Z"
    });
    expect(active).toMatchObject({ revision: 1, state: "active" });
    expect(() =>
      database.transitionDesignModeGrant({
        grantId: grant().grantId,
        expectedRevision: 0,
        nextState: "stopped",
        actor: "user:local",
        occurredAt: "2026-07-30T02:02:00.000Z"
      })
    ).toThrow(RevisionConflictError);
    const stopped = database.transitionDesignModeGrant({
      grantId: grant().grantId,
      expectedRevision: 1,
      nextState: "stopped",
      actor: "user:local",
      occurredAt: "2026-07-30T02:02:00.000Z",
      reason: "capture complete"
    });
    expect(stopped).toMatchObject({
      revision: 2,
      state: "stopped",
      terminalReason: "capture complete"
    });
    expect(() =>
      database.transitionDesignModeGrant({
        grantId: grant().grantId,
        expectedRevision: 2,
        nextState: "active",
        actor: "user:local",
        occurredAt: "2026-07-30T02:03:00.000Z"
      })
    ).toThrow(DesignModeGrantConflictError);
    expect(
      database
        .listAudit(`design-grant:${grant().grantId}`)
        .map((record) => record.action)
    ).toEqual([
      "authoring.design-grant.requested",
      "authoring.design-grant.active",
      "authoring.design-grant.stopped"
    ]);
    database.close();
  });

  it("rejects long-lived, insecure and detached grants", () => {
    const database = persistence();
    seedAuthoring(database);
    expect(() => database.putDesignModeGrant(grant())).toThrow(
      DesignModeGrantConflictError
    );
    database.openBrowserSession({
      session: browserSession(),
      now: timestamp
    });
    expect(() =>
      database.putDesignModeGrant({
        ...grant(),
        expiresAt: "2026-07-30T02:15:00.001Z"
      })
    ).toThrow(DesignModeGrantConflictError);
    expect(() =>
      database.putDesignModeGrant({
        ...grant(),
        origin: "http://www.chanmama.com"
      })
    ).toThrow(/HTTPS Origin/u);
    database.close();
  });

  it.each([
    "authoring.grant.create.after_current",
    "authoring.grant.create.after_history",
    "authoring.grant.create.after_audit"
  ])("rolls back Grant creation at %s", (failurePoint) => {
    let crash = false;
    const database = persistence((point) => {
      if (crash && point === failurePoint) throw new Error("crash");
    });
    seedAuthoring(database);
    database.openBrowserSession({
      session: browserSession(),
      now: timestamp
    });
    crash = true;
    expect(() => database.putDesignModeGrant(grant())).toThrow("crash");
    expect(database.getDesignModeGrant(grant().grantId)).toBeUndefined();
    database.close();
  });
});

describe("SQLite v9 PageSnapshot persistence", () => {
  it("atomically binds redacted semantics to exact Grant, Evidence and Asset", () => {
    const database = persistence();
    const { current, snapshot } = prepareCaptureSession(database);
    const operationId = "operation-attach-snapshot";
    const next = nextSession(current, "modeling", operationId, {
      designGrantRefs: [snapshot.binding.designGrantId],
      snapshotRefs: [
        {
          id: snapshot.snapshotId,
          digest: snapshot.contentDigest
        }
      ]
    });
    const input = {
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      operationId,
      next,
      actor: "codex:local",
      snapshot
    };
    expect(database.attachPageSnapshot(input).status).toBe("accepted");
    expect(database.attachPageSnapshot(input).status).toBe("duplicate");
    expect(database.getPageSnapshot(snapshot.snapshotId)).toEqual(snapshot);
    expect(database.getAuthoringSession(current.sessionId)).toEqual(next);
    expect(
      database
        .listAudit(`page-snapshot:${snapshot.snapshotId}`)
        .map((record) => record.action)
    ).toEqual(["authoring.snapshot.attached"]);
    database.close();
  });

  it("rejects a different Origin without leaving a snapshot or revision", () => {
    const database = persistence();
    const { current, snapshot } = prepareCaptureSession(database);
    const foreign = {
      ...snapshot,
      origin: "https://example.com"
    };
    const operationId = "operation-foreign-snapshot";
    const next = nextSession(current, "modeling", operationId, {
      designGrantRefs: [foreign.binding.designGrantId],
      snapshotRefs: [
        {
          id: foreign.snapshotId,
          digest: foreign.contentDigest
        }
      ]
    });
    expect(() =>
      database.attachPageSnapshot({
        sessionId: current.sessionId,
        expectedRevision: current.revision,
        operationId,
        next,
        actor: "codex:local",
        snapshot: foreign
      })
    ).toThrow(DesignModeGrantConflictError);
    expect(database.getPageSnapshot(snapshot.snapshotId)).toBeUndefined();
    expect(database.getAuthoringSession(current.sessionId)).toEqual(current);
    database.close();
  });

  it.each([
    "authoring.snapshot.after_insert",
    "authoring.snapshot.after_audit"
  ])("rolls back snapshot attachment at %s", (failurePoint) => {
    let crash = false;
    const database = persistence((point) => {
      if (crash && point === failurePoint) throw new Error("crash");
    });
    const { current, snapshot } = prepareCaptureSession(database);
    const operationId = "operation-attach-snapshot";
    const next = nextSession(current, "modeling", operationId, {
      designGrantRefs: [snapshot.binding.designGrantId],
      snapshotRefs: [
        {
          id: snapshot.snapshotId,
          digest: snapshot.contentDigest
        }
      ]
    });
    crash = true;
    expect(() =>
      database.attachPageSnapshot({
        sessionId: current.sessionId,
        expectedRevision: current.revision,
        operationId,
        next,
        actor: "codex:local",
        snapshot
      })
    ).toThrow("crash");
    expect(database.getPageSnapshot(snapshot.snapshotId)).toBeUndefined();
    expect(database.getAuthoringSession(current.sessionId)).toEqual(current);
    database.close();
  });

  it("records an opaque immutable export without accepting a filesystem path", () => {
    const database = persistence();
    const current = prepareValidationSession(database);
    const bundle = candidateBundle(current);
    const operationId = "operation-save-bundle";
    const next = nextSession(current, "candidate", operationId, {
      candidateBundleRef: {
        id: bundle.metadata.id,
        digest: digest(bundle)
      }
    });
    const saved = database.saveCandidateBundle({
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      operationId,
      next,
      actor: "user:local",
      bundle,
      validationResults: validationResults(bundle)
    });
    const record = {
      exportId: "candidate-export-001",
      bundleId: bundle.metadata.id,
      bundleDigest: saved.record!.digest,
      archiveDigest: `sha256:${"8".repeat(64)}`,
      manifestDigest: `sha256:${"9".repeat(64)}`,
      destinationRef: "candidate-export:lease-001",
      actor: "user:local",
      createdAt: "2026-07-30T02:10:00.000Z"
    };
    expect(database.putCandidateExport(record).status).toBe("accepted");
    expect(database.putCandidateExport(record).status).toBe("duplicate");
    expect(database.getCandidateExport(record.exportId)).toEqual(record);
    expect(() =>
      database.putCandidateExport({
        ...record,
        exportId: "candidate-export-unsafe",
        destinationRef: "/Users/operator/BPA/candidate.tar"
      })
    ).toThrow(CandidateBundleConflictError);
    expect(() =>
      database.putCandidateExport({
        ...record,
        archiveDigest: `sha256:${"7".repeat(64)}`
      })
    ).toThrow(CandidateBundleConflictError);
    expect(
      database
        .listAudit(`candidate-export:${record.exportId}`)
        .map((audit) => audit.action)
    ).toEqual(["authoring.candidate-bundle.exported"]);
    database.close();
  });
});

describe("SQLite v9 Candidate Bundle persistence", () => {
  it("atomically saves an immutable bundle, validation rows and Session ref", () => {
    const database = persistence();
    const current = prepareValidationSession(database);
    const bundle = candidateBundle(current);
    const operationId = "operation-save-bundle";
    const next = nextSession(current, "candidate", operationId, {
      candidateBundleRef: {
        id: bundle.metadata.id,
        digest: digest(bundle)
      }
    });
    const input = {
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      operationId,
      next,
      actor: "user:local",
      bundle,
      validationResults: validationResults(bundle)
    };
    const saved = database.saveCandidateBundle(input);
    expect(saved).toMatchObject({
      status: "accepted",
      record: {
        digest: digest(bundle),
        bundle: {
          metadata: { id: bundle.metadata.id }
        }
      }
    });
    expect(database.saveCandidateBundle(input).status).toBe("duplicate");
    expect(database.getAuthoringSession(current.sessionId)).toEqual(next);
    expect(database.listCandidateBundleValidation(bundle.metadata.id)).toHaveLength(
      5
    );
    expect(
      database
        .listAudit(`candidate-bundle:${bundle.metadata.id}`)
        .map((record) => record.action)
    ).toEqual(["authoring.candidate-bundle.saved"]);
    expect(() =>
      database.saveCandidateBundle({
        ...input,
        bundle: {
          ...bundle,
          metadata: {
            ...bundle.metadata,
            title: "changed"
          }
        }
      })
    ).toThrow(CandidateBundleConflictError);
    database.close();
  });

  it.each([
    "authoring.bundle.after_insert",
    "authoring.bundle.after_items",
    "authoring.bundle.after_validations",
    "authoring.bundle.after_audit"
  ])("rolls back the bundle and Session at %s", (failurePoint) => {
    let crash = false;
    const database = persistence((point) => {
      if (crash && point === failurePoint) throw new Error("crash");
    });
    const current = prepareValidationSession(database);
    const bundle = candidateBundle(current);
    const operationId = "operation-save-bundle";
    const next = nextSession(current, "candidate", operationId, {
      candidateBundleRef: {
        id: bundle.metadata.id,
        digest: digest(bundle)
      }
    });
    crash = true;
    expect(() =>
      database.saveCandidateBundle({
        sessionId: current.sessionId,
        expectedRevision: current.revision,
        operationId,
        next,
        actor: "user:local",
        bundle,
        validationResults: validationResults(bundle)
      })
    ).toThrow("crash");
    expect(database.getCandidateBundle(bundle.metadata.id)).toBeUndefined();
    expect(database.getAuthoringSession(current.sessionId)).toEqual(current);
    expect(
      database.getAuthoringSessionRevision(
        current.sessionId,
        current.revision + 1
      )
    ).toBeUndefined();
    database.close();
  });
});

describe("migration v9", () => {
  it("rolls an interrupted v9 back and applies it cleanly on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-migration-v9-"));
    const path = join(directory, "bpa.sqlite");
    try {
      expect(
        () =>
          new SqlitePersistence({
            path,
            failureInjector: (point) => {
              if (point === "migration.9.after_sql") throw new Error("crash");
            }
          })
      ).toThrow("crash");
      const recovered = new SqlitePersistence({ path });
      expect(recovered.health().schemaVersion).toBe(14);
      expect(recovered.getAuthoringSession("missing")).toBeUndefined();
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
