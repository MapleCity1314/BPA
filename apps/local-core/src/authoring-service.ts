import { createHash } from "node:crypto";
import {
  DraftRevisionConflictError,
  InvalidDraftOperationError,
  applyDraftOperation,
  createWorkflowCandidate,
  createWorkflowDraft,
  diffWorkflowDrafts,
  searchCatalog,
  validateWorkflowCandidateDraft,
  type CatalogEntry,
  type CatalogQuery,
  type DraftOperation,
  type WorkflowCandidate,
  type WorkflowDraft,
  type WorkflowDraftStore
} from "@bpa/authoring-core";
import { canonicalJson, contentDigest } from "@bpa/compiler";
import {
  validateElementContractEvidence,
  validatePageAssetCandidate,
  type PageAssetCandidate
} from "@bpa/page-model";
import {
  formatValidationErrors,
  validateCandidateBundle
} from "@bpa/schemas";
import type {
  ApplyAuthoringSessionResult,
  ArtifactRecord,
  DesignModeGrantRecord,
  Persistence,
  WorkflowDraftRecord
} from "@bpa/persistence";
import type {
  AuthoringSessionDefinition,
  CandidateBundleDefinition,
  ElementContractDefinition,
  NodeDefinition,
  NodeDefinitionV1Alpha2,
  PageSnapshotDefinition,
  ScenarioSpecDefinition,
  WorkflowDefinition,
  WorkflowDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha3
} from "@bpa/schemas";

type CatalogSelection =
  AuthoringSessionDefinition["catalogSelections"][number];
type CapabilityGap =
  AuthoringSessionDefinition["capabilityGaps"][number];
type CapabilityGapResolution = NonNullable<
  CapabilityGap["resolution"]
>;

export type AuthoringSessionOperation =
  | {
      operationId: string;
      type: "state.transition";
      state: AuthoringSessionDefinition["state"];
    }
  | {
      operationId: string;
      type: "catalog.selection.add";
      selection: CatalogSelection;
    }
  | {
      operationId: string;
      type: "capability-gap.upsert";
      gap: CapabilityGap;
    }
  | {
      operationId: string;
      type: "capability-gap.resolve";
      gapId: string;
      resolution: CapabilityGapResolution;
    };

function draftFromRecord(record: WorkflowDraftRecord): WorkflowDraft {
  const content = structuredClone(record.content) as WorkflowDraft;
  if (
    !content ||
    content.draftId !== record.draftId ||
    content.revision !== record.revision
  ) {
    throw new Error(`Corrupt Workflow Draft record: ${record.draftId}`);
  }
  return content;
}

export class PersistenceWorkflowDraftStore implements WorkflowDraftStore {
  constructor(readonly persistence: Persistence) {}

  create(input: {
    draftId: string;
    title: string;
    description: string;
    now: string;
  }): WorkflowDraft {
    const draft = createWorkflowDraft(input);
    return draftFromRecord(
      this.persistence.createWorkflowDraft({
        draftId: draft.draftId,
        revision: draft.revision,
        content: draft,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt
      })
    );
  }

  get(draftId: string): WorkflowDraft | undefined {
    const record = this.persistence.getWorkflowDraft(draftId);
    return record ? draftFromRecord(record) : undefined;
  }

  apply(
    draftId: string,
    expectedRevision: number,
    operation: DraftOperation,
    now: string
  ): WorkflowDraft {
    const current = this.get(draftId);
    if (!current) {
      throw new InvalidDraftOperationError(
        `Workflow Draft does not exist: ${draftId}`
      );
    }
    const next = applyDraftOperation(
      current,
      expectedRevision,
      operation,
      now
    );
    const result = this.persistence.applyWorkflowDraftRevision({
      draftId,
      expectedRevision,
      operationId: operation.operationId,
      content: next,
      updatedAt: next.updatedAt
    });
    if (result.status === "stale") {
      throw new DraftRevisionConflictError(
        expectedRevision,
        result.actualRevision
      );
    }
    return draftFromRecord(result.current);
  }

  revision(draftId: string, revision: number): WorkflowDraft | undefined {
    const record = this.persistence.getWorkflowDraftRevision(
      draftId,
      revision
    );
    if (!record) return undefined;
    return draftFromRecord({
      draftId: record.draftId,
      revision: record.revision,
      content: record.content,
      createdAt: record.createdAt,
      updatedAt: record.createdAt
    });
  }
}

function schemaTypes(
  schema: Record<string, unknown>,
  fallback: string
): string[] {
  const explicit =
    typeof schema.$id === "string" && schema.$id.trim()
      ? [schema.$id.trim()]
      : [];
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>).map(
          (key) => `${fallback}.${key}`
        )
      : [];
  return [
    ...new Set(
      explicit.length > 0
        ? explicit
        : properties.length > 0
          ? properties
          : [fallback]
    )
  ].sort();
}

