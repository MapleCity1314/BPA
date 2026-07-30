import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  AssetReferenceConflictError,
  ArtifactConflictError,
  EvidenceConflictError,
  EvidenceOwnershipError,
  RevisionConflictError,
  StaleFencingTokenError,
  WorkflowCandidateConflictError,
  WorkflowDraftConflictError,
  WorkflowOperationConflictError,
  type ApplyWorkflowDraftRevisionInput,
  type ApplyWorkflowDraftRevisionResult,
  type AssetRecordDefinition,
  type ArtifactRecord,
  type ArtifactType,
  type AssistanceTaskRecord,
  type AssistanceTaskListFilter,
  type AuditRecord,
  type BrowserCapabilityRecord,
  type BrowserSessionRecord,
  type BlobRecord,
  type CreateRunInput,
  type CreateBlockingAssistanceInput,
  type CommitAssistanceTaskRequestInput,
  type CommitAssistanceTaskRequestResult,
  type CompleteDetachedAssistanceInput,
  type DatasetStagingRecord,
  type DatasetVersionDefinition,
  type DecisionRecordDefinition,
  type EngineCheckpointRecord,
  type EvidenceChunkRecord,
  type EvidenceLinkDefinition,
  type EvidenceTransferRecord,
  type ExecutionScopeRecord,
  type ExecutionEventRecord,
  type GatewayCommandRecord,
  type InboxMessageRecord,
  type IterationInstanceRecord,
  type JsonValue,
  type NodeExecutionRecord,
  type OpenBrowserSessionInput,
  type NodeTransitionInput,
  type OutboxMessage,
  type Persistence,
  type PublishArtifactInput,
  type RetentionJobRecord,
  type RunRecord,
  type RunPlanSnapshotRecord,
  type RunTransitionInput,
  type SourceRecordDefinition,
  type StagingLeaseRecord,
  type StepInstanceRecord,
  type SubmitAssistanceAndWakeInput,
  type WorkflowCandidateRecord,
  type WorkflowDraftRecord,
  type WorkflowDraftRevisionRecord
} from "@bpa/persistence";
import {
  GLOBAL_STORAGE_WARNING_BYTES,
  MAX_RUN_BYTES,
  assertAssetRecord
} from "@bpa/asset-core";
import {
  EvidenceValidationError,
  acceptChunk,
  acknowledgeEvidence as transitionEvidenceAcknowledged,
  assertEvidenceLink,
  completeEvidence as transitionEvidenceComplete,
  markEvidenceLinked,
  terminateEvidence as transitionEvidenceTerminated
} from "@bpa/evidence-core";
import { assertSourceRecord } from "@bpa/source-core";
import { migrations, type Migration } from "./migrations.js";

type SqlRow = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  return value == null ? undefined : JSON.parse(String(value));
}

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

function assertJsonCompatible(
  value: unknown,
  label: string,
  seen = new Set<object>()
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} must not contain cycles`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertJsonCompatible(child, `${label}[${index}]`, seen)
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertJsonCompatible(child, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function authoringJson(value: unknown): string {
  assertJsonCompatible(value, "authoring content");
  return JSON.stringify(value);
}

function assertAuthoringId(value: string, label: string): void {
  if (!value.trim() || value.length > 200) {
    throw new Error(`${label} must be a 1-200 character identifier`);
  }
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a timestamp`);
  }
}

