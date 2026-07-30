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
import { contentDigest } from "@bpa/compiler";
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
  NodeDefinition,
  PageSnapshotDefinition,
  ScenarioSpecDefinition,
  WorkflowDefinition,
  WorkflowDefinitionV1Alpha2
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

function runtime(
  value: NodeDefinition["runtime"]
): CatalogEntry["runtime"] {
  if (value === "engine_builtin") return "builtin";
  if (value === "engine_team") return "team";
  if (value === "human") return "assistance";
  return value;
}

function nodeEntries(artifact: ArtifactRecord): CatalogEntry[] {
  const node = artifact.content as NodeDefinition;
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
    | WorkflowDefinitionV1Alpha2;
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

  constructor(readonly persistence: Persistence) {
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
    if (
      input.bundle.riskReport.ceiling !== "R0" &&
      input.bundle.riskReport.ceiling !== "R1"
    ) {
      throw new Error("BPA 0.5 only accepts R0/R1 Candidate Bundles");
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
