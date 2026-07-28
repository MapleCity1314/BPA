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
import type {
  ArtifactRecord,
  Persistence,
  WorkflowDraftRecord
} from "@bpa/persistence";
import type {
  NodeDefinition,
  WorkflowDefinition,
  WorkflowDefinitionV1Alpha2
} from "@bpa/schemas";

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