function assistanceFencingConsistent(
  record: AssistanceTaskRecord
): boolean {
  if (record.privateState.fencingCounter !== record.fencingCounter) {
    return false;
  }
  if (
    record.task.status === "claimed" ||
    record.task.status === "processing"
  ) {
    return (
      record.task.lease?.fencingToken === record.fencingCounter &&
      record.privateState.ownerType !== undefined
    );
  }
  return record.task.lease === undefined;
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

function assertMigrationSequence(items: readonly Migration[]): void {
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.version !== index + 1) {
      throw new Error(
        "Migrations must be append-only and contiguous from version 1"
      );
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

export interface SqlitePersistenceOptions {
  path: string;
  readonly?: boolean;
  failureInjector?: (point: string) => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export class SqlitePersistence implements Persistence {
  readonly #db: Database.Database;
  readonly #failureInjector: ((point: string) => void) | undefined;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  constructor(options: SqlitePersistenceOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    }
    this.#db = new Database(options.path, {
      readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false,
      timeout: 5_000
    });
    this.#failureInjector = options.failureInjector;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    try {
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("busy_timeout = 5000");
      if (!(options.readonly ?? false)) {
        this.#db.pragma("journal_mode = WAL");
        this.#migrate();
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    assertMigrationSequence(migrations);
    const hasMigrations = this.#db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      )
      .get();
    let current = 0;
    if (hasMigrations) {
      const columns = this.#db
        .prepare("PRAGMA table_info(schema_migrations)")
        .all() as Array<{ name: string }>;
      const hasChecksum = columns.some((column) => column.name === "checksum");
      const rows = this.#db
        .prepare(
          hasChecksum
            ? "SELECT version, checksum FROM schema_migrations ORDER BY version"
            : "SELECT version, NULL AS checksum FROM schema_migrations ORDER BY version"
        )
        .all() as Array<{ version: number; checksum: string | null }>;
      for (const [index, row] of rows.entries()) {
        if (row.version !== index + 1) {
          throw new Error("Applied migrations are not contiguous");
        }
        const migration = migrations.find(
          (candidate) => candidate.version === row.version
        );
        if (!migration) {
          throw new Error(`Unknown applied migration version ${row.version}`);
        }
        if (hasChecksum && row.checksum === null) {
          throw new Error(
            `Migration checksum missing at version ${row.version}`
          );
        }
        if (
          row.checksum !== null &&
          row.checksum !== migrationChecksum(migration)
        ) {
          throw new Error(
            `Migration checksum mismatch at version ${row.version}`
          );
        }
      }
      current = rows.at(-1)?.version ?? 0;
    }
    for (const migration of migrations.filter(
      (candidate) => candidate.version > current
    )) {
      this.#db.transaction(() => {
        this.#db.exec(migration.sql);
        this.#inject(`migration.${migration.version}.after_sql`);
        const checksumColumn = this.#db
          .prepare("PRAGMA table_info(schema_migrations)")
          .all()
          .some((column) => (column as { name: string }).name === "checksum");
        this.#db
          .prepare(
            checksumColumn
              ? "INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)"
              : "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
          )
          .run(
            ...(checksumColumn
              ? [migration.version, now(), migrationChecksum(migration)]
              : [migration.version, now()])
          );
        if (checksumColumn) {
          const update = this.#db.prepare(
            "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL"
          );
          for (const applied of migrations.filter(
            (candidate) => candidate.version <= migration.version
          )) {
            update.run(migrationChecksum(applied), applied.version);
          }
        }
      })();
    }
  }

  #inject(point: string): void {
    this.#failureInjector?.(point);
  }

  health(): { adapter: string; schemaVersion: number; writable: boolean } {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return {
      adapter: "sqlite",
      schemaVersion: row.version,
      writable: !this.#db.readonly
    };
  }

  close(): void {
    this.#db.close();
  }

  createWorkflowDraft(record: WorkflowDraftRecord): WorkflowDraftRecord {
    assertAuthoringId(record.draftId, "draftId");
    if (record.revision !== 0) {
      throw new Error("A new Workflow Draft must start at revision 0");
    }
    assertTimestamp(record.createdAt, "createdAt");
    assertTimestamp(record.updatedAt, "updatedAt");
    const contentJson = authoringJson(record.content);
    this.#db.transaction(() => {
      if (this.getWorkflowDraft(record.draftId)) {
        throw new WorkflowDraftConflictError(
          `Workflow Draft already exists: ${record.draftId}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO workflow_drafts(
            draft_id, revision, content_json, created_at, updated_at
          ) VALUES (?, 0, ?, ?, ?)`
        )
        .run(
          record.draftId,
          contentJson,
          record.createdAt,
          record.updatedAt
        );
      this.#inject("authoring.create.after_current");
      this.#db
        .prepare(
          `INSERT INTO workflow_draft_revisions(
            draft_id, revision, operation_id, operation_digest,
            content_json, created_at
          ) VALUES (?, 0, NULL, NULL, ?, ?)`
        )
        .run(record.draftId, contentJson, record.createdAt);
      this.#inject("authoring.create.after_history");
    }).immediate();
    return this.getWorkflowDraft(record.draftId)!;
  }

  getWorkflowDraft(draftId: string): WorkflowDraftRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM workflow_drafts WHERE draft_id = ?")
      .get(draftId) as SqlRow | undefined;
    return row ? this.#readWorkflowDraft(row) : undefined;
  }

  getWorkflowDraftRevision(
    draftId: string,
    revision: number
  ): WorkflowDraftRevisionRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM workflow_draft_revisions
         WHERE draft_id = ? AND revision = ?`
      )
      .get(draftId, revision) as SqlRow | undefined;
    return row ? this.#readWorkflowDraftRevision(row) : undefined;
  }

  applyWorkflowDraftRevision(
    input: ApplyWorkflowDraftRevisionInput
  ): ApplyWorkflowDraftRevisionResult {
    assertAuthoringId(input.draftId, "draftId");
    assertAuthoringId(input.operationId, "operationId");
    assertRevision(input.expectedRevision, "expectedRevision");
    if (input.expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new Error("expectedRevision cannot advance beyond a safe integer");
    }
    assertTimestamp(input.updatedAt, "updatedAt");
    const contentJson = authoringJson(input.content);
    const operationDigest = digest({
      expectedRevision: input.expectedRevision,
      content: parseJson(contentJson),
      updatedAt: input.updatedAt
    });

    return this.#db.transaction((): ApplyWorkflowDraftRevisionResult => {
      const replay = this.#db
        .prepare(
          `SELECT * FROM workflow_draft_revisions
           WHERE draft_id = ? AND operation_id = ?`
        )
        .get(input.draftId, input.operationId) as SqlRow | undefined;
      if (replay) {
        if (String(replay.operation_digest) !== operationDigest) {
          throw new WorkflowOperationConflictError(
            `Workflow operation payload changed: ${input.operationId}`
          );
        }
        const revision = this.#readWorkflowDraftRevision(replay);
        const latest = this.getWorkflowDraft(input.draftId)!;
        return {
          status: "duplicate",
          current: {
            draftId: revision.draftId,
            revision: revision.revision,
            content: revision.content,
            createdAt: latest.createdAt,
            updatedAt: revision.createdAt
          },
          revision
        };
      }

      const current = this.getWorkflowDraft(input.draftId);
      if (!current) {
        throw new WorkflowDraftConflictError(
          `Workflow Draft does not exist: ${input.draftId}`
        );
      }
      if (current.revision !== input.expectedRevision) {
        return {
          status: "stale",
          actualRevision: current.revision
        };
      }
      const nextRevision = input.expectedRevision + 1;
      const updated = this.#db
        .prepare(
          `UPDATE workflow_drafts
           SET revision = ?, content_json = ?, updated_at = ?
           WHERE draft_id = ? AND revision = ?`
        )
        .run(
          nextRevision,
          contentJson,
          input.updatedAt,
          input.draftId,
          input.expectedRevision
        );
      if (updated.changes !== 1) {
        const actual = this.getWorkflowDraft(input.draftId);
        return {
          status: "stale",
          actualRevision: actual?.revision ?? input.expectedRevision
        };
      }
      this.#inject("authoring.apply.after_current");
      this.#db
        .prepare(
          `INSERT INTO workflow_draft_revisions(
            draft_id, revision, operation_id, operation_digest,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.draftId,
          nextRevision,
          input.operationId,
          operationDigest,
          contentJson,
          input.updatedAt
        );
      this.#inject("authoring.apply.after_history");
      return {
        status: "accepted",
        current: this.getWorkflowDraft(input.draftId)!,
        revision: this.getWorkflowDraftRevision(
          input.draftId,
          nextRevision
        )!
      };
    }).immediate();
  }

  saveWorkflowCandidate(
    candidate: WorkflowCandidateRecord
  ): WorkflowCandidateRecord {
    assertAuthoringId(candidate.candidateId, "candidateId");
    assertAuthoringId(candidate.draftId, "draftId");
    assertRevision(candidate.sourceRevision, "sourceRevision");
    assertTimestamp(candidate.createdAt, "createdAt");
    const contentJson = authoringJson(candidate.content);
    const recordDigest = digest({
      candidateId: candidate.candidateId,
      draftId: candidate.draftId,
      sourceRevision: candidate.sourceRevision,
      content: parseJson(contentJson),
      createdAt: candidate.createdAt
    });

    return this.#db.transaction(() => {
      const existing = this.#db
        .prepare(
          "SELECT * FROM workflow_candidates WHERE candidate_id = ?"
        )
        .get(candidate.candidateId) as SqlRow | undefined;
      if (existing) {
        if (String(existing.record_digest) !== recordDigest) {
          throw new WorkflowCandidateConflictError(
            `Workflow Candidate is immutable: ${candidate.candidateId}`
          );
        }
        return this.#readWorkflowCandidate(existing);
      }
      if (
        !this.getWorkflowDraftRevision(
          candidate.draftId,
          candidate.sourceRevision
        )
      ) {
        throw new WorkflowDraftConflictError(
          `Workflow Candidate source revision does not exist: ${candidate.draftId}@${candidate.sourceRevision}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO workflow_candidates(
            candidate_id, draft_id, source_revision, record_digest,
            content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          candidate.candidateId,
          candidate.draftId,
          candidate.sourceRevision,
          recordDigest,
          contentJson,
          candidate.createdAt
        );
      this.#inject("authoring.candidate.after_insert");
      return this.getWorkflowCandidate(candidate.candidateId)!;
    }).immediate();
  }

  getWorkflowCandidate(
    candidateId: string
  ): WorkflowCandidateRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM workflow_candidates WHERE candidate_id = ?")
      .get(candidateId) as SqlRow | undefined;
    return row ? this.#readWorkflowCandidate(row) : undefined;
  }

  saveCandidate(input: PublishArtifactInput): ArtifactRecord {
    const createdAt = now();
    const recordId = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO artifacts(
          record_id, asset_type, asset_id, version, digest, status,
          content_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?)
        ON CONFLICT(asset_type, asset_id, version, status)
        DO UPDATE SET
          record_id = excluded.record_id,
          digest = excluded.digest,
          content_json = excluded.content_json,
          created_at = excluded.created_at`
      )
      .run(
        recordId,
        input.assetType,
        input.assetId,
        input.version,
        input.digest,
        json(input.content),
        createdAt
      );
    this.#insertAudit(
      "artifact.candidate.saved",
      input.actor,
      `${input.assetType}:${input.assetId}@${input.version}`,
      { digest: input.digest }
    );
    return this.#readArtifact(
      this.#db
        .prepare(
          `SELECT * FROM artifacts
           WHERE asset_type = ? AND asset_id = ? AND version = ? AND status = 'candidate'`
        )
        .get(input.assetType, input.assetId, input.version) as SqlRow
    );
  }

  publish(input: PublishArtifactInput): ArtifactRecord {
    return this.#db.transaction(() => {
      const existing = this.getPublished(
        input.assetType,
        input.assetId,
        input.version
      );
      if (existing) {
        if (existing.digest !== input.digest) {
          throw new ArtifactConflictError(
            `${input.assetType}:${input.assetId}@${input.version} is already published with ${existing.digest}`
          );
        }
        return existing;
      }
      const publishedAt = now();
      const recordId = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO artifacts(
            record_id, asset_type, asset_id, version, digest, status,
            content_json, created_at, published_at
          ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`
        )
        .run(
          recordId,
          input.assetType,
          input.assetId,
          input.version,
          input.digest,
          json(input.content),
          publishedAt,
          publishedAt
        );
      this.#insertAudit(
        "artifact.published",
        input.actor,
        `${input.assetType}:${input.assetId}@${input.version}`,
        { digest: input.digest }
      );
      return this.#readArtifact(
        this.#db
          .prepare("SELECT * FROM artifacts WHERE record_id = ?")
          .get(recordId) as SqlRow
      );
    })();
  }

  getPublished(
    assetType: ArtifactType,
    assetId: string,
    version: string
  ): ArtifactRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM artifacts
         WHERE asset_type = ? AND asset_id = ? AND version = ? AND status = 'published'`
      )
      .get(assetType, assetId, version) as SqlRow | undefined;
    return row ? this.#readArtifact(row) : undefined;
  }

  listPublished(assetType?: ArtifactType): ArtifactRecord[] {
    const rows = (assetType
      ? this.#db
          .prepare(
            `SELECT * FROM artifacts WHERE status = 'published' AND asset_type = ?
             ORDER BY asset_type, asset_id, version`
          )
          .all(assetType)
      : this.#db
          .prepare(
            `SELECT * FROM artifacts WHERE status = 'published'
             ORDER BY asset_type, asset_id, version`
          )
          .all()) as SqlRow[];
    return rows.map((row) => this.#readArtifact(row));
  }

  createRun(input: CreateRunInput): RunRecord {
    return this.#db.transaction(() => {
      const run = input.run;
      if (
        input.event.runId !== run.id ||
        (input.planSnapshot && input.planSnapshot.runId !== run.id)
      ) {
        throw new Error("Run, plan snapshot and initial event identities differ");
      }
      this.#insertRun(run);
      this.#inject("create_run.after_run");
      if (input.planSnapshot) {
        this.#insertPlanSnapshot(input.planSnapshot);
      }
      this.#insertEvent(input.event);
      this.#inject("create_run.after_event");
      return run;
    })();
  }

  createRecoverableRun(
    input: CreateRunInput & {
      planSnapshot: RunPlanSnapshotRecord;
      checkpoint: EngineCheckpointRecord;
      outbox?: readonly OutboxMessage[];
      assistanceTasks?: readonly AssistanceTaskRecord[];
    }
  ): RunRecord {
    return this.#db.transaction(() => {
      if (
        input.event.runId !== input.run.id ||
        input.planSnapshot.runId !== input.run.id ||
        input.checkpoint.runId !== input.run.id
      ) {
        throw new Error(
          "Recoverable Run, plan, checkpoint and event identities differ"
        );
      }
      this.#insertRun(input.run);
      this.#inject("recoverable_run.after_run");
      this.#insertPlanSnapshot(input.planSnapshot);
      this.#insertCheckpoint(input.checkpoint);
      for (const task of input.assistanceTasks ?? []) {
        if (task.task.runId !== input.run.id) {
          throw new Error("Assistance task belongs to a different Run");
        }
        this.#insertAssistanceTask(task);
      }
      for (const message of input.outbox ?? []) {
        this.#insertOutbox("engine_outbox", message);
      }
      this.#inject("recoverable_run.after_effects");
      this.#insertEvent(input.event);
      this.#inject("recoverable_run.after_event");
      return input.run;
    })();
  }

  commitRecoverableTransition(
    input: RunTransitionInput & {
      checkpoint: EngineCheckpointRecord;
      expectedCheckpointRevision: number;
      outbox?: readonly OutboxMessage[];
      assistanceTasks?: readonly AssistanceTaskRecord[];
      inbox?: readonly InboxMessageRecord[];
      acknowledgeOutboxIds?: readonly string[];
    }
  ): RunRecord {
    return this.#db.transaction(() => {
      if (
        input.checkpoint.runId !== input.runId ||
        input.event.runId !== input.runId ||
        input.checkpoint.stateRevision <= input.expectedCheckpointRevision
      ) {
        throw new Error("Recoverable transition identity or revision is invalid");
      }
      const runUpdate = this.#db
        .prepare(
          `UPDATE workflow_runs
           SET status = ?, revision = revision + 1, current_node_key = ?,
               output_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          input.nextStatus,
          input.currentNodeKey ?? null,
          input.output === undefined ? null : json(input.output),
          input.checkpoint.updatedAt,
          input.runId,
          input.expectedRevision
        );
      const checkpointUpdate = this.#db
        .prepare(
          `UPDATE engine_checkpoints
           SET state_version = ?, state_revision = ?, state_json = ?,
               updated_at = ?
           WHERE run_id = ? AND state_revision = ?`
        )
        .run(
          input.checkpoint.stateVersion,
          input.checkpoint.stateRevision,
          json(input.checkpoint.state),
          input.checkpoint.updatedAt,
          input.runId,
          input.expectedCheckpointRevision
        );
      if (runUpdate.changes !== 1 || checkpointUpdate.changes !== 1) {
        throw new RevisionConflictError(
          `Recoverable Run ${input.runId} revision changed`
        );
      }
      this.#inject("recoverable_transition.after_state");
      for (const task of input.assistanceTasks ?? []) {
        if (task.task.runId !== input.runId) {
          throw new Error("Assistance task belongs to a different Run");
        }
        this.#insertAssistanceTask(task);
      }
      for (const message of input.inbox ?? []) {
        this.#insertInbox(message);
      }
      for (const message of input.outbox ?? []) {
        this.#insertOutbox("engine_outbox", message);
      }
      for (const outboxId of input.acknowledgeOutboxIds ?? []) {
        const acknowledged = this.#db
          .prepare(
            `UPDATE engine_outbox SET acknowledged_at = ?
             WHERE id = ? AND acknowledged_at IS NULL`
          )
          .run(input.checkpoint.updatedAt, outboxId);
        if (acknowledged.changes !== 1) {
          throw new RevisionConflictError(
            `Engine outbox ${outboxId} is missing or already acknowledged`
          );
        }
      }
      this.#insertEvent(input.event);
      this.#inject("recoverable_transition.after_effects");
      return this.getRun(input.runId)!;
    })();
  }

  createNodeExecution(
    node: NodeExecutionRecord,
    event: ExecutionEventRecord
  ): NodeExecutionRecord {
    return this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO node_executions(
            id, run_id, node_key, node_id, node_version, status, revision,
            attempt, idempotency_key, fencing_token, input_json, output_json,
            error_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          node.id,
          node.runId,
          node.nodeKey,
          node.nodeId,
          node.nodeVersion,
          node.status,
          node.revision,
          node.attempt,
          node.idempotencyKey,
          node.fencingToken,
          json(node.input),
          node.output === undefined ? null : json(node.output),
          node.error === undefined ? null : json(node.error),
          node.createdAt,
          node.updatedAt
        );
      this.#insertEvent(event);
      return node;
    })();
  }

  commitRunTransition(input: RunTransitionInput): RunRecord {
    return this.#db.transaction(() => {
      const updatedAt = now();
      const result = this.#db
        .prepare(
          `UPDATE workflow_runs
           SET status = ?, revision = revision + 1, current_node_key = ?,
               output_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          input.nextStatus,
          input.currentNodeKey ?? null,
          input.output === undefined ? null : json(input.output),
          updatedAt,
          input.runId,
          input.expectedRevision
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          `Run ${input.runId} revision is not ${input.expectedRevision}`
        );
      }
      this.#insertEvent(input.event);
      return this.getRun(input.runId)!;
    })();
  }

  commitNodeTransition(input: NodeTransitionInput): NodeExecutionRecord {
    return this.#db.transaction(() => {
      const updatedAt = now();
      const result = this.#db
        .prepare(
          `UPDATE node_executions
           SET status = ?, revision = revision + 1, output_json = ?,
               error_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          input.nextStatus,
          input.output === undefined ? null : json(input.output),
          input.error === undefined ? null : json(input.error),
          updatedAt,
          input.nodeExecutionId,
          input.expectedRevision
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          `Node ${input.nodeExecutionId} revision is not ${input.expectedRevision}`
        );
      }
      this.#insertEvent(input.event);
      if (input.idempotencyResult) {
        this.#db
          .prepare(
            `INSERT INTO idempotency_records(
              idempotency_key, node_execution_id, status, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING`
          )
          .run(
            input.idempotencyResult.key,
            input.nodeExecutionId,
            input.idempotencyResult.status,
            json(input.idempotencyResult.result),
            updatedAt
          );
      }
      if (input.outbox) this.#insertOutbox("engine_outbox", input.outbox);
      return this.getNodeExecution(input.nodeExecutionId)!;
    })();
  }

  getRunPlanSnapshot(runId: string): RunPlanSnapshotRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM run_plan_snapshots WHERE run_id = ?")
      .get(runId) as SqlRow | undefined;
    return row ? this.#readPlanSnapshot(row) : undefined;
  }

  getEngineCheckpoint(runId: string): EngineCheckpointRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM engine_checkpoints WHERE run_id = ?")
      .get(runId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id),
      stateVersion: String(row.state_version),
      stateRevision: Number(row.state_revision),
      state: parseJson(row.state_json) as JsonValue,
      updatedAt: String(row.updated_at)
    };
  }

  putExecutionScope(scope: ExecutionScopeRecord): ExecutionScopeRecord {
    this.#db
      .prepare(
        `INSERT INTO execution_scopes(
          scope_id, run_id, scope_path, parent_scope_id, scope_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        scope.scopeId,
        scope.runId,
        json(scope.scopePath),
        scope.parentScopeId ?? null,
        scope.scopeKind,
        scope.createdAt
      );
    return scope;
  }

  putIterationInstance(
    iteration: IterationInstanceRecord
  ): IterationInstanceRecord {
    this.#db
      .prepare(
        `INSERT INTO iteration_instances(
          iteration_id, run_id, scope_id, iteration_key, ordinal, status,
          input_json, output_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        iteration.iterationId,
        iteration.runId,
        iteration.scopeId,
        iteration.iterationKey,
        iteration.ordinal,
        iteration.status,
        json(iteration.input),
        iteration.output === undefined ? null : json(iteration.output),
        iteration.createdAt,
        iteration.updatedAt
      );
    return iteration;
  }

  putStepInstance(step: StepInstanceRecord): StepInstanceRecord {
    this.#db
      .prepare(
        `INSERT INTO step_instances(
          step_instance_id, run_id, scope_id, iteration_id, step_key, attempt,
          execution_identity, status, revision, input_json, output_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        step.stepInstanceId,
        step.runId,
        step.scopeId,
        step.iterationId ?? null,
        step.stepKey,
        step.attempt,
        step.executionIdentity,
        step.status,
        step.revision,
        json(step.input),
        step.output === undefined ? null : json(step.output),
        step.createdAt,
        step.updatedAt
      );
    return step;
  }

  getExecutionScope(scopeId: string): ExecutionScopeRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM execution_scopes WHERE scope_id = ?")
      .get(scopeId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      scopeId: String(row.scope_id),
      runId: String(row.run_id),
      scopePath: parseJson(
        row.scope_path
      ) as ExecutionScopeRecord["scopePath"],
      ...(row.parent_scope_id == null
        ? {}
        : { parentScopeId: String(row.parent_scope_id) }),
      scopeKind: row.scope_kind as ExecutionScopeRecord["scopeKind"],
      createdAt: String(row.created_at)
    };
  }

  getIterationInstance(
    iterationId: string
  ): IterationInstanceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM iteration_instances WHERE iteration_id = ?")
      .get(iterationId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      iterationId: String(row.iteration_id),
      runId: String(row.run_id),
      scopeId: String(row.scope_id),
      iterationKey: String(row.iteration_key),
      ordinal: Number(row.ordinal),
      status: String(row.status),
      input: parseJson(row.input_json) as JsonValue,
      ...(row.output_json == null
        ? {}
        : { output: parseJson(row.output_json) as JsonValue }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  getStepInstance(stepInstanceId: string): StepInstanceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM step_instances WHERE step_instance_id = ?")
      .get(stepInstanceId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      stepInstanceId: String(row.step_instance_id),
      runId: String(row.run_id),
      scopeId: String(row.scope_id),
      ...(row.iteration_id == null
        ? {}
        : { iterationId: String(row.iteration_id) }),
      stepKey: String(row.step_key),
      attempt: Number(row.attempt),
      executionIdentity: String(row.execution_identity),
      status: String(row.status),
      revision: Number(row.revision),
      input: parseJson(row.input_json) as JsonValue,
      ...(row.output_json == null
        ? {}
        : { output: parseJson(row.output_json) as JsonValue }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  createBlockingTaskAndPauseRun(
    input: CreateBlockingAssistanceInput
  ): { task: AssistanceTaskRecord; run: RunRecord } {
    return this.#db.transaction(() => {
      if (
        input.task.task.runId !== input.runId ||
        input.waitingEvent.runId !== input.runId ||
        input.task.task.revision !== 0 ||
        input.task.fencingCounter !== 0 ||
        input.task.task.status !== "queued"
      ) {
        throw new Error(
          "Blocking assistance aggregate identity or state is invalid"
        );
      }
      this.#insertAssistanceTask(input.task);
      this.#inject("blocking_task.after_task");
      const nextStatus =
        input.task.task.mode === "ai_review"
          ? "waiting_assistance"
          : "waiting_human";
      const update = this.#db
        .prepare(
          `UPDATE workflow_runs
           SET status = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          nextStatus,
          input.task.task.updatedAt,
          input.runId,
          input.expectedRunRevision
        );
      if (update.changes !== 1) {
        throw new RevisionConflictError(
          `Run ${input.runId} revision is not ${input.expectedRunRevision}`
        );
      }
      this.#insertEvent(input.waitingEvent);
      this.#insertOutbox("engine_outbox", input.outbox);
      this.#inject("blocking_task.after_outbox");
      return {
        task: input.task,
        run: this.getRun(input.runId)!
      };
    })();
  }

  commitAssistanceTask(input: {
    task: AssistanceTaskRecord;
    expectedRevision: number;
    expectedFencingCounter: number;
  }): { status: "accepted"; task: AssistanceTaskRecord } | { status: "stale" } {
    return this.#db.transaction(() => {
      if (
        input.task.task.revision !== input.expectedRevision + 1 ||
        input.task.fencingCounter < input.expectedFencingCounter ||
        input.task.fencingCounter > input.expectedFencingCounter + 1 ||
        !assistanceFencingConsistent(input.task)
      ) {
        return { status: "stale" as const };
      }
      const update = this.#db
        .prepare(
          `UPDATE assistance_tasks
           SET status = ?, revision = ?, fencing_counter = ?,
               canonical_json = ?, private_state_json = ?, updated_at = ?
           WHERE task_id = ? AND revision = ? AND fencing_counter = ?`
        )
        .run(
          input.task.task.status,
          input.task.task.revision,
          input.task.fencingCounter,
          json(input.task.task),
          json(input.task.privateState),
          input.task.task.updatedAt,
          input.task.task.taskId,
          input.expectedRevision,
          input.expectedFencingCounter
        );
      return update.changes === 1
        ? { status: "accepted" as const, task: input.task }
        : { status: "stale" as const };
    })();
  }

  commitAssistanceTaskRequest(
    input: CommitAssistanceTaskRequestInput
  ): CommitAssistanceTaskRequestResult {
    return this.#db.transaction(() => {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.requestId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.expectedFencingCounter) ||
        input.expectedFencingCounter < 0 ||
        !Number.isFinite(Date.parse(input.recordedAt))
      ) {
        return { status: "stale" as const };
      }
      const duplicate = this.getAssistanceRequestResult(input.requestId);
      if (duplicate) {
        return {
          status: "duplicate" as const,
          task: duplicate
        };
      }
      if (
        input.task.task.revision !== input.expectedRevision + 1 ||
        input.task.fencingCounter < input.expectedFencingCounter ||
        input.task.fencingCounter > input.expectedFencingCounter + 1 ||
        !assistanceFencingConsistent(input.task)
      ) {
        return { status: "stale" as const };
      }
      const update = this.#db
        .prepare(
          `UPDATE assistance_tasks
           SET status = ?, revision = ?, fencing_counter = ?,
               canonical_json = ?, private_state_json = ?, updated_at = ?
           WHERE task_id = ? AND revision = ? AND fencing_counter = ?`
        )
        .run(
          input.task.task.status,
          input.task.task.revision,
          input.task.fencingCounter,
          json(input.task.task),
          json(input.task.privateState),
          input.task.task.updatedAt,
          input.task.task.taskId,
          input.expectedRevision,
          input.expectedFencingCounter
        );
      if (update.changes !== 1) return { status: "stale" as const };
      this.#inject("assistance_request.after_task");
      this.#db
        .prepare(
          `INSERT INTO assistance_task_request_results(
            request_id, task_id, expected_revision, expected_fencing_counter,
            result_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.requestId,
          input.task.task.taskId,
          input.expectedRevision,
          input.expectedFencingCounter,
          json(input.task),
          input.recordedAt
        );
      this.#inject("assistance_request.after_result");
      return {
        status: "accepted" as const,
        task: input.task
      };
    }).immediate();
  }

  completeDetachedAssistanceTask(
    input: CompleteDetachedAssistanceInput
  ): CommitAssistanceTaskRequestResult {
    return this.#db.transaction(() => {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.requestId) ||
        input.inbox.id !== input.requestId ||
        input.inbox.aggregateId !== input.task.task.taskId ||
        input.event.runId !== input.task.task.runId ||
        input.task.task.status !== "completed" ||
        input.task.privateState.blocking !== false ||
        input.task.task.revision !== input.expectedRevision + 1 ||
        input.task.fencingCounter !== input.expectedFencingCounter ||
        !assistanceFencingConsistent(input.task) ||
        !Number.isFinite(Date.parse(input.inbox.receivedAt)) ||
        (input.inbox.appliedAt !== undefined &&
          !Number.isFinite(Date.parse(input.inbox.appliedAt))) ||
        !Number.isFinite(Date.parse(input.event.occurredAt))
      ) {
        return { status: "stale" as const };
      }
      const duplicate = this.getAssistanceRequestResult(input.requestId);
      if (duplicate) {
        return {
          status: "duplicate" as const,
          task: duplicate
        };
      }
      const currentTask = this.getAssistanceTask(input.task.task.taskId);
      if (
        !currentTask ||
        !this.getRun(input.task.task.runId) ||
        currentTask.task.revision !== input.expectedRevision ||
        currentTask.fencingCounter !== input.expectedFencingCounter ||
        (currentTask.privateState.blocking !== false &&
          currentTask.privateState.blocking !== undefined) ||
        !assistanceFencingConsistent(currentTask) ||
        this.getInboxMessage(input.inbox.id)
      ) {
        return { status: "stale" as const };
      }
      for (const outboxId of input.acknowledgeOutboxIds ?? []) {
        const row = this.#db
          .prepare(
            `SELECT acknowledged_at
             FROM engine_outbox
             WHERE id = ?`
          )
          .get(outboxId) as { acknowledged_at: string | null } | undefined;
        if (!row || row.acknowledged_at !== null) {
          return { status: "stale" as const };
        }
      }

      this.#insertInbox(input.inbox);
      const update = this.#db
        .prepare(
          `UPDATE assistance_tasks
           SET status = ?, revision = ?, fencing_counter = ?,
               canonical_json = ?, private_state_json = ?, updated_at = ?
           WHERE task_id = ? AND revision = ? AND fencing_counter = ?`
        )
        .run(
          input.task.task.status,
          input.task.task.revision,
          input.task.fencingCounter,
          json(input.task.task),
          json(input.task.privateState),
          input.task.task.updatedAt,
          input.task.task.taskId,
          input.expectedRevision,
          input.expectedFencingCounter
        );
      if (update.changes !== 1) {
        throw new RevisionConflictError("Detached assistance task CAS failed");
      }
      this.#inject("detached_assistance.after_task");
      this.#db
        .prepare(
          `INSERT INTO assistance_task_request_results(
            request_id, task_id, expected_revision, expected_fencing_counter,
            result_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.requestId,
          input.task.task.taskId,
          input.expectedRevision,
          input.expectedFencingCounter,
          json(input.task),
          input.event.occurredAt
        );
      const sequenceRow = this.#db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM execution_events
           WHERE run_id = ?`
        )
        .get(input.event.runId) as { next_sequence: number };
      this.#insertEvent({
        ...input.event,
        sequence: sequenceRow.next_sequence
      });
      for (const outboxId of input.acknowledgeOutboxIds ?? []) {
        const acknowledged = this.#db
          .prepare(
            `UPDATE engine_outbox
             SET acknowledged_at = ?
             WHERE id = ? AND acknowledged_at IS NULL`
          )
          .run(input.event.occurredAt, outboxId);
        if (acknowledged.changes !== 1) {
          throw new RevisionConflictError(
            `Engine outbox ${outboxId} detached acknowledgement failed`
          );
        }
      }
      this.#inject("detached_assistance.after_audit");
      return {
        status: "accepted" as const,
        task: input.task
      };
    }).immediate();
  }

  submitTaskAndWakeRun(
    input: SubmitAssistanceAndWakeInput
  ):
    | { status: "accepted"; task: AssistanceTaskRecord; run: RunRecord }
    | { status: "duplicate" | "stale" } {
    return this.#db.transaction(() => {
      if (
        input.inbox.aggregateId !== input.task.task.taskId ||
        input.wakeEvent.runId !== input.task.task.runId
      ) {
        return { status: "stale" as const };
      }
      if (
        this.#db
          .prepare("SELECT 1 FROM engine_inbox WHERE message_id = ?")
          .get(input.inbox.id) ||
        this.getAssistanceRequestResult(input.inbox.id)
      ) {
        return { status: "duplicate" as const };
      }
      const currentTask = this.getAssistanceTask(input.task.task.taskId);
      const currentRun = this.getRun(input.task.task.runId);
      if (
        !currentTask ||
        !currentRun ||
        currentTask.task.revision !== input.expectedTaskRevision ||
        currentTask.fencingCounter !== input.expectedFencingToken ||
        input.task.fencingCounter !== input.expectedFencingToken ||
        input.task.task.revision !== input.expectedTaskRevision + 1 ||
        !["completed", "expired", "cancelled", "failed"].includes(
          input.task.task.status
        ) ||
        !assistanceFencingConsistent(currentTask) ||
        !assistanceFencingConsistent(input.task) ||
        currentRun.revision !== input.expectedRunRevision ||
        (input.checkpoint !== undefined &&
          (input.checkpoint.runId !== input.task.task.runId ||
            input.expectedCheckpointRevision === undefined ||
            input.checkpoint.stateRevision <=
              input.expectedCheckpointRevision)) ||
        !["waiting_assistance", "waiting_human"].includes(currentRun.status)
      ) {
        return { status: "stale" as const };
      }
      this.#insertInbox(input.inbox);
      this.#inject("submit_task.after_inbox");
      const taskUpdate = this.#db
        .prepare(
          `UPDATE assistance_tasks
           SET status = ?, revision = ?, fencing_counter = ?,
               canonical_json = ?, private_state_json = ?, updated_at = ?
           WHERE task_id = ? AND revision = ? AND fencing_counter = ?`
        )
        .run(
          input.task.task.status,
          input.task.task.revision,
          input.task.fencingCounter,
          json(input.task.task),
          json(input.task.privateState),
          input.task.task.updatedAt,
          input.task.task.taskId,
          input.expectedTaskRevision,
          input.expectedFencingToken
        );
      const runUpdate = this.#db
        .prepare(
          `UPDATE workflow_runs
           SET status = ?, revision = revision + 1, current_node_key = ?,
               output_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?
             AND status IN ('waiting_assistance', 'waiting_human')`
        )
        .run(
          input.nextRunStatus ?? "running",
          input.currentNodeKey ?? null,
          input.output === undefined ? null : json(input.output),
          input.wakeEvent.occurredAt,
          input.task.task.runId,
          input.expectedRunRevision
        );
      if (taskUpdate.changes !== 1 || runUpdate.changes !== 1) {
        throw new RevisionConflictError("Assistance wake CAS failed");
      }
      if (input.checkpoint) {
        const checkpointUpdate = this.#db
          .prepare(
            `UPDATE engine_checkpoints
             SET state_version = ?, state_revision = ?, state_json = ?,
                 updated_at = ?
             WHERE run_id = ? AND state_revision = ?`
          )
          .run(
            input.checkpoint.stateVersion,
            input.checkpoint.stateRevision,
            json(input.checkpoint.state),
            input.checkpoint.updatedAt,
            input.checkpoint.runId,
            input.expectedCheckpointRevision
          );
        if (checkpointUpdate.changes !== 1) {
          throw new RevisionConflictError("Assistance checkpoint CAS failed");
        }
      }
      this.#db
        .prepare(
          `INSERT INTO assistance_task_request_results(
            request_id, task_id, expected_revision, expected_fencing_counter,
            result_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.inbox.id,
          input.task.task.taskId,
          input.expectedTaskRevision,
          input.expectedFencingToken,
          json(input.task),
          input.wakeEvent.occurredAt
        );
      this.#insertEvent(input.wakeEvent);
      if (input.outbox) this.#insertOutbox("engine_outbox", input.outbox);
      for (const task of input.assistanceTasks ?? []) {
        if (task.task.runId !== input.task.task.runId) {
          throw new Error("Assistance task belongs to a different Run");
        }
        this.#insertAssistanceTask(task);
      }
      for (const message of input.additionalOutbox ?? []) {
        this.#insertOutbox("engine_outbox", message);
      }
      for (const outboxId of input.acknowledgeOutboxIds ?? []) {
        const acknowledged = this.#db
          .prepare(
            `UPDATE engine_outbox SET acknowledged_at = ?
             WHERE id = ? AND acknowledged_at IS NULL`
          )
          .run(input.wakeEvent.occurredAt, outboxId);
        if (acknowledged.changes !== 1) {
          throw new RevisionConflictError(
            `Engine outbox ${outboxId} is missing or already acknowledged`
          );
        }
      }
      this.#db
        .prepare(
          "UPDATE engine_inbox SET consumed_at = ? WHERE message_id = ?"
        )
        .run(input.inbox.appliedAt ?? input.wakeEvent.occurredAt, input.inbox.id);
      this.#inject("submit_task.after_wake");
      return {
        status: "accepted" as const,
        task: input.task,
        run: this.getRun(input.task.task.runId)!
      };
    })();
  }

  getAssistanceTask(taskId: string): AssistanceTaskRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM assistance_tasks WHERE task_id = ?")
      .get(taskId) as SqlRow | undefined;
    return row ? this.#readAssistanceTask(row) : undefined;
  }

  listAssistanceTasks(
    filter: AssistanceTaskListFilter
  ): AssistanceTaskRecord[] {
    const limit = filter.limit ?? 100;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new Error("Assistance task list limit must be between 1 and 1000");
    }
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      conditions.push(
        `status IN (${filter.statuses.map(() => "?").join(", ")})`
      );
      parameters.push(...filter.statuses);
    }
    if (filter.modes) {
      if (filter.modes.length === 0) return [];
      conditions.push(
        `json_extract(canonical_json, '$.mode')
          IN (${filter.modes.map(() => "?").join(", ")})`
      );
      parameters.push(...filter.modes);
    }
    if (filter.ownerType) {
      conditions.push(
        "json_extract(private_state_json, '$.ownerType') = ?"
      );
      parameters.push(filter.ownerType);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM assistance_tasks
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY created_at, task_id
         LIMIT ?`
      )
      .all(...parameters, limit) as SqlRow[];
    return rows.map((row) => this.#readAssistanceTask(row));
  }

  getAssistanceRequestResult(
    requestId: string
  ): AssistanceTaskRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT result_json
         FROM assistance_task_request_results
         WHERE request_id = ?`
      )
      .get(requestId) as { result_json: string } | undefined;
    return row
      ? (parseJson(row.result_json) as AssistanceTaskRecord)
      : undefined;
  }

  getInboxMessage(messageId: string): InboxMessageRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM engine_inbox WHERE message_id = ?")
      .get(messageId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      id: String(row.message_id),
      topic: String(row.topic),
      aggregateId: String(row.aggregate_id),
      payload: parseJson(row.payload_json),
      receivedAt: String(row.received_at),
      ...(row.consumed_at == null
        ? {}
        : { appliedAt: String(row.consumed_at) })
    };
  }

  stageDataset(record: DatasetStagingRecord): DatasetStagingRecord {
    this.#db
      .prepare(
        `INSERT INTO dataset_staging(
          staging_id, profile_id, profile_version, source_digest, state,
          validation_report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.stagingId,
        record.profileId,
        record.profileVersion,
        record.sourceDigest,
        record.state,
        json(record.validationReport),
        record.createdAt,
        record.updatedAt
      );
    return record;
  }

  transitionDatasetStaging(input: {
    stagingId: string;
    expectedState: DatasetStagingRecord["state"];
    nextState: DatasetStagingRecord["state"];
    validationReport: JsonValue;
    updatedAt: string;
  }): DatasetStagingRecord {
    const result = this.#db
      .prepare(
        `UPDATE dataset_staging
         SET state = ?, validation_report_json = ?, updated_at = ?
         WHERE staging_id = ? AND state = ?`
      )
      .run(
        input.nextState,
        json(input.validationReport),
        input.updatedAt,
        input.stagingId,
        input.expectedState
      );
    if (result.changes !== 1) {
      throw new RevisionConflictError(
        `Dataset staging ${input.stagingId} is not ${input.expectedState}`
      );
    }
    return this.getDatasetStaging(input.stagingId)!;
  }

  getDatasetStaging(stagingId: string): DatasetStagingRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM dataset_staging WHERE staging_id = ?")
      .get(stagingId) as SqlRow | undefined;
    return row ? this.#readDatasetStaging(row) : undefined;
  }

  publishDataset(input: {
    stagingId: string;
    expectedState: "validated";
    dataset: DatasetVersionDefinition;
    normalizedRecords: readonly JsonValue[];
    audit: AuditRecord;
  }): DatasetVersionDefinition {
    return this.#db.transaction(() => {
      if (input.dataset.recordCount !== input.normalizedRecords.length) {
        throw new Error(
          "Dataset record count does not match normalized records"
        );
      }
      const staging = this.getDatasetStaging(input.stagingId);
      if (!staging || staging.state !== input.expectedState) {
        throw new RevisionConflictError(
          `Dataset staging ${input.stagingId} is not validated`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO dataset_versions(
            dataset_id, version, records_digest, canonical_json, staging_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.dataset.metadata.id,
          input.dataset.metadata.version,
          input.dataset.recordsDigest,
          json(input.dataset),
          input.stagingId,
          input.audit.occurredAt
        );
      this.#inject("publish_dataset.after_version");
      const insertRecord = this.#db.prepare(
        `INSERT INTO dataset_record_index(
          dataset_id, version, record_key, ordinal, record_digest, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const recordKeys = new Set<string>();
      input.normalizedRecords.forEach((record, ordinal) => {
        const recordObject =
          record !== null && typeof record === "object" && !Array.isArray(record)
            ? (record as Readonly<Record<string, JsonValue>>)
            : undefined;
        const candidateId =
          recordObject &&
          (typeof recordObject.id === "string" ||
            typeof recordObject.id === "number")
            ? String(recordObject.id).trim()
            : "";
        const recordKey = candidateId
          ? `id:${candidateId}`
          : `ordinal:${String(ordinal).padStart(12, "0")}`;
        if (recordKeys.has(recordKey)) {
          throw new Error(`Duplicate dataset record key: ${recordKey}`);
        }
        recordKeys.add(recordKey);
        insertRecord.run(
          input.dataset.metadata.id,
          input.dataset.metadata.version,
          recordKey,
          ordinal,
          digest(record),
          json(record)
        );
      });
      const update = this.#db
        .prepare(
          `UPDATE dataset_staging
          SET state = 'published', updated_at = ?
           WHERE staging_id = ? AND state = ?`
        )
        .run(input.audit.occurredAt, input.stagingId, input.expectedState);
      if (update.changes !== 1) {
        throw new RevisionConflictError("Dataset staging changed concurrently");
      }
      this.#insertAuditRecord(input.audit);
      this.#inject("publish_dataset.after_audit");
      return input.dataset;
    })();
  }

  getDataset(
    id: string,
    version: string
  ): DatasetVersionDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM dataset_versions WHERE dataset_id = ? AND version = ?"
      )
      .get(id, version) as { canonical_json: string } | undefined;
    return row
      ? (parseJson(row.canonical_json) as DatasetVersionDefinition)
      : undefined;
  }

  readDatasetRecords(input: {
    id: string;
    version: string;
    afterRecordKey?: string;
    limit: number;
  }): { records: readonly JsonValue[]; nextRecordKey?: string } {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1000
    ) {
      throw new Error("Dataset record page limit must be between 1 and 1000");
    }
    const rows = this.#db
      .prepare(
        `SELECT record_key, record_json
         FROM dataset_record_index
         WHERE dataset_id = ? AND version = ? AND record_key > ?
         ORDER BY record_key
         LIMIT ?`
      )
      .all(
        input.id,
        input.version,
        input.afterRecordKey ?? "",
        input.limit + 1
      ) as Array<{ record_key: string; record_json: string }>;
    const page = rows.slice(0, input.limit);
    return {
      records: page.map((row) => parseJson(row.record_json) as JsonValue),
      ...(rows.length > input.limit && page.length > 0
        ? { nextRecordKey: page.at(-1)!.record_key }
        : {})
    };
  }

  putDecision(record: DecisionRecordDefinition): DecisionRecordDefinition {
    const existing = this.#db
      .prepare("SELECT canonical_json FROM decision_records WHERE decision_id = ?")
      .get(record.decisionId) as { canonical_json: string } | undefined;
    if (existing) {
      if (
        canonicalJson(parseJson(existing.canonical_json)) !==
        canonicalJson(record)
      ) {
        throw new ArtifactConflictError(
          `Decision ${record.decisionId} already exists with different content`
        );
      }
      return parseJson(existing.canonical_json) as DecisionRecordDefinition;
    }
    this.#insertDecision(record);
    return record;
  }

  getActiveDecision(
    decisionType: string,
    scope: Readonly<Record<string, string>>,
    preconditions: Readonly<Record<string, string>>
  ): DecisionRecordDefinition | undefined {
    const row = this.#db
      .prepare(
        `SELECT canonical_json FROM decision_records
         WHERE decision_type = ? AND scope_digest = ?
           AND preconditions_digest = ? AND status = 'active'`
      )
      .get(decisionType, digest(scope), digest(preconditions)) as
      | { canonical_json: string }
      | undefined;
    return row
      ? (parseJson(row.canonical_json) as DecisionRecordDefinition)
      : undefined;
  }

  revokeDecision(input: {
    decisionId: string;
    expectedStatus: "active";
    revokedBy: string;
    revokedAt: string;
  }): DecisionRecordDefinition {
    return this.#db.transaction(() => {
      const current = this.#getDecision(input.decisionId);
      if (!current || current.status !== input.expectedStatus) {
        throw new RevisionConflictError(
          `Decision ${input.decisionId} is not active`
        );
      }
      const revoked: DecisionRecordDefinition = {
        ...current,
        status: "revoked",
        revokedBy: input.revokedBy,
        revokedAt: input.revokedAt
      };
      const result = this.#db
        .prepare(
          `UPDATE decision_records
           SET status = 'revoked', canonical_json = ?, updated_at = ?
           WHERE decision_id = ? AND status = 'active'`
        )
        .run(json(revoked), input.revokedAt, input.decisionId);
      if (result.changes !== 1) {
        throw new RevisionConflictError("Decision changed concurrently");
      }
      return revoked;
    })();
  }

  supersedeDecision(input: {
    decisionId: string;
    expectedStatus: "active";
    replacement: DecisionRecordDefinition;
  }): {
    superseded: DecisionRecordDefinition;
    replacement: DecisionRecordDefinition;
  } {
    return this.#db.transaction(() => {
      const current = this.#getDecision(input.decisionId);
      if (
        !current ||
        current.status !== input.expectedStatus ||
        input.replacement.status !== "active" ||
        input.replacement.supersedes !== input.decisionId
      ) {
        throw new RevisionConflictError("Decision supersede precondition failed");
      }
      const superseded: DecisionRecordDefinition = {
        ...current,
        status: "superseded"
      };
      const update = this.#db
        .prepare(
          `UPDATE decision_records
           SET status = 'superseded', canonical_json = ?, updated_at = ?
           WHERE decision_id = ? AND status = 'active'`
        )
        .run(
          json(superseded),
          input.replacement.confirmedAt,
          input.decisionId
        );
      if (update.changes !== 1) {
        throw new RevisionConflictError("Decision changed concurrently");
      }
      this.#insertDecision(input.replacement);
      return { superseded, replacement: input.replacement };
    })();
  }

  enqueueCommand(command: GatewayCommandRecord, outbox: OutboxMessage): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO gateway_commands(
            id, node_execution_id, command_seq, idempotency_key, fencing_token,
            state, payload_json, result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          command.id,
          command.nodeExecutionId,
          command.commandSeq,
          command.idempotencyKey,
          command.fencingToken,
          command.state,
          json(command.payload),
          command.result === undefined ? null : json(command.result),
          command.createdAt,
          command.updatedAt
        );
      this.#insertOutbox("gateway_outbox", outbox);
    })();
  }

  promoteEngineOutbox(
    engineOutboxId: string,
    command: GatewayCommandRecord,
    outbox: OutboxMessage,
    acknowledgedAt: string
  ): GatewayCommandRecord {
    return this.#db.transaction(() => {
      const existing = this.#db
        .prepare(
          "SELECT * FROM gateway_commands WHERE node_execution_id = ?"
        )
        .get(command.nodeExecutionId) as SqlRow | undefined;
      if (!existing) {
        this.enqueueCommand(command, outbox);
      }
      const result = this.#db
        .prepare(
          `UPDATE engine_outbox
           SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE id = ?`
        )
        .run(acknowledgedAt, engineOutboxId);
      if (result.changes !== 1) {
        throw new Error(`Engine outbox message not found: ${engineOutboxId}`);
      }
      return existing
        ? this.#readGatewayCommand(existing)
        : this.getGatewayCommand(command.id)!;
    })();
  }

  acceptResult(input: {
    commandId: string;
    fencingToken: number;
    result: unknown;
    inboxMessageId: string;
    receivedAt: string;
  }): "accepted" | "duplicate" | "stale" {
    return this.#db.transaction(() => {
      const inbox = this.#db
        .prepare("SELECT 1 FROM gateway_inbox WHERE message_id = ?")
        .get(input.inboxMessageId);
      if (inbox) return "duplicate" as const;
      const command = this.#db
        .prepare(
          "SELECT fencing_token, state FROM gateway_commands WHERE id = ?"
        )
        .get(input.commandId) as
        | { fencing_token: number; state: string }
        | undefined;
      if (!command || command.fencing_token !== input.fencingToken) {
        this.#insertAudit("gateway.result.stale", "gateway", input.commandId, {
          receivedFencingToken: input.fencingToken,
          currentFencingToken: command?.fencing_token
        });
        return "stale" as const;
      }
      if (command.state === "terminal") {
        this.#db
          .prepare(
            "INSERT INTO gateway_inbox(message_id, command_id, received_at) VALUES (?, ?, ?)"
          )
          .run(input.inboxMessageId, input.commandId, input.receivedAt);
        return "duplicate" as const;
      }
      this.#db
        .prepare(
          "INSERT INTO gateway_inbox(message_id, command_id, received_at) VALUES (?, ?, ?)"
        )
        .run(input.inboxMessageId, input.commandId, input.receivedAt);
      this.#db
        .prepare(
          `UPDATE gateway_commands
           SET state = 'terminal', result_json = ?, updated_at = ?
           WHERE id = ? AND fencing_token = ?`
        )
        .run(
          json(input.result),
          input.receivedAt,
          input.commandId,
          input.fencingToken
        );
      this.#db
        .prepare(
          `UPDATE gateway_outbox
           SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE aggregate_id = ?`
        )
        .run(input.receivedAt, input.commandId);
      return "accepted" as const;
    })();
  }

  acceptResultWithEvidence(input: {
    commandId: string;
    runId: string;
    nodeExecutionId: string;
    fencingToken: number;
    result: unknown;
    evidenceIds: readonly string[];
    evidenceLinks: readonly EvidenceLinkDefinition[];
    inboxMessageId: string;
    receivedAt: string;
  }):
    | "accepted"
    | "duplicate"
    | "stale"
    | "evidence_not_ready"
    | "evidence_invalid" {
    return this.#db.transaction(() => {
      const inbox = this.#db
        .prepare("SELECT 1 FROM gateway_inbox WHERE message_id = ?")
        .get(input.inboxMessageId);
      if (inbox) return "duplicate" as const;
      const command = this.#db
        .prepare(
          `SELECT node_execution_id, fencing_token, state, payload_json
           FROM gateway_commands WHERE id = ?`
        )
        .get(input.commandId) as
        | {
            node_execution_id: string;
            fencing_token: number;
            state: string;
            payload_json: string;
          }
        | undefined;
      const execution = this.getNodeExecution(input.nodeExecutionId);
      if (
        !command ||
        command.fencing_token !== input.fencingToken ||
        command.node_execution_id !== input.nodeExecutionId ||
        !this.#gatewayPayloadOwnsExecution(
          command.payload_json,
          input.runId,
          input.nodeExecutionId,
          input.fencingToken
        ) ||
        (execution
          ? execution.runId !== input.runId ||
            execution.fencingToken !== input.fencingToken
          : !this.#hasRecoverableIr2Run(input.runId))
      ) {
        return "stale" as const;
      }
      if (command.state === "terminal") {
        this.#db
          .prepare(
            `INSERT INTO gateway_inbox(
              message_id, command_id, received_at
            ) VALUES (?, ?, ?)`
          )
          .run(input.inboxMessageId, input.commandId, input.receivedAt);
        return "duplicate" as const;
      }
      const evidenceIds = [...new Set(input.evidenceIds)];
      const linkEvidenceIds = input.evidenceLinks.map(
        (link) => link.evidenceId
      );
      if (
        evidenceIds.length !== input.evidenceIds.length ||
        new Set(linkEvidenceIds).size !== input.evidenceLinks.length ||
        evidenceIds.length !== input.evidenceLinks.length ||
        evidenceIds.some((id) => !linkEvidenceIds.includes(id))
      ) {
        return "evidence_invalid" as const;
      }
      for (const link of input.evidenceLinks) {
        const transfer = this.getEvidenceTransfer(link.evidenceId);
        if (
          transfer &&
          transfer.runId === input.runId &&
          transfer.nodeExecutionId === input.nodeExecutionId &&
          transfer.fencingToken === input.fencingToken &&
          transfer.state !== "acknowledged"
        ) {
          return "evidence_not_ready" as const;
        }
        try {
          assertEvidenceLink(link, {
            transfer,
            sourceExists: (id) => this.getSourceRecord(id) !== undefined,
            assetExists: (id) => this.getAssetRecord(id) !== undefined
          });
        } catch (error) {
          if (error instanceof EvidenceValidationError) {
            return "evidence_invalid" as const;
          }
          throw error;
        }
      }
      this.#db
        .prepare(
          `INSERT INTO gateway_inbox(
            message_id, command_id, received_at
          ) VALUES (?, ?, ?)`
        )
        .run(input.inboxMessageId, input.commandId, input.receivedAt);
      const commandUpdate = this.#db
        .prepare(
          `UPDATE gateway_commands
           SET state = 'terminal', result_json = ?, updated_at = ?
           WHERE id = ? AND fencing_token = ? AND state <> 'terminal'`
        )
        .run(
          json(input.result),
          input.receivedAt,
          input.commandId,
          input.fencingToken
        );
      if (commandUpdate.changes !== 1) {
        throw new RevisionConflictError("Gateway Result CAS failed");
      }
      this.#inject("evidence.result.after_gateway");
      const linkStatement = this.#db.prepare(
        `INSERT INTO evidence_links(
          link_id, evidence_id, run_id, node_execution_id,
          relation, claim_ref, canonical_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const sourceStatement = this.#db.prepare(
        `INSERT INTO evidence_link_sources(link_id, source_id)
         VALUES (?, ?)`
      );
      const assetStatement = this.#db.prepare(
        `INSERT INTO evidence_link_assets(link_id, asset_id)
         VALUES (?, ?)`
      );
      const transferStatement = this.#db.prepare(
        `UPDATE evidence_transfers
         SET state = 'linked', updated_at = ?
         WHERE evidence_id = ? AND run_id = ? AND node_execution_id = ?
           AND fencing_token = ? AND state = 'acknowledged'`
      );
      for (const link of input.evidenceLinks) {
        linkStatement.run(
          link.linkId,
          link.evidenceId,
          link.runId,
          link.nodeExecutionId,
          link.relation,
          link.claimRef ?? null,
          json(link),
          link.createdAt
        );
        for (const sourceId of link.sourceIds) {
          sourceStatement.run(link.linkId, sourceId);
        }
        for (const assetId of link.assetIds ?? []) {
          assetStatement.run(link.linkId, assetId);
        }
        const linked = transferStatement.run(
          input.receivedAt,
          link.evidenceId,
          input.runId,
          input.nodeExecutionId,
          input.fencingToken
        );
        if (linked.changes !== 1) {
          throw new RevisionConflictError(
            `Evidence link CAS failed: ${link.evidenceId}`
          );
        }
      }
      this.#db
        .prepare(
          `UPDATE gateway_outbox
           SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE aggregate_id = ?`
        )
        .run(input.receivedAt, input.commandId);
      this.#insertAudit(
        "gateway.result.evidence.accepted",
        "gateway",
        input.commandId,
        {
          runId: input.runId,
          nodeExecutionId: input.nodeExecutionId,
          fencingToken: input.fencingToken,
          evidenceIds
        }
      );
      return "accepted" as const;
    }).immediate();
  }

  listPendingEngineOutbox(): OutboxMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM engine_outbox
         WHERE acknowledged_at IS NULL AND created_at <= ?
         ORDER BY created_at, id`
      )
      .all(now()) as SqlRow[];
    return rows.map((row) => this.#readOutbox(row));
  }

  listPendingGatewayCommands(afterCommandSeq = 0): GatewayCommandRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM gateway_commands
         WHERE state != 'terminal' AND command_seq > ?
         ORDER BY command_seq`
      )
      .all(afterCommandSeq) as SqlRow[];
    return rows.map((row) => this.#readGatewayCommand(row));
  }

  listGatewayCommandsForRun(runId: string): GatewayCommandRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT *
         FROM gateway_commands
         WHERE json_extract(payload_json, '$.run_id') = ?
         ORDER BY command_seq`
      )
      .all(runId) as SqlRow[];
    return rows.map((row) => this.#readGatewayCommand(row));
  }

  listGatewayCommandsNeedingApplication(): GatewayCommandRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT gateway_commands.*
         FROM gateway_commands
         INNER JOIN node_executions
           ON node_executions.id = gateway_commands.node_execution_id
         WHERE gateway_commands.state = 'terminal'
           AND gateway_commands.result_json IS NOT NULL
           AND node_executions.status NOT IN (
             'succeeded', 'rejected', 'failed', 'timed_out',
             'cancelled', 'uncertain'
           )
         ORDER BY gateway_commands.command_seq`
      )
      .all() as SqlRow[];
    return rows.map((row) => this.#readGatewayCommand(row));
  }

  getGatewayCommand(id: string): GatewayCommandRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM gateway_commands WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readGatewayCommand(row) : undefined;
  }

  markGatewayCommandState(
    id: string,
    state: GatewayCommandRecord["state"],
    updatedAt: string
  ): GatewayCommandRecord {
    return this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE gateway_commands SET state = ?, updated_at = ?
           WHERE id = ? AND state != 'terminal'`
        )
        .run(state, updatedAt, id);
      if (result.changes === 0 && !this.getGatewayCommand(id)) {
        throw new Error(`Gateway command not found: ${id}`);
      }
      if (state === "accepted" || state === "terminal") {
        this.#db
          .prepare(
            `UPDATE gateway_outbox
             SET acknowledged_at = COALESCE(acknowledged_at, ?)
             WHERE aggregate_id = ?`
          )
          .run(updatedAt, id);
      }
      return this.getGatewayCommand(id)!;
    })();
  }

  nextGatewayCommandSequence(): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(command_seq), 0) + 1 AS next FROM gateway_commands"
      )
      .get() as { next: number };
    return row.next;
  }

  openBrowserSession(input: OpenBrowserSessionInput): {
    session: BrowserSessionRecord;
    resumedFrom?: BrowserSessionRecord;
  } {
    return this.#db.transaction(() => {
      let resumedFrom: BrowserSessionRecord | undefined;
      if (input.presentedResumeTokenDigest) {
        const row = this.#db
          .prepare(
            `SELECT * FROM browser_sessions
             WHERE resume_token_digest = ?
               AND browser_instance_id = ?
               AND extension_id = ?
               AND resume_token_expires_at > ?`
          )
          .get(
            input.presentedResumeTokenDigest,
            input.session.browserInstanceId,
            input.session.extensionId,
            input.now
          ) as SqlRow | undefined;
        if (row) {
          resumedFrom = this.#readBrowserSession(row);
          this.#db
            .prepare(
              `UPDATE browser_sessions
               SET resume_token_digest = NULL,
                   resume_token_expires_at = NULL,
                   disconnected_at = COALESCE(disconnected_at, ?)
               WHERE id = ?`
            )
            .run(input.now, resumedFrom.id);
        }
      }
      const session = input.session;
      this.#db
        .prepare(
          `INSERT INTO browser_sessions(
            id, browser_instance_id, extension_id, extension_version,
            protocol_version, last_seq, outgoing_seq, last_acked_command_seq,
            capability_digest, resume_token_digest, resume_token_expires_at,
            connected_at, disconnected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.id,
          session.browserInstanceId,
          session.extensionId,
          session.extensionVersion,
          session.protocolVersion,
          session.incomingSeq,
          session.outgoingSeq,
          resumedFrom?.lastAckedCommandSeq ?? session.lastAckedCommandSeq,
          session.capabilityDigest ?? null,
          session.resumeTokenDigest,
          session.resumeTokenExpiresAt,
          session.connectedAt,
          session.disconnectedAt ?? null
        );
      const opened = this.#getBrowserSession(session.id)!;
      return {
        session: opened,
        ...(resumedFrom ? { resumedFrom } : {})
      };
    })();
  }

  updateBrowserSession(input: {
    id: string;
    incomingSeq?: number;
    outgoingSeq?: number;
    lastAckedCommandSeq?: number;
    capabilityDigest?: string;
    disconnectedAt?: string;
  }): BrowserSessionRecord {
    const current = this.#getBrowserSession(input.id);
    if (!current) throw new Error(`Browser session not found: ${input.id}`);
    this.#db
      .prepare(
        `UPDATE browser_sessions
         SET last_seq = ?, outgoing_seq = ?, last_acked_command_seq = ?,
             capability_digest = ?, disconnected_at = ?
         WHERE id = ?`
      )
      .run(
        input.incomingSeq ?? current.incomingSeq,
        input.outgoingSeq ?? current.outgoingSeq,
        input.lastAckedCommandSeq ?? current.lastAckedCommandSeq,
        input.capabilityDigest ?? current.capabilityDigest ?? null,
        input.disconnectedAt ?? current.disconnectedAt ?? null,
        input.id
      );
    return this.#getBrowserSession(input.id)!;
  }

  replaceBrowserCapabilities(
    sessionId: string,
    capabilities: BrowserCapabilityRecord[]
  ): void {
    this.#db.transaction(() => {
      this.#db
        .prepare("DELETE FROM browser_capabilities WHERE session_id = ?")
        .run(sessionId);
      const insert = this.#db.prepare(
        `INSERT INTO browser_capabilities(
          session_id, node_id, node_version, risk_level, permissions_json
        ) VALUES (?, ?, ?, ?, ?)`
      );
      for (const capability of capabilities) {
        insert.run(
          sessionId,
          capability.nodeId,
          capability.nodeVersion,
          capability.riskLevel,
          json(capability.permissions)
        );
      }
    })();
  }

  listBrowserCapabilities(sessionId: string): BrowserCapabilityRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM browser_capabilities
         WHERE session_id = ?
         ORDER BY node_id, node_version`
      )
      .all(sessionId) as SqlRow[];
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      nodeVersion: String(row.node_version),
      riskLevel: String(row.risk_level),
      permissions: parseJson(row.permissions_json) as string[]
    }));
  }

  putSourceRecord(
    record: SourceRecordDefinition
  ): { status: "accepted" | "duplicate"; record: SourceRecordDefinition } {
    assertSourceRecord(record);
    const existing = this.getSourceRecord(record.sourceId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new EvidenceConflictError(
          `SourceRecord identity conflict: ${record.sourceId}`
        );
      }
      return { status: "duplicate", record: existing };
    }
    this.#db
      .prepare(
        `INSERT INTO source_records(
          source_id, source_type, classification, canonical_json,
          observed_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.sourceId,
        record.sourceType,
        record.classification,
        json(record),
        record.observedAt,
        record.recordedAt
      );
    return { status: "accepted", record: this.getSourceRecord(record.sourceId)! };
  }

  getSourceRecord(sourceId: string): SourceRecordDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM source_records WHERE source_id = ?"
      )
      .get(sourceId) as { canonical_json: string } | undefined;
    return row
      ? (parseJson(row.canonical_json) as SourceRecordDefinition)
      : undefined;
  }

  registerBlob(
    record: BlobRecord
  ): {
    status: "accepted" | "duplicate";
    record: BlobRecord;
    storageWarning: boolean;
  } {
    const expectedStorageRef = `asset-store:${record.digest}`;
    if (
      !/^sha256:[a-f0-9]{64}$/.test(record.digest) ||
      record.storageRef !== expectedStorageRef ||
      !Number.isSafeInteger(record.size) ||
      record.size < 1 ||
      record.size > 25 * 1024 * 1024
    ) {
      throw new EvidenceConflictError("Invalid immutable Blob metadata");
    }
    const existing = this.getBlob(record.digest);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new EvidenceConflictError(
          `Blob digest metadata conflict: ${record.digest}`
        );
      }
      return {
        status: "duplicate",
        record: existing,
        storageWarning: this.#storedBlobBytes() >= GLOBAL_STORAGE_WARNING_BYTES
      };
    }
    this.#db
      .prepare(
        `INSERT INTO blobs(
          digest, size, media_type, storage_ref, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        record.digest,
        record.size,
        record.mediaType,
        record.storageRef,
        record.createdAt
      );
    return {
      status: "accepted",
      record,
      storageWarning: this.#storedBlobBytes() >= GLOBAL_STORAGE_WARNING_BYTES
    };
  }

  getBlob(blobDigest: string): BlobRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM blobs WHERE digest = ?")
      .get(blobDigest) as SqlRow | undefined;
    return row
      ? {
          digest: String(row.digest),
          size: Number(row.size),
          mediaType: String(row.media_type),
          storageRef: String(row.storage_ref),
          createdAt: String(row.created_at)
        }
      : undefined;
  }

  putAssetRecord(
    record: AssetRecordDefinition
  ): { status: "accepted" | "duplicate"; record: AssetRecordDefinition } {
    const existing = this.#getAssetRecordIncludingDeleted(record.assetId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new EvidenceConflictError(
          `AssetRecord identity conflict: ${record.assetId}`
        );
      }
      return { status: "duplicate", record: existing };
    }
    assertAssetRecord(record, {
      blob: this.getBlob(record.digest),
      sourceExists: (sourceId) => this.getSourceRecord(sourceId) !== undefined,
      assetExists: (assetId) => this.getAssetRecord(assetId) !== undefined
    });
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO asset_records(
            asset_id, digest, classification, retention_policy,
            retain_until, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.assetId,
          record.digest,
          record.classification,
          record.retention.policy,
          "retainUntil" in record.retention
            ? record.retention.retainUntil
            : null,
          json(record),
          record.createdAt
        );
      const sourceStatement = this.#db.prepare(
        "INSERT INTO asset_sources(asset_id, source_id) VALUES (?, ?)"
      );
      for (const sourceId of record.sourceIds) {
        sourceStatement.run(record.assetId, sourceId);
      }
      const derivationStatement = this.#db.prepare(
        `INSERT INTO asset_derivations(asset_id, parent_asset_id)
         VALUES (?, ?)`
      );
      for (const parentId of record.derivedFromAssetIds ?? []) {
        derivationStatement.run(record.assetId, parentId);
      }
      this.#inject("evidence.asset.after_record");
    }).immediate();
    return { status: "accepted", record: this.getAssetRecord(record.assetId)! };
  }

  getAssetRecord(assetId: string): AssetRecordDefinition | undefined {
    const deleted = this.#db
      .prepare("SELECT 1 FROM asset_deletions WHERE asset_id = ?")
      .get(assetId);
    return deleted ? undefined : this.#getAssetRecordIncludingDeleted(assetId);
  }

  deleteAssetRecord(input: {
    assetId: string;
    actor: string;
    deletedAt: string;
  }):
    | { status: "deleted" }
    | { status: "missing" | "referenced" | "retained" } {
    const asset = this.getAssetRecord(input.assetId);
    if (!asset) return { status: "missing" };
    const activeReference = this.#db
      .prepare(
        `SELECT 1
         FROM evidence_link_assets ela
         WHERE ela.asset_id = ?
         UNION ALL
         SELECT 1
         FROM asset_derivations ad
         LEFT JOIN asset_deletions deleted ON deleted.asset_id = ad.asset_id
         WHERE ad.parent_asset_id = ? AND deleted.asset_id IS NULL
         LIMIT 1`
      )
      .get(input.assetId, input.assetId);
    if (activeReference) return { status: "referenced" };
    if (!("retainUntil" in asset.retention)) {
      return { status: "retained" };
    }
    if (
      Date.parse(asset.retention.retainUntil) > Date.parse(input.deletedAt)
    ) {
      return { status: "retained" };
    }
    this.#db.transaction(() => {
      const recheck = this.#db
        .prepare(
          `SELECT 1 FROM evidence_link_assets WHERE asset_id = ?
           UNION ALL
           SELECT 1 FROM asset_derivations ad
           LEFT JOIN asset_deletions d ON d.asset_id = ad.asset_id
           WHERE ad.parent_asset_id = ? AND d.asset_id IS NULL
           LIMIT 1`
        )
        .get(input.assetId, input.assetId);
      if (recheck) {
        throw new AssetReferenceConflictError(
          `Asset became referenced: ${input.assetId}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO asset_deletions(asset_id, actor, deleted_at)
           VALUES (?, ?, ?)`
        )
        .run(input.assetId, input.actor, input.deletedAt);
      this.#insertAudit(
        "asset.retention.deleted",
        input.actor,
        input.assetId,
        { digest: asset.digest, retention: asset.retention }
      );
    }).immediate();
    return { status: "deleted" };
  }

  putStagingLease(
    lease: StagingLeaseRecord
  ): { status: "accepted" | "duplicate"; lease: StagingLeaseRecord } {
    const existing = this.getStagingLease(lease.leaseId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(lease)) {
        throw new EvidenceConflictError(
          `Staging lease identity conflict: ${lease.leaseId}`
        );
      }
      return { status: "duplicate", lease: existing };
    }
    this.#db
      .prepare(
        `INSERT INTO staging_leases(
          lease_id, run_id, token_digest, max_bytes, state,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        lease.leaseId,
        lease.runId,
        lease.tokenDigest,
        lease.maxBytes,
        lease.state,
        lease.createdAt,
        lease.expiresAt
      );
    return { status: "accepted", lease };
  }

  getStagingLease(leaseId: string): StagingLeaseRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM staging_leases WHERE lease_id = ?")
      .get(leaseId) as SqlRow | undefined;
    return row ? this.#readStagingLease(row) : undefined;
  }

  transitionStagingLease(input: {
    leaseId: string;
    expectedState: StagingLeaseRecord["state"];
    nextState: StagingLeaseRecord["state"];
  }): StagingLeaseRecord {
    if (
      input.expectedState !== "active" ||
      !["consumed", "expired", "rejected"].includes(input.nextState)
    ) {
      throw new RevisionConflictError(
        "A staging lease only transitions once from active to a terminal state"
      );
    }
    const result = this.#db
      .prepare(
        `UPDATE staging_leases SET state = ?
         WHERE lease_id = ? AND state = ?`
      )
      .run(input.nextState, input.leaseId, input.expectedState);
    if (result.changes !== 1) {
      throw new RevisionConflictError("Staging lease state changed");
    }
    return this.getStagingLease(input.leaseId)!;
  }

  declareEvidence(
    transfer: EvidenceTransferRecord
  ):
    | {
        status: "accepted" | "duplicate";
        transfer: EvidenceTransferRecord;
        runBytes: number;
      }
    | { status: "over_run_quota"; runBytes: number } {
    const existing = this.getEvidenceTransfer(transfer.evidenceId);
    if (existing) {
      if (
        canonicalJson(this.#evidenceDeclarationIdentity(existing)) !==
        canonicalJson(this.#evidenceDeclarationIdentity(transfer))
      ) {
        throw new EvidenceConflictError(
          `Evidence identity conflict: ${transfer.evidenceId}`
        );
      }
      return {
        status: "duplicate",
        transfer: existing,
        runBytes: this.#runEvidenceBytes(transfer.runId)
      };
    }
    const lease = this.getStagingLease(transfer.stagingLeaseId);
    const run = this.getRun(transfer.runId);
    const execution = this.getNodeExecution(transfer.nodeExecutionId);
    const session = this.#getBrowserSession(transfer.sessionId);
    const command = this.#db
      .prepare(
        `SELECT fencing_token, payload_json
         FROM gateway_commands WHERE node_execution_id = ?`
      )
      .get(transfer.nodeExecutionId) as
      | { fencing_token: number; payload_json: string }
      | undefined;
    if (
      !run ||
      !command ||
      command.fencing_token !== transfer.fencingToken ||
      !this.#gatewayPayloadOwnsExecution(
        command.payload_json,
        transfer.runId,
        transfer.nodeExecutionId,
        transfer.fencingToken
      ) ||
      (execution
        ? execution.runId !== transfer.runId ||
          execution.fencingToken !== transfer.fencingToken
        : !this.#hasRecoverableIr2Run(transfer.runId)) ||
      !session ||
      !lease ||
      lease.runId !== transfer.runId ||
      lease.state !== "active" ||
      Date.parse(lease.expiresAt) <= this.#clock().getTime()
    ) {
      throw new EvidenceOwnershipError(
        "Evidence ownership, fencing, Session or staging lease is stale"
      );
    }
    const runBytes = this.#runEvidenceBytes(transfer.runId);
    if (runBytes + transfer.size > MAX_RUN_BYTES) {
      return { status: "over_run_quota", runBytes };
    }
    this.#db
      .prepare(
        `INSERT INTO evidence_transfers(
          evidence_id, run_id, node_execution_id, session_id, fencing_token,
          kind, media_type, size, digest, chunk_size, chunk_count,
          next_chunk_index, classification, staging_lease_id, state,
          storage_ref, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        transfer.evidenceId,
        transfer.runId,
        transfer.nodeExecutionId,
        transfer.sessionId,
        transfer.fencingToken,
        transfer.kind,
        transfer.mediaType,
        transfer.size,
        transfer.digest,
        transfer.chunkSize,
        transfer.chunkCount,
        transfer.nextChunkIndex,
        transfer.classification,
        transfer.stagingLeaseId,
        transfer.state,
        transfer.storageRef ?? null,
        transfer.createdAt,
        transfer.updatedAt,
        transfer.expiresAt ?? null
      );
    return {
      status: "accepted",
      transfer: this.getEvidenceTransfer(transfer.evidenceId)!,
      runBytes: runBytes + transfer.size
    };
  }

  commitEvidenceChunk(input: {
    evidenceId: string;
    chunk: EvidenceChunkRecord;
  }):
    | { status: "accepted" | "duplicate"; transfer: EvidenceTransferRecord }
    | { status: "out_of_order"; nextChunkIndex: number }
    | { status: "conflict" } {
    const transfer = this.getEvidenceTransfer(input.evidenceId);
    if (!transfer) return { status: "conflict" };
    const existingRow = this.#db
      .prepare(
        `SELECT * FROM evidence_chunks
         WHERE evidence_id = ? AND chunk_index = ?`
      )
      .get(input.evidenceId, input.chunk.index) as SqlRow | undefined;
    const existing = existingRow
      ? this.#readEvidenceChunk(existingRow)
      : undefined;
    let result;
    try {
      result = acceptChunk(
        transfer,
        input.chunk,
        existing,
        { now: this.#clock }
      );
    } catch (error) {
      if (
        error instanceof EvidenceValidationError &&
        error.code === "OUT_OF_ORDER"
      ) {
        return {
          status: "out_of_order",
          nextChunkIndex: transfer.nextChunkIndex
        };
      }
      if (error instanceof EvidenceValidationError) {
        return { status: "conflict" };
      }
      throw error;
    }
    if (result.status === "duplicate") {
      return { status: "duplicate", transfer };
    }
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO evidence_chunks(
            evidence_id, chunk_index, digest, size, received_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.evidenceId,
          input.chunk.index,
          input.chunk.digest,
          input.chunk.size,
          input.chunk.receivedAt
        );
      this.#inject("evidence.chunk.after_metadata");
      const update = this.#db
        .prepare(
          `UPDATE evidence_transfers
           SET state = ?, next_chunk_index = ?, updated_at = ?
           WHERE evidence_id = ? AND next_chunk_index = ?
             AND state IN ('declared', 'receiving')`
        )
        .run(
          result.transfer.state,
          result.transfer.nextChunkIndex,
          result.transfer.updatedAt,
          input.evidenceId,
          transfer.nextChunkIndex
        );
      if (update.changes !== 1) {
        throw new RevisionConflictError("Evidence chunk CAS failed");
      }
    }).immediate();
    return {
      status: "accepted",
      transfer: this.getEvidenceTransfer(input.evidenceId)!
    };
  }

  completeEvidence(input: {
    evidenceId: string;
    blob: BlobRecord;
  }): EvidenceTransferRecord {
    const transfer = this.getEvidenceTransfer(input.evidenceId);
    if (!transfer) {
      throw new EvidenceConflictError("Evidence transfer does not exist");
    }
    if (
      transfer.state === "complete" ||
      transfer.state === "acknowledged" ||
      transfer.state === "linked"
    ) {
      const stored = this.getBlob(transfer.digest);
      if (
        !stored ||
        input.blob.digest !== transfer.digest ||
        input.blob.size !== transfer.size ||
        input.blob.mediaType !== transfer.mediaType ||
        input.blob.storageRef !== transfer.storageRef
      ) {
        throw new EvidenceConflictError(
          "Replayed Evidence completion conflicts with stored Blob"
        );
      }
      return transfer;
    }
    const chunks = this.listEvidenceChunks(input.evidenceId);
    const completed = transitionEvidenceComplete(
      transfer,
      chunks,
      input.blob,
      { now: this.#clock }
    );
    this.#db.transaction(() => {
      this.registerBlob(input.blob);
      const result = this.#db
        .prepare(
          `UPDATE evidence_transfers
           SET state = 'complete', storage_ref = ?, updated_at = ?
           WHERE evidence_id = ? AND state = 'receiving'
             AND next_chunk_index = chunk_count`
        )
        .run(
          completed.storageRef,
          completed.updatedAt,
          input.evidenceId
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("Evidence completion CAS failed");
      }
      this.#db
        .prepare(
          `UPDATE staging_leases SET state = 'consumed'
           WHERE lease_id = ? AND state = 'active'`
        )
        .run(transfer.stagingLeaseId);
      this.#inject("evidence.complete.after_blob");
    }).immediate();
    return this.getEvidenceTransfer(input.evidenceId)!;
  }

  acknowledgeEvidence(
    evidenceId: string,
    acknowledgedAt: string
  ): EvidenceTransferRecord {
    const transfer = this.getEvidenceTransfer(evidenceId);
    if (!transfer) {
      throw new EvidenceConflictError("Evidence transfer does not exist");
    }
    if (
      transfer.state === "acknowledged" ||
      transfer.state === "linked"
    ) {
      return transfer;
    }
    const acknowledged = transitionEvidenceAcknowledged(transfer, {
      now: () => new Date(acknowledgedAt)
    });
    const result = this.#db
      .prepare(
        `UPDATE evidence_transfers
         SET state = 'acknowledged', updated_at = ?
         WHERE evidence_id = ? AND state = 'complete'`
      )
      .run(acknowledged.updatedAt, evidenceId);
    if (result.changes !== 1) {
      throw new RevisionConflictError("Evidence acknowledgement CAS failed");
    }
    return this.getEvidenceTransfer(evidenceId)!;
  }

  terminateEvidence(input: {
    evidenceId: string;
    terminalState: "rejected" | "expired";
    updatedAt: string;
  }): EvidenceTransferRecord {
    const transfer = this.getEvidenceTransfer(input.evidenceId);
    if (!transfer) {
      throw new EvidenceConflictError("Evidence transfer does not exist");
    }
    const terminated = transitionEvidenceTerminated(
      transfer,
      input.terminalState,
      { now: () => new Date(input.updatedAt) }
    );
    const result = this.#db
      .prepare(
        `UPDATE evidence_transfers
         SET state = ?, updated_at = ?
         WHERE evidence_id = ? AND state IN ('declared', 'receiving')`
      )
      .run(
        terminated.state,
        terminated.updatedAt,
        input.evidenceId
      );
    if (result.changes !== 1) {
      throw new RevisionConflictError("Evidence terminal CAS failed");
    }
    this.#db
      .prepare(
        `UPDATE staging_leases SET state = ?
         WHERE lease_id = ? AND state = 'active'`
      )
      .run(
        input.terminalState,
        transfer.stagingLeaseId
      );
    return this.getEvidenceTransfer(input.evidenceId)!;
  }

  getEvidenceTransfer(
    evidenceId: string
  ): EvidenceTransferRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM evidence_transfers WHERE evidence_id = ?")
      .get(evidenceId) as SqlRow | undefined;
    return row ? this.#readEvidenceTransfer(row) : undefined;
  }

  listEvidenceChunks(evidenceId: string): EvidenceChunkRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM evidence_chunks
           WHERE evidence_id = ? ORDER BY chunk_index`
        )
        .all(evidenceId) as SqlRow[]
    ).map((row) => this.#readEvidenceChunk(row));
  }

  linkEvidence(
    link: EvidenceLinkDefinition
  ): { status: "accepted" | "duplicate"; link: EvidenceLinkDefinition } {
    const existing = this.getEvidenceLink(link.linkId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(link)) {
        throw new EvidenceConflictError(
          `EvidenceLink identity conflict: ${link.linkId}`
        );
      }
      return { status: "duplicate", link: existing };
    }
    const transfer = this.getEvidenceTransfer(link.evidenceId);
    assertEvidenceLink(link, {
      transfer,
      sourceExists: (id) => this.getSourceRecord(id) !== undefined,
      assetExists: (id) => this.getAssetRecord(id) !== undefined
    });
    const linked = markEvidenceLinked(transfer!, {
      now: () => new Date(link.createdAt)
    });
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO evidence_links(
            link_id, evidence_id, run_id, node_execution_id,
            relation, claim_ref, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          link.linkId,
          link.evidenceId,
          link.runId,
          link.nodeExecutionId,
          link.relation,
          link.claimRef ?? null,
          json(link),
          link.createdAt
        );
      const sourceStatement = this.#db.prepare(
        `INSERT INTO evidence_link_sources(link_id, source_id)
         VALUES (?, ?)`
      );
      for (const sourceId of link.sourceIds) {
        sourceStatement.run(link.linkId, sourceId);
      }
      const assetStatement = this.#db.prepare(
        `INSERT INTO evidence_link_assets(link_id, asset_id)
         VALUES (?, ?)`
      );
      for (const assetId of link.assetIds ?? []) {
        assetStatement.run(link.linkId, assetId);
      }
      const result = this.#db
        .prepare(
          `UPDATE evidence_transfers
           SET state = 'linked', updated_at = ?
           WHERE evidence_id = ? AND state = 'acknowledged'`
        )
        .run(linked.updatedAt, link.evidenceId);
      if (result.changes !== 1) {
        throw new RevisionConflictError("Evidence link CAS failed");
      }
      this.#inject("evidence.link.after_link");
    }).immediate();
    return { status: "accepted", link: this.getEvidenceLink(link.linkId)! };
  }

  getEvidenceLink(linkId: string): EvidenceLinkDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM evidence_links WHERE link_id = ?"
      )
      .get(linkId) as { canonical_json: string } | undefined;
    return row
      ? (parseJson(row.canonical_json) as EvidenceLinkDefinition)
      : undefined;
  }

  scheduleRetention(
    job: RetentionJobRecord
  ): { status: "accepted" | "duplicate"; job: RetentionJobRecord } {
    const existing = this.#getRetentionJob(job.jobId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(job)) {
        throw new EvidenceConflictError(
          `Retention job identity conflict: ${job.jobId}`
        );
      }
      return { status: "duplicate", job: existing };
    }
    this.#db
      .prepare(
        `INSERT INTO retention_jobs(
          job_id, target_type, target_id, expected_policy, state,
          not_before, attempt, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        job.jobId,
        job.targetType,
        job.targetId,
        job.expectedPolicy,
        job.state,
        job.notBefore,
        job.attempt,
        job.lastError ?? null,
        job.createdAt,
        job.updatedAt
      );
    return { status: "accepted", job };
  }

  listDueRetentionJobs(nowValue: string, limit: number): RetentionJobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Retention job limit must be between 1 and 1000");
    }
    return (
      this.#db
        .prepare(
          `SELECT * FROM retention_jobs
           WHERE state = 'scheduled' AND not_before <= ?
           ORDER BY not_before, job_id LIMIT ?`
        )
        .all(nowValue, limit) as SqlRow[]
    ).map((row) => this.#readRetentionJob(row));
  }

  completeRetentionJob(input: {
    jobId: string;
    expectedState: "scheduled" | "running";
    nextState: "completed" | "skipped" | "failed";
    updatedAt: string;
    lastError?: string;
  }): RetentionJobRecord {
    const result = this.#db
      .prepare(
        `UPDATE retention_jobs
         SET state = ?, attempt = attempt + 1, last_error = ?, updated_at = ?
         WHERE job_id = ? AND state = ?`
      )
      .run(
        input.nextState,
        input.lastError ?? null,
        input.updatedAt,
        input.jobId,
        input.expectedState
      );
    if (result.changes !== 1) {
      throw new RevisionConflictError("Retention job state changed");
    }
    return this.#getRetentionJob(input.jobId)!;
  }

  listAudit(target?: string): AuditRecord[] {
    const rows = (target
      ? this.#db
          .prepare(
            `SELECT * FROM audit_records
             WHERE target = ?
             ORDER BY occurred_at, id`
          )
          .all(target)
      : this.#db
          .prepare(
            "SELECT * FROM audit_records ORDER BY occurred_at, id"
          )
          .all()) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actor: String(row.actor),
      target: String(row.target),
      detail: parseJson(row.detail_json),
      occurredAt: String(row.occurred_at)
    }));
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readRun(row) : undefined;
  }

  getNodeExecution(id: string): NodeExecutionRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM node_executions WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      nodeVersion: String(row.node_version),
      status: row.status as NodeExecutionRecord["status"],
      revision: Number(row.revision),
      attempt: Number(row.attempt),
      idempotencyKey: String(row.idempotency_key),
      fencingToken: Number(row.fencing_token),
      input: parseJson(row.input_json),
      ...(row.output_json == null ? {} : { output: parseJson(row.output_json) }),
      ...(row.error_json == null
        ? {}
        : {
            error: parseJson(
              row.error_json
            ) as NodeExecutionRecord["error"] & object
          }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  listEvents(runId: string): ExecutionEventRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM execution_events WHERE run_id = ? ORDER BY sequence"
      )
      .all(runId) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      ...(row.node_execution_id == null
        ? {}
        : { nodeExecutionId: String(row.node_execution_id) }),
      sequence: Number(row.sequence),
      type: String(row.event_type),
      payload: parseJson(row.payload_json),
      occurredAt: String(row.occurred_at)
    }));
  }

  requestCancel(runId: string, actor: string): RunRecord {
    return this.#db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
      const occurredAt = now();
      const result = this.#db
        .prepare(
          `UPDATE workflow_runs
           SET status = 'paused', revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(occurredAt, runId, run.revision);
      if (result.changes !== 1) {
        throw new RevisionConflictError(`Run ${runId} changed concurrently`);
      }
      const nextSequence = this.#nextEventSequence(runId);
      this.#insertEvent({
        id: randomUUID(),
        runId,
        sequence: nextSequence,
        type: "RUN_CANCEL_REQUESTED",
        payload: { actor },
        occurredAt
      });
      return this.getRun(runId)!;
    })();
  }

  #nextEventSequence(runId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM execution_events WHERE run_id = ?"
      )
      .get(runId) as { next: number };
    return row.next;
  }

  #insertPlanSnapshot(snapshot: RunPlanSnapshotRecord): void {
    this.#db
      .prepare(
        `INSERT INTO run_plan_snapshots(
          run_id, ir_version, plan_digest, workflow_source_digest,
          artifact_closure_digest, plan_json, risk_snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.runId,
        snapshot.irVersion,
        snapshot.planDigest,
        snapshot.workflowSourceDigest,
        snapshot.artifactClosureDigest,
        json(snapshot.planJson),
        json(snapshot.riskSnapshot),
        snapshot.createdAt
      );
  }

  #insertAssistanceTask(record: AssistanceTaskRecord): void {
    if (!assistanceFencingConsistent(record)) {
      throw new StaleFencingTokenError(
        `Assistance task ${record.task.taskId} has inconsistent fencing state`
      );
    }
    this.#db
      .prepare(
        `INSERT INTO assistance_tasks(
          task_id, run_id, step_instance_id, status, revision, fencing_counter,
          canonical_json, private_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.task.taskId,
        record.task.runId,
        record.task.stepInstanceId,
        record.task.status,
        record.task.revision,
        record.fencingCounter,
        json(record.task),
        json(record.privateState),
        record.task.createdAt,
        record.task.updatedAt
      );
  }

  #insertRun(run: RunRecord): void {
    this.#db
      .prepare(
        `INSERT INTO workflow_runs(
          id, workflow_id, workflow_version, workflow_digest, status,
          revision, input_json, output_json, current_node_key, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.workflowId,
        run.workflowVersion,
        run.workflowDigest,
        run.status,
        run.revision,
        json(run.input),
        run.output === undefined ? null : json(run.output),
        run.currentNodeKey ?? null,
        run.createdAt,
        run.updatedAt
      );
  }

  #insertCheckpoint(checkpoint: EngineCheckpointRecord): void {
    this.#db
      .prepare(
        `INSERT INTO engine_checkpoints(
          run_id, state_version, state_revision, state_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        checkpoint.runId,
        checkpoint.stateVersion,
        checkpoint.stateRevision,
        json(checkpoint.state),
        checkpoint.updatedAt
      );
  }

  #insertInbox(record: InboxMessageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO engine_inbox(
          message_id, topic, aggregate_id, payload_json, received_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.topic,
        record.aggregateId,
        json(record.payload),
        record.receivedAt,
        record.appliedAt ?? null
      );
  }

  #insertEvent(event: ExecutionEventRecord): void {
    this.#db
      .prepare(
        `INSERT INTO execution_events(
          id, run_id, node_execution_id, sequence, event_type, payload_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.runId,
        event.nodeExecutionId ?? null,
        event.sequence,
        event.type,
        json(event.payload),
        event.occurredAt
      );
  }

  #insertOutbox(table: "engine_outbox" | "gateway_outbox", message: OutboxMessage): void {
    this.#db
      .prepare(
        `INSERT INTO ${table}(id, topic, aggregate_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.topic,
        message.aggregateId,
        json(message.payload),
        message.createdAt
      );
  }

  #insertAudit(
    action: string,
    actor: string,
    target: string,
    detail: unknown
  ): void {
    this.#db
      .prepare(
        `INSERT INTO audit_records(
          id, action, actor, target, detail_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.#idFactory(),
        action,
        actor,
        target,
        json(detail),
        this.#clock().toISOString()
      );
  }

  #insertAuditRecord(record: AuditRecord): void {
    this.#db
      .prepare(
        `INSERT INTO audit_records(
          id, action, actor, target, detail_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.action,
        record.actor,
        record.target,
        json(record.detail),
        record.occurredAt
      );
  }

  #insertDecision(record: DecisionRecordDefinition): void {
    this.#db
      .prepare(
        `INSERT INTO decision_records(
          decision_id, decision_type, status, scope_digest,
          preconditions_digest, canonical_json, confirmed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.decisionId,
        record.decisionType,
        record.status,
        digest(record.scope),
        digest(record.preconditions),
        json(record),
        record.confirmedAt,
        record.revokedAt ?? record.confirmedAt
      );
  }

  #getDecision(decisionId: string): DecisionRecordDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM decision_records WHERE decision_id = ?"
      )
      .get(decisionId) as { canonical_json: string } | undefined;
    return row
      ? (parseJson(row.canonical_json) as DecisionRecordDefinition)
      : undefined;
  }

  #getAssetRecordIncludingDeleted(
    assetId: string
  ): AssetRecordDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM asset_records WHERE asset_id = ?"
      )
      .get(assetId) as { canonical_json: string } | undefined;
    return row
      ? (parseJson(row.canonical_json) as AssetRecordDefinition)
      : undefined;
  }

  #storedBlobBytes(): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs")
      .get() as { bytes: number };
    return Number(row.bytes);
  }

  #runEvidenceBytes(runId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS bytes
         FROM evidence_transfers
         WHERE run_id = ? AND state NOT IN ('rejected', 'expired')`
      )
      .get(runId) as { bytes: number };
    return Number(row.bytes);
  }

  #gatewayPayloadOwnsExecution(
    payloadJson: string,
    runId: string,
    nodeExecutionId: string,
    fencingToken: number
  ): boolean {
    const payload = parseJson(payloadJson) as
      | Record<string, unknown>
      | undefined;
    return (
      payload?.run_id === runId &&
      payload.node_execution_id === nodeExecutionId &&
      payload.fencing_token === fencingToken
    );
  }

  #evidenceDeclarationIdentity(
    transfer: EvidenceTransferRecord
  ): Record<string, unknown> {
    return {
      evidenceId: transfer.evidenceId,
      runId: transfer.runId,
      nodeExecutionId: transfer.nodeExecutionId,
      sessionId: transfer.sessionId,
      fencingToken: transfer.fencingToken,
      kind: transfer.kind,
      mediaType: transfer.mediaType,
      size: transfer.size,
      digest: transfer.digest,
      chunkSize: transfer.chunkSize,
      chunkCount: transfer.chunkCount,
      classification: transfer.classification,
      stagingLeaseId: transfer.stagingLeaseId
    };
  }

  #hasRecoverableIr2Run(runId: string): boolean {
    return (
      this.getRun(runId) !== undefined &&
      this.getRunPlanSnapshot(runId) !== undefined &&
      this.getEngineCheckpoint(runId) !== undefined
    );
  }

  #readStagingLease(row: SqlRow): StagingLeaseRecord {
    return {
      leaseId: String(row.lease_id),
      runId: String(row.run_id),
      tokenDigest: String(row.token_digest),
      maxBytes: Number(row.max_bytes),
      state: row.state as StagingLeaseRecord["state"],
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at)
    };
  }

  #readEvidenceTransfer(row: SqlRow): EvidenceTransferRecord {
    return {
      evidenceId: String(row.evidence_id),
      runId: String(row.run_id),
      nodeExecutionId: String(row.node_execution_id),
      sessionId: String(row.session_id),
      fencingToken: Number(row.fencing_token),
      kind: row.kind as EvidenceTransferRecord["kind"],
      mediaType: String(row.media_type),
      size: Number(row.size),
      digest: String(row.digest),
      chunkSize: Number(row.chunk_size) as EvidenceTransferRecord["chunkSize"],
      chunkCount: Number(row.chunk_count),
      nextChunkIndex: Number(row.next_chunk_index),
      classification:
        row.classification as EvidenceTransferRecord["classification"],
      stagingLeaseId: String(row.staging_lease_id),
      state: row.state as EvidenceTransferRecord["state"],
      ...(row.storage_ref == null
        ? {}
        : { storageRef: String(row.storage_ref) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.expires_at == null
        ? {}
        : { expiresAt: String(row.expires_at) })
    };
  }

  #readEvidenceChunk(row: SqlRow): EvidenceChunkRecord {
    return {
      evidenceId: String(row.evidence_id),
      index: Number(row.chunk_index),
      digest: String(row.digest),
      size: Number(row.size),
      receivedAt: String(row.received_at)
    };
  }

  #getRetentionJob(jobId: string): RetentionJobRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM retention_jobs WHERE job_id = ?")
      .get(jobId) as SqlRow | undefined;
    return row ? this.#readRetentionJob(row) : undefined;
  }

  #readRetentionJob(row: SqlRow): RetentionJobRecord {
    return {
      jobId: String(row.job_id),
      targetType: row.target_type as RetentionJobRecord["targetType"],
      targetId: String(row.target_id),
      expectedPolicy: String(row.expected_policy),
      state: row.state as RetentionJobRecord["state"],
      notBefore: String(row.not_before),
      attempt: Number(row.attempt),
      ...(row.last_error == null
        ? {}
        : { lastError: String(row.last_error) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  #readArtifact(row: SqlRow): ArtifactRecord {
    return {
      recordId: String(row.record_id),
      assetType: row.asset_type as ArtifactRecord["assetType"],
      assetId: String(row.asset_id),
      version: String(row.version),
      digest: String(row.digest),
      status: row.status as ArtifactRecord["status"],
      content: parseJson(row.content_json),
      createdAt: String(row.created_at),
      ...(row.published_at == null
        ? {}
        : { publishedAt: String(row.published_at) })
    };
  }

  #readRun(row: SqlRow): RunRecord {
    return {
      id: String(row.id),
      workflowId: String(row.workflow_id),
      workflowVersion: String(row.workflow_version),
      workflowDigest: String(row.workflow_digest),
      status: row.status as RunRecord["status"],
      revision: Number(row.revision),
      input: parseJson(row.input_json),
      ...(row.output_json == null ? {} : { output: parseJson(row.output_json) }),
      ...(row.current_node_key == null
        ? {}
        : { currentNodeKey: String(row.current_node_key) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  #readPlanSnapshot(row: SqlRow): RunPlanSnapshotRecord {
    return {
      runId: String(row.run_id),
      irVersion: String(row.ir_version) as RunPlanSnapshotRecord["irVersion"],
      planDigest: String(row.plan_digest),
      workflowSourceDigest: String(row.workflow_source_digest),
      artifactClosureDigest: String(row.artifact_closure_digest),
      planJson: parseJson(
        row.plan_json
      ) as RunPlanSnapshotRecord["planJson"],
      riskSnapshot: parseJson(row.risk_snapshot_json) as JsonValue,
      createdAt: String(row.created_at)
    };
  }

  #readAssistanceTask(row: SqlRow): AssistanceTaskRecord {
    return {
      task: parseJson(
        row.canonical_json
      ) as AssistanceTaskRecord["task"],
      fencingCounter: Number(row.fencing_counter),
      privateState: parseJson(
        row.private_state_json
      ) as AssistanceTaskRecord["privateState"]
    };
  }

  #readDatasetStaging(row: SqlRow): DatasetStagingRecord {
    return {
      stagingId: String(row.staging_id),
      profileId: String(row.profile_id),
      profileVersion: String(row.profile_version),
      sourceDigest: String(row.source_digest),
      state: row.state as DatasetStagingRecord["state"],
      validationReport: parseJson(row.validation_report_json) as JsonValue,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  #readWorkflowDraft(row: SqlRow): WorkflowDraftRecord {
    return {
      draftId: String(row.draft_id),
      revision: Number(row.revision),
      content: parseJson(row.content_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  #readWorkflowDraftRevision(
    row: SqlRow
  ): WorkflowDraftRevisionRecord {
    return {
      draftId: String(row.draft_id),
      revision: Number(row.revision),
      ...(row.operation_id == null
        ? {}
        : { operationId: String(row.operation_id) }),
      content: parseJson(row.content_json),
      createdAt: String(row.created_at)
    };
  }

  #readWorkflowCandidate(row: SqlRow): WorkflowCandidateRecord {
    return {
      candidateId: String(row.candidate_id),
      draftId: String(row.draft_id),
      sourceRevision: Number(row.source_revision),
      content: parseJson(row.content_json),
      createdAt: String(row.created_at)
    };
  }

  #readOutbox(row: SqlRow): OutboxMessage {
    return {
      id: String(row.id),
      topic: String(row.topic),
      aggregateId: String(row.aggregate_id),
      payload: parseJson(row.payload_json),
      createdAt: String(row.created_at)
    };
  }

  #readGatewayCommand(row: SqlRow): GatewayCommandRecord {
    return {
      id: String(row.id),
      nodeExecutionId: String(row.node_execution_id),
      commandSeq: Number(row.command_seq),
      idempotencyKey: String(row.idempotency_key),
      fencingToken: Number(row.fencing_token),
      state: row.state as GatewayCommandRecord["state"],
      payload: parseJson(row.payload_json),
      ...(row.result_json == null ? {} : { result: parseJson(row.result_json) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  #getBrowserSession(id: string): BrowserSessionRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM browser_sessions WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readBrowserSession(row) : undefined;
  }

  #readBrowserSession(row: SqlRow): BrowserSessionRecord {
    return {
      id: String(row.id),
      browserInstanceId: String(row.browser_instance_id),
      extensionId: String(row.extension_id),
      extensionVersion: String(row.extension_version),
      protocolVersion: String(row.protocol_version),
      incomingSeq: Number(row.last_seq),
      outgoingSeq: Number(row.outgoing_seq),
      lastAckedCommandSeq: Number(row.last_acked_command_seq),
      ...(row.capability_digest == null
        ? {}
        : { capabilityDigest: String(row.capability_digest) }),
      resumeTokenDigest: String(row.resume_token_digest ?? ""),
      resumeTokenExpiresAt: String(row.resume_token_expires_at ?? ""),
      connectedAt: String(row.connected_at),
      ...(row.disconnected_at == null
        ? {}
        : { disconnectedAt: String(row.disconnected_at) })
    };
  }
}

export * from "./migrations.js";