function semanticMatchCount(
  snapshot: PageSnapshotDefinition,
  candidate: ElementContractDefinition["candidates"][number]
): number {
  return snapshot.semanticNodes.filter((node) => {
    switch (candidate.strategy) {
      case "business-id":
        return Object.entries(node.stableAttributes ?? {}).some(
          ([name, value]) =>
            ["data-id", "data-key", "data-row-key"].includes(name) &&
            value === candidate.value
        );
      case "role-name":
        return (
          node.role === candidate.role &&
          node.accessibleName === candidate.name
        );
      case "label":
        return node.label === candidate.label;
      case "attribute":
        return node.stableAttributes?.[candidate.name] === candidate.value;
      case "relative-anchor":
        return false;
      case "css-diagnostic":
        return node.cssDiagnostic === candidate.selector;
    }
  }).length;
}

function snapshotObservation(snapshot: PageSnapshotDefinition) {
  return {
    snapshot: {
      snapshotId: snapshot.snapshotId,
      source: "design-mode" as const,
      capturedAt: snapshot.capturedAt,
      origin: snapshot.origin,
      path: snapshot.path,
      pageState: snapshot.pageState,
      contentDigest: snapshot.contentDigest,
      redaction: snapshot.redaction,
      rawEvidenceExpiresAt: snapshot.rawEvidenceExpiresAt
    }
  };
}

const RISK_RANK = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4
} as const;

function runtime(
  value: NodeDefinition["runtime"] | NodeDefinitionV1Alpha2["runtime"]
): CatalogEntry["runtime"] {
  if (value === "engine_builtin") return "builtin";
  if (value === "engine_team") return "team";
  if (value === "human") return "assistance";
  return value;
}

function nodeEntries(artifact: ArtifactRecord): CatalogEntry[] {
  const node = artifact.content as
    | NodeDefinition
    | NodeDefinitionV1Alpha2;
  if (node.kind !== "Node") return [];
  const base = {
    kind: "node" as const,
    id: node.metadata.id,
    version: node.metadata.version,
    title: node.metadata.title,
    capabilityIds: [node.metadata.id],
    aliases: [],
    platforms: node.adapter ? [node.adapter.id] : [],
    runtime: runtime(node.runtime),
    inputTypes: schemaTypes(node.inputSchema, `${node.metadata.id}.input`),
    outputTypes: schemaTypes(node.outputSchema, `${node.metadata.id}.output`),
    riskLevel: node.risk.level,
    permissions: [...node.risk.permissions],
    ...(artifact.publishedAt ? { verifiedAt: artifact.publishedAt } : {})
  };
  return node.adapter
    ? node.adapter.versions.map((version) => ({
        ...base,
        adapter: { id: node.adapter!.id, version }
      }))
    : [base];
}

function workflowEntry(artifact: ArtifactRecord): CatalogEntry | undefined {
  const workflow = artifact.content as
    | WorkflowDefinition
    | WorkflowDefinitionV1Alpha2
    | WorkflowDefinitionV1Alpha3;
  if (workflow.kind !== "Workflow") return undefined;
  const riskLevel =
    workflow.apiVersion === "bpa/v1alpha2"
      ? workflow.spec.riskLevel
      : workflow.spec.riskLevel;
  return {
    kind: "workflow",
    id: workflow.metadata.id,
    version: workflow.metadata.version,
    title: workflow.metadata.title,
    capabilityIds: [workflow.metadata.id],
    aliases: [],
    platforms: [],
    runtime: "composite",
    inputTypes: schemaTypes(
      workflow.spec.inputSchema,
      `${workflow.metadata.id}.input`
    ),
    outputTypes: schemaTypes(
      workflow.spec.outputSchema,
      `${workflow.metadata.id}.output`
    ),
    riskLevel,
    permissions: [],
    ...(artifact.publishedAt ? { verifiedAt: artifact.publishedAt } : {})
  };
}

export class LocalAuthoringService {
  readonly drafts: PersistenceWorkflowDraftStore;

  constructor(
    readonly persistence: Persistence,
    readonly readAsset?: (storageRef: string) => Uint8Array
  ) {
    this.drafts = new PersistenceWorkflowDraftStore(persistence);
  }

  createSession(input: {
    sessionId: string;
    scenario: ScenarioSpecDefinition;
    actor: AuthoringSessionDefinition["actor"];
    now: string;
  }): AuthoringSessionDefinition {
    this.#assertReadOnlyRisk(input.scenario);
    const scenarioDigest = contentDigest(input.scenario);
    const existingScenario = this.persistence.getAuthoringScenario(
      input.scenario.metadata.id,
      input.scenario.metadata.version
    );
    if (existingScenario) {
      if (
        existingScenario.digest !== scenarioDigest ||
        contentDigest(existingScenario.scenario) !== scenarioDigest
      ) {
        throw new Error(
          `ScenarioSpec is immutable: ${input.scenario.metadata.id}@${input.scenario.metadata.version}`
        );
      }
    } else {
      this.persistence.putAuthoringScenario({
        scenario: structuredClone(input.scenario),
        digest: scenarioDigest,
        createdAt: input.now
      });
    }
    const expected: AuthoringSessionDefinition = {
      apiVersion: "bpa.authoring/v1alpha1",
      kind: "AuthoringSession",
      sessionId: input.sessionId,
      revision: 0,
      state: "intake",
      scenarioRef: {
        id: input.scenario.metadata.id,
        version: input.scenario.metadata.version,
        digest: scenarioDigest
      },
      actor: structuredClone(input.actor),
      catalogSelections: [],
      capabilityGaps: [],
      designGrantRefs: [],
      snapshotRefs: [],
      appliedOperationIds: [],
      createdAt: input.now,
      updatedAt: input.now
    };
    const existing = this.persistence.getAuthoringSession(input.sessionId);
    if (existing) {
      if (
        contentDigest(existing.scenarioRef) !==
          contentDigest(expected.scenarioRef) ||
        contentDigest(existing.actor) !== contentDigest(expected.actor)
      ) {
        throw new Error(
          `Authoring Session already exists with different authority: ${input.sessionId}`
        );
      }
      return existing;
    }
    return this.persistence.createAuthoringSession(expected);
  }

  getSession(sessionId: string): AuthoringSessionDefinition {
    const session = this.persistence.getAuthoringSession(sessionId);
    if (!session) {
      throw new Error(`Authoring Session not found: ${sessionId}`);
    }
    return session;
  }

  applySession(input: {
    sessionId: string;
    expectedRevision: number;
    operation: AuthoringSessionOperation;
    actor: string;
    occurredAt: string;
  }): ApplyAuthoringSessionResult {
    const base = this.persistence.getAuthoringSessionRevision(
      input.sessionId,
      input.expectedRevision
    )?.session;
    if (!base) {
      const current = this.persistence.getAuthoringSession(input.sessionId);
      if (current) {
        return {
          status: "stale",
          actualRevision: current.revision
        };
      }
      throw new Error(`Authoring Session not found: ${input.sessionId}`);
    }
    const next = this.#applySessionOperation(
      base,
      input.operation,
      input.occurredAt
    );
    return this.persistence.applyAuthoringSession({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operation.operationId,
      next,
      actor: input.actor
    });
  }

  requestDesignMode(input: {
    grantId: string;
    authoringSessionId: string;
    approvedBy: string;
    browserSessionId: string;
    profileId: string;
    tabId: number;
    origin: string;
    pageEpoch: string;
    screenshotApproved: boolean;
    issuedAt: string;
    expiresAt: string;
  }): DesignModeGrantRecord {
    const session = this.persistence.getAuthoringSession(
      input.authoringSessionId
    );
    if (!session || ["bundled", "archived"].includes(session.state)) {
      throw new Error(
        "Design Mode requires an active Authoring Session."
      );
    }
    const browserSession = this.persistence.getBrowserSession(
      input.browserSessionId
    );
    if (
      !browserSession ||
      browserSession.disconnectedAt ||
      browserSession.observationState !== "available" ||
      browserSession.observedOrigin !== input.origin
    ) {
      throw new Error(
        "Design Mode Browser Session is unavailable or has a different Origin."
      );
    }
    const issuedAt = Date.parse(input.issuedAt);
    const expiresAt = Date.parse(input.expiresAt);
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      throw new Error("Design Mode Origin is invalid.");
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== input.origin ||
      !Number.isSafeInteger(input.tabId) ||
      input.tabId < 0 ||
      !input.pageEpoch.startsWith(`tab-${input.tabId}:`) ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 15 * 60 * 1000 ||
      !input.approvedBy.trim() ||
      !input.profileId.trim()
    ) {
      throw new Error(
        "Design Mode Grant must bind an exact HTTPS Origin, Tab, PageEpoch, operator and TTL of at most 15 minutes."
      );
    }
    const grant: DesignModeGrantRecord = {
      grantId: input.grantId,
      authoringSessionId: input.authoringSessionId,
      revision: 0,
      state: "requested",
      approvedBy: input.approvedBy,
      browserSessionId: input.browserSessionId,
      profileId: input.profileId,
      tabId: input.tabId,
      origin: input.origin,
      pageEpoch: input.pageEpoch,
      allowedOperations: [
        "semantic_snapshot",
        ...(input.screenshotApproved ? ["screenshot_once" as const] : [])
      ],
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      updatedAt: input.issuedAt
    };
    return this.persistence.putDesignModeGrant(grant);
  }

  getDesignMode(grantId: string): DesignModeGrantRecord {
    const grant = this.persistence.getDesignModeGrant(grantId);
    if (!grant) {
      throw new Error(`Design Mode Grant not found: ${grantId}`);
    }
    return grant;
  }

  activateDesignMode(input: {
    grantId: string;
    expectedRevision: number;
    actor: string;
    occurredAt: string;
  }): DesignModeGrantRecord {
    const grant = this.getDesignMode(input.grantId);
    const browserSession = this.persistence.getBrowserSession(
      grant.browserSessionId
    );
    if (
      grant.state !== "requested" ||
      Date.parse(grant.expiresAt) <= Date.parse(input.occurredAt) ||
      !browserSession ||
      browserSession.disconnectedAt ||
      browserSession.observationState !== "available" ||
      browserSession.observedOrigin !== grant.origin
    ) {
      throw new Error(
        "Design Mode Grant cannot be activated because its page resource is no longer exact and available."
      );
    }
    return this.persistence.transitionDesignModeGrant({
      ...input,
      nextState: "active"
    });
  }

  stopDesignMode(input: {
    grantId: string;
    expectedRevision: number;
    actor: string;
    occurredAt: string;
    reason?: string;
  }): DesignModeGrantRecord {
    return this.persistence.transitionDesignModeGrant({
      ...input,
      nextState: "stopped"
    });
  }

  attachSnapshot(input: {
    sessionId: string;
    expectedRevision: number;
    operationId: string;
    actor: string;
    occurredAt: string;
    snapshot: PageSnapshotDefinition;
  }): ApplyAuthoringSessionResult {
    const current = this.#revision(
      input.sessionId,
      input.expectedRevision
    );
    const next: AuthoringSessionDefinition = {
      ...structuredClone(current),
      revision: current.revision + 1,
      designGrantRefs: [
        ...new Set([
          ...current.designGrantRefs,
          input.snapshot.binding.designGrantId
        ])
      ],
      snapshotRefs: [
        ...current.snapshotRefs,
        {
          id: input.snapshot.snapshotId,
          digest: input.snapshot.contentDigest
        }
      ],
      appliedOperationIds: [
        ...current.appliedOperationIds,
        input.operationId
      ],
      updatedAt: input.occurredAt
    };
    return this.persistence.attachPageSnapshot({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      next,
      actor: input.actor,
      snapshot: structuredClone(input.snapshot)
    });
  }

  completeSnapshot(input: {
    sessionId: string;
    expectedRevision: number;
    operationId: string;
    actor: string;
    occurredAt: string;
    runId: string;
    snapshotId: string;
  }): {
    mutation: ApplyAuthoringSessionResult;
    snapshot: PageSnapshotDefinition;
  } {
    const run = this.persistence.getRun(input.runId);
    const runOutput =
      run?.output !== null &&
      typeof run?.output === "object" &&
      !Array.isArray(run.output)
        ? (run.output as Record<string, unknown>)
        : undefined;
    if (
      !run ||
      run.status !== "succeeded" ||
      !runOutput ||
      runOutput.kind !== "SemanticSnapshotCapture" ||
      runOutput.apiVersion !== "bpa.authoring/v1alpha1" ||
      runOutput.authoringSessionId !== input.sessionId
    ) {
      throw new Error(
        "Design snapshot Run has not succeeded with a governed semantic capture."
      );
    }
    const grantId = String(runOutput.designGrantId ?? "");
    const grant = this.persistence.getDesignModeGrant(grantId);
    if (
      !grant ||
      grant.authoringSessionId !== input.sessionId ||
      grant.state !== "active"
    ) {
      throw new Error("Design snapshot Grant is unavailable or inactive.");
    }
    const transfers = this.persistence
      .listEvidenceTransfersForRun({
        runId: input.runId,
        limit: 200
      })
      .records.filter(
        (transfer) =>
          transfer.kind === "dom_summary" &&
          transfer.mediaType === "application/json"
      );
    if (transfers.length !== 1) {
      throw new Error(
        "Design snapshot requires exactly one trusted JSON DOM Evidence transfer."
      );
    }
    const transfer = transfers[0]!;
    if (
      transfer.state !== "linked" ||
      transfer.sessionId !== grant.browserSessionId
    ) {
      throw new Error(
        "Design snapshot Evidence is not linked to the exact Browser Session."
      );
    }
    const asset = this.persistence.getAssetRecord(
      `asset-${transfer.evidenceId}`
    );
    if (
      !asset ||
      asset.digest !== transfer.digest ||
      asset.size !== transfer.size ||
      !this.readAsset
    ) {
      throw new Error(
        "Design snapshot immutable Evidence Asset is unavailable."
      );
    }
    let evidenceEnvelope: Record<string, unknown>;
    try {
      const bytes = this.readAsset(asset.storageRef);
      if (
        bytes.byteLength !== asset.size ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
          asset.digest
      ) {
        throw new Error("Evidence Asset digest or size mismatch");
      }
      evidenceEnvelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      ) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Design snapshot Evidence body cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const evidenceOutput =
      evidenceEnvelope.output &&
      typeof evidenceEnvelope.output === "object" &&
      !Array.isArray(evidenceEnvelope.output)
        ? (evidenceEnvelope.output as Record<string, unknown>)
        : undefined;
    const evidencePage =
      evidenceEnvelope.page &&
      typeof evidenceEnvelope.page === "object" &&
      !Array.isArray(evidenceEnvelope.page)
        ? (evidenceEnvelope.page as Record<string, unknown>)
        : undefined;
    const evidenceNode =
      evidenceEnvelope.node &&
      typeof evidenceEnvelope.node === "object" &&
      !Array.isArray(evidenceEnvelope.node)
        ? (evidenceEnvelope.node as Record<string, unknown>)
        : undefined;
    if (
      evidenceEnvelope.schema !== "bpa.browser-evidence/1" ||
      evidenceEnvelope.status !== "succeeded" ||
      !evidenceNode ||
      evidenceNode.id !== "browser.design.snapshot.capture" ||
      evidenceNode.version !== "1.0.0" ||
      !evidencePage ||
      evidencePage.origin !== runOutput.origin ||
      evidencePage.pathname !== runOutput.path ||
      evidencePage.epoch !== grant.pageEpoch ||
      !evidenceOutput ||
      contentDigest(evidenceOutput) !== contentDigest(runOutput)
    ) {
      throw new Error(
        "Design snapshot Result and immutable Evidence body do not match."
      );
    }
    const output = evidenceOutput;
    const capturedAt = String(output.capturedAt ?? "");
    const semanticNodes =
      output.semanticNodes as PageSnapshotDefinition["semanticNodes"];
    const semanticBody = {
      pageState: String(output.pageState ?? ""),
      capturedAt,
      origin: String(output.origin ?? ""),
      path: String(output.path ?? ""),
      untrusted: true as const,
      redaction: output.redaction,
      semanticNodes
    };
    if (
      output.kind !== "SemanticSnapshotCapture" ||
      output.apiVersion !== "bpa.authoring/v1alpha1" ||
      output.authoringSessionId !== input.sessionId ||
      output.designGrantId !== grant.grantId ||
      output.profileId !== grant.profileId ||
      output.origin !== grant.origin ||
      output.page_epoch !== grant.pageEpoch ||
      output.contentDigest !== contentDigest(semanticBody) ||
      Number(output.sizeBytes) !==
        Buffer.byteLength(canonicalJson(semanticBody), "utf8") ||
      !Array.isArray(semanticNodes) ||
      semanticNodes.some(({ digest, ...node }) => {
        return digest !== contentDigest(node);
      })
    ) {
      throw new Error(
        "Design snapshot semantic content failed deterministic verification."
      );
    }
    const snapshot: PageSnapshotDefinition = {
      apiVersion: "bpa.authoring/v1alpha1",
      kind: "PageSnapshot",
      snapshotId: input.snapshotId,
      pageState: String(output.pageState ?? ""),
      capturedAt,
      origin: String(output.origin ?? ""),
      path: String(output.path ?? ""),
      binding: {
        designGrantId: grant.grantId,
        browserSessionId: grant.browserSessionId,
        profileId: grant.profileId,
        tabId: grant.tabId,
        pageEpoch: grant.pageEpoch
      },
      captureSource: {
        runId: input.runId,
        nodeExecutionId: transfer.nodeExecutionId,
        evidenceId: transfer.evidenceId,
        assetRef: {
          id: `asset-${transfer.evidenceId}`,
          digest: transfer.digest,
          sizeBytes: transfer.size
        }
      },
      classification: "restricted",
      untrusted: true,
      redaction: output.redaction as PageSnapshotDefinition["redaction"],
      semanticNodes,
      contentDigest: String(output.contentDigest ?? ""),
      sizeBytes: Number(output.sizeBytes),
      rawEvidenceExpiresAt: new Date(
        Date.parse(capturedAt) + 24 * 60 * 60 * 1000
      ).toISOString()
    };
    const mutation = this.attachSnapshot({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      actor: input.actor,
      occurredAt: input.occurredAt,
      snapshot
    });
    return { mutation, snapshot };
  }

  querySnapshot(input: {
    snapshotId: string;
    offset?: number;
    limit?: number;
    role?: string;
    text?: string;
  }): {
    snapshot: Omit<PageSnapshotDefinition, "semanticNodes">;
    totalSemanticNodes: number;
    offset: number;
    semanticNodes: PageSnapshotDefinition["semanticNodes"];
  } {
    const snapshot = this.persistence.getPageSnapshot(input.snapshotId);
    if (!snapshot) {
      throw new Error(`PageSnapshot not found: ${input.snapshotId}`);
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(
      200,
      Math.max(1, Math.floor(input.limit ?? 100))
    );
    const role = input.role?.trim().toLowerCase();
    const needle = input.text?.trim().toLowerCase();
    const matching = snapshot.semanticNodes.filter((node) => {
      if (role && node.role?.toLowerCase() !== role) return false;
      if (!needle) return true;
      return [
        node.accessibleName,
        node.label,
        node.text,
        node.region
      ].some((value) => value?.toLowerCase().includes(needle));
    });
    const { semanticNodes: _semanticNodes, ...summary } = snapshot;
    return {
      snapshot: summary,
      totalSemanticNodes: matching.length,
      offset,
      semanticNodes: matching.slice(offset, offset + limit)
    };
  }

  validatePageCandidate(input: {
    sessionId: string;
    expectedRevision: number;
    candidate: PageAssetCandidate;
  }): {
    valid: boolean;
    issues: Array<{
      code: string;
      path: string;
      message: string;
    }>;
    evidence: Array<{
      contractId: string;
      stableCandidateIndexes: number[];
      observedSnapshotDigests: string[];
    }>;
  } {
    const session = this.#revision(
      input.sessionId,
      input.expectedRevision
    );
    const snapshots = session.snapshotRefs.flatMap((reference) => {
      const snapshot = this.persistence.getPageSnapshot(reference.id);
      return snapshot && snapshot.contentDigest === reference.digest
        ? [snapshot]
        : [];
    });
    const issues = validatePageAssetCandidate(input.candidate).map(
      (entry) => ({ ...entry })
    );
    const evidence = input.candidate.contracts.map((pinned) => {
      const observations = pinned.definition.validatedSnapshots.flatMap(
        (digest) => {
          const snapshot = snapshots.find(
            (candidate) => candidate.contentDigest === digest
          );
          return snapshot
            ? [
                {
                  ...snapshotObservation(snapshot),
                  matchCounts: pinned.definition.candidates.map(
                    (candidate) =>
                      semanticMatchCount(snapshot, candidate)
                  )
                }
              ]
            : [];
        }
      );
      const validation = validateElementContractEvidence(
        pinned.definition,
        observations,
        {
          allowedOrigins: input.candidate.pageModel.origins,
          knownPageStates: input.candidate.pageModel.states.map(
            (state) => state.id
          ),
          knownElementIds: input.candidate.pageModel.elements.map(
            (element) => element.id
          )
        }
      );
      issues.push(
        ...validation.issues.map((entry) => ({
          ...entry,
          path: `/contracts/${pinned.definition.metadata.id}${entry.path}`
        }))
      );
      return {
        contractId: pinned.definition.metadata.id,
        stableCandidateIndexes: validation.stableCandidateIndexes,
        observedSnapshotDigests:
          validation.observedSnapshotDigests
      };
    });
    return {
      valid: issues.length === 0,
      issues,
      evidence
    };
  }

  savePageCandidate(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    candidate: PageAssetCandidate;
  }) {
    const validation = this.validatePageCandidate(input);
    if (!validation.valid) {
      throw new Error(
        `Page Candidate validation failed: ${validation.issues
          .map((issue) => `${issue.code} ${issue.path}`)
          .join("; ")}`
      );
    }
    const contracts = input.candidate.contracts.map((pinned) =>
      this.persistence.saveCandidate({
        assetType: "element_contract",
        assetId: pinned.definition.metadata.id,
        version: pinned.definition.metadata.version,
        digest: pinned.digest,
        content: structuredClone(pinned.definition),
        actor: input.actor
      })
    );
    const pageModel = this.persistence.saveCandidate({
      assetType: "page_model",
      assetId: input.candidate.pageModel.metadata.id,
      version: input.candidate.pageModel.metadata.version,
      digest: contentDigest(input.candidate.pageModel),
      content: structuredClone(input.candidate.pageModel),
      actor: input.actor
    });
    return {
      status: "candidate" as const,
      candidateId: input.candidate.candidateId,
      pageModel,
      contracts,
      implementations: structuredClone(
        input.candidate.implementations
      ),
      validation
    };
  }

  saveCandidateBundle(input: {
    sessionId: string;
    expectedRevision: number;
    operationId: string;
    actor: string;
    occurredAt: string;
    bundle: CandidateBundleDefinition;
  }) {
    const current = this.#revision(
      input.sessionId,
      input.expectedRevision
    );
    if (current.state !== "validation") {
      throw new Error(
        "Candidate Bundle can only be saved from validation state"
      );
    }
    const validation = this.validateCandidateBundle({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      bundle: input.bundle
    });
    if (!validation.valid) {
      throw new Error(
        `Candidate Bundle validation failed: ${validation.issues
          .map((issue) => `${issue.code} ${issue.path}`)
          .join("; ")}`
      );
    }
    const bundleDigest = contentDigest(input.bundle);
    const next: AuthoringSessionDefinition = {
      ...structuredClone(current),
      revision: current.revision + 1,
      state: "candidate",
      candidateBundleRef: {
        id: input.bundle.metadata.id,
        digest: bundleDigest
      },
      appliedOperationIds: [
        ...current.appliedOperationIds,
        input.operationId
      ],
      updatedAt: input.occurredAt
    };
    const validationResults = (
      [
        "schema",
        "contracts",
        "replay",
        "permissions",
        "risk"
      ] as const
    ).map((checkType) => ({
      bundleId: input.bundle.metadata.id,
      checkType,
      valid: input.bundle.validation[checkType].valid,
      issueCount: input.bundle.validation[checkType].issueCount,
      createdAt: input.occurredAt
    }));
    return this.persistence.saveCandidateBundle({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      next,
      actor: input.actor,
      bundle: structuredClone(input.bundle),
      validationResults
    });
  }

  validateCandidateBundle(input: {
    sessionId: string;
    expectedRevision: number;
    bundle: CandidateBundleDefinition;
  }): {
    valid: boolean;
    issues: Array<{
      code: string;
      path: string;
      message: string;
    }>;
  } {
    const issues: Array<{
      code: string;
      path: string;
      message: string;
    }> = [];
    if (!validateCandidateBundle(input.bundle)) {
      for (const message of formatValidationErrors(
        validateCandidateBundle.errors
      )) {
        issues.push({
          code: "SCHEMA_INVALID",
          path: "/",
          message
        });
      }
      return { valid: false, issues };
    }
    const session = this.#revision(
      input.sessionId,
      input.expectedRevision
    );
    const bundle = input.bundle;
    if (
      bundle.authoringSession.id !== input.sessionId ||
      bundle.authoringSession.revision !== input.expectedRevision
    ) {
      issues.push({
        code: "SESSION_REVISION_MISMATCH",
        path: "/authoringSession",
        message:
          "Candidate Bundle must freeze the exact Authoring Session revision."
      });
    }
    if (
      bundle.scenarioRef.id !== session.scenarioRef.id ||
      bundle.scenarioRef.version !== session.scenarioRef.version ||
      bundle.scenarioRef.digest !== session.scenarioRef.digest
    ) {
      issues.push({
        code: "SCENARIO_MISMATCH",
        path: "/scenarioRef",
        message:
          "Candidate Bundle must reference the Session's exact ScenarioSpec."
      });
    }
    const scenario = this.persistence.getAuthoringScenario(
      bundle.scenarioRef.id,
      bundle.scenarioRef.version
    );
    if (!scenario || scenario.digest !== bundle.scenarioRef.digest) {
      issues.push({
        code: "SCENARIO_NOT_FOUND",
        path: "/scenarioRef",
        message: "The exact ScenarioSpec is not present in the Registry."
      });
    }
    const riskLimit = scenario?.scenario.riskCeiling ?? "R0";
    if (
      RISK_RANK[bundle.riskReport.ceiling] > RISK_RANK.R1 ||
      RISK_RANK[bundle.riskReport.ceiling] > RISK_RANK[riskLimit] ||
      RISK_RANK[bundle.riskReport.effective] >
        RISK_RANK[bundle.riskReport.ceiling]
    ) {
      issues.push({
        code: "RISK_CEILING_EXCEEDED",
        path: "/riskReport",
        message:
          "BPA 0.5 Candidate risk must remain at R0/R1 and within the Scenario ceiling."
      });
    }
    for (const [checkType, check] of Object.entries(
      bundle.validation
    )) {
      if (!check.valid || check.issueCount !== 0) {
        issues.push({
          code: "VALIDATION_CHECK_FAILED",
          path: `/validation/${checkType}`,
          message:
            "All Candidate Bundle checks must be valid with zero unresolved issues."
        });
      }
    }
    const filePaths = new Set<string>();
    bundle.files.forEach((file, index) => {
      if (filePaths.has(file.path)) {
        issues.push({
          code: "DUPLICATE_FILE_PATH",
          path: `/files/${index}/path`,
          message: "Candidate file paths must be unique."
        });
      }
      filePaths.add(file.path);
      const asset = this.persistence.getAssetRecord(
        file.sourceAssetRef.id
      );
      if (
        !asset ||
        asset.digest !== file.sourceAssetRef.digest ||
        asset.digest !== file.digest ||
        asset.size !== file.sizeBytes ||
        asset.mediaType !== file.mediaType
      ) {
        issues.push({
          code: "FILE_ASSET_MISMATCH",
          path: `/files/${index}/sourceAssetRef`,
          message:
            "Candidate file metadata must match one immutable CAS Asset exactly."
        });
      }
    });
    bundle.dependencyClosure.forEach((reference, index) => {
      const artifact =
        reference.status === "published"
          ? this.persistence.getPublished(
              reference.assetType,
              reference.id,
              reference.version
            )
          : this.persistence.getCandidate(
              reference.assetType,
              reference.id,
              reference.version
            );
      if (!artifact || artifact.digest !== reference.digest) {
        issues.push({
          code: "DEPENDENCY_NOT_PINNED",
          path: `/dependencyClosure/${index}`,
          message:
            "Every dependency must resolve to the exact candidate or published digest."
        });
      }
    });
    const registryKinds = {
      workflow: "workflow",
      node: "node",
      page_model: "page_model",
      element_contract: "element_contract",
      adapter_patch: "adapter"
    } as const;
    bundle.artifacts.forEach((reference, index) => {
      if (!(reference.kind in registryKinds)) return;
      const assetType =
        registryKinds[reference.kind as keyof typeof registryKinds];
      const artifact =
        reference.status === "published"
          ? this.persistence.getPublished(
              assetType,
              reference.id,
              reference.version
            )
          : this.persistence.getCandidate(
              assetType,
              reference.id,
              reference.version
            );
      if (!artifact || artifact.digest !== reference.digest) {
        issues.push({
          code: "ARTIFACT_NOT_PINNED",
          path: `/artifacts/${index}`,
          message:
            "Executable and page artifacts must resolve to the exact Registry digest."
        });
      }
    });
    return { valid: issues.length === 0, issues };
  }

  getCandidateBundle(bundleId: string) {
    const bundle = this.persistence.getCandidateBundle(bundleId);
    if (!bundle) {
      throw new Error(`Candidate Bundle not found: ${bundleId}`);
    }
    return {
      ...bundle,
      validationResults:
        this.persistence.listCandidateBundleValidation(bundleId)
    };
  }

  #revision(
    sessionId: string,
    revision: number
  ): AuthoringSessionDefinition {
    const record = this.persistence.getAuthoringSessionRevision(
      sessionId,
      revision
    );
    if (!record) {
      throw new Error(
        `Authoring Session revision not found: ${sessionId}@${revision}`
      );
    }
    return record.session;
  }

  #applySessionOperation(
    current: AuthoringSessionDefinition,
    operation: AuthoringSessionOperation,
    occurredAt: string
  ): AuthoringSessionDefinition {
    const next = structuredClone(current);
    switch (operation.type) {
      case "state.transition":
        if (
          current.state === "catalog" &&
          operation.state === "assembly" &&
          current.capabilityGaps.some((gap) => gap.status === "open")
        ) {
          throw new Error(
            "Open Capability Gaps must enter discovery before assembly"
          );
        }
        next.state = operation.state;
        break;
      case "catalog.selection.add": {
        const key = `${operation.selection.assetType}:${operation.selection.id}@${operation.selection.version}`;
        next.catalogSelections = [
          ...next.catalogSelections.filter(
            (selection) =>
              `${selection.assetType}:${selection.id}@${selection.version}` !==
              key
          ),
          structuredClone(operation.selection)
        ];
        break;
      }
      case "capability-gap.upsert":
        next.capabilityGaps = [
          ...next.capabilityGaps.filter(
            (gap) => gap.gapId !== operation.gap.gapId
          ),
          structuredClone(operation.gap)
        ];
        break;
      case "capability-gap.resolve": {
        const index = next.capabilityGaps.findIndex(
          (gap) => gap.gapId === operation.gapId
        );
        if (index < 0) {
          throw new Error(`Capability Gap not found: ${operation.gapId}`);
        }
        next.capabilityGaps[index] = {
          ...next.capabilityGaps[index]!,
          status: "resolved",
          resolution: structuredClone(operation.resolution)
        };
        break;
      }
    }
    next.revision = current.revision + 1;
    next.appliedOperationIds = [
      ...current.appliedOperationIds,
      operation.operationId
    ];
    next.updatedAt = occurredAt;
    return next;
  }

  #assertReadOnlyRisk(scenario: ScenarioSpecDefinition): void {
    if (
      scenario.riskCeiling !== "R0" &&
      scenario.riskCeiling !== "R1"
    ) {
      throw new Error("BPA 0.5 authoring only accepts R0/R1 scenarios");
    }
  }

  catalogSearch(input: {
    query?: string;
    assetType?: string;
    capabilityIds?: string[];
    platform?: string;
    runtime?: CatalogQuery["runtime"];
    availableInputTypes?: string[];
    requiredOutputTypes?: string[];
    maximumRisk?: CatalogQuery["maximumRisk"];
    allowedPermissions?: string[];
    adapter?: CatalogQuery["adapter"];
    limit?: number;
  }) {
    const entries: CatalogEntry[] = [];
    if (!input.assetType || input.assetType === "node") {
      entries.push(
        ...this.persistence.listPublished("node").flatMap(nodeEntries)
      );
    }
    if (!input.assetType || input.assetType === "workflow") {
      for (const artifact of this.persistence.listPublished("workflow")) {
        const entry = workflowEntry(artifact);
        if (entry) entries.push(entry);
      }
    }
    const query: CatalogQuery = {
      capabilityIds: input.capabilityIds ?? [],
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      availableInputTypes:
        input.availableInputTypes && input.availableInputTypes.length > 0
          ? input.availableInputTypes
          : [...new Set(entries.flatMap((entry) => entry.inputTypes))],
      requiredOutputTypes: input.requiredOutputTypes ?? [],
      maximumRisk: input.maximumRisk ?? "R4",
      allowedPermissions:
        input.allowedPermissions ??
        [...new Set(entries.flatMap((entry) => entry.permissions))],
      ...(input.adapter ? { adapter: input.adapter } : {})
    };
    const needle = input.query?.trim().toLowerCase() ?? "";
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return searchCatalog(query, entries)
      .filter(
        ({ entry }) =>
          !needle ||
          `${entry.id} ${entry.title} ${entry.capabilityIds.join(" ")}`
            .toLowerCase()
            .includes(needle)
      )
      .slice(0, limit);
  }

  diff(
    draftId: string,
    fromRevision: number,
    toRevision: number,
    limit: number
  ) {
    const before = this.drafts.revision(draftId, fromRevision);
    const after = this.drafts.revision(draftId, toRevision);
    if (!before || !after) {
      throw new InvalidDraftOperationError(
        `Workflow Draft revision not found: ${draftId}`
      );
    }
    return diffWorkflowDrafts(before, after, limit);
  }

  validate(draftId: string, expectedRevision: number) {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      throw new InvalidDraftOperationError(
        `Workflow Draft does not exist: ${draftId}`
      );
    }
    return validateWorkflowCandidateDraft(draft, expectedRevision);
  }

  saveCandidate(input: {
    draftId: string;
    expectedRevision: number;
    candidateId: string;
    now: string;
  }): WorkflowCandidate {
    const draft = this.drafts.get(input.draftId);
    if (!draft) {
      throw new InvalidDraftOperationError(
        `Workflow Draft does not exist: ${input.draftId}`
      );
    }
    const candidate = createWorkflowCandidate(
      draft,
      input.expectedRevision,
      {
        candidateId: input.candidateId,
        now: input.now
      }
    );
    return this.persistence.saveWorkflowCandidate({
      candidateId: candidate.candidateId,
      draftId: candidate.draftId,
      sourceRevision: candidate.sourceRevision,
      content: candidate,
      createdAt: candidate.createdAt
    }).content as WorkflowCandidate;
  }
}
