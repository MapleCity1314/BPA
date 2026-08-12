import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  parseSucceededRunBusinessAttentionMarker,
  projectSucceededRunBusinessAttention
} from "@bpa/attention-core";
import {
  AssetReferenceConflictError,
  AuthoringConflictError,
  AuthoringOperationConflictError,
  ArtifactConflictError,
  CandidateBundleConflictError,
  DesignModeGrantConflictError,
  EvidenceConflictError,
  EvidenceOwnershipError,
  ExternalDomainLeaseConflictError,
  OperationalFactConflictError,
  RecoverySessionConflictError,
  RevisionConflictError,
  StaleFencingTokenError,
  WorkflowCandidateConflictError,
  WorkflowDraftConflictError,
  WorkflowOperationConflictError,
  type ApplyWorkflowDraftRevisionInput,
  type ApplyWorkflowDraftRevisionResult,
  type ApplyAuthoringSessionInput,
  type ApplyAuthoringSessionResult,
  type AttachPageSnapshotInput,
  type AssetRecordDefinition,
  type AuthoringScenarioRecord,
  type AuthoringSessionDefinition,
  type AuthoringSessionRevisionRecord,
  type ArtifactRecord,
  type ArtifactType,
  type AssistanceTaskRecord,
  type AssistanceTaskListFilter,
  type AttentionDeliveryRecord,
  type AttentionDeliveryState,
  type AttentionRecord,
  type AuditRecord,
  type BinanceCollectionRunRecord,
  type BinanceCurrentRecord,
  type BinanceMarketCaptureRecord,
  type BinanceRawRecord,
  type BrowserCapabilityRecord,
  type BrowserControlLeaseRecord,
  type BrowserPageObservationRecord,
  type BrowserSessionObservationState,
  type BrowserSessionRecord,
  type BrowserSessionRole,
  type BlobRecord,
  type CreateRunInput,
  type CandidateBundleRecord,
  type CandidateBundleValidationRecord,
  type CandidateExportRecord,
  type CreateBlockingAssistanceInput,
  type CommitAssistanceTaskRequestInput,
  type CommitAssistanceTaskRequestResult,
  type CompleteDetachedAssistanceInput,
  type DatasetStagingRecord,
  type DatasetVersionDefinition,
  type DecisionRecordDefinition,
  type DesignModeGrantRecord,
  type EngineCheckpointRecord,
  type EvidenceChunkRecord,
  type EvidenceListCursor,
  type EvidenceListPage,
  type EvidenceLinkDefinition,
  type EvidenceTransferRecord,
  type ExportRecord,
  type ExecutionScopeRecord,
  type ExecutionEventRecord,
  type ExternalDomainLeaseMutationResult,
  type ExternalDomainLeaseRecord,
  type InventoryEffectReconciliationClassification,
  type InventoryEffectReconciliationRecord,
  type GatewayCommandRecord,
  type InboxMessageRecord,
  type IterationInstanceRecord,
  type JsonValue,
  type NodeExecutionRecord,
  type OpenBrowserSessionInput,
  type OperationalDatasetCoverage,
  type OperationalDatasetPublicationLineage,
  type OperationalExecutionContext,
  type OperationalFactRecord,
  type NodeTransitionInput,
  type OutboxMessage,
  type PageSnapshotDefinition,
  type Persistence,
  type PublishArtifactInput,
  type PreparedOperationalDatasetPublication,
  type PersistBinanceCopyTradingCaptureInput,
  type PersistBinanceMarketCaptureInput,
  type RetentionJobRecord,
  type RecoverySessionRecord,
  type RecoverySessionState,
  type IssueRecoverySessionInput,
  type RuntimeActivityMetrics,
  type RunRecord,
  type RunPlanSnapshotRecord,
  type RunStatus,
  type RunTransitionInput,
  type RuntimeInvocationOutboxRecord,
  type SucceededRunBusinessAttentionMarker,
  type SaveCandidateBundleInput,
  type ResourceAuthentication,
  type ResourceBindingSnapshot,
  type SourceRecordDefinition,
  type StagingLeaseRecord,
  type StepInstanceRecord,
  type TriggerAttemptRecord,
  type TriggerAttemptStatus,
  type TriggerOccurrenceRecord,
  type TriggerOccurrenceStatus,
  type TriggerScheduleStateRecord,
  type TriggerTerminalOutcome,
  type TriggerSpecDefinition,
  type TriggerSpecRecord,
  type SubmitAssistanceAndWakeInput,
  type TransitionDesignModeGrantInput,
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
import { assertResourceBindingSnapshotForPlan } from "@bpa/resource-binding";
import {
  formatValidationErrors,
  validateAuthoringSession,
  validateCandidateBundle,
  validateDataset,
  validatePageSnapshot,
  validateScenarioSpec
} from "@bpa/schemas";
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

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("businessDate must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("businessDate must be a real calendar date");
  }
}

function businessDateAt(timestamp: string, timeZone: string): string {
  assertTimestamp(timestamp, "business date anchor");
  if (!timeZone.trim()) {
    throw new Error("businessTimeZone must not be empty");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(timestamp));
  } catch {
    throw new Error("businessTimeZone must be an IANA time zone");
  }
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const value = `${field("year")}-${field("month")}-${field("day")}`;
  assertBusinessDate(value);
  return value;
}

function assertSemver(value: string, label: string): void {
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      value
    )
  ) {
    throw new Error(`${label} must be a SemVer version`);
  }
}

function assertOperationalCoverage(
  quality: "complete" | "partial",
  coverage: OperationalDatasetCoverage,
  factCount: number
): void {
  for (const [key, value] of Object.entries(coverage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Operational Dataset coverage.${key} is invalid`);
    }
  }
  if (
    coverage.skipped !== coverage.discovered - coverage.collectable ||
    coverage.attempted !== coverage.collectable ||
    coverage.persisted + coverage.failed !== coverage.attempted ||
    coverage.discovered !== coverage.attempted + coverage.skipped ||
    coverage.persisted !== factCount
  ) {
    throw new Error("Operational Dataset coverage counts do not conserve");
  }
  if (
    quality === "complete" &&
    (coverage.failed !== 0 || coverage.persisted !== coverage.collectable)
  ) {
    throw new Error("Complete Operational Dataset has incomplete coverage");
  }
  if (
    quality === "partial" &&
    (coverage.persisted === 0 || coverage.failed === 0)
  ) {
    throw new Error("Partial Operational Dataset requires mixed coverage");
  }
}

function operationalFactKey(input: {
  namespace: string;
  runId: string;
  businessDate: string;
  subjectId: string;
  schemaVersion: string;
}): string {
  return `fact:${digest(input).slice("sha256:".length)}`;
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
}

function assertHttpsOrigin(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact HTTPS Origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must be an exact HTTPS Origin`);
  }
}

function assertSchema(
  valid: boolean,
  errors: Parameters<typeof formatValidationErrors>[0],
  label: string
): void {
  if (!valid) {
    throw new Error(
      `${label} is invalid: ${formatValidationErrors(errors).join("; ")}`
    );
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
  sqliteObservabilityExtensionPath?: string;
  failureInjector?: (point: string) => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface SqliteResourceMetrics {
  configuredCacheBytes: number;
  pageSizeBytes: number;
  cacheSizeSetting: number;
  cacheUsedBytes: number;
  schemaUsedBytes: number;
  statementUsedBytes: number;
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
      if (options.sqliteObservabilityExtensionPath) {
        this.#db.loadExtension(options.sqliteObservabilityExtensionPath);
      }
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

  readSqliteResourceMetrics(): SqliteResourceMetrics {
    const pageSizeBytes = Number(this.#db.pragma("page_size", { simple: true }));
    const cacheSizeSetting = Number(
      this.#db.pragma("cache_size", { simple: true })
    );
    const row = this.#db
      .prepare(`
        SELECT
          bpa_sqlite_cache_used() AS cache_used_bytes,
          bpa_sqlite_schema_used() AS schema_used_bytes,
          bpa_sqlite_statement_used() AS statement_used_bytes
      `)
      .get() as {
        cache_used_bytes: number;
        schema_used_bytes: number;
        statement_used_bytes: number;
      };
    const metrics = {
      configuredCacheBytes:
        cacheSizeSetting < 0
          ? Math.abs(cacheSizeSetting) * 1024
          : cacheSizeSetting * pageSizeBytes,
      pageSizeBytes,
      cacheSizeSetting,
      cacheUsedBytes: row.cache_used_bytes,
      schemaUsedBytes: row.schema_used_bytes,
      statementUsedBytes: row.statement_used_bytes
    };
    for (const [name, value] of Object.entries(metrics)) {
      if (
        !Number.isSafeInteger(value) ||
        (name !== "cacheSizeSetting" && value < 0)
      ) {
        throw new Error(`SQLite resource metric ${name} is invalid`);
      }
    }
    return metrics;
  }

  readRuntimeActivityMetrics(observedAt: string): RuntimeActivityMetrics {
    assertTimestamp(observedAt, "observedAt");
    const row = this.#db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM workflow_runs
           WHERE status NOT IN (
             'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
           )) AS active_run_count,
          (SELECT COUNT(*) FROM trigger_occurrences
           WHERE status != 'terminal') AS active_trigger_occurrence_count,
          (SELECT COUNT(*) FROM trigger_attempts
           WHERE status != 'terminal') AS active_trigger_attempt_count,
          (SELECT COUNT(*) FROM engine_outbox
           WHERE acknowledged_at IS NULL) AS pending_engine_outbox_count,
          ((SELECT COUNT(*) FROM leases WHERE expires_at > ?)
            + (SELECT COUNT(*) FROM trigger_leases WHERE expires_at > ?)
            + (SELECT COUNT(*) FROM browser_control_leases
               WHERE expires_at > ?)) AS active_control_lease_count,
          (SELECT COUNT(*) FROM external_domain_leases
           WHERE state != 'released') AS active_external_domain_lease_count,
          (SELECT COUNT(*) FROM staging_leases
           WHERE state = 'active') AS active_staging_lease_count,
          (SELECT COUNT(*) FROM recovery_sessions
           WHERE state IN ('issued', 'active')) AS active_recovery_session_count,
          (SELECT COUNT(*) FROM attention_deliveries
           WHERE state IN ('pending', 'delivering'))
            AS active_attention_delivery_count,
          (SELECT COUNT(*) FROM workflow_runs
           WHERE status IN (
             'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
           )) AS terminal_run_count,
          (SELECT MAX(updated_at) FROM workflow_runs
           WHERE status IN (
             'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
           )) AS latest_terminal_run_at
      `)
      .get(observedAt, observedAt, observedAt) as Record<string, unknown>;
    const metrics: RuntimeActivityMetrics = {
      activeRunCount: Number(row.active_run_count),
      activeTriggerOccurrenceCount: Number(
        row.active_trigger_occurrence_count
      ),
      activeTriggerAttemptCount: Number(row.active_trigger_attempt_count),
      pendingEngineOutboxCount: Number(row.pending_engine_outbox_count),
      activeControlLeaseCount: Number(row.active_control_lease_count),
      activeExternalDomainLeaseCount: Number(
        row.active_external_domain_lease_count
      ),
      activeStagingLeaseCount: Number(row.active_staging_lease_count),
      activeRecoverySessionCount: Number(row.active_recovery_session_count),
      activeAttentionDeliveryCount: Number(
        row.active_attention_delivery_count
      ),
      terminalRunCount: Number(row.terminal_run_count),
      latestTerminalRunAt:
        row.latest_terminal_run_at === null
          ? null
          : String(row.latest_terminal_run_at)
    };
    for (const [name, value] of Object.entries(metrics)) {
      if (
        name !== "latestTerminalRunAt" &&
        (!Number.isSafeInteger(value) || Number(value) < 0)
      ) {
        throw new Error(`Runtime activity metric ${name} is invalid`);
      }
    }
    if (
      metrics.latestTerminalRunAt !== null &&
      !Number.isFinite(Date.parse(metrics.latestTerminalRunAt))
    ) {
      throw new Error("Latest terminal Run timestamp is invalid");
    }
    if (
      (metrics.terminalRunCount === 0) !==
      (metrics.latestTerminalRunAt === null)
    ) {
      throw new Error("Terminal Run activity metrics are inconsistent");
    }
    return metrics;
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
      if (migration.version === 20) {
        this.#assertSeparatedTriggerModelReady();
      }
      if (migration.version === 21) {
        this.#assertTriggerAttentionModelReady();
      }
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

  #assertSeparatedTriggerModelReady(): void {
    const triggerRunCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS count FROM trigger_runs").get() as {
        count: number;
      }).count
    );
    const triggerSpecCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS count FROM trigger_specs").get() as {
        count: number;
      }).count
    );
    if (triggerRunCount > 0 || triggerSpecCount > 0) {
      throw new Error(
        "Schema 20 requires an empty legacy Trigger control plane; export and retire v1alpha1 TriggerSpecs and Trigger Runs before upgrading."
      );
    }
  }

  #assertTriggerAttentionModelReady(): void {
    const occupied = [
      "attention_records",
      "attention_deliveries",
      "recovery_sessions"
    ].filter((table) => {
      const row = this.#db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      return Number(row.count) > 0;
    });
    if (occupied.length > 0) {
      throw new Error(
        "Schema 21 requires an empty legacy Attention control plane; export and retire Attention, deliveries and Recovery Sessions before upgrading."
      );
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

  putAuthoringScenario(
    record: AuthoringScenarioRecord
  ): { status: "accepted" | "duplicate"; record: AuthoringScenarioRecord } {
    assertSchema(
      validateScenarioSpec(record.scenario),
      validateScenarioSpec.errors,
      "ScenarioSpec"
    );
    assertDigest(record.digest, "scenario digest");
    assertTimestamp(record.createdAt, "createdAt");
    const expectedDigest = digest(record.scenario);
    if (record.digest !== expectedDigest) {
      throw new AuthoringConflictError(
        `ScenarioSpec digest mismatch: expected ${expectedDigest}`
      );
    }
    const scenarioId = record.scenario.metadata.id;
    const version = record.scenario.metadata.version;
    const canonical = canonicalJson(record.scenario);

    return this.#db.transaction(() => {
      const existing = this.#db
        .prepare(
          `SELECT * FROM authoring_scenarios
           WHERE scenario_id = ? AND version = ?`
        )
        .get(scenarioId, version) as SqlRow | undefined;
      if (existing) {
        const current = this.#readAuthoringScenario(existing);
        if (
          current.digest !== record.digest ||
          current.createdAt !== record.createdAt ||
          canonicalJson(current.scenario) !== canonical
        ) {
          throw new AuthoringConflictError(
            `ScenarioSpec is immutable: ${scenarioId}@${version}`
          );
        }
        return { status: "duplicate" as const, record: current };
      }
      this.#db
        .prepare(
          `INSERT INTO authoring_scenarios(
            scenario_id, version, scenario_digest, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          scenarioId,
          version,
          record.digest,
          canonical,
          record.createdAt
        );
      this.#inject("authoring.scenario.after_insert");
      this.#insertAudit(
        "authoring.scenario.saved",
        "system:authoring",
        `scenario:${scenarioId}@${version}`,
        { digest: record.digest }
      );
      this.#inject("authoring.scenario.after_audit");
      return {
        status: "accepted" as const,
        record: this.getAuthoringScenario(scenarioId, version)!
      };
    }).immediate();
  }

  getAuthoringScenario(
    scenarioId: string,
    version: string
  ): AuthoringScenarioRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM authoring_scenarios
         WHERE scenario_id = ? AND version = ?`
      )
      .get(scenarioId, version) as SqlRow | undefined;
    return row ? this.#readAuthoringScenario(row) : undefined;
  }

  createAuthoringSession(
    session: AuthoringSessionDefinition
  ): AuthoringSessionDefinition {
    this.#assertAuthoringSession(session);
    if (session.revision !== 0 || session.state !== "intake") {
      throw new AuthoringConflictError(
        "A new Authoring Session must start at intake revision 0"
      );
    }
    const scenario = this.getAuthoringScenario(
      session.scenarioRef.id,
      session.scenarioRef.version
    );
    if (!scenario || scenario.digest !== session.scenarioRef.digest) {
      throw new AuthoringConflictError(
        `ScenarioSpec does not exist: ${session.scenarioRef.id}@${session.scenarioRef.version}`
      );
    }
    const canonical = authoringJson(session);
    const actor = `${session.actor.type}:${session.actor.id}`;

    return this.#db.transaction(() => {
      if (this.getAuthoringSession(session.sessionId)) {
        throw new AuthoringConflictError(
          `Authoring Session already exists: ${session.sessionId}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO authoring_sessions(
            session_id, revision, state, scenario_id, scenario_version,
            scenario_digest, canonical_json, created_at, updated_at
          ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.sessionId,
          session.state,
          session.scenarioRef.id,
          session.scenarioRef.version,
          session.scenarioRef.digest,
          canonical,
          session.createdAt,
          session.updatedAt
        );
      this.#inject("authoring.session.create.after_current");
      this.#db
        .prepare(
          `INSERT INTO authoring_session_revisions(
            session_id, revision, operation_id, operation_digest,
            state, canonical_json, created_at
          ) VALUES (?, 0, NULL, NULL, ?, ?, ?)`
        )
        .run(
          session.sessionId,
          session.state,
          canonical,
          session.createdAt
        );
      this.#inject("authoring.session.create.after_history");
      this.#insertAudit(
        "authoring.session.created",
        actor,
        `authoring-session:${session.sessionId}`,
        {
          revision: 0,
          scenarioRef: session.scenarioRef
        }
      );
      this.#inject("authoring.session.create.after_audit");
      return this.getAuthoringSession(session.sessionId)!;
    }).immediate();
  }

  getAuthoringSession(
    sessionId: string
  ): AuthoringSessionDefinition | undefined {
    const row = this.#db
      .prepare("SELECT * FROM authoring_sessions WHERE session_id = ?")
      .get(sessionId) as SqlRow | undefined;
    return row ? this.#readAuthoringSession(row) : undefined;
  }

  getAuthoringSessionRevision(
    sessionId: string,
    revision: number
  ): AuthoringSessionRevisionRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM authoring_session_revisions
         WHERE session_id = ? AND revision = ?`
      )
      .get(sessionId, revision) as SqlRow | undefined;
    return row ? this.#readAuthoringSessionRevision(row) : undefined;
  }

  applyAuthoringSession(
    input: ApplyAuthoringSessionInput
  ): ApplyAuthoringSessionResult {
    this.#assertAuthoringMutation(input);
    return this.#db
      .transaction(() => this.#applyAuthoringSessionInTransaction(input))
      .immediate();
  }

  putDesignModeGrant(grant: DesignModeGrantRecord): DesignModeGrantRecord {
    this.#assertDesignModeGrant(grant);
    if (grant.revision !== 0 || grant.state !== "requested") {
      throw new DesignModeGrantConflictError(
        "A Design Mode Grant must start at requested revision 0"
      );
    }
    if (!this.getAuthoringSession(grant.authoringSessionId)) {
      throw new DesignModeGrantConflictError(
        `Authoring Session does not exist: ${grant.authoringSessionId}`
      );
    }
    if (!this.getBrowserSession(grant.browserSessionId)) {
      throw new DesignModeGrantConflictError(
        `Browser Session does not exist: ${grant.browserSessionId}`
      );
    }

    return this.#db.transaction(() => {
      if (this.getDesignModeGrant(grant.grantId)) {
        throw new DesignModeGrantConflictError(
          `Design Mode Grant already exists: ${grant.grantId}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO design_mode_grants(
            grant_id, authoring_session_id, revision, state, approved_by,
            browser_session_id, profile_id, tab_id, origin, page_epoch,
            allowed_operations_json, issued_at, expires_at, updated_at,
            terminal_reason
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          grant.grantId,
          grant.authoringSessionId,
          grant.state,
          grant.approvedBy,
          grant.browserSessionId,
          grant.profileId,
          grant.tabId,
          grant.origin,
          grant.pageEpoch,
          json(grant.allowedOperations),
          grant.issuedAt,
          grant.expiresAt,
          grant.updatedAt,
          grant.terminalReason ?? null
        );
      this.#inject("authoring.grant.create.after_current");
      this.#db
        .prepare(
          `INSERT INTO design_mode_grant_revisions(
            grant_id, revision, state, actor, reason, occurred_at
          ) VALUES (?, 0, ?, ?, NULL, ?)`
        )
        .run(
          grant.grantId,
          grant.state,
          grant.approvedBy,
          grant.issuedAt
        );
      this.#inject("authoring.grant.create.after_history");
      this.#insertAudit(
        "authoring.design-grant.requested",
        grant.approvedBy,
        `design-grant:${grant.grantId}`,
        {
          authoringSessionId: grant.authoringSessionId,
          browserSessionId: grant.browserSessionId,
          tabId: grant.tabId,
          origin: grant.origin,
          pageEpoch: grant.pageEpoch,
          expiresAt: grant.expiresAt
        }
      );
      this.#inject("authoring.grant.create.after_audit");
      return this.getDesignModeGrant(grant.grantId)!;
    }).immediate();
  }

  getDesignModeGrant(
    grantId: string
  ): DesignModeGrantRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM design_mode_grants WHERE grant_id = ?")
      .get(grantId) as SqlRow | undefined;
    return row ? this.#readDesignModeGrant(row) : undefined;
  }

  transitionDesignModeGrant(
    input: TransitionDesignModeGrantInput
  ): DesignModeGrantRecord {
    assertAuthoringId(input.grantId, "grantId");
    assertRevision(input.expectedRevision, "expectedRevision");
    assertAuthoringId(input.actor, "actor");
    assertTimestamp(input.occurredAt, "occurredAt");
    if (input.reason != null && input.reason.length > 2000) {
      throw new Error("Design Mode Grant reason exceeds 2000 characters");
    }

    return this.#db.transaction(() => {
      const current = this.getDesignModeGrant(input.grantId);
      if (!current) {
        throw new DesignModeGrantConflictError(
          `Design Mode Grant does not exist: ${input.grantId}`
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError(
          `Design Mode Grant revision changed: ${current.revision}`
        );
      }
      if (
        !this.#canTransitionDesignModeGrant(
          current.state,
          input.nextState
        )
      ) {
        throw new DesignModeGrantConflictError(
          `Invalid Design Mode Grant transition: ${current.state} -> ${input.nextState}`
        );
      }
      if (
        input.nextState === "active" &&
        Date.parse(input.occurredAt) >= Date.parse(current.expiresAt)
      ) {
        throw new DesignModeGrantConflictError(
          "An expired Design Mode Grant cannot become active"
        );
      }
      const nextRevision = current.revision + 1;
      const terminalReason =
        input.nextState === "active" ? undefined : input.reason;
      const updated = this.#db
        .prepare(
          `UPDATE design_mode_grants
           SET revision = ?, state = ?, updated_at = ?, terminal_reason = ?
           WHERE grant_id = ? AND revision = ?`
        )
        .run(
          nextRevision,
          input.nextState,
          input.occurredAt,
          terminalReason ?? null,
          input.grantId,
          input.expectedRevision
        );
      if (updated.changes !== 1) {
        throw new RevisionConflictError(
          "Design Mode Grant changed concurrently"
        );
      }
      this.#inject("authoring.grant.transition.after_current");
      this.#db
        .prepare(
          `INSERT INTO design_mode_grant_revisions(
            grant_id, revision, state, actor, reason, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.grantId,
          nextRevision,
          input.nextState,
          input.actor,
          input.reason ?? null,
          input.occurredAt
        );
      this.#inject("authoring.grant.transition.after_history");
      this.#insertAudit(
        `authoring.design-grant.${input.nextState}`,
        input.actor,
        `design-grant:${input.grantId}`,
        {
          revision: nextRevision,
          reason: input.reason ?? null
        }
      );
      this.#inject("authoring.grant.transition.after_audit");
      return this.getDesignModeGrant(input.grantId)!;
    }).immediate();
  }

  attachPageSnapshot(
    input: AttachPageSnapshotInput
  ): ApplyAuthoringSessionResult {
    this.#assertAuthoringMutation(input);
    assertSchema(
      validatePageSnapshot(input.snapshot),
      validatePageSnapshot.errors,
      "PageSnapshot"
    );
    const snapshot = input.snapshot;
    const snapshotRefCount = input.next.snapshotRefs.filter(
      (reference) =>
        reference.id === snapshot.snapshotId &&
        reference.digest === snapshot.contentDigest
    ).length;
    if (
      snapshotRefCount !== 1 ||
      !input.next.designGrantRefs.includes(
        snapshot.binding.designGrantId
      )
    ) {
      throw new AuthoringConflictError(
        "Authoring Session must reference the exact PageSnapshot and Design Mode Grant"
      );
    }

    return this.#db.transaction(() => {
      const existing = this.getPageSnapshot(snapshot.snapshotId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(snapshot)) {
          throw new AuthoringConflictError(
            `PageSnapshot is immutable: ${snapshot.snapshotId}`
          );
        }
        const replay = this.#applyAuthoringSessionInTransaction(input);
        if (replay.status !== "duplicate") {
          throw new AuthoringConflictError(
            `PageSnapshot is already attached: ${snapshot.snapshotId}`
          );
        }
        return replay;
      }
      this.#assertSnapshotOwnership(input.sessionId, snapshot);
      this.#db
        .prepare(
          `INSERT INTO authoring_page_snapshots(
            snapshot_id, authoring_session_id, design_grant_id, page_state,
            evidence_id, asset_id, content_digest, canonical_json,
            captured_at, raw_evidence_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshot.snapshotId,
          input.sessionId,
          snapshot.binding.designGrantId,
          snapshot.pageState,
          snapshot.captureSource.evidenceId,
          snapshot.captureSource.assetRef.id,
          snapshot.contentDigest,
          authoringJson(snapshot),
          snapshot.capturedAt,
          snapshot.rawEvidenceExpiresAt
        );
      this.#inject("authoring.snapshot.after_insert");
      const result = this.#applyAuthoringSessionInTransaction(input);
      if (result.status === "stale") {
        throw new RevisionConflictError(
          `Authoring Session revision changed: ${result.actualRevision}`
        );
      }
      this.#insertAudit(
        "authoring.snapshot.attached",
        input.actor,
        `page-snapshot:${snapshot.snapshotId}`,
        {
          authoringSessionId: input.sessionId,
          designGrantId: snapshot.binding.designGrantId,
          evidenceId: snapshot.captureSource.evidenceId,
          assetId: snapshot.captureSource.assetRef.id,
          contentDigest: snapshot.contentDigest
        }
      );
      this.#inject("authoring.snapshot.after_audit");
      return result;
    }).immediate();
  }

  getPageSnapshot(
    snapshotId: string
  ): PageSnapshotDefinition | undefined {
    const row = this.#db
      .prepare(
        "SELECT canonical_json FROM authoring_page_snapshots WHERE snapshot_id = ?"
      )
      .get(snapshotId) as SqlRow | undefined;
    return row
      ? (parseJson(row.canonical_json) as PageSnapshotDefinition)
      : undefined;
  }

  saveCandidateBundle(
    input: SaveCandidateBundleInput
  ): {
    status: "accepted" | "duplicate" | "stale";
    record?: CandidateBundleRecord;
    actualRevision?: number;
  } {
    this.#assertAuthoringMutation(input);
    assertSchema(
      validateCandidateBundle(input.bundle),
      validateCandidateBundle.errors,
      "CandidateBundle"
    );
    const bundle = input.bundle;
    const bundleId = bundle.metadata.id;
    const recordDigest = digest(bundle);
    this.#assertCandidateBundleInput(input, recordDigest);

    return this.#db.transaction(() => {
      const existing = this.getCandidateBundle(bundleId);
      if (existing) {
        if (
          existing.digest !== recordDigest ||
          canonicalJson(existing.bundle) !== canonicalJson(bundle)
        ) {
          throw new CandidateBundleConflictError(
            `Candidate Bundle is immutable: ${bundleId}`
          );
        }
        return { status: "duplicate" as const, record: existing };
      }
      const applied = this.#applyAuthoringSessionInTransaction(input);
      if (applied.status === "stale") {
        return {
          status: "stale" as const,
          actualRevision: applied.actualRevision
        };
      }
      this.#db
        .prepare(
          `INSERT INTO candidate_bundles(
            bundle_id, version, authoring_session_id, source_revision,
            record_digest, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          bundleId,
          bundle.metadata.version,
          input.sessionId,
          bundle.authoringSession.revision,
          recordDigest,
          authoringJson(bundle),
          bundle.createdAt
        );
      this.#inject("authoring.bundle.after_insert");
      const insertItem = this.#db.prepare(
        `INSERT INTO candidate_bundle_items(
          bundle_id, item_type, ordinal, item_key, digest, canonical_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      bundle.artifacts.forEach((artifact, ordinal) => {
        insertItem.run(
          bundleId,
          "artifact",
          ordinal,
          `${artifact.kind}:${artifact.id}@${artifact.version}`,
          artifact.digest,
          authoringJson(artifact)
        );
      });
      bundle.files.forEach((file, ordinal) => {
        insertItem.run(
          bundleId,
          "file",
          ordinal,
          file.path,
          file.digest,
          authoringJson(file)
        );
      });
      this.#inject("authoring.bundle.after_items");
      const insertValidation = this.#db.prepare(
        `INSERT INTO candidate_bundle_validations(
          bundle_id, check_type, valid, issue_count, report_asset_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const validation of input.validationResults) {
        insertValidation.run(
          bundleId,
          validation.checkType,
          validation.valid ? 1 : 0,
          validation.issueCount,
          validation.reportAssetId ?? null,
          validation.createdAt
        );
      }
      this.#inject("authoring.bundle.after_validations");
      this.#insertAudit(
        "authoring.candidate-bundle.saved",
        input.actor,
        `candidate-bundle:${bundleId}`,
        {
          digest: recordDigest,
          sourceRevision: bundle.authoringSession.revision,
          fileCount: bundle.files.length,
          artifactCount: bundle.artifacts.length
        }
      );
      this.#inject("authoring.bundle.after_audit");
      return {
        status: "accepted" as const,
        record: this.getCandidateBundle(bundleId)!
      };
    }).immediate();
  }

  getCandidateBundle(
    bundleId: string
  ): CandidateBundleRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM candidate_bundles WHERE bundle_id = ?")
      .get(bundleId) as SqlRow | undefined;
    return row ? this.#readCandidateBundle(row) : undefined;
  }

  listCandidateBundleValidation(
    bundleId: string
  ): CandidateBundleValidationRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM candidate_bundle_validations
           WHERE bundle_id = ?
           ORDER BY check_type`
        )
        .all(bundleId) as SqlRow[]
    ).map((row) => this.#readCandidateBundleValidation(row));
  }

  putCandidateExport(
    record: CandidateExportRecord
  ): { status: "accepted" | "duplicate"; record: CandidateExportRecord } {
    assertAuthoringId(record.exportId, "exportId");
    assertAuthoringId(record.bundleId, "bundleId");
    assertDigest(record.bundleDigest, "bundleDigest");
    assertDigest(record.archiveDigest, "archiveDigest");
    assertDigest(record.manifestDigest, "manifestDigest");
    assertTimestamp(record.createdAt, "createdAt");
    if (
      !/^candidate-export:[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(
        record.destinationRef
      )
    ) {
      throw new CandidateBundleConflictError(
        "Candidate export destination must be an opaque candidate-export reference"
      );
    }
    const bundle = this.getCandidateBundle(record.bundleId);
    if (!bundle || bundle.digest !== record.bundleDigest) {
      throw new CandidateBundleConflictError(
        `Candidate Bundle digest does not match: ${record.bundleId}`
      );
    }

    return this.#db.transaction(() => {
      const existing = this.getCandidateExport(record.exportId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw new CandidateBundleConflictError(
            `Candidate export is immutable: ${record.exportId}`
          );
        }
        return { status: "duplicate" as const, record: existing };
      }
      this.#db
        .prepare(
          `INSERT INTO candidate_exports(
            export_id, bundle_id, bundle_digest, archive_digest,
            manifest_digest, destination_ref, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.exportId,
          record.bundleId,
          record.bundleDigest,
          record.archiveDigest,
          record.manifestDigest,
          record.destinationRef,
          record.actor,
          record.createdAt
        );
      this.#inject("authoring.export.after_insert");
      this.#insertAudit(
        "authoring.candidate-bundle.exported",
        record.actor,
        `candidate-export:${record.exportId}`,
        {
          bundleId: record.bundleId,
          bundleDigest: record.bundleDigest,
          archiveDigest: record.archiveDigest,
          manifestDigest: record.manifestDigest,
          destinationRef: record.destinationRef
        }
      );
      this.#inject("authoring.export.after_audit");
      return {
        status: "accepted" as const,
        record: this.getCandidateExport(record.exportId)!
      };
    }).immediate();
  }

  getCandidateExport(
    exportId: string
  ): CandidateExportRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM candidate_exports WHERE export_id = ?")
      .get(exportId) as SqlRow | undefined;
    return row ? this.#readCandidateExport(row) : undefined;
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

  getCandidate(
    assetType: ArtifactType,
    assetId: string,
    version: string
  ): ArtifactRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM artifacts
         WHERE asset_type = ? AND asset_id = ? AND version = ? AND status = 'candidate'`
      )
      .get(assetType, assetId, version) as SqlRow | undefined;
    return row ? this.#readArtifact(row) : undefined;
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
        (input.planSnapshot && input.planSnapshot.runId !== run.id) ||
        (input.resourceBindingSnapshot &&
          input.resourceBindingSnapshot.runId !== run.id)
      ) {
        throw new Error(
          "Run, plan, resource binding snapshot and initial event identities differ"
        );
      }
      if (input.resourceBindingSnapshot && !input.planSnapshot) {
        throw new Error(
          "A Resource Binding Snapshot requires an immutable Run plan"
        );
      }
      if (input.resourceBindingSnapshot && input.planSnapshot) {
        this.#validateResourceBindingSnapshot(
          run.id,
          input.planSnapshot,
          input.resourceBindingSnapshot
        );
      }
      this.#insertRun(run);
      this.#inject("create_run.after_run");
      if (input.planSnapshot) {
        this.#insertPlanSnapshot(input.planSnapshot);
      }
      if (input.resourceBindingSnapshot) {
        this.#insertResourceBindingSnapshot(
          input.resourceBindingSnapshot,
          run.createdAt
        );
        this.#inject("create_run.after_binding");
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
      triggerAttemptId?: string;
      externalDomainLeaseRequestId?: string;
      outbox?: readonly OutboxMessage[];
      assistanceTasks?: readonly AssistanceTaskRecord[];
    }
  ): RunRecord {
    if (input.externalDomainLeaseRequestId && !input.triggerAttemptId) {
      throw new Error(
        "An external domain lease requires an owning Trigger Attempt"
      );
    }
    if (input.triggerAttemptId) {
      const attempt = this.getTriggerAttempt(input.triggerAttemptId);
      const occurrence = attempt
        ? this.getTriggerOccurrence(attempt.occurrenceId)
        : undefined;
      if (
        !attempt ||
        attempt.status !== "running" ||
        attempt.workflowRunId ||
        !occurrence ||
        occurrence.status !== "running"
      ) {
        throw new Error(
          `Trigger Attempt is not ready for atomic Run creation: ${input.triggerAttemptId}`
        );
      }
      const pinnedSpec = this.getTriggerSpecVersion(
        occurrence.triggerId,
        occurrence.triggerVersion
      );
      if (!pinnedSpec) {
        throw new Error(
          `Pinned TriggerSpec is missing for atomic Run creation: ${input.triggerAttemptId}`
        );
      }
      if (
        pinnedSpec.workflow.id !== input.run.workflowId ||
        pinnedSpec.workflow.version !== input.run.workflowVersion
      ) {
        throw new Error(
          `Trigger Attempt workflow does not match Run: ${input.triggerAttemptId}`
        );
      }
      if (
        (pinnedSpec.externalDomainLease !== undefined) !==
        (input.externalDomainLeaseRequestId !== undefined)
      ) {
        throw new Error(
          `Trigger Attempt external domain lease does not match Run creation: ${input.triggerAttemptId}`
        );
      }
      if (input.externalDomainLeaseRequestId) {
        const lease = this.getExternalDomainLease(
          input.externalDomainLeaseRequestId
        );
        const externalDomainLease = pinnedSpec.externalDomainLease;
        if (
          !externalDomainLease ||
          !lease ||
          lease.state !== "bound" ||
          lease.providerId !== externalDomainLease.providerId ||
          lease.domainKey !== externalDomainLease.resourceId ||
          lease.ownerId !== input.triggerAttemptId ||
          lease.occurrenceId !== attempt.occurrenceId ||
          lease.triggerAttemptId ||
          lease.runId ||
          !lease.expiresAt
        ) {
          throw new Error(
            `External domain lease is not ready for atomic Run creation: ${input.externalDomainLeaseRequestId}`
          );
        }
      }
    }
    return this.#db.transaction(() => {
      if (
        input.event.runId !== input.run.id ||
        input.planSnapshot.runId !== input.run.id ||
        input.checkpoint.runId !== input.run.id ||
        (input.resourceBindingSnapshot &&
          input.resourceBindingSnapshot.runId !== input.run.id)
      ) {
        throw new Error(
          "Recoverable Run, plan, binding, checkpoint and event identities differ"
        );
      }
      if (input.resourceBindingSnapshot) {
        this.#validateResourceBindingSnapshot(
          input.run.id,
          input.planSnapshot,
          input.resourceBindingSnapshot
        );
      }
      this.#insertRun(input.run);
      this.#inject("recoverable_run.after_run");
      this.#insertPlanSnapshot(input.planSnapshot);
      this.#insertCheckpoint(input.checkpoint);
      if (input.resourceBindingSnapshot) {
        this.#insertResourceBindingSnapshot(
          input.resourceBindingSnapshot,
          input.run.createdAt
        );
        this.#inject("recoverable_run.after_binding");
      }
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
      if (input.triggerAttemptId) {
        const linked = this.#db.prepare(
          `UPDATE trigger_attempts
           SET workflow_run_id=?,updated_at=?,revision=revision+1
           WHERE attempt_id=? AND status='running'
             AND workflow_run_id IS NULL
             AND EXISTS (
               SELECT 1
               FROM trigger_occurrences occurrence
               INNER JOIN trigger_spec_versions version
                 ON version.trigger_id=occurrence.trigger_id
                AND version.trigger_version=occurrence.trigger_version
               WHERE occurrence.occurrence_id=trigger_attempts.occurrence_id
                 AND occurrence.status='running'
                 AND json_extract(version.spec_json,'$.workflow.id')=?
                 AND json_extract(version.spec_json,'$.workflow.version')=?
             )`
        ).run(
          input.run.id,
          input.run.createdAt,
          input.triggerAttemptId,
          input.run.workflowId,
          input.run.workflowVersion
        );
        if (linked.changes !== 1) {
          throw new Error(
            `Trigger Attempt is not ready for atomic Run creation: ${input.triggerAttemptId}`
          );
        }
      }
      if (input.externalDomainLeaseRequestId && input.triggerAttemptId) {
        const linked = this.#db
          .prepare(
            `UPDATE external_domain_leases
             SET trigger_attempt_id=?,workflow_run_id=?,updated_at=?,
                 revision=revision+1
             WHERE request_id=? AND state='bound'
               AND proposed_owner_id=?
               AND trigger_attempt_id IS NULL AND workflow_run_id IS NULL
               AND EXISTS (
                 SELECT 1
                 FROM trigger_attempts attempt
                 INNER JOIN trigger_occurrences occurrence
                   ON occurrence.occurrence_id=attempt.occurrence_id
                 INNER JOIN trigger_spec_versions version
                   ON version.trigger_id=occurrence.trigger_id
                  AND version.trigger_version=occurrence.trigger_version
                 WHERE attempt.attempt_id=?
                   AND attempt.workflow_run_id=?
                   AND occurrence.occurrence_id=external_domain_leases.occurrence_id
                   AND json_extract(
                     version.spec_json,'$.externalDomainLease.providerId'
                   )=external_domain_leases.provider_id
                   AND json_extract(
                     version.spec_json,'$.externalDomainLease.resourceId'
                   )=external_domain_leases.domain_key
               )`
          )
          .run(
            input.triggerAttemptId,
            input.run.id,
            input.run.createdAt,
            input.externalDomainLeaseRequestId,
            input.triggerAttemptId,
            input.triggerAttemptId,
            input.run.id
          );
        if (linked.changes !== 1) {
          throw new Error(
            `External domain lease is not ready for atomic Run creation: ${input.externalDomainLeaseRequestId}`
          );
        }
        this.#inject("recoverable_run.after_external_domain_lease");
      }
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
      this.#assertOperationalAttentionMarker(
        input.output,
        input.operationalAttentionMarker,
        input.nextStatus
      );
      this.#assertOperationalDatasetPublicationMarker(
        input.runId,
        input.output,
        input.operationalDatasetPublicationIntentId,
        input.nextStatus
      );
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
      this.#commitAttentionForTerminal({
        ...input,
        terminalAt: input.event.occurredAt
      });
      if (
        (input.nextStatus === "succeeded" || input.nextStatus === "uncertain") &&
        input.operationalDatasetPublicationIntentId
      ) {
        this.#publishPreparedOperationalDataset(
          input.runId,
          input.nextStatus,
          input.operationalDatasetPublicationIntentId
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
      this.#assertOperationalAttentionMarker(
        input.output,
        input.operationalAttentionMarker,
        input.nextStatus
      );
      this.#assertOperationalDatasetPublicationMarker(
        input.runId,
        input.output,
        input.operationalDatasetPublicationIntentId,
        input.nextStatus
      );
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
      this.#commitAttentionForTerminal({
        ...input,
        terminalAt: input.event.occurredAt
      });
      if (
        (input.nextStatus === "succeeded" || input.nextStatus === "uncertain") &&
        input.operationalDatasetPublicationIntentId
      ) {
        this.#publishPreparedOperationalDataset(
          input.runId,
          input.nextStatus,
          input.operationalDatasetPublicationIntentId
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

  getRunResourceBindingSnapshot(
    runId: string
  ): ResourceBindingSnapshot | undefined {
    const row = this.#db
      .prepare(
        `SELECT snapshot_json
         FROM run_resource_binding_snapshots WHERE run_id = ?`
      )
      .get(runId) as { snapshot_json: string } | undefined;
    return row
      ? (parseJson(row.snapshot_json) as ResourceBindingSnapshot)
      : undefined;
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
      this.#assertOperationalAttentionMarker(
        input.output,
        input.operationalAttentionMarker,
        input.nextRunStatus ?? "running"
      );
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
      this.#commitAttentionForTerminal({
        runId: input.task.task.runId,
        nextStatus: input.nextRunStatus ?? "running",
        terminalAt: input.wakeEvent.occurredAt,
        ...(input.operationalAttentionMarker
          ? { operationalAttentionMarker: input.operationalAttentionMarker }
          : {}),
        ...(input.attention ? { attention: input.attention } : {}),
        ...(input.attentionDelivery
          ? { attentionDelivery: input.attentionDelivery }
          : {})
      });
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

  putOperationalFact(input: {
    namespace: string;
    businessTimeZone: string;
    subjectId: string;
    schemaVersion: string;
    record: JsonValue;
    observedAt: string;
    persistedAt: string;
    executionContext: OperationalExecutionContext;
  }): {
    status: "accepted" | "duplicate";
    fact: OperationalFactRecord;
  } {
    assertAuthoringId(input.namespace, "operational fact namespace");
    assertAuthoringId(input.subjectId, "operational fact subjectId");
    if (!input.businessTimeZone.trim()) {
      throw new Error("businessTimeZone must not be empty");
    }
    assertSemver(input.schemaVersion, "operational fact schemaVersion");
    assertTimestamp(input.observedAt, "operational fact observedAt");
    assertTimestamp(input.persistedAt, "operational fact persistedAt");
    assertJsonCompatible(input.record, "operational fact record");
    const recordObject =
      input.record !== null &&
      typeof input.record === "object" &&
      !Array.isArray(input.record)
        ? (input.record as Readonly<Record<string, JsonValue>>)
        : undefined;
    if (recordObject?.id !== input.subjectId) {
      throw new Error(
        "Operational fact record.id must equal the stable subjectId"
      );
    }
    const runId = input.executionContext.identity.runId;
    return this.#db.transaction(() => {
      this.#assertActiveOperationalExecutionContext(
        runId,
        input.executionContext
      );
      this.#assertActiveTriggerOwnership(runId);
      const sealed = this.#db
        .prepare(
          `SELECT 1 FROM operational_dataset_publication_intents
           WHERE run_id = ?
           UNION ALL
           SELECT 1 FROM operational_dataset_publication_lineage
           WHERE run_id = ? LIMIT 1`
        )
        .get(runId, runId);
      if (sealed) {
        throw new StaleFencingTokenError(
          `Operational facts are sealed for Run ${runId}`
        );
      }
      const businessAnchorAt = this.#operationalBusinessAnchor(runId);
      const businessDate = businessDateAt(
        businessAnchorAt,
        input.businessTimeZone
      );
      if (
        recordObject.businessDate !== undefined &&
        recordObject.businessDate !== businessDate
      ) {
        throw new Error(
          "Operational fact record.businessDate conflicts with the Run anchor"
        );
      }
      const record: JsonValue = { ...recordObject, businessDate };
      const factKey = operationalFactKey({
        namespace: input.namespace,
        runId,
        businessDate,
        subjectId: input.subjectId,
        schemaVersion: input.schemaVersion
      });
      const recordDigest = digest(record);
      const existing = this.getOperationalFact(factKey);
      if (existing) {
        if (existing.recordDigest !== recordDigest) {
          throw new OperationalFactConflictError(
            `Operational fact ${factKey} already has different content`
          );
        }
        return { status: "duplicate" as const, fact: existing };
      }
      this.#db
        .prepare(
          `INSERT INTO operational_facts(
            fact_key, namespace, run_id, business_date, business_time_zone,
            business_anchor_at, subject_id,
            schema_version, record_digest, record_json, invocation_id,
            node_json, scope_path_json, iteration_key, step_key, attempt,
            idempotency_key, fencing_token, observed_at, persisted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          factKey,
          input.namespace,
          runId,
          businessDate,
          input.businessTimeZone,
          businessAnchorAt,
          input.subjectId,
          input.schemaVersion,
          recordDigest,
          json(record),
          input.executionContext.invocationId,
          json(input.executionContext.node),
          json(input.executionContext.identity.scopePath),
          input.executionContext.identity.iterationKey,
          input.executionContext.identity.stepKey,
          input.executionContext.identity.attempt,
          input.executionContext.idempotencyKey,
          input.executionContext.fencingToken,
          input.observedAt,
          input.persistedAt
        );
      return {
        status: "accepted" as const,
        fact: this.getOperationalFact(factKey)!
      };
    })();
  }

  getOperationalFact(factKey: string): OperationalFactRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM operational_facts WHERE fact_key = ?")
      .get(factKey) as SqlRow | undefined;
    return row ? this.#readOperationalFact(row) : undefined;
  }

  listOperationalFactsForRun(runId: string): OperationalFactRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM operational_facts
           WHERE run_id = ?
           ORDER BY business_date, subject_id, fact_key`
        )
        .all(runId) as SqlRow[]
    ).map((row) => this.#readOperationalFact(row));
  }

  persistBinanceCopyTradingCapture(
    input: PersistBinanceCopyTradingCaptureInput
  ): {
    status: "accepted" | "duplicate";
    run: BinanceCollectionRunRecord;
    newCurrentRecordCount: number;
  } {
    assertAuthoringId(input.collectionRunId, "Binance collectionRunId");
    if (input.workflowRunId !== input.executionContext.identity.runId) {
      throw new Error("Binance workflowRunId must match execution context");
    }
    for (const [label, value] of [
      ["attemptAt", input.attemptAt],
      ["captureAt", input.captureAt],
      ["oldestEventTimeUtc", input.oldestEventTimeUtc],
      ["newestEventTimeUtc", input.newestEventTimeUtc]
    ] as const) {
      if (value !== undefined) assertTimestamp(value, `Binance ${label}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.contentDigest)) {
      throw new Error("Binance contentDigest is invalid");
    }
    for (const [label, value] of [
      ["projectCount", input.projectCount],
      ["pageCount", input.pageCount],
      ["recordCount", input.recordCount]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Binance ${label} is invalid`);
      }
    }
    if (
      input.projects.length !== input.projectCount ||
      input.rawRecords.length !== input.recordCount
    ) {
      throw new Error("Binance capture counts do not conserve");
    }
    if (
      input.sourceCaptures.filter((capture) => capture.sourceKind === "management")
        .length !== 1 ||
      input.sourceCaptures.length !== input.pageCount
    ) {
      throw new Error("Binance source capture coverage is invalid");
    }
    return this.#db.transaction(() => {
      this.#assertActiveOperationalExecutionContext(
        input.workflowRunId,
        input.executionContext
      );
      this.#assertActiveTriggerOwnership(input.workflowRunId);
      const existing = this.getBinanceCollectionRun(input.collectionRunId);
      if (existing) {
        if (
          existing.workflowRunId !== input.workflowRunId ||
          existing.contentDigest !== input.contentDigest ||
          existing.status !== input.status
        ) {
          throw new OperationalFactConflictError(
            `Binance collection ${input.collectionRunId} already has different content`
          );
        }
        return {
          status: "duplicate" as const,
          run: existing,
          newCurrentRecordCount: 0
        };
      }
      const previous = this.getLatestSuccessfulBinanceCollectionRun();
      const status = input.status;
      const lastSuccessAt =
        status === "success" || status === "authenticated_but_no_data"
          ? input.captureAt
          : previous?.lastSuccessAt;
      this.#db.prepare(
        `INSERT INTO binance_collection_runs(
          collection_run_id,workflow_run_id,source_url,attempt_at,capture_at,
          status,content_digest,project_count,page_count,record_count,
          oldest_event_time_utc,newest_event_time_utc,last_success_at,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.collectionRunId,
        input.workflowRunId,
        input.sourceUrl,
        input.attemptAt,
        input.captureAt,
        status,
        input.contentDigest,
        input.projectCount,
        input.pageCount,
        input.recordCount,
        input.oldestEventTimeUtc ?? null,
        input.newestEventTimeUtc ?? null,
        lastSuccessAt ?? null,
        this.#clock().toISOString()
      );
      const captureStatement = this.#db.prepare(
        `INSERT INTO binance_source_captures(
          capture_id,collection_run_id,source_kind,project_id,source_tab,page,
          source_url,capture_at,record_count,payload_digest,payload_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const capture of input.sourceCaptures) {
        assertJsonCompatible(capture.payload, "Binance source capture payload");
        captureStatement.run(
          capture.captureId,
          input.collectionRunId,
          capture.sourceKind,
          capture.projectId ?? null,
          capture.sourceTab ?? null,
          capture.page ?? null,
          capture.sourceUrl,
          capture.captureAt,
          capture.recordCount,
          capture.payloadDigest,
          json(capture.payload)
        );
      }
      const projectStatement = this.#db.prepare(
        `INSERT INTO binance_copy_project_snapshots(
          collection_run_id,project_id,project_status,source_url,captured_at,
          summary_json
        ) VALUES (?,?,?,?,?,?)`
      );
      for (const project of input.projects) {
        assertJsonCompatible(project.summary, "Binance project summary");
        projectStatement.run(
          input.collectionRunId,
          project.projectId,
          project.projectStatus,
          project.sourceUrl,
          project.capturedAt,
          json(project.summary)
        );
      }
      const positionStatement = this.#db.prepare(
        `INSERT INTO binance_position_snapshots(
          snapshot_id,collection_run_id,project_id,symbol,position_side,
          ordinal,captured_at,fields_json
        ) VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const position of input.positions) {
        assertJsonCompatible(position.fields, "Binance position fields");
        positionStatement.run(
          position.snapshotId,
          input.collectionRunId,
          position.projectId,
          position.symbol,
          position.positionSide,
          position.ordinal,
          position.capturedAt,
          json(position.fields)
        );
      }
      const rawStatement = this.#db.prepare(
        `INSERT INTO binance_copy_raw_records(
          raw_record_id,collection_run_id,current_record_key,project_id,
          source_tab,page,row_ordinal,capture_at,original_event_time,
          event_time_utc,page_time_zone_assumption,fields_json,fields_digest
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const currentStatement = this.#db.prepare(
        `INSERT INTO binance_copy_record_current(
          current_record_key,project_id,source_tab,original_event_time,
          event_time_utc,page_time_zone_assumption,fields_json,fields_digest,
          first_collection_run_id,last_collection_run_id,first_seen_at,last_seen_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(current_record_key) DO UPDATE SET
          original_event_time=excluded.original_event_time,
          event_time_utc=excluded.event_time_utc,
          page_time_zone_assumption=excluded.page_time_zone_assumption,
          fields_json=excluded.fields_json,
          fields_digest=excluded.fields_digest,
          last_collection_run_id=excluded.last_collection_run_id,
          last_seen_at=excluded.last_seen_at`
      );
      const currentExistsStatement = this.#db.prepare(
        `SELECT 1 FROM binance_copy_record_current
         WHERE current_record_key=?`
      );
      let newCurrentRecordCount = 0;
      for (const record of input.rawRecords) {
        assertJsonCompatible(record.fields, "Binance raw record fields");
        rawStatement.run(
          record.rawRecordId,
          input.collectionRunId,
          record.currentRecordKey,
          record.projectId,
          record.sourceTab,
          record.page,
          record.rowOrdinal,
          record.captureAt,
          record.originalEventTime ?? null,
          record.eventTimeUtc ?? null,
          record.pageTimeZoneAssumption ?? null,
          json(record.fields),
          record.fieldsDigest
        );
        if (!currentExistsStatement.get(record.currentRecordKey)) {
          newCurrentRecordCount += 1;
        }
        currentStatement.run(
          record.currentRecordKey,
          record.projectId,
          record.sourceTab,
          record.originalEventTime ?? null,
          record.eventTimeUtc ?? null,
          record.pageTimeZoneAssumption ?? null,
          json(record.fields),
          record.fieldsDigest,
          input.collectionRunId,
          input.collectionRunId,
          input.captureAt,
          input.captureAt
        );
      }
      return {
        status: "accepted" as const,
        run: this.getBinanceCollectionRun(input.collectionRunId)!,
        newCurrentRecordCount
      };
    })();
  }

  getBinanceCollectionRun(
    collectionRunId: string
  ): BinanceCollectionRunRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM binance_collection_runs WHERE collection_run_id=?"
    ).get(collectionRunId) as SqlRow | undefined;
    return row ? this.#readBinanceCollectionRun(row) : undefined;
  }

  getLatestSuccessfulBinanceCollectionRun():
    | BinanceCollectionRunRecord
    | undefined {
    const row = this.#db.prepare(
      `SELECT * FROM binance_collection_runs
       WHERE status IN ('success','authenticated_but_no_data')
       ORDER BY capture_at DESC,collection_run_id DESC LIMIT 1`
    ).get() as SqlRow | undefined;
    return row ? this.#readBinanceCollectionRun(row) : undefined;
  }

  listBinanceRawRecords(collectionRunId: string): BinanceRawRecord[] {
    return (this.#db.prepare(
      `SELECT * FROM binance_copy_raw_records WHERE collection_run_id=?
       ORDER BY project_id,source_tab,page,row_ordinal`
    ).all(collectionRunId) as SqlRow[]).map((row) => ({
      rawRecordId: String(row.raw_record_id),
      collectionRunId: String(row.collection_run_id),
      currentRecordKey: String(row.current_record_key),
      projectId: String(row.project_id),
      sourceTab: String(row.source_tab),
      page: Number(row.page),
      rowOrdinal: Number(row.row_ordinal),
      captureAt: String(row.capture_at),
      ...(row.original_event_time == null ? {} : {
        originalEventTime: String(row.original_event_time)
      }),
      ...(row.event_time_utc == null ? {} : {
        eventTimeUtc: String(row.event_time_utc)
      }),
      ...(row.page_time_zone_assumption == null ? {} : {
        pageTimeZoneAssumption: String(row.page_time_zone_assumption)
      }),
      fields: parseJson(row.fields_json) as JsonValue,
      fieldsDigest: String(row.fields_digest)
    }));
  }

  listBinanceCurrentRecords(projectId?: string): BinanceCurrentRecord[] {
    const rows = (projectId
      ? this.#db.prepare(
          `SELECT * FROM binance_copy_record_current WHERE project_id=?
           ORDER BY source_tab,event_time_utc,current_record_key`
        ).all(projectId)
      : this.#db.prepare(
          `SELECT * FROM binance_copy_record_current
           ORDER BY project_id,source_tab,event_time_utc,current_record_key`
        ).all()) as SqlRow[];
    return rows.map((row) => ({
      currentRecordKey: String(row.current_record_key),
      projectId: String(row.project_id),
      sourceTab: String(row.source_tab),
      ...(row.original_event_time == null ? {} : {
        originalEventTime: String(row.original_event_time)
      }),
      ...(row.event_time_utc == null ? {} : {
        eventTimeUtc: String(row.event_time_utc)
      }),
      ...(row.page_time_zone_assumption == null ? {} : {
        pageTimeZoneAssumption: String(row.page_time_zone_assumption)
      }),
      fields: parseJson(row.fields_json) as JsonValue,
      fieldsDigest: String(row.fields_digest),
      firstCollectionRunId: String(row.first_collection_run_id),
      lastCollectionRunId: String(row.last_collection_run_id),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at)
    }));
  }

  #readBinanceCollectionRun(row: SqlRow): BinanceCollectionRunRecord {
    return {
      collectionRunId: String(row.collection_run_id),
      workflowRunId: String(row.workflow_run_id),
      sourceUrl: String(row.source_url),
      attemptAt: String(row.attempt_at),
      captureAt: String(row.capture_at),
      status: String(row.status) as BinanceCollectionRunRecord["status"],
      contentDigest: String(row.content_digest),
      projectCount: Number(row.project_count),
      pageCount: Number(row.page_count),
      recordCount: Number(row.record_count),
      ...(row.oldest_event_time_utc == null ? {} : {
        oldestEventTimeUtc: String(row.oldest_event_time_utc)
      }),
      ...(row.newest_event_time_utc == null ? {} : {
        newestEventTimeUtc: String(row.newest_event_time_utc)
      }),
      ...(row.last_success_at == null ? {} : {
        lastSuccessAt: String(row.last_success_at)
      }),
      createdAt: String(row.created_at)
    };
  }

  persistBinanceMarketCapture(input: PersistBinanceMarketCaptureInput): {
    status: "accepted" | "duplicate";
    capture: BinanceMarketCaptureRecord;
    insertedCandleCount: number;
    insertedFundingCount: number;
  } {
    assertAuthoringId(input.marketCaptureId, "Binance marketCaptureId");
    if (input.workflowRunId !== input.executionContext.identity.runId) {
      throw new Error("Binance market workflowRunId must match execution context");
    }
    assertTimestamp(input.captureAt, "Binance market captureAt");
    for (const [label, value] of [
      ["symbolsDigest", input.symbolsDigest],
      ["candlesDigest", input.candlesDigest],
      ["referencesDigest", input.referencesDigest]
    ] as const) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
        throw new Error(`Binance market ${label} is invalid`);
      }
    }
    assertJsonCompatible(input.symbolsPayload, "Binance symbols payload");
    assertJsonCompatible(input.candlesPayload, "Binance candles payload");
    assertJsonCompatible(input.referencesPayload, "Binance references payload");
    return this.#db.transaction(() => {
      this.#assertActiveOperationalExecutionContext(
        input.workflowRunId,
        input.executionContext
      );
      this.#assertActiveTriggerOwnership(input.workflowRunId);
      const existing = this.getBinanceMarketCapture(input.marketCaptureId);
      if (existing) {
        return {
          status: "duplicate" as const,
          capture: existing,
          insertedCandleCount: 0,
          insertedFundingCount: 0
        };
      }
      this.#db.prepare(
        `INSERT INTO binance_market_captures(
          market_capture_id,workflow_run_id,capture_at,source_url,
          symbols_payload_json,symbols_digest,candles_payload_json,
          candles_digest,references_payload_json,references_digest,
          symbol_count,candle_count,funding_count,reference_count,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.marketCaptureId,
        input.workflowRunId,
        input.captureAt,
        input.sourceUrl,
        json(input.symbolsPayload),
        input.symbolsDigest,
        json(input.candlesPayload),
        input.candlesDigest,
        json(input.referencesPayload),
        input.referencesDigest,
        input.symbols.length,
        input.candles.length,
        input.funding.length,
        input.references.length,
        this.#clock().toISOString()
      );
      const symbolStatement = this.#db.prepare(
        `INSERT INTO binance_market_symbol_snapshots(
          market_capture_id,symbol,pair,contract_type,status,onboard_date_utc,
          delivery_date_utc,base_asset,quote_asset,margin_asset
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      for (const symbol of input.symbols) {
        symbolStatement.run(
          input.marketCaptureId,
          symbol.symbol,
          symbol.pair,
          symbol.contractType,
          symbol.status,
          symbol.onboardDateUtc ?? null,
          symbol.deliveryDateUtc ?? null,
          symbol.baseAsset,
          symbol.quoteAsset,
          symbol.marginAsset
        );
      }
      const candleExists = this.#db.prepare(
        `SELECT 1 FROM binance_market_candles_1m
         WHERE symbol=? AND open_time_utc=?`
      );
      const candleStatement = this.#db.prepare(
        `INSERT INTO binance_market_candles_1m(
          symbol,open_time_utc,close_time_utc,open,high,low,close,volume,
          quote_volume,trade_count,first_market_capture_id,
          last_market_capture_id,first_seen_at,last_seen_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol,open_time_utc) DO UPDATE SET
          close_time_utc=excluded.close_time_utc,open=excluded.open,
          high=excluded.high,low=excluded.low,close=excluded.close,
          volume=excluded.volume,quote_volume=excluded.quote_volume,
          trade_count=excluded.trade_count,
          last_market_capture_id=excluded.last_market_capture_id,
          last_seen_at=excluded.last_seen_at`
      );
      let insertedCandleCount = 0;
      for (const candle of input.candles) {
        if (!candleExists.get(candle.symbol, candle.openTimeUtc)) {
          insertedCandleCount += 1;
        }
        candleStatement.run(
          candle.symbol,
          candle.openTimeUtc,
          candle.closeTimeUtc,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.quoteVolume,
          candle.tradeCount,
          input.marketCaptureId,
          input.marketCaptureId,
          input.captureAt,
          input.captureAt
        );
      }
      const fundingExists = this.#db.prepare(
        `SELECT 1 FROM binance_market_funding_rates
         WHERE symbol=? AND funding_time_utc=?`
      );
      const fundingStatement = this.#db.prepare(
        `INSERT INTO binance_market_funding_rates(
          symbol,funding_time_utc,funding_rate,mark_price,
          first_market_capture_id,last_market_capture_id,first_seen_at,last_seen_at
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol,funding_time_utc) DO UPDATE SET
          funding_rate=excluded.funding_rate,mark_price=excluded.mark_price,
          last_market_capture_id=excluded.last_market_capture_id,
          last_seen_at=excluded.last_seen_at`
      );
      let insertedFundingCount = 0;
      for (const funding of input.funding) {
        if (!fundingExists.get(funding.symbol, funding.fundingTimeUtc)) {
          insertedFundingCount += 1;
        }
        fundingStatement.run(
          funding.symbol,
          funding.fundingTimeUtc,
          funding.fundingRate,
          funding.markPrice ?? null,
          input.marketCaptureId,
          input.marketCaptureId,
          input.captureAt,
          input.captureAt
        );
      }
      const referenceStatement = this.#db.prepare(
        `INSERT INTO binance_market_reference_snapshots(
          market_capture_id,symbol,mark_price,index_price,last_funding_rate,
          next_funding_time_utc,open_interest,observed_at
        ) VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const reference of input.references) {
        referenceStatement.run(
          input.marketCaptureId,
          reference.symbol,
          reference.markPrice,
          reference.indexPrice,
          reference.lastFundingRate,
          reference.nextFundingTimeUtc ?? null,
          reference.openInterest ?? null,
          reference.observedAt
        );
      }
      return {
        status: "accepted" as const,
        capture: this.getBinanceMarketCapture(input.marketCaptureId)!,
        insertedCandleCount,
        insertedFundingCount
      };
    })();
  }

  getBinanceMarketCapture(
    marketCaptureId: string
  ): BinanceMarketCaptureRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM binance_market_captures WHERE market_capture_id=?"
    ).get(marketCaptureId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      marketCaptureId: String(row.market_capture_id),
      workflowRunId: String(row.workflow_run_id),
      captureAt: String(row.capture_at),
      sourceUrl: String(row.source_url),
      symbolCount: Number(row.symbol_count),
      candleCount: Number(row.candle_count),
      fundingCount: Number(row.funding_count),
      referenceCount: Number(row.reference_count),
      createdAt: String(row.created_at)
    };
  }

  getOperationalBusinessContext(
    runId: string,
    businessTimeZone: string
  ): { businessDate: string; anchorAt: string } {
    const anchorAt = this.#operationalBusinessAnchor(runId);
    return {
      businessDate: businessDateAt(anchorAt, businessTimeZone),
      anchorAt
    };
  }

  prepareOperationalDatasetPublication(input: {
    publicationIntentId: string;
    runId: string;
    stagingId: string;
    dataset: DatasetVersionDefinition;
    factKeys: readonly string[];
    audit: AuditRecord;
    quality: "complete" | "partial";
    coverage: OperationalDatasetCoverage;
    executionContext: OperationalExecutionContext;
    preparedAt: string;
  }): PreparedOperationalDatasetPublication {
    assertAuthoringId(
      input.publicationIntentId,
      "operational Dataset publicationIntentId"
    );
    if (input.executionContext.identity.runId !== input.runId) {
      throw new Error("Dataset publication intent belongs to a different Run");
    }
    assertTimestamp(input.preparedAt, "dataset publication preparedAt");
    assertTimestamp(input.audit.occurredAt, "dataset publication audit time");
    assertSemver(input.dataset.metadata.version, "Dataset version");
    assertSchema(
      validateDataset(input.dataset),
      validateDataset.errors,
      "Operational Dataset"
    );
    if (input.factKeys.length === 0) {
      throw new Error("Operational Dataset requires at least one fact");
    }
    const distinctFactKeys = new Set(input.factKeys);
    if (distinctFactKeys.size !== input.factKeys.length) {
      throw new Error("Operational Dataset factKeys must be unique");
    }
    return this.#db.transaction(() => {
      this.#assertActiveOperationalExecutionContext(
        input.runId,
        input.executionContext
      );
      this.#assertActiveTriggerOwnership(input.runId);
      const facts = input.factKeys.map((factKey) => {
        const fact = this.getOperationalFact(factKey);
        if (!fact || fact.runId !== input.runId) {
          throw new Error(
            `Operational Dataset fact does not belong to Run ${input.runId}: ${factKey}`
          );
        }
        return fact;
      });
      const records = facts.map((fact) => fact.record);
      const businessDates = new Set(facts.map((fact) => fact.businessDate));
      const namespaces = new Set(facts.map((fact) => fact.namespace));
      const timeZones = new Set(facts.map((fact) => fact.businessTimeZone));
      const schemaVersions = new Set(facts.map((fact) => fact.schemaVersion));
      if (
        businessDates.size !== 1 ||
        namespaces.size !== 1 ||
        timeZones.size !== 1 ||
        schemaVersions.size !== 1
      ) {
        throw new Error(
          "Operational Dataset facts must share namespace, businessDate, time zone and schemaVersion"
        );
      }
      const businessDate = facts[0]!.businessDate;
      assertOperationalCoverage(
        input.quality,
        input.coverage,
        facts.length
      );
      if (
        input.dataset.recordCount !== records.length ||
        input.dataset.recordsDigest !== digest(records)
      ) {
        throw new Error(
          "Operational Dataset count or digest does not match selected facts"
        );
      }
      const expectedStaging: DatasetStagingRecord = {
        stagingId: input.stagingId,
        profileId: input.dataset.profile.id,
        profileVersion: input.dataset.profile.version,
        sourceDigest: input.dataset.source.digest,
        state: "validated",
        validationReport: {
          valid: true,
          source: "operational-facts",
          runId: input.runId,
          businessDate,
          quality: input.quality,
          coverage: { ...input.coverage },
          factCount: facts.length,
          recordsDigest: input.dataset.recordsDigest
        },
        createdAt: input.preparedAt,
        updatedAt: input.preparedAt
      };
      const staging = this.getDatasetStaging(input.stagingId);
      if (!staging) {
        this.stageDataset(expectedStaging);
      } else if (
        canonicalJson(staging) !== canonicalJson(expectedStaging)
      ) {
        throw new OperationalFactConflictError(
          `Dataset staging ${input.stagingId} has different content`
        );
      }
      this.#inject("operational_dataset_prepare.after_staging");
      const existing = this.getPreparedOperationalDatasetPublication(
        input.runId
      );
      if (existing) {
        if (
          existing.publicationIntentId !== input.publicationIntentId ||
          existing.stagingId !== input.stagingId ||
          canonicalJson(existing.dataset) !== canonicalJson(input.dataset) ||
          canonicalJson(existing.factKeys) !== canonicalJson(input.factKeys) ||
          canonicalJson(existing.audit) !== canonicalJson(input.audit) ||
          existing.quality !== input.quality ||
          canonicalJson(existing.coverage) !== canonicalJson(input.coverage)
        ) {
          throw new OperationalFactConflictError(
            `Run ${input.runId} already has a different Dataset publication intent`
          );
        }
        return existing;
      }
      this.#db
        .prepare(
          `INSERT INTO operational_dataset_publication_intents(
            run_id, publication_intent_id, staging_id, dataset_id,
            dataset_version, dataset_json, audit_json, quality,
            business_date, coverage_json, invocation_id,
            execution_context_json, prepared_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.runId,
          input.publicationIntentId,
          input.stagingId,
          input.dataset.metadata.id,
          input.dataset.metadata.version,
          json(input.dataset),
          json(input.audit),
          input.quality,
          businessDate,
          json(input.coverage),
          input.executionContext.invocationId,
          json(input.executionContext),
          input.preparedAt
        );
      const insertFact = this.#db.prepare(
        `INSERT INTO operational_dataset_publication_intent_facts(
          run_id, fact_key, ordinal
        ) VALUES (?, ?, ?)`
      );
      input.factKeys.forEach((factKey, ordinal) => {
        insertFact.run(input.runId, factKey, ordinal);
      });
      this.#inject("operational_dataset_prepare.after_intent");
      return this.getPreparedOperationalDatasetPublication(input.runId)!;
    })();
  }

  getPreparedOperationalDatasetPublication(
    runId: string
  ): PreparedOperationalDatasetPublication | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM operational_dataset_publication_intents WHERE run_id = ?"
      )
      .get(runId) as SqlRow | undefined;
    if (!row) return undefined;
    const factRows = this.#db
      .prepare(
        `SELECT fact_key
         FROM operational_dataset_publication_intent_facts
         WHERE run_id = ? ORDER BY ordinal`
      )
      .all(runId) as Array<{ fact_key: string }>;
    return {
      publicationIntentId: String(row.publication_intent_id),
      runId,
      stagingId: String(row.staging_id),
      dataset: parseJson(row.dataset_json) as DatasetVersionDefinition,
      factKeys: factRows.map((fact) => fact.fact_key),
      audit: parseJson(row.audit_json) as AuditRecord,
      quality: row.quality as "complete" | "partial",
      businessDate: String(row.business_date),
      coverage: parseJson(row.coverage_json) as OperationalDatasetCoverage,
      preparedBy: parseJson(
        row.execution_context_json
      ) as OperationalExecutionContext,
      preparedAt: String(row.prepared_at)
    };
  }

  getOperationalDatasetPublicationLineage(
    datasetId: string,
    datasetVersion: string
  ): OperationalDatasetPublicationLineage | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM operational_dataset_publication_lineage
         WHERE dataset_id = ? AND dataset_version = ?`
      )
      .get(datasetId, datasetVersion) as SqlRow | undefined;
    if (!row) return undefined;
    const facts = this.#db
      .prepare(
        `SELECT fact_key FROM operational_dataset_publication_facts
         WHERE dataset_id = ? AND dataset_version = ? ORDER BY ordinal`
      )
      .all(datasetId, datasetVersion) as Array<{ fact_key: string }>;
    return {
      runId: String(row.run_id),
      datasetId,
      datasetVersion,
      terminalStatus: row.terminal_status as "succeeded" | "uncertain",
      quality: row.quality as "complete" | "partial",
      businessDate: String(row.business_date),
      coverage: parseJson(row.coverage_json) as OperationalDatasetCoverage,
      factKeys: facts.map((fact) => fact.fact_key),
      publishedAt: String(row.published_at)
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

  listRuntimeInvocationsForRun(runId: string): RuntimeInvocationOutboxRecord[] {
    assertAuthoringId(runId, "runId");
    const rows = this.#db
      .prepare(
        `SELECT id,payload_json,created_at,acknowledged_at
         FROM engine_outbox
         WHERE topic='runtime.invoke'
           AND json_extract(payload_json,'$.kind')='runtime.invoke'
           AND json_extract(payload_json,'$.invocation.identity.runId')=?
         ORDER BY created_at,id`
      )
      .all(runId) as SqlRow[];
    return rows.map((row) => {
      const payload = parseJson(row.payload_json) as {
        invocation?: unknown;
      };
      if (!payload || typeof payload !== "object" ||
        payload.invocation === undefined) {
        throw new Error("Runtime invocation outbox payload is invalid");
      }
      assertJsonCompatible(payload.invocation, "runtime invocation");
      return {
        outboxId:String(row.id),
        invocation:payload.invocation as JsonValue,
        createdAt:String(row.created_at),
        ...(row.acknowledged_at == null
          ? {}
          : { acknowledgedAt:String(row.acknowledged_at) })
      };
    });
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
               SET extension_version = ?,
                   protocol_version = ?,
                   last_seq = ?,
                   outgoing_seq = ?,
                   last_acked_command_seq = ?,
                   resume_token_digest = ?,
                   resume_token_expires_at = ?,
                   connected_at = ?,
                   disconnected_at = NULL
               WHERE id = ?`
            )
            .run(
              input.session.extensionVersion,
              input.session.protocolVersion,
              input.session.incomingSeq,
              input.session.outgoingSeq,
              resumedFrom.lastAckedCommandSeq,
              input.session.resumeTokenDigest,
              input.session.resumeTokenExpiresAt,
              input.session.connectedAt,
              resumedFrom.id
            );
          return {
            session: this.#getBrowserSession(resumedFrom.id)!,
            resumedFrom
          };
        }
      }
      const session = input.session;
      this.#db
        .prepare(
          `INSERT INTO browser_sessions(
            id, browser_instance_id, extension_id, extension_version,
            protocol_version, last_seq, outgoing_seq, last_acked_command_seq,
            capability_digest, resume_token_digest, resume_token_expires_at,
            connected_at, disconnected_at, observation_revision,
            session_role, observed_origin, observed_authentication,
            observation_state, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          session.disconnectedAt ?? null,
          0,
          null,
          null,
          null,
          "unknown",
          null
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
    return this.#db.transaction(() => {
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
      if (input.disconnectedAt && !current.disconnectedAt) {
        const active = this.#db.prepare(
          `SELECT * FROM recovery_sessions
           WHERE browser_session_id = ? AND state IN ('issued', 'active')
           ORDER BY recovery_session_id`
        ).all(input.id) as SqlRow[];
        for (const row of active) {
          const recovery = this.#readRecoverySession(row);
          this.terminateRecoverySession({
            id: recovery.id,
            expectedRevision: recovery.revision,
            nextState: "invalidated",
            actor: "system:browser-disconnect",
            occurredAt: input.disconnectedAt,
            reason: "RECOVERY_BROWSER_DISCONNECTED"
          });
        }
      }
      return this.#getBrowserSession(input.id)!;
    })();
  }

  getBrowserSession(id: string): BrowserSessionRecord | undefined {
    return this.#getBrowserSession(id);
  }

  listBrowserSessions(input: {
    limit: number;
    role?: BrowserSessionRole;
    observationState?: BrowserSessionObservationState;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<BrowserSessionRecord> {
    this.#assertLineageLimit(input.limit);
    this.#assertLineageCursor(input.cursor);
    const rows = this.#db
      .prepare(
        `SELECT * FROM browser_sessions
         WHERE (? IS NULL OR session_role = ?)
           AND (? IS NULL OR observation_state = ?)
           AND (
             ? IS NULL OR connected_at > ?
             OR (connected_at = ? AND id > ?)
           )
         ORDER BY connected_at, id LIMIT ?`
      )
      .all(
        input.role ?? null,
        input.role ?? null,
        input.observationState ?? null,
        input.observationState ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit + 1
      ) as SqlRow[];
    return this.#lineagePage(
      rows,
      input.limit,
      (row) => this.#readBrowserSession(row),
      (row) => ({
        createdAt: String(row.connected_at),
        id: String(row.id)
      })
    );
  }

  updateBrowserSessionObservation(input: {
    id: string;
    expectedRevision: number;
    role: BrowserSessionRole;
    observedOrigin?: string;
    observedAuthentication?: ResourceAuthentication;
    observationState: BrowserSessionObservationState;
    observedAt: string;
  }): BrowserSessionRecord {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(Date.parse(input.observedAt))
    ) {
      throw new Error("Browser Session observation revision or time is invalid");
    }
    if (input.observedOrigin !== undefined) {
      const parsed = new URL(input.observedOrigin);
      if (
        parsed.protocol !== "https:" ||
        parsed.origin !== input.observedOrigin
      ) {
        throw new Error(
          "Browser Session observedOrigin must be an exact HTTPS Origin"
        );
      }
    }
    if (
      input.observationState === "available" &&
      (input.observedOrigin === undefined ||
        input.observedAuthentication === undefined)
    ) {
      throw new Error(
        "An available Browser Session requires Origin and authentication"
      );
    }
    const current = this.#getBrowserSession(input.id);
    if (!current) {
      throw new Error(`Browser session not found: ${input.id}`);
    }
    if (
      current.observationState === "revoked" &&
      input.observationState !== "revoked"
    ) {
      throw new RevisionConflictError(
        "A revoked Browser Session observation is terminal"
      );
    }
    const result = this.#db
      .prepare(
        `UPDATE browser_sessions
         SET observation_revision = observation_revision + 1,
             session_role = ?, observed_origin = ?,
             observed_authentication = ?, observation_state = ?,
             observed_at = ?
         WHERE id = ? AND observation_revision = ?`
      )
      .run(
        input.role,
        input.observedOrigin ?? null,
        input.observedAuthentication ?? null,
        input.observationState,
        input.observedAt,
        input.id,
        input.expectedRevision
      );
    if (result.changes !== 1) {
      throw new RevisionConflictError(
        `Browser Session ${input.id} observation revision changed`
      );
    }
    return this.#getBrowserSession(input.id)!;
  }

  upsertBrowserPageObservation(
    input: BrowserPageObservationRecord
  ): BrowserPageObservationRecord {
    if (
      !Number.isSafeInteger(input.tabId) ||
      input.tabId < 0 ||
      (input.windowId !== undefined &&
        (!Number.isSafeInteger(input.windowId) || input.windowId < 0)) ||
      !Number.isFinite(Date.parse(input.observedAt)) ||
      !input.pathname.startsWith("/") ||
      !input.pageEpoch.trim() ||
      !input.observerCapabilityId.trim() ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    ) {
      throw new Error("Browser page observation is invalid");
    }
    const session = this.#getBrowserSession(input.sessionId);
    if (
      !session ||
      session.browserInstanceId !== input.browserInstanceId
    ) {
      throw new Error("Browser page observation Session does not match");
    }
    const parsedOrigin = new URL(input.origin);
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.origin !== input.origin
    ) {
      throw new Error("Browser page observation Origin must be exact HTTPS");
    }
    if (
      input.observationState === "ready" &&
      !input.contentScriptReady
    ) {
      throw new Error(
        "A ready browser page requires ready content"
      );
    }
    if (
      ["authenticated", "membership"].includes(input.authentication) &&
      !input.authenticationContextRef
    ) {
      throw new Error(
        "Authenticated browser pages require an authentication context"
      );
    }
    const current = this.getBrowserPageObservation(input.sessionId, input.tabId);
    if (
      current &&
      Date.parse(input.observedAt) < Date.parse(current.observedAt)
    ) {
      return current;
    }
    if (current && input.revision < current.revision) return current;
    if (
      current &&
      input.revision === current.revision &&
      (current.browserInstanceId !== input.browserInstanceId ||
        current.windowId !== input.windowId ||
        current.origin !== input.origin ||
        current.pathname !== input.pathname ||
        current.contentScriptReady !== input.contentScriptReady ||
        current.authentication !== input.authentication ||
        current.authenticationContextRef !==
          input.authenticationContextRef ||
        current.observationState !== input.observationState ||
        current.pageEpoch !== input.pageEpoch ||
        current.observerCapabilityId !== input.observerCapabilityId ||
        current.reasonCode !== input.reasonCode)
    ) {
      throw new RevisionConflictError(
        "Browser page observation changed without a new revision"
      );
    }
    this.#db
      .prepare(
        `INSERT INTO browser_page_observations(
           session_id, browser_instance_id, tab_id, window_id, origin, pathname,
           content_script_ready, authentication, authentication_context_ref,
           observation_state, page_epoch, observer_capability_id, revision,
           observed_at, reason_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, tab_id) DO UPDATE SET
           browser_instance_id = excluded.browser_instance_id,
           window_id = excluded.window_id,
           origin = excluded.origin,
           pathname = excluded.pathname,
           content_script_ready = excluded.content_script_ready,
           authentication = excluded.authentication,
           authentication_context_ref = excluded.authentication_context_ref,
           observation_state = excluded.observation_state,
           page_epoch = excluded.page_epoch,
           observer_capability_id = excluded.observer_capability_id,
           revision = excluded.revision,
           observed_at = excluded.observed_at,
           reason_code = excluded.reason_code`
      )
      .run(
        input.sessionId,
        input.browserInstanceId,
        input.tabId,
        input.windowId ?? null,
        input.origin,
        input.pathname,
        input.contentScriptReady ? 1 : 0,
        input.authentication,
        input.authenticationContextRef ?? null,
        input.observationState,
        input.pageEpoch,
        input.observerCapabilityId,
        input.revision,
        input.observedAt,
        input.reasonCode ?? null
      );
    return this.getBrowserPageObservation(input.sessionId, input.tabId)!;
  }

  getBrowserPageObservation(
    sessionId: string,
    tabId: number
  ): BrowserPageObservationRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM browser_page_observations WHERE session_id = ? AND tab_id = ?"
      )
      .get(sessionId, tabId) as SqlRow | undefined;
    return row ? this.#readBrowserPageObservation(row) : undefined;
  }

  listBrowserPageObservations(input: {
    limit: number;
    sessionId?: string;
    browserInstanceId?: string;
  }): BrowserPageObservationRecord[] {
    this.#assertLineageLimit(input.limit);
    return (
      this.#db
        .prepare(
          `SELECT * FROM browser_page_observations
           WHERE (? IS NULL OR session_id = ?)
             AND (? IS NULL OR browser_instance_id = ?)
           ORDER BY observed_at DESC, session_id, tab_id
           LIMIT ?`
        )
        .all(
          input.sessionId ?? null,
          input.sessionId ?? null,
          input.browserInstanceId ?? null,
          input.browserInstanceId ?? null,
          input.limit
        ) as SqlRow[]
    ).map((row) => this.#readBrowserPageObservation(row));
  }

  invalidateBrowserPageObservations(input: {
    sessionId: string;
    observedAt: string;
    reasonCode: string;
  }): number {
    if (!Number.isFinite(Date.parse(input.observedAt))) {
      throw new Error("Browser page invalidation time is invalid");
    }
    return this.#db
      .prepare(
        `UPDATE browser_page_observations
         SET observation_state = 'stale',
             authentication = 'unknown',
             authentication_context_ref = NULL,
             content_script_ready = 0,
             revision = revision + 1,
             observed_at = ?,
             reason_code = ?
         WHERE session_id = ? AND observation_state <> 'stale'`
      )
      .run(input.observedAt, input.reasonCode, input.sessionId).changes;
  }

  resetBrowserPageObservations(sessionId: string): number {
    if (!sessionId.trim()) {
      throw new Error("Browser Session identity is required");
    }
    return this.#db
      .prepare("DELETE FROM browser_page_observations WHERE session_id = ?")
      .run(sessionId).changes;
  }

  pruneBrowserPageObservations(input: {
    observedBefore: string;
  }): number {
    if (!Number.isFinite(Date.parse(input.observedBefore))) {
      throw new Error("Browser page observation retention time is invalid");
    }
    return this.#db
      .prepare(
        `DELETE FROM browser_page_observations
         WHERE observed_at < ?
           AND observation_state IN ('departed', 'stale')`
      )
      .run(input.observedBefore).changes;
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
          session_id, node_id, node_version, risk_level, permissions_json,
          routes_json, adapter_id, adapter_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const capability of capabilities) {
        insert.run(
          sessionId,
          capability.nodeId,
          capability.nodeVersion,
          capability.riskLevel,
          json(capability.permissions),
          json(capability.routes ?? []),
          capability.adapterId ?? null,
          capability.adapterVersion ?? null
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
      permissions: parseJson(row.permissions_json) as string[],
      routes: parseJson(row.routes_json) as NonNullable<
        BrowserCapabilityRecord["routes"]
      >,
      ...(row.adapter_id == null
        ? {}
        : { adapterId: String(row.adapter_id) }),
      ...(row.adapter_version == null
        ? {}
        : { adapterVersion: String(row.adapter_version) })
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
         FROM export_record_assets era
         WHERE era.asset_id = ?
         UNION ALL
         SELECT 1
         FROM asset_derivations ad
         LEFT JOIN asset_deletions deleted ON deleted.asset_id = ad.asset_id
         WHERE ad.parent_asset_id = ? AND deleted.asset_id IS NULL
         LIMIT 1`
      )
      .get(input.assetId, input.assetId, input.assetId);
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
           SELECT 1 FROM export_record_assets WHERE asset_id = ?
           UNION ALL
           SELECT 1 FROM asset_derivations ad
           LEFT JOIN asset_deletions d ON d.asset_id = ad.asset_id
           WHERE ad.parent_asset_id = ? AND d.asset_id IS NULL
           LIMIT 1`
        )
        .get(input.assetId, input.assetId, input.assetId);
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

  listEvidenceTransfersForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<EvidenceTransferRecord> {
    this.#assertLineageLimit(input.limit);
    this.#assertLineageCursor(input.cursor);
    const rows = (input.cursor
      ? this.#db
          .prepare(
            `SELECT * FROM evidence_transfers
             WHERE run_id = ? AND (
               created_at > ? OR (created_at = ? AND evidence_id > ?)
             )
             ORDER BY created_at, evidence_id LIMIT ?`
          )
          .all(
            input.runId,
            input.cursor.createdAt,
            input.cursor.createdAt,
            input.cursor.id,
            input.limit + 1
          )
      : this.#db
          .prepare(
            `SELECT * FROM evidence_transfers
             WHERE run_id = ?
             ORDER BY created_at, evidence_id LIMIT ?`
          )
          .all(input.runId, input.limit + 1)) as SqlRow[];
    return this.#lineagePage(
      rows,
      input.limit,
      (row) => this.#readEvidenceTransfer(row),
      (row) => ({
        createdAt: String(row.created_at),
        id: String(row.evidence_id)
      })
    );
  }

  listEvidenceLinksForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<EvidenceLinkDefinition> {
    this.#assertLineageLimit(input.limit);
    this.#assertLineageCursor(input.cursor);
    const rows = (input.cursor
      ? this.#db
          .prepare(
            `SELECT * FROM evidence_links
             WHERE run_id = ? AND (
               created_at > ? OR (created_at = ? AND link_id > ?)
             )
             ORDER BY created_at, link_id LIMIT ?`
          )
          .all(
            input.runId,
            input.cursor.createdAt,
            input.cursor.createdAt,
            input.cursor.id,
            input.limit + 1
          )
      : this.#db
          .prepare(
            `SELECT * FROM evidence_links
             WHERE run_id = ?
             ORDER BY created_at, link_id LIMIT ?`
          )
          .all(input.runId, input.limit + 1)) as SqlRow[];
    return this.#lineagePage(
      rows,
      input.limit,
      (row) =>
        parseJson(row.canonical_json) as EvidenceLinkDefinition,
      (row) => ({
        createdAt: String(row.created_at),
        id: String(row.link_id)
      })
    );
  }

  listSourceRecordsForRun(input: {
    runId: string;
    limit: number;
    afterSourceId?: string;
  }): {
    records: readonly SourceRecordDefinition[];
    nextSourceId?: string;
  } {
    this.#assertLineageLimit(input.limit);
    this.#assertAfterId(input.afterSourceId);
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT sources.source_id, sources.canonical_json
         FROM source_records sources
         INNER JOIN evidence_link_sources linked
           ON linked.source_id = sources.source_id
         INNER JOIN evidence_links links ON links.link_id = linked.link_id
         WHERE links.run_id = ? AND sources.source_id > ?
         ORDER BY sources.source_id LIMIT ?`
      )
      .all(
        input.runId,
        input.afterSourceId ?? "",
        input.limit + 1
      ) as Array<{ source_id: string; canonical_json: string }>;
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    return {
      records: selected.map(
        (row) => parseJson(row.canonical_json) as SourceRecordDefinition
      ),
      ...(hasMore
        ? { nextSourceId: selected.at(-1)!.source_id }
        : {})
    };
  }

  listAssetRecordsForRun(input: {
    runId: string;
    limit: number;
    afterAssetId?: string;
  }): {
    records: readonly AssetRecordDefinition[];
    nextAssetId?: string;
  } {
    this.#assertLineageLimit(input.limit);
    this.#assertAfterId(input.afterAssetId);
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT assets.asset_id, assets.canonical_json
         FROM asset_records assets
         INNER JOIN evidence_link_assets linked
           ON linked.asset_id = assets.asset_id
         INNER JOIN evidence_links links ON links.link_id = linked.link_id
         LEFT JOIN asset_deletions deleted
           ON deleted.asset_id = assets.asset_id
         WHERE links.run_id = ? AND assets.asset_id > ?
           AND deleted.asset_id IS NULL
         ORDER BY assets.asset_id LIMIT ?`
      )
      .all(
        input.runId,
        input.afterAssetId ?? "",
        input.limit + 1
      ) as Array<{ asset_id: string; canonical_json: string }>;
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    return {
      records: selected.map(
        (row) => parseJson(row.canonical_json) as AssetRecordDefinition
      ),
      ...(hasMore ? { nextAssetId: selected.at(-1)!.asset_id } : {})
    };
  }

  getSourceRecords(
    sourceIds: readonly string[]
  ): SourceRecordDefinition[] {
    const ids = this.#boundedUniqueIds(sourceIds);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.#db
        .prepare(
          `SELECT canonical_json FROM source_records
           WHERE source_id IN (${placeholders}) ORDER BY source_id`
        )
        .all(...ids) as Array<{ canonical_json: string }>
    ).map(
      (row) => parseJson(row.canonical_json) as SourceRecordDefinition
    );
  }

  getAssetRecords(assetIds: readonly string[]): AssetRecordDefinition[] {
    const ids = this.#boundedUniqueIds(assetIds);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.#db
        .prepare(
          `SELECT assets.canonical_json
           FROM asset_records assets
           LEFT JOIN asset_deletions deleted
             ON deleted.asset_id = assets.asset_id
           WHERE assets.asset_id IN (${placeholders})
             AND deleted.asset_id IS NULL
           ORDER BY assets.asset_id`
        )
        .all(...ids) as Array<{ canonical_json: string }>
    ).map(
      (row) => parseJson(row.canonical_json) as AssetRecordDefinition
    );
  }

  putExportRecord(
    record: ExportRecord
  ): { status: "accepted" | "duplicate"; record: ExportRecord } {
    const existing = this.getExportRecord(record.exportId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new EvidenceConflictError(
          `ExportRecord identity conflict: ${record.exportId}`
        );
      }
      return { status: "duplicate", record: existing };
    }
    if (
      !record.exportId.trim() ||
      !this.getRun(record.runId) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      record.assetIds.length > 100 ||
      new Set(record.assetIds).size !== record.assetIds.length ||
      (record.status !== "failed" && record.assetIds.length < 1)
    ) {
      throw new EvidenceConflictError("Invalid ExportRecord metadata");
    }
    assertJsonCompatible(record.metadata, "ExportRecord metadata");
    if (Buffer.byteLength(json(record.metadata), "utf8") > 32 * 1024) {
      throw new EvidenceConflictError(
        "ExportRecord metadata exceeds 32 KiB"
      );
    }
    this.#assertExportMetadata(record.metadata);
    for (const assetId of record.assetIds) {
      if (!this.getAssetRecord(assetId)) {
        throw new EvidenceConflictError(
          `ExportRecord references an unknown Asset: ${assetId}`
        );
      }
    }
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO export_records(
            export_id, run_id, export_type, status, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.exportId,
          record.runId,
          record.exportType,
          record.status,
          json(record.metadata),
          record.createdAt
        );
      const statement = this.#db.prepare(
        `INSERT INTO export_record_assets(export_id, ordinal, asset_id)
         VALUES (?, ?, ?)`
      );
      record.assetIds.forEach((assetId, ordinal) =>
        statement.run(record.exportId, ordinal, assetId)
      );
      this.#inject("export.after_record");
    }).immediate();
    return {
      status: "accepted",
      record: this.getExportRecord(record.exportId)!
    };
  }

  getExportRecord(exportId: string): ExportRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM export_records WHERE export_id = ?")
      .get(exportId) as SqlRow | undefined;
    return row ? this.#readExportRecord(row) : undefined;
  }

  listExportRecordsForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<ExportRecord> {
    this.#assertLineageLimit(input.limit);
    this.#assertLineageCursor(input.cursor);
    const rows = (input.cursor
      ? this.#db
          .prepare(
            `SELECT * FROM export_records
             WHERE run_id = ? AND (
               created_at > ? OR (created_at = ? AND export_id > ?)
             )
             ORDER BY created_at, export_id LIMIT ?`
          )
          .all(
            input.runId,
            input.cursor.createdAt,
            input.cursor.createdAt,
            input.cursor.id,
            input.limit + 1
          )
      : this.#db
          .prepare(
            `SELECT * FROM export_records
             WHERE run_id = ? ORDER BY created_at, export_id LIMIT ?`
          )
          .all(input.runId, input.limit + 1)) as SqlRow[];
    return this.#lineagePage(
      rows,
      input.limit,
      (row) => this.#readExportRecord(row),
      (row) => ({
        createdAt: String(row.created_at),
        id: String(row.export_id)
      })
    );
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

  putTriggerSpec(input: {
    spec: TriggerSpecDefinition;
    actor: string;
    occurredAt: string;
  }): TriggerSpecRecord {
    const current = this.getTriggerSpec(input.spec.id);
    if (current && current.spec.version === input.spec.version) {
      if (canonicalJson(current.spec) !== canonicalJson(input.spec)) {
        throw new ArtifactConflictError(
          `Trigger identity conflict: ${input.spec.id}@${input.spec.version}`
        );
      }
      return current;
    }
    return this.#db.transaction(() => {
      const existingVersion = this.getTriggerSpecVersion(
        input.spec.id,
        input.spec.version
      );
      if (
        existingVersion &&
        canonicalJson(existingVersion) !== canonicalJson(input.spec)
      ) {
        throw new ArtifactConflictError(
          `Trigger identity conflict: ${input.spec.id}@${input.spec.version}`
        );
      }
      const revision = (current?.revision ?? 0) + 1;
      this.#db.prepare(
        `INSERT INTO trigger_spec_versions(
          trigger_id,trigger_version,spec_json,created_at,created_by
        ) VALUES (?,?,?,?,?)
        ON CONFLICT(trigger_id,trigger_version) DO NOTHING`
      ).run(
        input.spec.id,input.spec.version,json(input.spec),input.occurredAt,input.actor
      );
      this.#db.prepare(
        `INSERT INTO trigger_specs(
          trigger_id,trigger_version,revision,enabled,spec_json,
          created_at,updated_at,created_by,updated_by
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(trigger_id) DO UPDATE SET
          trigger_version=excluded.trigger_version,
          revision=excluded.revision,
          enabled=excluded.enabled,
          spec_json=excluded.spec_json,
          updated_at=excluded.updated_at,
          updated_by=excluded.updated_by`
      ).run(
        input.spec.id,input.spec.version,revision,input.spec.enabled ? 1 : 0,
        json(input.spec),current?.createdAt ?? input.occurredAt,input.occurredAt,
        current?.createdBy ?? input.actor,input.actor
      );
      this.#insertAuditRecord({
        id:this.#idFactory(),action:"trigger.spec.put",actor:input.actor,
        target:`trigger:${input.spec.id}`,
        detail:{ version:input.spec.version,revision,enabled:input.spec.enabled },
        occurredAt:input.occurredAt
      });
      return this.getTriggerSpec(input.spec.id)!;
    })();
  }

  setTriggerEnabled(input: {
    id: string;
    expectedRevision: number;
    enabled: boolean;
    actor: string;
    occurredAt: string;
  }): TriggerSpecRecord {
    return this.#db.transaction(() => {
      const current = this.getTriggerSpec(input.id);
      if (!current) throw new Error(`Trigger not found: ${input.id}`);
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError("Trigger revision changed");
      }
      const nextSpec = { ...current.spec,enabled:input.enabled };
      const result = this.#db.prepare(
        `UPDATE trigger_specs SET revision=revision+1,enabled=?,spec_json=?,
           updated_at=?,updated_by=? WHERE trigger_id=? AND revision=?`
      ).run(
        input.enabled ? 1 : 0,json(nextSpec),input.occurredAt,input.actor,
        input.id,input.expectedRevision
      );
      if (result.changes !== 1) throw new RevisionConflictError("Trigger revision changed");
      this.#insertAuditRecord({
        id:this.#idFactory(),action:"trigger.spec.enable",actor:input.actor,
        target:`trigger:${input.id}`,detail:{ enabled:input.enabled },
        occurredAt:input.occurredAt
      });
      return this.getTriggerSpec(input.id)!;
    })();
  }

  getTriggerSpec(id: string): TriggerSpecRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM trigger_specs WHERE trigger_id=?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readTriggerSpec(row) : undefined;
  }

  getTriggerSpecVersion(
    id: string,
    version: string
  ): TriggerSpecDefinition | undefined {
    const row = this.#db.prepare(
      `SELECT spec_json FROM trigger_spec_versions
       WHERE trigger_id=? AND trigger_version=?`
    ).get(id,version) as SqlRow | undefined;
    return row
      ? parseJson(row.spec_json) as TriggerSpecDefinition
      : undefined;
  }

  listTriggerSpecs(): TriggerSpecRecord[] {
    return (this.#db.prepare("SELECT * FROM trigger_specs ORDER BY trigger_id").all() as SqlRow[])
      .map((row) => this.#readTriggerSpec(row));
  }

  claimTriggerOccurrence(input: TriggerOccurrenceRecord):
    | { status:"accepted";record:TriggerOccurrenceRecord }
    | { status:"duplicate";record:TriggerOccurrenceRecord } {
    if (
      input.status !== "pending" || input.attemptCount !== 0 || input.revision !== 0 ||
      input.nextAttemptAt !== undefined || input.terminalOutcome !== undefined
    ) {
      throw new Error("A new Trigger Occurrence must start pending at revision zero");
    }
    const result = this.#db.prepare(
      `INSERT INTO trigger_occurrences(
        occurrence_id,trigger_id,trigger_version,occurrence_key,scheduled_at,
        status,next_attempt_at,attempt_count,revision,terminal_outcome,
        dataset_id,dataset_version,diagnostic,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(trigger_id,trigger_version,occurrence_key) DO NOTHING`
    ).run(
      input.occurrenceId,input.triggerId,input.triggerVersion,input.occurrenceKey,
      input.scheduledAt,input.status,input.nextAttemptAt ?? null,input.attemptCount,
      input.revision,input.terminalOutcome ?? null,input.datasetId ?? null,
      input.datasetVersion ?? null,input.diagnostic ?? null,input.createdAt,input.updatedAt
    );
    if (result.changes === 1) return { status:"accepted",record:input };
    const existing = this.#db.prepare(
      `SELECT * FROM trigger_occurrences
       WHERE trigger_id=? AND trigger_version=? AND occurrence_key=?`
    ).get(input.triggerId,input.triggerVersion,input.occurrenceKey) as SqlRow;
    return { status:"duplicate",record:this.#readTriggerOccurrence(existing) };
  }

  deferTriggerOccurrence(input: {
    occurrenceId: string;
    expectedRevision: number;
    updatedAt: string;
    nextAttemptAt: string;
    diagnostic?: string;
  }): TriggerOccurrenceRecord {
    assertRevision(input.expectedRevision,"expectedRevision");
    if (!Number.isFinite(Date.parse(input.nextAttemptAt))) {
      throw new Error("Deferred Trigger Occurrence requires nextAttemptAt");
    }
    const current = this.getTriggerOccurrence(input.occurrenceId);
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("Trigger Occurrence revision changed");
    }
    const allowed =
      current.status === "pending" || current.status === "deferred";
    if (!allowed) {
      throw new Error(
        `Invalid Trigger Occurrence transition: ${current.status} -> deferred`
      );
    }
    const result = this.#db.prepare(
      `UPDATE trigger_occurrences
       SET status=?,next_attempt_at=?,terminal_outcome=?,updated_at=?,
           diagnostic=COALESCE(?,diagnostic),revision=revision+1
       WHERE occurrence_id=? AND revision=? AND status=?`
    ).run(
      "deferred",input.nextAttemptAt,null,
      input.updatedAt,input.diagnostic ?? null,input.occurrenceId,input.expectedRevision,
      current.status
    );
    if (result.changes !== 1) {
      throw new RevisionConflictError("Trigger Occurrence revision changed");
    }
    return this.getTriggerOccurrence(input.occurrenceId)!;
  }

  finishTriggerOccurrenceWithAttention(input: {
    occurrenceId: string;
    expectedRevision: number;
    outcome: "missed" | "skipped" | "blocked" | "failed";
    diagnostic?: string;
    updatedAt: string;
    attention: AttentionRecord;
  }): {
    occurrence: TriggerOccurrenceRecord;
    attention: AttentionRecord;
  } {
    assertRevision(input.expectedRevision, "expectedRevision");
    this.#assertTriggerOccurrenceAttention(
      input.attention,
      input.occurrenceId,
      input.updatedAt
    );
    return this.#db.transaction(() => {
      const current = this.getTriggerOccurrence(input.occurrenceId);
      if (!current) {
        throw new RevisionConflictError("Trigger Occurrence revision changed");
      }
      if (current.status === "terminal") {
        const existing = this.#getAttentionForTriggerOccurrence(
          input.occurrenceId
        );
        if (
          current.terminalOutcome === input.outcome &&
          current.diagnostic === input.diagnostic &&
          existing &&
          this.#sameAttentionIdentity(existing,input.attention)
        ) {
          return { occurrence: current, attention: existing };
        }
        throw new RevisionConflictError("Trigger Occurrence is already terminal");
      }
      if (
        current.revision !== input.expectedRevision ||
        (current.status !== "pending" && current.status !== "deferred")
      ) {
        throw new RevisionConflictError("Trigger Occurrence is not finishable");
      }
      const result = this.#db.prepare(
        `UPDATE trigger_occurrences
         SET status='terminal',terminal_outcome=?,next_attempt_at=NULL,
             diagnostic=?,updated_at=?,revision=revision+1
         WHERE occurrence_id=? AND revision=? AND status IN ('pending','deferred')`
      ).run(
        input.outcome,
        input.diagnostic ?? null,
        input.updatedAt,
        input.occurrenceId,
        input.expectedRevision
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError("Trigger Occurrence finish CAS failed");
      }
      this.#inject("trigger_occurrence.attention.after_occurrence");
      this.#insertAttention(input.attention);
      return {
        occurrence: this.getTriggerOccurrence(input.occurrenceId)!,
        attention: this.getAttention(input.attention.item.id)!
      };
    })();
  }

  getTriggerOccurrence(occurrenceId: string): TriggerOccurrenceRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM trigger_occurrences WHERE occurrence_id=?"
    ).get(occurrenceId) as SqlRow | undefined;
    return row ? this.#readTriggerOccurrence(row) : undefined;
  }

  listTriggerOccurrences(triggerId?: string): TriggerOccurrenceRecord[] {
    const rows = (triggerId
      ? this.#db.prepare(
          `SELECT * FROM trigger_occurrences
           WHERE trigger_id=? ORDER BY scheduled_at DESC,occurrence_id DESC LIMIT 200`
        ).all(triggerId)
      : this.#db.prepare(
          `SELECT * FROM trigger_occurrences
           ORDER BY scheduled_at DESC,occurrence_id DESC LIMIT 200`
        ).all()) as SqlRow[];
    return rows.map((row) => this.#readTriggerOccurrence(row));
  }

  listActiveTriggerOccurrences(triggerId?: string): TriggerOccurrenceRecord[] {
    const rows = (triggerId
      ? this.#db.prepare(
          `SELECT * FROM trigger_occurrences
           WHERE trigger_id=? AND status!='terminal'
           ORDER BY scheduled_at,trigger_id,occurrence_id`
        ).all(triggerId)
      : this.#db.prepare(
          `SELECT * FROM trigger_occurrences WHERE status!='terminal'
           ORDER BY scheduled_at,trigger_id,occurrence_id`
        ).all()) as SqlRow[];
    return rows.map((row) => this.#readTriggerOccurrence(row));
  }

  listRunnableTriggerOccurrences(input: {
    now: string;
    triggerId?: string;
  }): TriggerOccurrenceRecord[] {
    const rows = (input.triggerId
      ? this.#db.prepare(
          `SELECT * FROM trigger_occurrences
           WHERE trigger_id=? AND (
             status='pending' OR (status='deferred' AND next_attempt_at<=?)
           ) AND julianday(scheduled_at)<=julianday(?)
           ORDER BY scheduled_at,occurrence_id`
        ).all(input.triggerId,input.now,input.now)
      : this.#db.prepare(
          `SELECT * FROM trigger_occurrences
           WHERE (status='pending' OR (status='deferred' AND next_attempt_at<=?))
             AND julianday(scheduled_at)<=julianday(?)
           ORDER BY scheduled_at,occurrence_id`
        ).all(input.now,input.now)) as SqlRow[];
    return rows.map((row) => this.#readTriggerOccurrence(row));
  }

  createTriggerAttempt(input: {
    attemptId: string;
    occurrenceId: string;
    expectedOccurrenceRevision: number;
    createdAt: string;
  }): { occurrence:TriggerOccurrenceRecord;attempt:TriggerAttemptRecord } {
    assertRevision(input.expectedOccurrenceRevision,"expectedOccurrenceRevision");
    return this.#db.transaction(() => {
      const row = this.#db.prepare(
        "SELECT * FROM trigger_occurrences WHERE occurrence_id=?"
      ).get(input.occurrenceId) as SqlRow | undefined;
      if (!row) throw new Error(`Trigger Occurrence not found: ${input.occurrenceId}`);
      const current = this.#readTriggerOccurrence(row);
      if (
        current.revision !== input.expectedOccurrenceRevision ||
        (current.status !== "pending" && current.status !== "deferred")
      ) {
        throw new RevisionConflictError("Trigger Occurrence is not claimable");
      }
      const attemptNumber = current.attemptCount + 1;
      const claimed = this.#db.prepare(
        `UPDATE trigger_occurrences
         SET status='running',next_attempt_at=NULL,attempt_count=?,revision=revision+1,
             diagnostic=NULL,updated_at=?
         WHERE occurrence_id=? AND revision=? AND status IN ('pending','deferred')`
      ).run(
        attemptNumber,input.createdAt,input.occurrenceId,input.expectedOccurrenceRevision
      );
      if (claimed.changes !== 1) {
        throw new RevisionConflictError("Trigger Occurrence claim CAS failed");
      }
      this.#db.prepare(
        `INSERT INTO trigger_attempts(
          attempt_id,occurrence_id,attempt_number,revision,status,created_at,updated_at
        ) VALUES (?,?,?,0,'pending',?,?)`
      ).run(
        input.attemptId,input.occurrenceId,attemptNumber,input.createdAt,input.createdAt
      );
      return {
        occurrence:this.getTriggerOccurrence(input.occurrenceId)!,
        attempt:this.getTriggerAttempt(input.attemptId)!
      };
    })();
  }

  updateTriggerAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    status: TriggerAttemptStatus;
    updatedAt: string;
    terminalOutcome?: TriggerTerminalOutcome;
    fencingToken?: number;
    browserFencingToken?: number;
    diagnostic?: string;
  }): TriggerAttemptRecord {
    assertRevision(input.expectedRevision,"expectedRevision");
    if ((input.status === "terminal") !== (input.terminalOutcome !== undefined)) {
      throw new Error("Terminal Trigger Attempt requires terminalOutcome");
    }
    const current = this.getTriggerAttempt(input.attemptId);
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("Trigger Attempt revision changed");
    }
    const allowed =
      (current.status === "pending" &&
        (input.status === "running" || input.status === "terminal")) ||
      (current.status === "running" && input.status === "terminal");
    if (!allowed) {
      throw new Error(
        `Invalid Trigger Attempt transition: ${current.status} -> ${input.status}`
      );
    }
    const result = this.#db.prepare(
      `UPDATE trigger_attempts
       SET status=?,terminal_outcome=?,updated_at=?,revision=revision+1,
           fencing_token=COALESCE(?,fencing_token),
           browser_fencing_token=COALESCE(?,browser_fencing_token),
           diagnostic=COALESCE(?,diagnostic)
       WHERE attempt_id=? AND revision=? AND status=?`
    ).run(
      input.status,input.terminalOutcome ?? null,input.updatedAt,
      input.fencingToken ?? null,input.browserFencingToken ?? null,
      input.diagnostic ?? null,
      input.attemptId,input.expectedRevision,current.status
    );
    if (result.changes !== 1) {
      throw new RevisionConflictError("Trigger Attempt revision changed");
    }
    return this.getTriggerAttempt(input.attemptId)!;
  }

  finishTriggerAttempt(input: {
    attemptId: string;
    expectedAttemptRevision: number;
    occurrenceId: string;
    expectedOccurrenceRevision: number;
    outcome: TriggerTerminalOutcome;
    diagnostic?: string;
    updatedAt: string;
    attention?: AttentionRecord;
  }): { occurrence:TriggerOccurrenceRecord;attempt:TriggerAttemptRecord } {
    assertRevision(input.expectedAttemptRevision,"expectedAttemptRevision");
    assertRevision(input.expectedOccurrenceRevision,"expectedOccurrenceRevision");
    return this.#db.transaction(() => {
      const attempt = this.getTriggerAttempt(input.attemptId);
      if (!attempt || attempt.occurrenceId !== input.occurrenceId) {
        throw new RevisionConflictError("Trigger Attempt finish identity changed");
      }
      const requiresDashboardAttention =
        !attempt.workflowRunId &&
        (input.outcome === "blocked" || input.outcome === "failed");
      if (
        !attempt.workflowRunId &&
        input.outcome !== "blocked" &&
        input.outcome !== "failed"
      ) {
        throw new Error(
          "A pre-Run Trigger Attempt may only terminate as blocked or failed"
        );
      }
      if (requiresDashboardAttention) {
        if (!input.attention) {
          throw new Error(
            `${input.outcome} pre-Run Trigger Attempt requires dashboard Attention`
          );
        }
        this.#assertTriggerOccurrenceAttention(
          input.attention,
          input.occurrenceId,
          input.updatedAt
        );
      } else if (input.attention) {
        throw new Error(
          "Only blocked or failed pre-Run Trigger Attempts emit dashboard Attention"
        );
      }
      if (attempt.status === "terminal") {
        const occurrence = this.getTriggerOccurrence(input.occurrenceId);
        const existing = this.#getAttentionForTriggerOccurrence(
          input.occurrenceId
        );
        if (
          requiresDashboardAttention &&
          attempt.terminalOutcome === input.outcome &&
          attempt.diagnostic === input.diagnostic &&
          occurrence?.status === "terminal" &&
          occurrence.terminalOutcome === input.outcome &&
          occurrence.diagnostic === input.diagnostic &&
          input.attention &&
          existing &&
          this.#sameAttentionIdentity(existing,input.attention)
        ) {
          return { occurrence, attempt };
        }
        throw new Error("A terminal Trigger Attempt cannot be finished again");
      }
      const occurrence = this.getTriggerOccurrence(input.occurrenceId);
      if (!occurrence || occurrence.status !== "running") {
        throw new RevisionConflictError("Trigger Occurrence is not running");
      }
      const attemptResult = this.#db.prepare(
        `UPDATE trigger_attempts
         SET status='terminal',terminal_outcome=?,diagnostic=?,
             updated_at=?,revision=revision+1
         WHERE attempt_id=? AND occurrence_id=? AND revision=?
           AND status IN ('pending','running')`
      ).run(
        input.outcome,input.diagnostic ?? null,input.updatedAt,input.attemptId,
        input.occurrenceId,input.expectedAttemptRevision
      );
      if (attemptResult.changes !== 1) {
        throw new RevisionConflictError("Trigger Attempt finish CAS failed");
      }
      this.#inject("trigger_attempt.finish.after_attempt");
      const occurrenceResult = this.#db.prepare(
        `UPDATE trigger_occurrences
         SET status='terminal',terminal_outcome=?,next_attempt_at=NULL,
             diagnostic=?,updated_at=?,revision=revision+1
         WHERE occurrence_id=? AND revision=? AND status='running'`
      ).run(
        input.outcome,input.diagnostic ?? null,input.updatedAt,input.occurrenceId,
        input.expectedOccurrenceRevision
      );
      if (occurrenceResult.changes !== 1) {
        throw new RevisionConflictError("Trigger Occurrence finish CAS failed");
      }
      if (input.attention) {
        this.#inject("trigger_attempt.finish.before_attention");
        this.#insertAttention(input.attention);
      }
      return {
        occurrence:this.getTriggerOccurrence(input.occurrenceId)!,
        attempt:this.getTriggerAttempt(input.attemptId)!
      };
    })();
  }

  getTriggerAttempt(attemptId: string): TriggerAttemptRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM trigger_attempts WHERE attempt_id=?"
    ).get(attemptId) as SqlRow | undefined;
    return row ? this.#readTriggerAttempt(row) : undefined;
  }

  listTriggerAttempts(occurrenceId: string): TriggerAttemptRecord[] {
    return (this.#db.prepare(
      `SELECT * FROM trigger_attempts
       WHERE occurrence_id=? ORDER BY attempt_number,attempt_id`
    ).all(occurrenceId) as SqlRow[]).map((row) => this.#readTriggerAttempt(row));
  }

  listActiveTriggerAttempts(triggerId?: string): TriggerAttemptRecord[] {
    const rows = (triggerId
      ? this.#db.prepare(
          `SELECT a.* FROM trigger_attempts a
           JOIN trigger_occurrences o ON o.occurrence_id=a.occurrence_id
           WHERE a.status!='terminal' AND o.trigger_id=?
           ORDER BY a.created_at,a.attempt_id`
        ).all(triggerId)
      : this.#db.prepare(
          `SELECT * FROM trigger_attempts WHERE status!='terminal'
           ORDER BY created_at,attempt_id`
        ).all()) as SqlRow[];
    return rows.map((row) => this.#readTriggerAttempt(row));
  }

  getTriggerScheduleState(
    triggerId: string,
    triggerVersion: string
  ): TriggerScheduleStateRecord | undefined {
    const row = this.#db.prepare(
      `SELECT * FROM trigger_schedule_state
       WHERE trigger_id=? AND trigger_version=?`
    ).get(triggerId,triggerVersion) as SqlRow | undefined;
    return row ? this.#readTriggerScheduleState(row) : undefined;
  }

  initializeTriggerScheduleState(input: {
    triggerId: string;
    triggerVersion: string;
    cursorAt: string;
    createdAt: string;
  }): TriggerScheduleStateRecord {
    this.#db.prepare(
      `INSERT INTO trigger_schedule_state(
        trigger_id,trigger_version,cursor_at,revision,created_at,updated_at
      ) VALUES (?,?,?,0,?,?)
      ON CONFLICT(trigger_id,trigger_version) DO NOTHING`
    ).run(
      input.triggerId,input.triggerVersion,input.cursorAt,input.createdAt,input.createdAt
    );
    return this.getTriggerScheduleState(input.triggerId,input.triggerVersion)!;
  }

  advanceTriggerScheduleState(input: {
    triggerId: string;
    triggerVersion: string;
    expectedRevision: number;
    cursorAt: string;
    updatedAt: string;
  }): TriggerScheduleStateRecord {
    assertRevision(input.expectedRevision,"expectedRevision");
    const result = this.#db.prepare(
      `UPDATE trigger_schedule_state
       SET cursor_at=?,revision=revision+1,updated_at=?
       WHERE trigger_id=? AND trigger_version=? AND revision=? AND cursor_at<?`
    ).run(
      input.cursorAt,input.updatedAt,input.triggerId,input.triggerVersion,
      input.expectedRevision,input.cursorAt
    );
    if (result.changes !== 1) {
      throw new RevisionConflictError("Trigger Schedule State revision changed");
    }
    return this.getTriggerScheduleState(input.triggerId,input.triggerVersion)!;
  }

  latestDatasetVersion(datasetId: string): { id:string;version:string;createdAt:string } | undefined {
    const row = this.#db.prepare(
      `SELECT dataset_id,version,created_at FROM dataset_versions
       WHERE dataset_id=? ORDER BY created_at DESC,version DESC LIMIT 1`
    ).get(datasetId) as SqlRow | undefined;
    return row ? {
      id:String(row.dataset_id),version:String(row.version),createdAt:String(row.created_at)
    } : undefined;
  }

  beginExternalDomainLeaseAcquisition(input: {
    requestId: string;
    providerId: string;
    domainKey: string;
    occurrenceId: string;
    ownerId: string;
    createdAt: string;
  }): {
    status: "accepted" | "duplicate";
    record: ExternalDomainLeaseRecord;
  } {
    assertAuthoringId(input.requestId, "requestId");
    assertAuthoringId(input.providerId, "providerId");
    assertAuthoringId(input.domainKey, "domainKey");
    assertAuthoringId(input.occurrenceId, "occurrenceId");
    assertAuthoringId(input.ownerId, "ownerId");
    assertTimestamp(input.createdAt, "createdAt");
    return this.#db.transaction(() => {
      const replay = this.getExternalDomainLease(input.requestId);
      if (replay) {
        if (
          replay.providerId !== input.providerId ||
          replay.domainKey !== input.domainKey ||
          replay.occurrenceId !== input.occurrenceId ||
          replay.ownerId !== input.ownerId ||
          replay.createdAt !== input.createdAt
        ) {
          throw new ExternalDomainLeaseConflictError(
            `External domain lease request identity changed: ${input.requestId}`
          );
        }
        return { status: "duplicate" as const, record: replay };
      }
      const occurrence = this.getTriggerOccurrence(input.occurrenceId);
      if (
        !occurrence ||
        (occurrence.status !== "pending" && occurrence.status !== "deferred")
      ) {
        throw new ExternalDomainLeaseConflictError(
          `Trigger Occurrence is not ready for lease acquisition: ${input.occurrenceId}`
        );
      }
      const pinnedSpec = this.getTriggerSpecVersion(
        occurrence.triggerId,
        occurrence.triggerVersion
      );
      if (
        !pinnedSpec?.externalDomainLease ||
        pinnedSpec.externalDomainLease.providerId !== input.providerId ||
        pinnedSpec.externalDomainLease.resourceId !== input.domainKey
      ) {
        throw new ExternalDomainLeaseConflictError(
          `External domain lease does not match pinned TriggerSpec: ${input.occurrenceId}`
        );
      }
      const conflict = this.#db
        .prepare(
          `SELECT request_id FROM external_domain_leases
           WHERE state!='released' AND (
             (provider_id=? AND domain_key=?) OR occurrence_id=?
           ) LIMIT 1`
        )
        .get(input.providerId, input.domainKey, input.occurrenceId) as
        | SqlRow
        | undefined;
      if (conflict) {
        throw new ExternalDomainLeaseConflictError(
          `External domain lease is already active: ${String(conflict.request_id)}`
        );
      }
      this.#db
        .prepare(
          `INSERT INTO external_domain_leases(
            request_id,provider_id,domain_key,occurrence_id,proposed_owner_id,
            state,revision,created_at,updated_at
          ) VALUES (?,?,?,?,?,'acquiring',0,?,?)`
        )
        .run(
          input.requestId,
          input.providerId,
          input.domainKey,
          input.occurrenceId,
          input.ownerId,
          input.createdAt,
          input.createdAt
        );
      this.#inject("external_domain_lease.begin.after_insert");
      return {
        status: "accepted" as const,
        record: this.getExternalDomainLease(input.requestId)!
      };
    }).immediate();
  }

  bindExternalDomainLease(input: {
    requestId: string;
    expectedRevision: number;
    fencingToken: number;
    serverNow: string;
    expiresAt: string;
    updatedAt: string;
  }): ExternalDomainLeaseMutationResult {
    this.#assertExternalDomainLeaseBinding(input);
    const current = this.getExternalDomainLease(input.requestId);
    if (
      current?.state === "bound" &&
      current.fencingToken === input.fencingToken &&
      current.serverNow === input.serverNow &&
      current.expiresAt === input.expiresAt &&
      current.updatedAt === input.updatedAt
    ) {
      return { status: "duplicate", record: current };
    }
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("External domain lease revision changed");
    }
    if (current.state !== "acquiring") {
      throw new ExternalDomainLeaseConflictError(
        `Invalid external domain lease transition: ${current.state} -> bound`
      );
    }
    return this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE external_domain_leases
           SET state='bound',revision=revision+1,fencing_token=?,server_now=?,
               expires_at=?,diagnostic=NULL,updated_at=?
           WHERE request_id=? AND revision=? AND state='acquiring'`
        )
        .run(
          input.fencingToken,
          input.serverNow,
          input.expiresAt,
          input.updatedAt,
          input.requestId,
          input.expectedRevision
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("External domain lease revision changed");
      }
      this.#inject("external_domain_lease.bind.after_update");
      return {
        status: "updated" as const,
        record: this.getExternalDomainLease(input.requestId)!
      };
    })();
  }

  renewExternalDomainLease(input: {
    requestId: string;
    expectedRevision: number;
    fencingToken: number;
    serverNow: string;
    expiresAt: string;
    updatedAt: string;
  }): ExternalDomainLeaseMutationResult {
    this.#assertExternalDomainLeaseBinding(input);
    const current = this.getExternalDomainLease(input.requestId);
    if (
      current?.state === "bound" &&
      current.fencingToken === input.fencingToken &&
      current.serverNow === input.serverNow &&
      current.expiresAt === input.expiresAt &&
      current.updatedAt === input.updatedAt
    ) {
      return { status: "duplicate", record: current };
    }
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("External domain lease revision changed");
    }
    if (current.state !== "bound") {
      throw new ExternalDomainLeaseConflictError(
        `Invalid external domain lease transition: ${current.state} -> bound renewal`
      );
    }
    if (current.fencingToken !== input.fencingToken) {
      throw new ExternalDomainLeaseConflictError(
        "External domain lease fencing token changed during renewal"
      );
    }
    return this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE external_domain_leases
           SET revision=revision+1,server_now=?,expires_at=?,updated_at=?
           WHERE request_id=? AND revision=? AND state='bound'
             AND fencing_token=?`
        )
        .run(
          input.serverNow,
          input.expiresAt,
          input.updatedAt,
          input.requestId,
          input.expectedRevision,
          input.fencingToken
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("External domain lease revision changed");
      }
      this.#inject("external_domain_lease.renew.after_update");
      return {
        status: "updated" as const,
        record: this.getExternalDomainLease(input.requestId)!
      };
    })();
  }

  markExternalDomainLeaseReconciliationRequired(input: {
    requestId: string;
    expectedRevision: number;
    diagnostic: string;
    updatedAt: string;
  }): ExternalDomainLeaseMutationResult {
    assertRevision(input.expectedRevision, "expectedRevision");
    assertTimestamp(input.updatedAt, "updatedAt");
    if (!input.diagnostic.trim() || input.diagnostic.length > 1_000) {
      throw new Error("diagnostic must be 1-1000 characters");
    }
    const current = this.getExternalDomainLease(input.requestId);
    if (
      current?.state === "reconciliation_required" &&
      current.diagnostic === input.diagnostic &&
      current.reconciliationRequiredAt === input.updatedAt &&
      current.updatedAt === input.updatedAt
    ) {
      return { status: "duplicate", record: current };
    }
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("External domain lease revision changed");
    }
    if (current.state !== "acquiring" && current.state !== "bound") {
      throw new ExternalDomainLeaseConflictError(
        `Invalid external domain lease transition: ${current.state} -> reconciliation_required`
      );
    }
    return this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE external_domain_leases
           SET state='reconciliation_required',revision=revision+1,diagnostic=?,
               reconciliation_required_at=?,updated_at=?
           WHERE request_id=? AND revision=? AND state=?`
        )
        .run(
          input.diagnostic,
          input.updatedAt,
          input.updatedAt,
          input.requestId,
          input.expectedRevision,
          current.state
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("External domain lease revision changed");
      }
      this.#inject("external_domain_lease.reconcile.after_update");
      return {
        status: "updated" as const,
        record: this.getExternalDomainLease(input.requestId)!
      };
    })();
  }

  releaseExternalDomainLease(input: {
    requestId: string;
    expectedRevision: number;
    releasedAt: string;
  }): ExternalDomainLeaseMutationResult {
    assertRevision(input.expectedRevision, "expectedRevision");
    assertTimestamp(input.releasedAt, "releasedAt");
    const current = this.getExternalDomainLease(input.requestId);
    if (
      current?.state === "released" &&
      current.releasedAt === input.releasedAt &&
      current.updatedAt === input.releasedAt
    ) {
      return { status: "duplicate", record: current };
    }
    if (!current || current.revision !== input.expectedRevision) {
      throw new RevisionConflictError("External domain lease revision changed");
    }
    if (current.state === "released") {
      throw new ExternalDomainLeaseConflictError(
        "External domain lease was released with a different operation"
      );
    }
    return this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE external_domain_leases
           SET state='released',revision=revision+1,released_at=?,updated_at=?
           WHERE request_id=? AND revision=? AND state!='released'`
        )
        .run(
          input.releasedAt,
          input.releasedAt,
          input.requestId,
          input.expectedRevision
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("External domain lease revision changed");
      }
      this.#inject("external_domain_lease.release.after_update");
      return {
        status: "updated" as const,
        record: this.getExternalDomainLease(input.requestId)!
      };
    })();
  }

  getExternalDomainLease(
    requestId: string
  ): ExternalDomainLeaseRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM external_domain_leases WHERE request_id=?")
      .get(requestId) as SqlRow | undefined;
    return row ? this.#readExternalDomainLease(row) : undefined;
  }

  listExternalDomainLeases(): ExternalDomainLeaseRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM external_domain_leases
           ORDER BY created_at,request_id`
        )
        .all() as SqlRow[]
    ).map((row) => this.#readExternalDomainLease(row));
  }

  listExternalDomainLeasesNeedingRecovery(input: {
    now: string;
  }): ExternalDomainLeaseRecord[] {
    assertTimestamp(input.now, "now");
    return (
      this.#db
        .prepare(
          `SELECT lease.* FROM external_domain_leases lease
           LEFT JOIN trigger_attempts attempt
             ON attempt.attempt_id=lease.trigger_attempt_id
           LEFT JOIN workflow_runs run ON run.id=lease.workflow_run_id
           WHERE lease.state!='released'
             AND (attempt.attempt_id IS NULL OR attempt.status!='terminal')
             AND (run.id IS NULL OR run.status NOT IN (
               'succeeded','rejected','failed','cancelled','uncertain'
             ))
             AND (
               lease.state IN ('acquiring','reconciliation_required')
               OR (lease.state='bound' AND julianday(lease.expires_at)<=julianday(?))
             )
           ORDER BY lease.updated_at,lease.request_id`
        )
        .all(input.now) as SqlRow[]
    ).map((row) => this.#readExternalDomainLease(row));
  }

  listExternalDomainLeasesNeedingRenewal(input: {
    now: string;
    renewBefore: string;
  }): ExternalDomainLeaseRecord[] {
    assertTimestamp(input.now, "now");
    assertTimestamp(input.renewBefore, "renewBefore");
    if (Date.parse(input.renewBefore) < Date.parse(input.now)) {
      throw new Error("renewBefore must not be before now");
    }
    return (
      this.#db
        .prepare(
          `SELECT lease.* FROM external_domain_leases lease
           LEFT JOIN trigger_attempts attempt
             ON attempt.attempt_id=lease.trigger_attempt_id
           LEFT JOIN workflow_runs run ON run.id=lease.workflow_run_id
           WHERE lease.state='bound'
             AND julianday(lease.expires_at)>julianday(?)
             AND julianday(lease.expires_at)<=julianday(?)
             AND (attempt.attempt_id IS NULL OR attempt.status!='terminal')
             AND (run.id IS NULL OR run.status NOT IN (
               'succeeded','rejected','failed','cancelled','uncertain'
             ))
           ORDER BY lease.expires_at,lease.request_id`
        )
        .all(input.now, input.renewBefore) as SqlRow[]
    ).map((row) => this.#readExternalDomainLease(row));
  }

  listExternalDomainLeasesNeedingRelease(): ExternalDomainLeaseRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT lease.* FROM external_domain_leases lease
           LEFT JOIN trigger_attempts attempt
             ON attempt.attempt_id=lease.trigger_attempt_id
           LEFT JOIN workflow_runs run ON run.id=lease.workflow_run_id
           WHERE lease.state!='released' AND (
             attempt.status='terminal' OR run.status IN (
               'succeeded','rejected','failed','cancelled','uncertain'
             )
           )
           ORDER BY lease.updated_at,lease.request_id`
        )
        .all() as SqlRow[]
    ).map((row) => this.#readExternalDomainLease(row));
  }

  commitInventoryEffectReconciliation(input: {
    requestId: string;
    resolutionToken: string;
    runId: string;
    ownerId: string;
    fencingToken: number;
    expectedLeaseRevision: number;
    expectedEffectSetDigest: string;
    remoteReportDigest: string;
    expectedEffectCount: number;
    remoteEffectCount: number;
    succeededEffectCount: number;
    failedEffectCount: number;
    missingEffectCount: number;
    succeededItemCount: number;
    failedItemCount: number;
    classification: InventoryEffectReconciliationClassification;
    inspectedAt: string;
    resolvedAt: string;
    resolvedBy: string;
  }): { status: "created" | "duplicate"; record: InventoryEffectReconciliationRecord } {
    assertAuthoringId(input.requestId,"requestId");
    assertDigest(input.resolutionToken,"resolutionToken");
    assertAuthoringId(input.runId,"runId");
    assertAuthoringId(input.ownerId,"ownerId");
    assertRevision(input.expectedLeaseRevision,"expectedLeaseRevision");
    assertDigest(input.expectedEffectSetDigest,"expectedEffectSetDigest");
    assertDigest(input.remoteReportDigest,"remoteReportDigest");
    assertTimestamp(input.inspectedAt,"inspectedAt");
    assertTimestamp(input.resolvedAt,"resolvedAt");
    assertAuthoringId(input.resolvedBy,"resolvedBy");
    if (Date.parse(input.resolvedAt) < Date.parse(input.inspectedAt)) {
      throw new Error("resolvedAt must not be before inspectedAt");
    }
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error("fencingToken must be a positive safe integer");
    }
    const counts = [
      input.expectedEffectCount,input.remoteEffectCount,
      input.succeededEffectCount,input.failedEffectCount,input.missingEffectCount,
      input.succeededItemCount,input.failedItemCount
    ];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      input.remoteEffectCount !== input.succeededEffectCount + input.failedEffectCount ||
      input.expectedEffectCount !== input.remoteEffectCount + input.missingEffectCount) {
      throw new Error("Inventory effect reconciliation counts do not conserve");
    }
    const existing = this.getInventoryEffectReconciliation(input.requestId);
    if (existing) {
      const stableIdentityMatches =
        existing.resolutionToken === input.resolutionToken &&
        existing.runId === input.runId && existing.ownerId === input.ownerId &&
        existing.fencingToken === input.fencingToken &&
        existing.leaseRevision === input.expectedLeaseRevision &&
        existing.expectedEffectSetDigest === input.expectedEffectSetDigest &&
        existing.remoteReportDigest === input.remoteReportDigest &&
        existing.expectedEffectCount === input.expectedEffectCount &&
        existing.remoteEffectCount === input.remoteEffectCount &&
        existing.succeededEffectCount === input.succeededEffectCount &&
        existing.failedEffectCount === input.failedEffectCount &&
        existing.missingEffectCount === input.missingEffectCount &&
        existing.succeededItemCount === input.succeededItemCount &&
        existing.failedItemCount === input.failedItemCount &&
        existing.classification === input.classification;
      const currentLease = this.getExternalDomainLease(input.requestId);
      if (stableIdentityMatches && currentLease?.state === "released") {
        return { status:"duplicate",record:existing };
      }
      throw new ExternalDomainLeaseConflictError(
        "Inventory effect reconciliation already differs"
      );
    }
    const lease = this.getExternalDomainLease(input.requestId);
    const run = this.getRun(input.runId);
    const attempt = lease?.triggerAttemptId
      ? this.getTriggerAttempt(lease.triggerAttemptId)
      : undefined;
    if (!lease || lease.state !== "reconciliation_required" ||
      lease.revision !== input.expectedLeaseRevision ||
      lease.runId !== input.runId || lease.ownerId !== input.ownerId ||
      lease.triggerAttemptId !== input.ownerId ||
      lease.fencingToken !== input.fencingToken ||
      run?.status !== "uncertain" || attempt?.status !== "running" ||
      attempt.workflowRunId !== input.runId) {
      throw new ExternalDomainLeaseConflictError(
        "Inventory effect reconciliation ownership is invalid"
      );
    }
    return this.#db.transaction(() => {
      this.#db.prepare(
        `INSERT INTO external_domain_lease_reconciliations(
           request_id,resolution_token,workflow_run_id,owner_id,fencing_token,lease_revision,
           expected_effect_set_digest,remote_report_digest,
           expected_effect_count,remote_effect_count,succeeded_effect_count,
           failed_effect_count,missing_effect_count,succeeded_item_count,
           failed_item_count,classification,inspected_at,resolved_at,resolved_by
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.requestId,input.resolutionToken,input.runId,input.ownerId,input.fencingToken,
        input.expectedLeaseRevision,input.expectedEffectSetDigest,
        input.remoteReportDigest,input.expectedEffectCount,input.remoteEffectCount,
        input.succeededEffectCount,input.failedEffectCount,input.missingEffectCount,
        input.succeededItemCount,input.failedItemCount,input.classification,
        input.inspectedAt,input.resolvedAt,input.resolvedBy
      );
      this.#inject("external_domain_lease_reconciliation.resolve.after_audit");
      const updatedLease = this.#db.prepare(
        `UPDATE external_domain_leases
         SET state='released',revision=revision+1,released_at=?,updated_at=?,
             diagnostic='External inventory effects were reconciled.'
         WHERE request_id=? AND revision=? AND state='reconciliation_required'`
      ).run(
        input.resolvedAt,input.resolvedAt,input.requestId,input.expectedLeaseRevision
      );
      if (updatedLease.changes !== 1) {
        throw new RevisionConflictError("External domain lease revision changed");
      }
      this.#insertAudit(
        "external-domain-lease.reconciliation.resolved",
        input.resolvedBy,
        input.requestId,
        {
          runId:input.runId,
          expectedEffectSetDigest:input.expectedEffectSetDigest,
          remoteReportDigest:input.remoteReportDigest,
          classification:input.classification
        }
      );
      return {
        status:"created" as const,
        record:this.getInventoryEffectReconciliation(input.requestId)!
      };
    }).immediate();
  }

  getInventoryEffectReconciliation(
    requestId: string
  ): InventoryEffectReconciliationRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM external_domain_lease_reconciliations WHERE request_id=?"
    ).get(requestId) as SqlRow | undefined;
    return row ? this.#readInventoryEffectReconciliation(row) : undefined;
  }

  getInventoryEffectReconciliationByResolutionToken(
    resolutionToken: string
  ): InventoryEffectReconciliationRecord | undefined {
    assertDigest(resolutionToken,"resolutionToken");
    const row = this.#db.prepare(
      "SELECT * FROM external_domain_lease_reconciliations WHERE resolution_token=?"
    ).get(resolutionToken) as SqlRow | undefined;
    return row ? this.#readInventoryEffectReconciliation(row) : undefined;
  }

  getLatestInventoryEffectReconciliation():
    InventoryEffectReconciliationRecord | undefined {
    const row = this.#db.prepare(
      `SELECT * FROM external_domain_lease_reconciliations
       ORDER BY resolved_at DESC,request_id DESC LIMIT 1`
    ).get() as SqlRow | undefined;
    return row ? this.#readInventoryEffectReconciliation(row) : undefined;
  }

  acquireTriggerLease(input: {
    concurrencyKey: string;ownerId: string;now: string;ttlSeconds: number;
  }): BrowserControlLeaseRecord | undefined {
    return this.#acquireControlLease(
      "trigger_leases","concurrency_key",input.concurrencyKey,input.ownerId,input.now,input.ttlSeconds
    );
  }

  renewTriggerLease(input: {
    concurrencyKey:string;ownerId:string;fencingToken:number;now:string;ttlSeconds:number;
  }): BrowserControlLeaseRecord | undefined {
    return this.#renewControlLease(
      "trigger_leases","concurrency_key",input.concurrencyKey,input.ownerId,
      input.fencingToken,input.now,input.ttlSeconds
    );
  }

  releaseTriggerLease(input: {
    concurrencyKey:string;ownerId:string;fencingToken:number;releasedAt:string;
  }): boolean {
    return this.#releaseControlLease(
      "trigger_leases","concurrency_key",input.concurrencyKey,
      input.ownerId,input.fencingToken,input.releasedAt
    );
  }

  listTriggerLeases(nowValue: string): BrowserControlLeaseRecord[] {
    return (this.#db.prepare(
      "SELECT * FROM trigger_leases WHERE expires_at>? ORDER BY concurrency_key"
    ).all(nowValue) as SqlRow[]).map((row) => ({
      resourceId:String(row.concurrency_key),ownerId:String(row.owner_id),
      fencingToken:Number(row.fencing_token),acquiredAt:String(row.acquired_at),
      expiresAt:String(row.expires_at)
    }));
  }

  acquireBrowserControlLease(input: {
    resourceId:string;ownerId:string;now:string;ttlSeconds:number;
  }): BrowserControlLeaseRecord | undefined {
    return this.#acquireControlLease(
      "browser_control_leases","resource_id",input.resourceId,input.ownerId,input.now,input.ttlSeconds
    );
  }

  renewBrowserControlLease(input: {
    resourceId:string;ownerId:string;fencingToken:number;now:string;ttlSeconds:number;
  }): BrowserControlLeaseRecord | undefined {
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 5 || input.ttlSeconds > 3600) {
      throw new Error("Control lease TTL must be between 5 and 3600 seconds");
    }
    const expiresAt = new Date(Date.parse(input.now) + input.ttlSeconds * 1000).toISOString();
    const result = this.#db.prepare(
      `UPDATE browser_control_leases
       SET expires_at=CASE WHEN expires_at>? THEN expires_at ELSE ? END
       WHERE resource_id=? AND owner_id=? AND fencing_token=? AND expires_at>?`
    ).run(
      expiresAt,expiresAt,input.resourceId,input.ownerId,input.fencingToken,input.now
    );
    if (result.changes !== 1) return undefined;
    const row = this.#db.prepare(
      "SELECT * FROM browser_control_leases WHERE resource_id=?"
    ).get(input.resourceId) as SqlRow;
    return {
      resourceId:String(row.resource_id),ownerId:String(row.owner_id),
      fencingToken:Number(row.fencing_token),acquiredAt:String(row.acquired_at),
      expiresAt:String(row.expires_at)
    };
  }

  releaseBrowserControlLease(input: {
    resourceId:string;ownerId:string;fencingToken:number;releasedAt:string;
  }): boolean {
    return this.#releaseControlLease(
      "browser_control_leases","resource_id",input.resourceId,
      input.ownerId,input.fencingToken,input.releasedAt
    );
  }

  listBrowserControlLeases(nowValue: string): BrowserControlLeaseRecord[] {
    return (this.#db.prepare(
      "SELECT * FROM browser_control_leases WHERE expires_at>? ORDER BY resource_id"
    ).all(nowValue) as SqlRow[]).map((row) => ({
      resourceId:String(row.resource_id),ownerId:String(row.owner_id),
      fencingToken:Number(row.fencing_token),acquiredAt:String(row.acquired_at),
      expiresAt:String(row.expires_at)
    }));
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

  listRuns(input: {
    statuses?: readonly RunStatus[];
    limit: number;
  }): RunRecord[] {
    const requestedLimit = Number.isSafeInteger(input.limit)
      ? input.limit
      : 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 200);
    const statuses = [...new Set(input.statuses ?? [])];
    const rows = (statuses.length === 0
      ? this.#db
          .prepare(
            `SELECT * FROM workflow_runs
             ORDER BY updated_at DESC, id
             LIMIT ?`
          )
          .all(limit)
      : this.#db
          .prepare(
            `SELECT * FROM workflow_runs
             WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY updated_at DESC, id
             LIMIT ?`
          )
          .all(...statuses, limit)) as SqlRow[];
    return rows.map((row) => this.#readRun(row));
  }

  getLatestTriggeredWorkflowExecution(input: {
    appId: string;
    workflowId: string;
    workflowVersion: string;
  }): {
    scheduledAt:string;
    occurrenceStatus:"pending"|"deferred"|"running"|"terminal";
    occurrenceTerminalOutcome?:
      | "complete"|"partial"|"blocked"|"degraded"|"rejected"
      | "uncertain"|"cancelled"|"failed"|"skipped"|"missed";
    run?:RunRecord;
  } | undefined {
    const appId = input.appId.trim();
    const workflowId = input.workflowId.trim();
    const workflowVersion = input.workflowVersion.trim();
    if (
      !appId || appId.length > 200 ||
      !workflowId || workflowId.length > 500 ||
      !workflowVersion || workflowVersion.length > 100
    ) {
      throw new Error("Triggered Workflow execution query is invalid");
    }
    const row = this.#db.prepare(
      `WITH latest_occurrence AS (
         SELECT occurrence.*
         FROM trigger_occurrences occurrence
         INNER JOIN trigger_spec_versions version
           ON version.trigger_id=occurrence.trigger_id
          AND version.trigger_version=occurrence.trigger_version
         WHERE json_extract(version.spec_json,'$.appId')=?
           AND json_extract(version.spec_json,'$.workflow.id')=?
           AND json_extract(version.spec_json,'$.workflow.version')=?
         ORDER BY occurrence.scheduled_at DESC,
                  occurrence.created_at DESC,
                  occurrence.occurrence_id DESC
         LIMIT 1
       ), latest_attempt AS (
         SELECT attempt.*
         FROM trigger_attempts attempt
         INNER JOIN latest_occurrence occurrence
           ON occurrence.occurrence_id=attempt.occurrence_id
         ORDER BY attempt.attempt_number DESC,attempt.attempt_id DESC
         LIMIT 1
       )
       SELECT run.*,
              occurrence.scheduled_at AS trigger_scheduled_at,
              occurrence.status AS trigger_occurrence_status,
              occurrence.terminal_outcome AS trigger_terminal_outcome,
              attempt.workflow_run_id AS linked_workflow_run_id
       FROM latest_occurrence occurrence
       LEFT JOIN latest_attempt attempt ON TRUE
       LEFT JOIN workflow_runs run ON run.id=attempt.workflow_run_id`
    ).get(
      appId,
      workflowId,
      workflowVersion
    ) as (SqlRow & {
      trigger_scheduled_at:string;
      trigger_occurrence_status:string;
      trigger_terminal_outcome:string|null;
      linked_workflow_run_id:string|null;
    }) | undefined;
    if (!row) return undefined;
    const hasLinkedRun=row.linked_workflow_run_id!=null;
    const occurrenceStatus=String(row.trigger_occurrence_status);
    const occurrenceTerminalOutcome=row.trigger_terminal_outcome==null
      ? undefined
      : String(row.trigger_terminal_outcome);
    const allowedOccurrenceStatuses=["pending","deferred","running","terminal"];
    const allowedTerminalOutcomes=[
      "complete","partial","blocked","degraded","rejected","uncertain",
      "cancelled","failed","skipped","missed"
    ];
    const runStatus=hasLinkedRun ? String(row.status) : undefined;
    const expectedRunOutcome:Record<string,string>={
      succeeded:"complete",
      uncertain:"uncertain",
      failed:"failed",
      rejected:"rejected",
      cancelled:"cancelled"
    };
    const terminalWithoutRunOutcomes=["blocked","failed","skipped","missed"];
    if (
      !allowedOccurrenceStatuses.includes(occurrenceStatus) ||
      (occurrenceStatus==="terminal")!==
        (occurrenceTerminalOutcome!==undefined) ||
      (occurrenceTerminalOutcome!==undefined &&
        !allowedTerminalOutcomes.includes(occurrenceTerminalOutcome)) ||
      hasLinkedRun && (
        row.id==null || row.workflow_id!==workflowId ||
        row.workflow_version!==workflowVersion
      ) ||
      (hasLinkedRun && occurrenceStatus!=="running" && occurrenceStatus!=="terminal") ||
      (hasLinkedRun && occurrenceStatus==="terminal" &&
        expectedRunOutcome[runStatus!]!==occurrenceTerminalOutcome) ||
      (!hasLinkedRun && occurrenceStatus==="terminal" &&
        !terminalWithoutRunOutcomes.includes(occurrenceTerminalOutcome!))
    ) {
      throw new Error("Triggered Workflow execution attribution is invalid");
    }
    return {
      scheduledAt:String(row.trigger_scheduled_at),
      occurrenceStatus:occurrenceStatus as
        "pending"|"deferred"|"running"|"terminal",
      ...(occurrenceTerminalOutcome===undefined
        ? {}
        : { occurrenceTerminalOutcome:occurrenceTerminalOutcome as
          | "complete"|"partial"|"blocked"|"degraded"|"rejected"
          | "uncertain"|"cancelled"|"failed"|"skipped"|"missed" }),
      ...(hasLinkedRun ? { run:this.#readRun(row) } : {})
    };
  }

  getAttention(id: string): AttentionRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM attention_records WHERE attention_id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readAttention(row) : undefined;
  }

  queryAttention(input: {
    states?: readonly AttentionRecord["state"][];
    sourceKinds?: readonly AttentionRecord["sourceRef"]["kind"][];
    appIds?: readonly string[];
    limit: number;
  }): {
    records: AttentionRecord[];
    total: number;
    truncated: boolean;
  } {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error("Attention query limit must be between 1 and 200");
    }
    const states = [...new Set(input.states ?? [])];
    const sourceKinds = [...new Set(input.sourceKinds ?? [])];
    const appIds = [...new Set(input.appIds ?? [])];
    if (
      (input.states !== undefined && states.length === 0) ||
      (input.sourceKinds !== undefined && sourceKinds.length === 0) ||
      (input.appIds !== undefined && appIds.length === 0) ||
      appIds.length > 100 ||
      appIds.some((appId) => !appId.trim() || appId.length > 200)
    ) {
      throw new Error("Attention appId filter is invalid");
    }
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (states.length > 0) {
      conditions.push(`attention.state IN (${states.map(() => "?").join(",")})`);
      parameters.push(...states);
    }
    if (sourceKinds.length > 0) {
      conditions.push(
        `attention.source_type IN (${sourceKinds.map(() => "?").join(",")})`
      );
      parameters.push(...sourceKinds);
    }
    if (appIds.length > 0) {
      conditions.push(
        `(
          (
            attention.source_type='trigger-occurrence'
            AND EXISTS (
              SELECT 1
              FROM trigger_occurrences occurrence
              INNER JOIN trigger_spec_versions version
                ON version.trigger_id=occurrence.trigger_id
               AND version.trigger_version=occurrence.trigger_version
              WHERE occurrence.occurrence_id=attention.trigger_occurrence_id
                AND json_extract(version.spec_json,'$.appId') IN (
                  ${appIds.map(() => "?").join(",")}
                )
            )
          )
          OR
          (
            attention.source_type='workflow-run'
            AND EXISTS (
              SELECT 1
              FROM trigger_attempts attempt
              INNER JOIN trigger_occurrences occurrence
                ON occurrence.occurrence_id=attempt.occurrence_id
              INNER JOIN trigger_spec_versions version
                ON version.trigger_id=occurrence.trigger_id
               AND version.trigger_version=occurrence.trigger_version
              WHERE attempt.workflow_run_id=attention.workflow_run_id
                AND json_extract(version.spec_json,'$.appId') IN (
                  ${appIds.map(() => "?").join(",")}
                )
            )
          )
        )`
      );
      parameters.push(...appIds,...appIds);
    }
    const predicate = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const total = Number((this.#db.prepare(
      `SELECT COUNT(*) AS count FROM attention_records attention
       ${predicate}`
    ).get(...parameters) as { count:number }).count);
    const rows = this.#db.prepare(
      `SELECT attention.* FROM attention_records attention
       ${predicate}
       ORDER BY attention.created_at DESC,attention.attention_id
       LIMIT ?`
    ).all(...parameters,input.limit) as SqlRow[];
    return {
      records:rows.map((row) => this.#readAttention(row)),
      total,
      truncated:total > rows.length
    };
  }

  acknowledgeAttention(input: {
    id: string;
    expectedRevision: number;
    actor: string;
    acknowledgedAt: string;
  }): AttentionRecord {
    return this.#db.transaction(() => {
      const current = this.getAttention(input.id);
      const result = this.#db
        .prepare(
          `UPDATE attention_records
           SET state = 'acknowledged', revision = revision + 1,
               acknowledged_at = ?, acknowledged_by = ?
           WHERE attention_id = ? AND state = 'open' AND revision = ?`
        )
        .run(
          input.acknowledgedAt,
          input.actor,
          input.id,
          input.expectedRevision
        );
      if (result.changes !== 1 || !current) {
        throw new RevisionConflictError(
          `Attention ${input.id} is not open at revision ${input.expectedRevision}`
        );
      }
      const acknowledged = this.getAttention(input.id)!;
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: "attention.acknowledged",
        actor: input.actor,
        target: `attention:${input.id}`,
        detail: {
          runId: current.item.runId,
          previousRevision: input.expectedRevision,
          revision: acknowledged.revision
        },
        occurredAt: input.acknowledgedAt
      });
      return acknowledged;
    })();
  }

  issueRecoverySession(
    input: IssueRecoverySessionInput
  ): RecoverySessionRecord {
    assertRevision(input.expectedAttentionRevision, "expectedAttentionRevision");
    return this.#db.transaction(() => {
      const required = [
        input.id,
        input.attentionId,
        input.requestedBy,
        input.browserSessionId,
        input.browserInstanceId,
        input.profileId,
        input.origin,
        input.initialPageEpoch,
        input.tokenDigest
      ];
      if (required.some((value) => !value.trim())) {
        throw new RecoverySessionConflictError(
          "Recovery Session identity and binding are required"
        );
      }
      if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) {
        throw new RecoverySessionConflictError(
          "Recovery Session tabId is invalid"
        );
      }
      if (!/^sha256:[a-f0-9]{64}$/u.test(input.tokenDigest)) {
        throw new RecoverySessionConflictError(
          "Recovery Session token digest is invalid"
        );
      }
      const issuedAtMs = Date.parse(input.issuedAt);
      const expiresAtMs = Date.parse(input.expiresAt);
      const ttlSeconds = (expiresAtMs - issuedAtMs) / 1_000;
      if (
        !Number.isFinite(issuedAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < 5 ||
        ttlSeconds > 3_600
      ) {
        throw new RecoverySessionConflictError(
          "Recovery Session lifetime is invalid"
        );
      }
      const browser = this.getBrowserSession(input.browserSessionId);
      if (
        !browser ||
        browser.disconnectedAt ||
        browser.browserInstanceId !== input.browserInstanceId
      ) {
        throw new RecoverySessionConflictError(
          "Recovery Session browser binding is unavailable"
        );
      }
      const attention = this.getAttention(input.attentionId);
      if (
        !attention ||
        attention.sourceRef.kind !== "workflow-run" ||
        attention.deliveryPolicy !== "operator-notification" ||
        attention.state !== "open" ||
        attention.revision !== input.expectedAttentionRevision ||
        attention.item.source !== "browser" ||
        !attention.item.blocking ||
        attention.item.groupKey !== "authentication"
      ) {
        throw new RecoverySessionConflictError(
          "Recovery Session Attention is not eligible"
        );
      }
      const run = this.getRun(attention.sourceRef.runId);
      if (
        !run ||
        (run.status !== "rejected" &&
          run.status !== "failed" &&
          run.status !== "uncertain")
      ) {
        throw new RecoverySessionConflictError(
          "Recovery Session Run is not eligible"
        );
      }
      const page = this.getBrowserPageObservation(
        input.browserSessionId,
        input.tabId
      );
      if (
        !page ||
        page.browserInstanceId !== input.browserInstanceId ||
        page.origin !== input.origin ||
        page.pageEpoch !== input.initialPageEpoch ||
        input.profileId !== input.browserInstanceId
      ) {
        throw new RecoverySessionConflictError(
          "Recovery Session page binding does not match"
        );
      }
      const existing = this.#db
        .prepare(
          "SELECT recovery_session_id FROM recovery_sessions WHERE attention_id = ?"
        )
        .get(input.attentionId);
      if (existing) {
        throw new RecoverySessionConflictError(
          "Attention already has a Recovery Session"
        );
      }
      const leaseResourceId = `browser-instance:${input.browserInstanceId}`;
      const leaseOwnerId = `recovery-session:${input.id}`;
      const lease = this.#acquireControlLease(
        "browser_control_leases",
        "resource_id",
        leaseResourceId,
        leaseOwnerId,
        input.issuedAt,
        ttlSeconds
      );
      if (!lease) {
        throw new RecoverySessionConflictError(
          "Recovery Session browser resource is busy"
        );
      }
      this.#db.prepare(
        `INSERT INTO recovery_sessions(
          recovery_session_id, attention_id, revision, state, requested_by,
          browser_session_id, browser_instance_id, profile_id, tab_id, origin,
          initial_page_epoch, token_digest, lease_resource_id, lease_owner_id,
          lease_fencing_token, issued_at, expires_at, updated_at
        ) VALUES (?, ?, 0, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.attentionId,
        input.requestedBy,
        input.browserSessionId,
        input.browserInstanceId,
        input.profileId,
        input.tabId,
        input.origin,
        input.initialPageEpoch,
        input.tokenDigest,
        leaseResourceId,
        leaseOwnerId,
        lease.fencingToken,
        input.issuedAt,
        input.expiresAt,
        input.issuedAt
      );
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: "recovery-session.issued",
        actor: input.requestedBy,
        target: `recovery-session:${input.id}`,
        detail: {
          attentionId: input.attentionId,
          browserInstanceId: input.browserInstanceId,
          profileId: input.profileId,
          tabId: input.tabId,
          origin: input.origin,
          expiresAt: input.expiresAt,
          leaseFencingToken: lease.fencingToken
        },
        occurredAt: input.issuedAt
      });
      return this.getRecoverySession(input.id)!;
    })();
  }

  getRecoverySession(id: string): RecoverySessionRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM recovery_sessions WHERE recovery_session_id = ?"
      )
      .get(id) as SqlRow | undefined;
    return row ? this.#readRecoverySession(row) : undefined;
  }

  listRecoverySessions(input: {
    states?: readonly RecoverySessionState[];
    limit: number;
  }): RecoverySessionRecord[] {
    const requestedLimit = Number.isSafeInteger(input.limit)
      ? input.limit
      : 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 200);
    const states = [...new Set(input.states ?? [])];
    const rows = (states.length === 0
      ? this.#db.prepare(
          `SELECT * FROM recovery_sessions
           ORDER BY issued_at DESC, recovery_session_id LIMIT ?`
        ).all(limit)
      : this.#db.prepare(
          `SELECT * FROM recovery_sessions
           WHERE state IN (${states.map(() => "?").join(",")})
           ORDER BY issued_at DESC, recovery_session_id LIMIT ?`
        ).all(...states, limit)) as SqlRow[];
    return rows.map((row) => this.#readRecoverySession(row));
  }

  activateRecoverySession(input: {
    id: string;
    expectedRevision: number;
    tokenDigest: string;
    actor: string;
    activatedAt: string;
  }): RecoverySessionRecord {
    return this.#db.transaction(() => {
      const result = this.#db.prepare(
        `UPDATE recovery_sessions
         SET state = 'active', revision = revision + 1,
             activated_at = ?, updated_at = ?
         WHERE recovery_session_id = ? AND state = 'issued'
           AND revision = ? AND token_digest = ? AND expires_at > ?`
      ).run(
        input.activatedAt,
        input.activatedAt,
        input.id,
        input.expectedRevision,
        input.tokenDigest,
        input.activatedAt
      );
      if (result.changes !== 1) {
        throw new RecoverySessionConflictError(
          "Recovery Session cannot be activated"
        );
      }
      const record = this.getRecoverySession(input.id)!;
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: "recovery-session.activated",
        actor: input.actor,
        target: `recovery-session:${input.id}`,
        detail: { revision: record.revision },
        occurredAt: input.activatedAt
      });
      return record;
    })();
  }

  completeRecoverySession(input: {
    id: string;
    expectedRevision: number;
    actor: string;
    completedAt: string;
    completionPageEpoch: string;
  }): RecoverySessionRecord {
    return this.#db.transaction(() => {
      if (!input.completionPageEpoch.trim()) {
        throw new RecoverySessionConflictError(
          "Recovery Session completion page epoch is required"
        );
      }
      const current = this.getRecoverySession(input.id);
      const result = this.#db.prepare(
        `UPDATE recovery_sessions
         SET state = 'completed', revision = revision + 1,
             completed_at = ?, completion_page_epoch = ?, updated_at = ?
         WHERE recovery_session_id = ? AND state = 'active'
           AND revision = ? AND expires_at > ?`
      ).run(
        input.completedAt,
        input.completionPageEpoch,
        input.completedAt,
        input.id,
        input.expectedRevision,
        input.completedAt
      );
      if (result.changes !== 1 || !current) {
        throw new RecoverySessionConflictError(
          "Recovery Session cannot be completed"
        );
      }
      this.#releaseControlLease(
        "browser_control_leases",
        "resource_id",
        current.leaseResourceId,
        current.leaseOwnerId,
        current.leaseFencingToken,
        input.completedAt
      );
      const record = this.getRecoverySession(input.id)!;
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: "recovery-session.completed",
        actor: input.actor,
        target: `recovery-session:${input.id}`,
        detail: {
          revision: record.revision,
          completionPageEpoch: input.completionPageEpoch
        },
        occurredAt: input.completedAt
      });
      return record;
    })();
  }

  terminateRecoverySession(input: {
    id: string;
    expectedRevision: number;
    nextState: "revoked" | "invalidated";
    actor: string;
    occurredAt: string;
    reason: string;
  }): RecoverySessionRecord {
    return this.#db.transaction(() => {
      if (!input.reason.trim()) {
        throw new RecoverySessionConflictError(
          "Recovery Session terminal reason is required"
        );
      }
      const current = this.getRecoverySession(input.id);
      const result = this.#db.prepare(
        `UPDATE recovery_sessions
         SET state = ?, revision = revision + 1,
             terminal_reason = ?, updated_at = ?
         WHERE recovery_session_id = ? AND state IN ('issued', 'active')
           AND revision = ?`
      ).run(
        input.nextState,
        input.reason,
        input.occurredAt,
        input.id,
        input.expectedRevision
      );
      if (result.changes !== 1 || !current) {
        throw new RecoverySessionConflictError(
          "Recovery Session cannot be terminated"
        );
      }
      this.#releaseControlLease(
        "browser_control_leases",
        "resource_id",
        current.leaseResourceId,
        current.leaseOwnerId,
        current.leaseFencingToken,
        input.occurredAt
      );
      const record = this.getRecoverySession(input.id)!;
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: `recovery-session.${input.nextState}`,
        actor: input.actor,
        target: `recovery-session:${input.id}`,
        detail: { reason: input.reason, revision: record.revision },
        occurredAt: input.occurredAt
      });
      return record;
    })();
  }

  expireRecoverySessions(input: {
    now: string;
    actor: string;
  }): RecoverySessionRecord[] {
    return this.#db.transaction(() => {
      const expiring = this.#db.prepare(
        `SELECT * FROM recovery_sessions
         WHERE state IN ('issued', 'active') AND expires_at <= ?
         ORDER BY expires_at, recovery_session_id`
      ).all(input.now) as SqlRow[];
      const expired: RecoverySessionRecord[] = [];
      for (const row of expiring) {
        const current = this.#readRecoverySession(row);
        const result = this.#db.prepare(
          `UPDATE recovery_sessions
           SET state = 'expired', revision = revision + 1,
               terminal_reason = 'RECOVERY_SESSION_EXPIRED', updated_at = ?
           WHERE recovery_session_id = ? AND revision = ?
             AND state IN ('issued', 'active') AND expires_at <= ?`
        ).run(input.now, current.id, current.revision, input.now);
        if (result.changes !== 1) continue;
        const record = this.getRecoverySession(current.id)!;
        this.#insertAuditRecord({
          id: this.#idFactory(),
          action: "recovery-session.expired",
          actor: input.actor,
          target: `recovery-session:${current.id}`,
          detail: { revision: record.revision },
          occurredAt: input.now
        });
        expired.push(record);
      }
      return expired;
    })();
  }

  getAttentionDelivery(id: string): AttentionDeliveryRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM attention_deliveries WHERE delivery_id = ?")
      .get(id) as SqlRow | undefined;
    return row ? this.#readAttentionDelivery(row) : undefined;
  }

  getAttentionDeliveryForAttention(
    attentionId: string
  ): AttentionDeliveryRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM attention_deliveries WHERE attention_id = ?")
      .get(attentionId) as SqlRow | undefined;
    return row ? this.#readAttentionDelivery(row) : undefined;
  }

  listAttentionDeliveries(input: {
    states?: readonly AttentionDeliveryState[];
    limit: number;
  }): AttentionDeliveryRecord[] {
    const requestedLimit = Number.isSafeInteger(input.limit)
      ? input.limit
      : 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 200);
    const states = [...new Set(input.states ?? [])];
    const rows = (states.length === 0
      ? this.#db
          .prepare(
            `SELECT * FROM attention_deliveries
             ORDER BY created_at DESC, delivery_id
             LIMIT ?`
          )
          .all(limit)
      : this.#db
          .prepare(
            `SELECT * FROM attention_deliveries
             WHERE state IN (${states.map(() => "?").join(",")})
             ORDER BY created_at DESC, delivery_id
             LIMIT ?`
          )
          .all(...states, limit)) as SqlRow[];
    return rows.map((row) => this.#readAttentionDelivery(row));
  }

  claimNextAttentionDelivery(input: {
    leaseId: string;
    leaseOwner: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): AttentionDeliveryRecord | undefined {
    assertTimestamp(input.claimedAt, "claimedAt");
    assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
    if (
      !input.leaseId.trim() ||
      !input.leaseOwner.trim() ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.claimedAt)
    ) {
      throw new Error("Attention delivery lease is invalid");
    }
    return this.#db.transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT delivery_id, revision
           FROM attention_deliveries
           WHERE state = 'pending'
           ORDER BY created_at, delivery_id
           LIMIT 1`
        )
        .get() as SqlRow | undefined;
      if (!row) return undefined;
      const result = this.#db
        .prepare(
          `UPDATE attention_deliveries
           SET state = 'delivering', revision = revision + 1,
               attempt = attempt + 1, lease_id = ?, lease_owner = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE delivery_id = ? AND state = 'pending' AND revision = ?`
        )
        .run(
          input.leaseId,
          input.leaseOwner,
          input.leaseExpiresAt,
          input.claimedAt,
          String(row.delivery_id),
          Number(row.revision)
        );
      if (result.changes !== 1) {
        throw new RevisionConflictError("Attention delivery claim CAS failed");
      }
      return this.getAttentionDelivery(String(row.delivery_id))!;
    })();
  }

  completeAttentionDelivery(input: {
    id: string;
    expectedRevision: number;
    leaseId: string;
    outcome: "delivered" | "failed" | "uncertain";
    completedAt: string;
    lastErrorCode?: string;
    providerReceiptId?: string;
  }): AttentionDeliveryRecord {
    assertTimestamp(input.completedAt, "completedAt");
    assertRevision(input.expectedRevision, "expectedRevision");
    if (
      !input.id.trim() ||
      !input.leaseId.trim() ||
      (input.outcome === "delivered" && input.lastErrorCode !== undefined) ||
      (input.outcome !== "delivered" && !input.lastErrorCode?.trim()) ||
      (input.outcome !== "delivered" && input.providerReceiptId !== undefined) ||
      (input.providerReceiptId !== undefined && !input.providerReceiptId.trim())
    ) {
      throw new Error("Attention delivery outcome is invalid");
    }
    return this.#db.transaction(() => {
      const current = this.getAttentionDelivery(input.id);
      const result = this.#db
        .prepare(
          `UPDATE attention_deliveries
           SET state = ?, revision = revision + 1, lease_id = NULL,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = ?, provider_receipt_id = ?,
               updated_at = ?, completed_at = ?
           WHERE delivery_id = ? AND state = 'delivering'
             AND revision = ? AND lease_id = ?`
        )
        .run(
          input.outcome,
          input.lastErrorCode ?? null,
          input.providerReceiptId ?? null,
          input.completedAt,
          input.completedAt,
          input.id,
          input.expectedRevision,
          input.leaseId
        );
      if (result.changes !== 1 || !current) {
        throw new RevisionConflictError(
          `Attention delivery ${input.id} completion CAS failed`
        );
      }
      const completed = this.getAttentionDelivery(input.id)!;
      this.#insertAuditRecord({
        id: this.#idFactory(),
        action: "attention.delivery.completed",
        actor: `delivery:${current.leaseOwner}`,
        target: `attention-delivery:${input.id}`,
        detail: {
          attentionId: current.attentionId,
          outcome: input.outcome,
          attempt: current.attempt,
          previousRevision: input.expectedRevision,
          revision: completed.revision,
          ...(input.lastErrorCode
            ? { lastErrorCode: input.lastErrorCode }
            : {})
        },
        occurredAt: input.completedAt
      });
      return completed;
    })();
  }

  expireAttentionDeliveryLeases(input: { now: string }): number {
    assertTimestamp(input.now, "now");
    return this.#db.transaction(() => {
      const expired = this.#db
        .prepare(
          `SELECT * FROM attention_deliveries
           WHERE state = 'delivering'
             AND julianday(lease_expires_at) <= julianday(?)
           ORDER BY lease_expires_at, delivery_id`
        )
        .all(input.now) as SqlRow[];
      for (const row of expired) {
        const delivery = this.#readAttentionDelivery(row);
        const result = this.#db
          .prepare(
            `UPDATE attention_deliveries
             SET state = 'uncertain', revision = revision + 1,
                 lease_id = NULL, lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error_code = 'DELIVERY_LEASE_EXPIRED',
                 updated_at = ?, completed_at = ?
             WHERE delivery_id = ? AND state = 'delivering'
               AND revision = ?`
          )
          .run(input.now, input.now, delivery.id, delivery.revision);
        if (result.changes !== 1) {
          throw new RevisionConflictError(
            `Attention delivery ${delivery.id} expiry CAS failed`
          );
        }
        this.#insertAuditRecord({
          id: this.#idFactory(),
          action: "attention.delivery.expired",
          actor: "runtime:delivery-recovery",
          target: `attention-delivery:${delivery.id}`,
          detail: {
            attentionId: delivery.attentionId,
            attempt: delivery.attempt,
            previousRevision: delivery.revision,
            revision: delivery.revision + 1,
            lastErrorCode: "DELIVERY_LEASE_EXPIRED"
          },
          occurredAt: input.now
        });
      }
      return expired.length;
    })();
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
      if (
        ["succeeded", "rejected", "failed", "cancelled", "uncertain"].includes(
          run.status
        )
      ) {
        return run;
      }
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

  #validateResourceBindingSnapshot(
    runId: string,
    plan: RunPlanSnapshotRecord,
    snapshot: ResourceBindingSnapshot
  ): void {
    assertResourceBindingSnapshotForPlan(runId, snapshot, plan.planJson);
    for (const [slotName, binding] of Object.entries(snapshot.bindings)) {
      const session = this.#getBrowserSession(binding.sessionId);
      const page = this.getBrowserPageObservation(
        binding.sessionId,
        binding.tabId
      );
      const normalizedAuthentication =
        page?.authentication === "membership"
          ? "membership"
          : page?.authentication === "authenticated"
            ? "authenticated"
            : "anonymous";
      if (
        !session ||
        !page ||
        page.revision !== binding.revision ||
        page.browserInstanceId !== binding.browserInstanceId ||
        page.observationState !== "ready" ||
        page.pageEpoch !== binding.pageEpoch ||
        page.observerCapabilityId !== binding.observerCapabilityId ||
        page.authenticationContextRef !==
          binding.authenticationContextRef ||
        page.pathname !== binding.pathname ||
        page.origin !== binding.origin ||
        session.capabilityDigest !== binding.capabilityDigest ||
        binding.authentication !== normalizedAuthentication
      ) {
        throw new Error(
          `Resource Binding Snapshot session observation drifted for slot ${slotName}`
        );
      }
    }
  }

  #insertResourceBindingSnapshot(
    snapshot: ResourceBindingSnapshot,
    createdAt: string
  ): void {
    this.#db
      .prepare(
        `INSERT INTO run_resource_binding_snapshots(
          run_id, snapshot_version, snapshot_digest, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.runId,
        snapshot.snapshotVersion,
        digest(snapshot),
        json(snapshot),
        createdAt
      );
    const statement = this.#db.prepare(
      `INSERT INTO run_resource_bindings(
        run_id, slot_name, binding_id, binding_revision, session_id,
        capability_digest, origin, authentication, frozen_at, approved_by,
        requirement_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const slotName of Object.keys(snapshot.bindings).sort()) {
      const binding = snapshot.bindings[slotName]!;
      statement.run(
        snapshot.runId,
        slotName,
        binding.bindingId,
        binding.revision,
        binding.sessionId,
        binding.capabilityDigest,
        binding.origin,
        binding.authentication,
        binding.frozenAt,
        binding.approvedBy,
        json(snapshot.resourceSlots[slotName])
      );
    }
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

  #commitAttentionForTerminal(input: {
    runId: string;
    nextStatus: RunStatus;
    terminalAt: string;
    operationalAttentionMarker?: SucceededRunBusinessAttentionMarker;
    attention?: AttentionRecord;
    attentionDelivery?: AttentionDeliveryRecord;
  }): void {
    const failedTerminal = ["rejected", "failed", "uncertain"].includes(
      input.nextStatus
    );
    const succeededBusinessFinding =
      input.nextStatus === "succeeded" &&
      input.operationalAttentionMarker !== undefined;
    const requiresAttention = failedTerminal || succeededBusinessFinding;
    if (!requiresAttention) {
      if (input.attention || input.attentionDelivery) {
        throw new Error("Run status does not permit an Attention delivery");
      }
      return;
    }
    if (
      !input.attention ||
      input.attention.sourceRef.kind !== "workflow-run" ||
      input.attention.sourceRef.runId !== input.runId ||
      input.attention.deliveryPolicy !== "operator-notification" ||
      input.attention.item.runId !== input.runId ||
      input.attention.state !== "open" ||
      input.attention.revision !== 0 ||
      input.attention.acknowledgedAt !== undefined ||
      input.attention.acknowledgedBy !== undefined ||
      !input.attentionDelivery ||
      input.attentionDelivery.attentionId !== input.attention.item.id ||
      input.attentionDelivery.channel !== "operator-notification" ||
      !input.attentionDelivery.id.trim() ||
      !input.attentionDelivery.idempotencyKey.trim() ||
      input.attentionDelivery.state !== "pending" ||
      input.attentionDelivery.revision !== 0 ||
      input.attentionDelivery.attempt !== 0 ||
      input.attentionDelivery.leaseId !== undefined ||
      input.attentionDelivery.leaseOwner !== undefined ||
      input.attentionDelivery.leaseExpiresAt !== undefined ||
      input.attentionDelivery.lastErrorCode !== undefined ||
      input.attentionDelivery.providerReceiptId !== undefined ||
      input.attentionDelivery.completedAt !== undefined ||
      input.attentionDelivery.createdAt !== input.attention.item.createdAt ||
      input.attentionDelivery.updatedAt !== input.attention.item.createdAt
    ) {
      throw new Error(
        `Terminal Run ${input.runId} requires one new Attention delivery pair`
      );
    }
    if (succeededBusinessFinding) {
      const expected = projectSucceededRunBusinessAttention({
        id: input.runId,
        marker: input.operationalAttentionMarker!,
        updatedAt: input.terminalAt
      });
      if (json(input.attention.item) !== json(expected)) {
        throw new Error(
          "Succeeded Run business Attention must use the controlled projection"
        );
      }
      const run = this.getRun(input.runId);
      if (!run) throw new Error(`Run not found: ${input.runId}`);
      const expectedPayload = {
        attentionId: expected.id,
        runId: input.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        severity: expected.kind,
        title: expected.title,
        requestedAction: expected.requestedAction,
        occurredAt: expected.createdAt
      };
      const expectedIdempotencyKey =
        `attention:${expected.id}:operator-notification`;
      if (
        input.attentionDelivery.id !==
          `delivery:${expectedIdempotencyKey}` ||
        input.attentionDelivery.idempotencyKey !== expectedIdempotencyKey ||
        json(input.attentionDelivery.payload) !== json(expectedPayload)
      ) {
        throw new Error(
          "Succeeded Run business Attention delivery must use the controlled projection"
        );
      }
    }
    assertDigest(input.attentionDelivery.requestDigest, "requestDigest");
    assertJsonCompatible(
      input.attentionDelivery.payload,
      "attention delivery payload"
    );
    const actualRequestDigest = `sha256:${createHash("sha256")
      .update(json(input.attentionDelivery.payload))
      .digest("hex")}`;
    if (input.attentionDelivery.requestDigest !== actualRequestDigest) {
      throw new Error("Attention delivery request digest does not match payload");
    }
    this.#insertAttention(input.attention);
    this.#insertAttentionDelivery(input.attentionDelivery);
  }

  #insertAttention(record: AttentionRecord): void {
    const item = record.item;
    const workflowRunId =
      record.sourceRef.kind === "workflow-run"
        ? record.sourceRef.runId
        : undefined;
    const triggerOccurrenceId =
      record.sourceRef.kind === "trigger-occurrence"
        ? record.sourceRef.occurrenceId
        : undefined;
    if (
      !item.id.trim() ||
      (record.sourceRef.kind === "workflow-run" &&
        (!workflowRunId?.trim() ||
          item.runId !== workflowRunId ||
          record.deliveryPolicy !== "operator-notification")) ||
      (record.sourceRef.kind === "trigger-occurrence" &&
        (!triggerOccurrenceId?.trim() ||
          item.runId !== undefined ||
          record.deliveryPolicy !== "dashboard-only"))
    ) {
      throw new Error("Attention source reference is invalid");
    }
    this.#db
      .prepare(
        `INSERT INTO attention_records(
          attention_id, source_type, workflow_run_id, trigger_occurrence_id,
          delivery_policy,
          stage_key, group_key, kind, source, title, reason, requested_action,
          blocking, batchable,
          attempted_actions_json, resumes_automatically, state, revision,
          created_at, due_at, acknowledged_at, acknowledged_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        record.sourceRef.kind,
        workflowRunId ?? null,
        triggerOccurrenceId ?? null,
        record.deliveryPolicy,
        item.stageKey,
        item.groupKey,
        item.kind,
        item.source,
        item.title,
        item.reason,
        item.requestedAction,
        item.blocking ? 1 : 0,
        item.batchable ? 1 : 0,
        json(item.attemptedActions),
        item.resumesAutomatically ? 1 : 0,
        record.state,
        record.revision,
        item.createdAt,
        item.dueAt ?? null,
        record.acknowledgedAt ?? null,
        record.acknowledgedBy ?? null
      );
  }

  #assertTriggerOccurrenceAttention(
    record: AttentionRecord,
    occurrenceId: string,
    updatedAt: string
  ): void {
    if (
      record.sourceRef.kind !== "trigger-occurrence" ||
      record.sourceRef.occurrenceId !== occurrenceId ||
      record.deliveryPolicy !== "dashboard-only" ||
      record.item.id !== `trigger-occurrence-terminal:${occurrenceId}` ||
      record.item.runId !== undefined ||
      record.item.createdAt !== updatedAt ||
      record.state !== "open" ||
      record.revision !== 0 ||
      record.acknowledgedAt !== undefined ||
      record.acknowledgedBy !== undefined
    ) {
      throw new Error(
        `Trigger Occurrence ${occurrenceId} requires one new dashboard Attention`
      );
    }
  }

  #getAttentionForTriggerOccurrence(
    occurrenceId: string
  ): AttentionRecord | undefined {
    const row = this.#db.prepare(
      `SELECT * FROM attention_records
       WHERE source_type='trigger-occurrence' AND trigger_occurrence_id=?`
    ).get(occurrenceId) as SqlRow | undefined;
    return row ? this.#readAttention(row) : undefined;
  }

  #sameAttentionIdentity(
    left: AttentionRecord,
    right: AttentionRecord
  ): boolean {
    return canonicalJson({
      sourceRef:left.sourceRef,
      deliveryPolicy:left.deliveryPolicy,
      item:left.item
    }) === canonicalJson({
      sourceRef:right.sourceRef,
      deliveryPolicy:right.deliveryPolicy,
      item:right.item
    });
  }

  #insertAttentionDelivery(record: AttentionDeliveryRecord): void {
    this.#db
      .prepare(
        `INSERT INTO attention_deliveries(
          delivery_id, attention_id, channel, idempotency_key,
          request_digest, payload_json, state, revision, attempt,
          lease_id, lease_owner, lease_expires_at, last_error_code,
          provider_receipt_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.attentionId,
        record.channel,
        record.idempotencyKey,
        record.requestDigest,
        json(record.payload),
        record.state,
        record.revision,
        record.attempt,
        record.leaseId ?? null,
        record.leaseOwner ?? null,
        record.leaseExpiresAt ?? null,
        record.lastErrorCode ?? null,
        record.providerReceiptId ?? null,
        record.createdAt,
        record.updatedAt,
        record.completedAt ?? null
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

  #readTriggerSpec(row: SqlRow): TriggerSpecRecord {
    return {
      spec:parseJson(row.spec_json) as TriggerSpecDefinition,
      revision:Number(row.revision),createdAt:String(row.created_at),
      updatedAt:String(row.updated_at),createdBy:String(row.created_by),
      updatedBy:String(row.updated_by)
    };
  }

  #readTriggerOccurrence(row: SqlRow): TriggerOccurrenceRecord {
    return {
      occurrenceId:String(row.occurrence_id),triggerId:String(row.trigger_id),
      triggerVersion:String(row.trigger_version),occurrenceKey:String(row.occurrence_key),
      scheduledAt:String(row.scheduled_at),status:row.status as TriggerOccurrenceStatus,
      ...(row.next_attempt_at == null ? {} : { nextAttemptAt:String(row.next_attempt_at) }),
      attemptCount:Number(row.attempt_count),revision:Number(row.revision),
      ...(row.terminal_outcome == null
        ? {}
        : { terminalOutcome:row.terminal_outcome as TriggerTerminalOutcome }),
      ...(row.dataset_id == null ? {} : { datasetId:String(row.dataset_id) }),
      ...(row.dataset_version == null ? {} : { datasetVersion:String(row.dataset_version) }),
      ...(row.diagnostic == null ? {} : { diagnostic:String(row.diagnostic) }),
      createdAt:String(row.created_at),updatedAt:String(row.updated_at)
    };
  }

  #readTriggerAttempt(row: SqlRow): TriggerAttemptRecord {
    return {
      attemptId:String(row.attempt_id),occurrenceId:String(row.occurrence_id),
      attemptNumber:Number(row.attempt_number),revision:Number(row.revision),
      status:row.status as TriggerAttemptStatus,
      ...(row.terminal_outcome == null
        ? {}
        : { terminalOutcome:row.terminal_outcome as TriggerTerminalOutcome }),
      ...(row.workflow_run_id == null ? {} : { workflowRunId:String(row.workflow_run_id) }),
      ...(row.fencing_token == null ? {} : { fencingToken:Number(row.fencing_token) }),
      ...(row.browser_fencing_token == null
        ? {}
        : { browserFencingToken:Number(row.browser_fencing_token) }),
      ...(row.diagnostic == null ? {} : { diagnostic:String(row.diagnostic) }),
      createdAt:String(row.created_at),updatedAt:String(row.updated_at)
    };
  }

  #readTriggerScheduleState(row: SqlRow): TriggerScheduleStateRecord {
    return {
      triggerId:String(row.trigger_id),triggerVersion:String(row.trigger_version),
      cursorAt:String(row.cursor_at),revision:Number(row.revision),
      createdAt:String(row.created_at),updatedAt:String(row.updated_at)
    };
  }

  #acquireControlLease(
    table: "trigger_leases" | "browser_control_leases",
    keyColumn: "concurrency_key" | "resource_id",
    resourceId: string,
    ownerId: string,
    nowValue: string,
    ttlSeconds: number
  ): BrowserControlLeaseRecord | undefined {
    if (!resourceId.trim() || !ownerId.trim()) throw new Error("Control lease identity is required");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 3600) {
      throw new Error("Control lease TTL must be between 5 and 3600 seconds");
    }
    const expiresAt = new Date(Date.parse(nowValue) + ttlSeconds * 1000).toISOString();
    return this.#db.transaction(() => {
      const existing = this.#db.prepare(
        `SELECT * FROM ${table} WHERE ${keyColumn}=?`
      ).get(resourceId) as SqlRow | undefined;
      if (existing && String(existing.expires_at) > nowValue) return undefined;
      const fencingToken = existing ? Number(existing.fencing_token) + 1 : 1;
      this.#db.prepare(
        `INSERT INTO ${table}(${keyColumn},owner_id,fencing_token,acquired_at,expires_at)
         VALUES (?,?,?,?,?) ON CONFLICT(${keyColumn}) DO UPDATE SET
           owner_id=excluded.owner_id,fencing_token=excluded.fencing_token,
           acquired_at=excluded.acquired_at,expires_at=excluded.expires_at`
      ).run(resourceId,ownerId,fencingToken,nowValue,expiresAt);
      return { resourceId,ownerId,fencingToken,acquiredAt:nowValue,expiresAt };
    })();
  }

  #releaseControlLease(
    table: "trigger_leases" | "browser_control_leases",
    keyColumn: "concurrency_key" | "resource_id",
    resourceId: string,
    ownerId: string,
    fencingToken: number,
    releasedAt: string
  ): boolean {
    const result = this.#db.prepare(
      `UPDATE ${table} SET expires_at=?
       WHERE ${keyColumn}=? AND owner_id=? AND fencing_token=? AND expires_at>?`
    ).run(releasedAt,resourceId,ownerId,fencingToken,releasedAt);
    return result.changes === 1;
  }

  #renewControlLease(
    table: "trigger_leases" | "browser_control_leases",
    keyColumn: "concurrency_key" | "resource_id",
    resourceId: string,
    ownerId: string,
    fencingToken: number,
    nowValue: string,
    ttlSeconds: number
  ): BrowserControlLeaseRecord | undefined {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 3600) {
      throw new Error("Control lease TTL must be between 5 and 3600 seconds");
    }
    const expiresAt = new Date(Date.parse(nowValue) + ttlSeconds * 1000).toISOString();
    const result = this.#db.prepare(
      `UPDATE ${table}
       SET expires_at=CASE WHEN expires_at>? THEN expires_at ELSE ? END
       WHERE ${keyColumn}=? AND owner_id=? AND fencing_token=? AND expires_at>?`
    ).run(expiresAt,expiresAt,resourceId,ownerId,fencingToken,nowValue);
    if (result.changes !== 1) return undefined;
    const row = this.#db.prepare(
      `SELECT * FROM ${table} WHERE ${keyColumn}=?`
    ).get(resourceId) as SqlRow;
    return {
      resourceId,ownerId:String(row.owner_id),fencingToken:Number(row.fencing_token),
      acquiredAt:String(row.acquired_at),expiresAt:String(row.expires_at)
    };
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

  #assertLineageLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Lineage list limit must be between 1 and 200");
    }
  }

  #assertLineageCursor(cursor: EvidenceListCursor | undefined): void {
    if (
      cursor !== undefined &&
      (!Number.isFinite(Date.parse(cursor.createdAt)) ||
        !cursor.id.trim() ||
        cursor.id.length > 200)
    ) {
      throw new Error("Lineage cursor is invalid");
    }
  }

  #assertAfterId(id: string | undefined): void {
    if (id !== undefined && (!id.trim() || id.length > 200)) {
      throw new Error("Lineage after-ID is invalid");
    }
  }

  #assertExportMetadata(value: JsonValue, path = "metadata"): void {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > 4 * 1024) {
        throw new EvidenceConflictError(
          `ExportRecord ${path} contains inline content`
        );
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        this.#assertExportMetadata(item, `${path}[${index}]`)
      );
      return;
    }
    const inlineContentKeys = new Set([
      "body",
      "bytes",
      "content",
      "data",
      "data_base64",
      "dataBase64",
      "blob"
    ]);
    for (const [key, item] of Object.entries(value)) {
      if (inlineContentKeys.has(key)) {
        throw new EvidenceConflictError(
          `ExportRecord ${path}.${key} must be an AssetRef, not inline content`
        );
      }
      this.#assertExportMetadata(item, `${path}.${key}`);
    }
  }

  #boundedUniqueIds(ids: readonly string[]): string[] {
    if (ids.length > 100) {
      throw new Error("A metadata batch can contain at most 100 IDs");
    }
    const unique = [...new Set(ids)];
    if (
      unique.length !== ids.length ||
      unique.some((id) => !id.trim() || id.length > 200)
    ) {
      throw new Error("Metadata batch IDs must be unique bounded identifiers");
    }
    return unique;
  }

  #lineagePage<T>(
    rows: readonly SqlRow[],
    limit: number,
    read: (row: SqlRow) => T,
    cursor: (row: SqlRow) => EvidenceListCursor
  ): EvidenceListPage<T> {
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      records: selected.map(read),
      ...(hasMore
        ? { nextCursor: cursor(selected.at(-1)!) }
        : {})
    };
  }

  #readExportRecord(row: SqlRow): ExportRecord {
    const assetIds = (
      this.#db
        .prepare(
          `SELECT asset_id FROM export_record_assets
           WHERE export_id = ? ORDER BY ordinal`
        )
        .all(String(row.export_id)) as Array<{ asset_id: string }>
    ).map((asset) => asset.asset_id);
    return {
      exportId: String(row.export_id),
      runId: String(row.run_id),
      exportType: row.export_type as ExportRecord["exportType"],
      status: row.status as ExportRecord["status"],
      assetIds,
      metadata: parseJson(row.metadata_json) as JsonValue,
      createdAt: String(row.created_at)
    };
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

  #readAttention(row: SqlRow): AttentionRecord {
    const sourceRef: AttentionRecord["sourceRef"] =
      row.source_type === "workflow-run"
        ? { kind: "workflow-run", runId: String(row.workflow_run_id) }
        : {
            kind: "trigger-occurrence",
            occurrenceId: String(row.trigger_occurrence_id)
          };
    return {
      sourceRef,
      deliveryPolicy: row.delivery_policy as AttentionRecord["deliveryPolicy"],
      item: {
        id: String(row.attention_id),
        ...(sourceRef.kind === "workflow-run"
          ? { runId: sourceRef.runId }
          : {}),
        stageKey: String(row.stage_key),
        groupKey: String(row.group_key),
        kind: row.kind as AttentionRecord["item"]["kind"],
        source: row.source as AttentionRecord["item"]["source"],
        title: String(row.title),
        reason: String(row.reason),
        requestedAction: String(row.requested_action),
        blocking: Boolean(row.blocking),
        batchable: Boolean(row.batchable),
        attemptedActions: parseJson(
          row.attempted_actions_json
        ) as readonly string[],
        resumesAutomatically: Boolean(row.resumes_automatically),
        createdAt: String(row.created_at),
        ...(row.due_at == null ? {} : { dueAt: String(row.due_at) })
      },
      state: row.state as AttentionRecord["state"],
      revision: Number(row.revision),
      ...(row.acknowledged_at == null
        ? {}
        : { acknowledgedAt: String(row.acknowledged_at) }),
      ...(row.acknowledged_by == null
        ? {}
        : { acknowledgedBy: String(row.acknowledged_by) })
    };
  }

  #readAttentionDelivery(row: SqlRow): AttentionDeliveryRecord {
    return {
      id: String(row.delivery_id),
      attentionId: String(row.attention_id),
      channel: "operator-notification",
      idempotencyKey: String(row.idempotency_key),
      requestDigest: String(row.request_digest),
      payload: parseJson(row.payload_json),
      state: row.state as AttentionDeliveryState,
      revision: Number(row.revision),
      attempt: Number(row.attempt),
      ...(row.lease_id == null ? {} : { leaseId: String(row.lease_id) }),
      ...(row.lease_owner == null
        ? {}
        : { leaseOwner: String(row.lease_owner) }),
      ...(row.lease_expires_at == null
        ? {}
        : { leaseExpiresAt: String(row.lease_expires_at) }),
      ...(row.last_error_code == null
        ? {}
        : { lastErrorCode: String(row.last_error_code) }),
      ...(row.provider_receipt_id == null
        ? {}
        : { providerReceiptId: String(row.provider_receipt_id) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.completed_at == null
        ? {}
        : { completedAt: String(row.completed_at) })
    };
  }

  #readRecoverySession(row: SqlRow): RecoverySessionRecord {
    return {
      id: String(row.recovery_session_id),
      attentionId: String(row.attention_id),
      revision: Number(row.revision),
      state: row.state as RecoverySessionState,
      requestedBy: String(row.requested_by),
      browserSessionId: String(row.browser_session_id),
      browserInstanceId: String(row.browser_instance_id),
      profileId: String(row.profile_id),
      tabId: Number(row.tab_id),
      origin: String(row.origin),
      initialPageEpoch: String(row.initial_page_epoch),
      leaseResourceId: String(row.lease_resource_id),
      leaseOwnerId: String(row.lease_owner_id),
      leaseFencingToken: Number(row.lease_fencing_token),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      updatedAt: String(row.updated_at),
      ...(row.activated_at == null
        ? {}
        : { activatedAt: String(row.activated_at) }),
      ...(row.completed_at == null
        ? {}
        : { completedAt: String(row.completed_at) }),
      ...(row.completion_page_epoch == null
        ? {}
        : { completionPageEpoch: String(row.completion_page_epoch) }),
      ...(row.terminal_reason == null
        ? {}
        : { terminalReason: String(row.terminal_reason) })
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

  #assertActiveOperationalExecutionContext(
    runId: string,
    context: OperationalExecutionContext
  ): void {
    const run = this.getRun(runId);
    if (
      !run ||
      ["succeeded", "rejected", "failed", "cancelled", "uncertain"].includes(
        run.status
      )
    ) {
      throw new StaleFencingTokenError(
        `Operational execution Run is not active: ${runId}`
      );
    }
    const checkpoint = this.getEngineCheckpoint(runId);
    const state = checkpoint?.state as
      | {
          runId?: unknown;
          status?: unknown;
          active?: {
            kind?: unknown;
            invocation?: {
              invocationId?: unknown;
              node?: unknown;
              identity?: {
                runId?: unknown;
                scopePath?: unknown;
                iterationKey?: unknown;
                stepKey?: unknown;
                attempt?: unknown;
              };
              idempotencyKey?: unknown;
              fencingToken?: unknown;
            };
          };
        }
      | undefined;
    const invocation =
      state?.active?.kind === "call"
        ? state.active.invocation
        : undefined;
    const identity = invocation?.identity;
    if (
      state?.runId !== runId ||
      state.status !== "waiting_runtime" ||
      invocation?.invocationId !== context.invocationId ||
      identity?.runId !== runId ||
      context.identity.runId !== runId ||
      canonicalJson(invocation?.node) !== canonicalJson(context.node) ||
      canonicalJson(identity?.scopePath) !==
        canonicalJson(context.identity.scopePath) ||
      identity?.iterationKey !== context.identity.iterationKey ||
      identity?.stepKey !== context.identity.stepKey ||
      identity?.attempt !== context.identity.attempt ||
      invocation?.idempotencyKey !== context.idempotencyKey ||
      invocation?.fencingToken !== context.fencingToken ||
      !Number.isSafeInteger(context.identity.attempt) ||
      context.identity.attempt < 1 ||
      !Number.isSafeInteger(context.fencingToken) ||
      context.fencingToken < 1
    ) {
      throw new StaleFencingTokenError(
        `Operational execution context is stale for Run ${runId}`
      );
    }
  }

  #assertActiveTriggerOwnership(runId: string): void {
    const rows = this.#db
      .prepare(
        `SELECT
           attempts.attempt_id, attempts.status AS attempt_status,
           attempts.fencing_token, attempts.browser_fencing_token,
           occurrences.status AS occurrence_status,
           occurrences.trigger_id, occurrences.trigger_version
         FROM trigger_attempts attempts
         INNER JOIN trigger_occurrences occurrences
           ON occurrences.occurrence_id = attempts.occurrence_id
         WHERE attempts.workflow_run_id = ?`
      )
      .all(runId) as SqlRow[];
    if (rows.length === 0) return;
    if (rows.length !== 1) {
      throw new StaleFencingTokenError(
        `Run ${runId} has ambiguous Trigger ownership`
      );
    }
    const row = rows[0]!;
    const attemptId = String(row.attempt_id);
    const triggerToken = Number(row.fencing_token);
    if (
      row.attempt_status !== "running" ||
      row.occurrence_status !== "running" ||
      !attemptId.startsWith("trigger-attempt:") ||
      !Number.isSafeInteger(triggerToken) ||
      triggerToken < 1
    ) {
      throw new StaleFencingTokenError(
        `Trigger Attempt is not active for Run ${runId}`
      );
    }
    const spec = this.getTriggerSpecVersion(
      String(row.trigger_id),
      String(row.trigger_version)
    );
    if (!spec) {
      throw new StaleFencingTokenError(
        `Trigger version is missing for Run ${runId}`
      );
    }
    const nowValue = this.#clock().toISOString();
    const triggerLease = this.#db
      .prepare(
        `SELECT 1 FROM trigger_leases
         WHERE concurrency_key = ? AND owner_id = ? AND fencing_token = ?
           AND expires_at > ?`
      )
      .get(spec.concurrencyKey, attemptId, triggerToken, nowValue);
    if (!triggerLease) {
      throw new StaleFencingTokenError(
        `Trigger concurrency lease was lost for Run ${runId}`
      );
    }
    if (spec.browserInstanceId) {
      const browserToken = Number(row.browser_fencing_token);
      const browserLease =
        Number.isSafeInteger(browserToken) && browserToken >= 1
          ? this.#db
              .prepare(
                `SELECT 1 FROM browser_control_leases
                 WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?
                   AND expires_at > ?`
              )
              .get(
                `browser-instance:${spec.browserInstanceId}`,
                attemptId,
                browserToken,
                nowValue
              )
          : undefined;
      if (!browserLease) {
        throw new StaleFencingTokenError(
          `Browser control lease was lost for Run ${runId}`
        );
      }
    }
  }

  #operationalBusinessAnchor(runId: string): string {
    const occurrenceRows = this.#db
      .prepare(
        `SELECT occurrences.scheduled_at
         FROM trigger_attempts attempts
         INNER JOIN trigger_occurrences occurrences
           ON occurrences.occurrence_id = attempts.occurrence_id
         WHERE attempts.workflow_run_id = ?`
      )
      .all(runId) as Array<{ scheduled_at: string }>;
    if (occurrenceRows.length > 1) {
      throw new StaleFencingTokenError(
        `Run ${runId} has ambiguous business date anchors`
      );
    }
    if (occurrenceRows[0]) return occurrenceRows[0].scheduled_at;
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run.createdAt;
  }

  #readOperationalFact(row: SqlRow): OperationalFactRecord {
    return {
      factKey: String(row.fact_key),
      namespace: String(row.namespace),
      runId: String(row.run_id),
      businessDate: String(row.business_date),
      businessTimeZone: String(row.business_time_zone),
      businessAnchorAt: String(row.business_anchor_at),
      subjectId: String(row.subject_id),
      schemaVersion: String(row.schema_version),
      record: parseJson(row.record_json) as JsonValue,
      recordDigest: String(row.record_digest),
      invocationId: String(row.invocation_id),
      node: parseJson(row.node_json) as OperationalExecutionContext["node"],
      identity: {
        runId: String(row.run_id),
        scopePath: parseJson(row.scope_path_json) as OperationalFactRecord["identity"]["scopePath"],
        iterationKey: String(row.iteration_key),
        stepKey: String(row.step_key),
        attempt: Number(row.attempt)
      },
      idempotencyKey: String(row.idempotency_key),
      fencingToken: Number(row.fencing_token),
      observedAt: String(row.observed_at),
      persistedAt: String(row.persisted_at)
    };
  }

  #assertOperationalDatasetPublicationMarker(
    runId: string,
    output: unknown,
    publicationIntentId: string | undefined,
    nextStatus: RunStatus
  ): void {
    const record =
      output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : undefined;
    const outputMarker = record?.operationalDatasetPublicationIntentId;
    if (publicationIntentId === undefined) {
      if (outputMarker !== undefined) {
        throw new Error(
          "Operational Dataset publication marker must be passed explicitly"
        );
      }
      if (
        nextStatus === "succeeded" &&
        this.getPreparedOperationalDatasetPublication(runId)
      ) {
        throw new Error(
          "Succeeded Run with a prepared Operational Dataset requires its publication marker"
        );
      }
      return;
    }
    if (nextStatus !== "succeeded" && nextStatus !== "uncertain") {
      throw new Error(
        "Operational Dataset publication marker requires a publishable terminal Run"
      );
    }
    if (outputMarker !== publicationIntentId) {
      throw new Error(
        "Operational Dataset publication marker must match terminal output"
      );
    }
  }

  #assertOperationalAttentionMarker(
    output: unknown,
    marker: SucceededRunBusinessAttentionMarker | undefined,
    nextStatus: RunStatus
  ): void {
    const record =
      output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : undefined;
    const outputMarker = record?.operationalAttentionMarker;
    if (marker === undefined) {
      if (outputMarker !== undefined) {
        throw new Error(
          "Operational Attention marker must be passed explicitly"
        );
      }
      return;
    }
    if (nextStatus !== "succeeded") {
      throw new Error(
        "Operational Attention marker requires a succeeded terminal Run"
      );
    }
    const explicit = parseSucceededRunBusinessAttentionMarker(marker);
    const projected = parseSucceededRunBusinessAttentionMarker(outputMarker);
    if (
      explicit.version !== projected.version ||
      explicit.kind !== projected.kind ||
      explicit.code !== projected.code
    ) {
      throw new Error(
        "Operational Attention marker must match terminal output"
      );
    }
  }

  #publishPreparedOperationalDataset(
    runId: string,
    terminalStatus: "succeeded" | "uncertain",
    publicationIntentId: string
  ): void {
    const prepared = this.getPreparedOperationalDatasetPublication(runId);
    if (!prepared || prepared.publicationIntentId !== publicationIntentId) {
      throw new RevisionConflictError(
        `Operational Dataset publication intent does not match Run ${runId}`
      );
    }
    this.#assertActiveTriggerOwnership(runId);
    if (prepared.quality === "partial" && terminalStatus !== "uncertain") {
      throw new Error("Partial Operational Dataset requires uncertain Run");
    }
    const facts = prepared.factKeys.map((factKey) => {
      const fact = this.getOperationalFact(factKey);
      if (!fact || fact.runId !== runId) {
        throw new Error(
          `Prepared Operational Dataset lost Run fact ${factKey}`
        );
      }
      return fact;
    });
    const records = facts.map((fact) => fact.record);
    if (
      records.length === 0 ||
      prepared.dataset.recordCount !== records.length ||
      prepared.dataset.recordsDigest !== digest(records) ||
      new Set(facts.map((fact) => fact.businessDate)).size !== 1 ||
      facts[0]?.businessDate !== prepared.businessDate
    ) {
      throw new Error("Prepared Operational Dataset facts changed");
    }
    assertOperationalCoverage(
      prepared.quality,
      prepared.coverage,
      records.length
    );
    this.publishDataset({
      stagingId: prepared.stagingId,
      expectedState: "validated",
      dataset: prepared.dataset,
      normalizedRecords: records,
      audit: prepared.audit
    });
    this.#inject("operational_dataset_publication.after_dataset");
    this.#db
      .prepare(
        `INSERT INTO operational_dataset_publication_lineage(
          dataset_id, dataset_version, run_id, terminal_status, quality,
          business_date, coverage_json, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        prepared.dataset.metadata.id,
        prepared.dataset.metadata.version,
        runId,
        terminalStatus,
        prepared.quality,
        prepared.businessDate,
        json(prepared.coverage),
        prepared.audit.occurredAt
      );
    const insertFact = this.#db.prepare(
      `INSERT INTO operational_dataset_publication_facts(
        dataset_id, dataset_version, fact_key, ordinal
      ) VALUES (?, ?, ?, ?)`
    );
    prepared.factKeys.forEach((factKey, ordinal) => {
      insertFact.run(
        prepared.dataset.metadata.id,
        prepared.dataset.metadata.version,
        factKey,
        ordinal
      );
    });
    const consumed = this.#db
      .prepare(
        "DELETE FROM operational_dataset_publication_intents WHERE run_id = ?"
      )
      .run(runId);
    if (consumed.changes !== 1) {
      throw new RevisionConflictError(
        `Operational Dataset intent changed for Run ${runId}`
      );
    }
    this.#inject("operational_dataset_publication.after_lineage");
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

  #readAuthoringScenario(row: SqlRow): AuthoringScenarioRecord {
    return {
      scenario: parseJson(
        row.canonical_json
      ) as AuthoringScenarioRecord["scenario"],
      digest: String(row.scenario_digest),
      createdAt: String(row.created_at)
    };
  }

  #readAuthoringSession(row: SqlRow): AuthoringSessionDefinition {
    return parseJson(row.canonical_json) as AuthoringSessionDefinition;
  }

  #readAuthoringSessionRevision(
    row: SqlRow
  ): AuthoringSessionRevisionRecord {
    return {
      sessionId: String(row.session_id),
      revision: Number(row.revision),
      ...(row.operation_id == null
        ? {}
        : { operationId: String(row.operation_id) }),
      ...(row.operation_digest == null
        ? {}
        : { operationDigest: String(row.operation_digest) }),
      session: parseJson(
        row.canonical_json
      ) as AuthoringSessionDefinition,
      createdAt: String(row.created_at)
    };
  }

  #readDesignModeGrant(row: SqlRow): DesignModeGrantRecord {
    return {
      grantId: String(row.grant_id),
      authoringSessionId: String(row.authoring_session_id),
      revision: Number(row.revision),
      state: row.state as DesignModeGrantRecord["state"],
      approvedBy: String(row.approved_by),
      browserSessionId: String(row.browser_session_id),
      profileId: String(row.profile_id),
      tabId: Number(row.tab_id),
      origin: String(row.origin),
      pageEpoch: String(row.page_epoch),
      allowedOperations: parseJson(
        row.allowed_operations_json
      ) as DesignModeGrantRecord["allowedOperations"],
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      updatedAt: String(row.updated_at),
      ...(row.terminal_reason == null
        ? {}
        : { terminalReason: String(row.terminal_reason) })
    };
  }

  #readCandidateBundle(row: SqlRow): CandidateBundleRecord {
    return {
      bundle: parseJson(
        row.canonical_json
      ) as CandidateBundleRecord["bundle"],
      digest: String(row.record_digest),
      createdAt: String(row.created_at)
    };
  }

  #readCandidateBundleValidation(
    row: SqlRow
  ): CandidateBundleValidationRecord {
    return {
      bundleId: String(row.bundle_id),
      checkType:
        row.check_type as CandidateBundleValidationRecord["checkType"],
      valid: Number(row.valid) === 1,
      issueCount: Number(row.issue_count),
      ...(row.report_asset_id == null
        ? {}
        : { reportAssetId: String(row.report_asset_id) }),
      createdAt: String(row.created_at)
    };
  }

  #readCandidateExport(row: SqlRow): CandidateExportRecord {
    return {
      exportId: String(row.export_id),
      bundleId: String(row.bundle_id),
      bundleDigest: String(row.bundle_digest),
      archiveDigest: String(row.archive_digest),
      manifestDigest: String(row.manifest_digest),
      destinationRef: String(row.destination_ref),
      actor: String(row.actor),
      createdAt: String(row.created_at)
    };
  }

  #assertAuthoringSession(session: AuthoringSessionDefinition): void {
    assertSchema(
      validateAuthoringSession(session),
      validateAuthoringSession.errors,
      "AuthoringSession"
    );
    assertAuthoringId(session.sessionId, "sessionId");
    assertRevision(session.revision, "revision");
    assertTimestamp(session.createdAt, "createdAt");
    assertTimestamp(session.updatedAt, "updatedAt");
  }

  #assertAuthoringMutation(input: ApplyAuthoringSessionInput): void {
    assertAuthoringId(input.sessionId, "sessionId");
    assertAuthoringId(input.operationId, "operationId");
    assertRevision(input.expectedRevision, "expectedRevision");
    assertAuthoringId(input.actor, "actor");
    this.#assertAuthoringSession(input.next);
    if (
      input.next.sessionId !== input.sessionId ||
      input.next.revision !== input.expectedRevision + 1
    ) {
      throw new AuthoringConflictError(
        "Authoring Session mutation identity or next revision is invalid"
      );
    }
    if (
      input.next.appliedOperationIds.filter(
        (operationId) => operationId === input.operationId
      ).length !== 1
    ) {
      throw new AuthoringConflictError(
        "Authoring Session must record the exact operation id once"
      );
    }
  }

  #applyAuthoringSessionInTransaction(
    input: ApplyAuthoringSessionInput
  ): ApplyAuthoringSessionResult {
    const operationDigest = digest({
      expectedRevision: input.expectedRevision,
      next: input.next,
      actor: input.actor
    });
    const replay = this.#db
      .prepare(
        `SELECT * FROM authoring_session_revisions
         WHERE session_id = ? AND operation_id = ?`
      )
      .get(input.sessionId, input.operationId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.operation_digest) !== operationDigest) {
        throw new AuthoringOperationConflictError(
          `Authoring operation payload changed: ${input.operationId}`
        );
      }
      const revision = this.#readAuthoringSessionRevision(replay);
      return {
        status: "duplicate",
        current: revision.session,
        revision
      };
    }
    const current = this.getAuthoringSession(input.sessionId);
    if (!current) {
      throw new AuthoringConflictError(
        `Authoring Session does not exist: ${input.sessionId}`
      );
    }
    if (current.revision !== input.expectedRevision) {
      return {
        status: "stale",
        actualRevision: current.revision
      };
    }
    if (
      current.createdAt !== input.next.createdAt ||
      canonicalJson(current.scenarioRef) !==
        canonicalJson(input.next.scenarioRef) ||
      canonicalJson(current.actor) !== canonicalJson(input.next.actor)
    ) {
      throw new AuthoringConflictError(
        "Authoring Session immutable identity fields changed"
      );
    }
    if (
      current.appliedOperationIds.some(
        (operationId) =>
          !input.next.appliedOperationIds.includes(operationId)
      ) ||
      current.designGrantRefs.some(
        (grantId) => !input.next.designGrantRefs.includes(grantId)
      ) ||
      current.snapshotRefs.some(
        (reference) =>
          !input.next.snapshotRefs.some(
            (candidate) =>
              candidate.id === reference.id &&
              candidate.digest === reference.digest
          )
      )
    ) {
      throw new AuthoringConflictError(
        "Authoring Session durable references are append-only"
      );
    }
    if (!this.#canTransitionAuthoringSession(current.state, input.next.state)) {
      throw new AuthoringConflictError(
        `Invalid Authoring Session transition: ${current.state} -> ${input.next.state}`
      );
    }
    const canonical = authoringJson(input.next);
    const updated = this.#db
      .prepare(
        `UPDATE authoring_sessions
         SET revision = ?, state = ?, canonical_json = ?, updated_at = ?
         WHERE session_id = ? AND revision = ?`
      )
      .run(
        input.next.revision,
        input.next.state,
        canonical,
        input.next.updatedAt,
        input.sessionId,
        input.expectedRevision
      );
    if (updated.changes !== 1) {
      const latest = this.getAuthoringSession(input.sessionId);
      return {
        status: "stale",
        actualRevision: latest?.revision ?? input.expectedRevision
      };
    }
    this.#inject("authoring.session.apply.after_current");
    this.#db
      .prepare(
        `INSERT INTO authoring_session_revisions(
          session_id, revision, operation_id, operation_digest,
          state, canonical_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.next.revision,
        input.operationId,
        operationDigest,
        input.next.state,
        canonical,
        input.next.updatedAt
      );
    this.#inject("authoring.session.apply.after_history");
    this.#insertAudit(
      "authoring.session.revised",
      input.actor,
      `authoring-session:${input.sessionId}`,
      {
        operationId: input.operationId,
        previousRevision: input.expectedRevision,
        revision: input.next.revision,
        state: input.next.state
      }
    );
    this.#inject("authoring.session.apply.after_audit");
    return {
      status: "accepted",
      current: this.getAuthoringSession(input.sessionId)!,
      revision: this.getAuthoringSessionRevision(
        input.sessionId,
        input.next.revision
      )!
    };
  }

  #canTransitionAuthoringSession(
    current: AuthoringSessionDefinition["state"],
    next: AuthoringSessionDefinition["state"]
  ): boolean {
    if (current === next) {
      return !["candidate", "closed", "failed"].includes(current);
    }
    if (
      !["candidate", "closed", "failed"].includes(current) &&
      next === "failed"
    ) {
      return true;
    }
    const transitions: Record<
      AuthoringSessionDefinition["state"],
      readonly AuthoringSessionDefinition["state"][]
    > = {
      intake: ["catalog"],
      catalog: ["discovery", "assembly"],
      discovery: ["modeling"],
      modeling: ["assembly"],
      assembly: ["validation"],
      validation: ["assembly", "candidate"],
      candidate: ["closed"],
      closed: [],
      failed: []
    };
    return transitions[current].includes(next);
  }

  #assertDesignModeGrant(grant: DesignModeGrantRecord): void {
    assertAuthoringId(grant.grantId, "grantId");
    assertAuthoringId(grant.authoringSessionId, "authoringSessionId");
    assertRevision(grant.revision, "revision");
    assertAuthoringId(grant.approvedBy, "approvedBy");
    assertAuthoringId(grant.browserSessionId, "browserSessionId");
    if (!grant.profileId.trim() || grant.profileId.length > 300) {
      throw new Error("profileId must be a 1-300 character identifier");
    }
    if (!Number.isSafeInteger(grant.tabId) || grant.tabId < 0) {
      throw new Error("tabId must be a non-negative safe integer");
    }
    assertHttpsOrigin(grant.origin, "origin");
    if (!grant.pageEpoch.trim() || grant.pageEpoch.length > 300) {
      throw new Error("pageEpoch must be a 1-300 character identifier");
    }
    assertTimestamp(grant.issuedAt, "issuedAt");
    assertTimestamp(grant.expiresAt, "expiresAt");
    assertTimestamp(grant.updatedAt, "updatedAt");
    const duration =
      Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
    if (duration <= 0 || duration > 15 * 60 * 1000) {
      throw new DesignModeGrantConflictError(
        "Design Mode Grant TTL must be positive and at most 15 minutes"
      );
    }
    const operations = new Set(grant.allowedOperations);
    if (
      operations.size !== grant.allowedOperations.length ||
      !operations.has("semantic_snapshot") ||
      [...operations].some(
        (operation) =>
          operation !== "semantic_snapshot" &&
          operation !== "screenshot_once"
      )
    ) {
      throw new DesignModeGrantConflictError(
        "Design Mode Grant operations are invalid"
      );
    }
  }

  #canTransitionDesignModeGrant(
    current: DesignModeGrantRecord["state"],
    next: DesignModeGrantRecord["state"]
  ): boolean {
    if (current === "requested") {
      return [
        "active",
        "stopped",
        "expired",
        "revoked",
        "invalidated"
      ].includes(next);
    }
    if (current === "active") {
      return [
        "stopped",
        "expired",
        "revoked",
        "invalidated"
      ].includes(next);
    }
    return false;
  }

  #assertSnapshotOwnership(
    authoringSessionId: string,
    snapshot: PageSnapshotDefinition
  ): void {
    const grant = this.getDesignModeGrant(
      snapshot.binding.designGrantId
    );
    if (
      !grant ||
      grant.authoringSessionId !== authoringSessionId ||
      grant.state !== "active"
    ) {
      throw new DesignModeGrantConflictError(
        "PageSnapshot requires an active Design Mode Grant"
      );
    }
    if (
      Date.parse(snapshot.capturedAt) < Date.parse(grant.issuedAt) ||
      Date.parse(snapshot.capturedAt) >= Date.parse(grant.expiresAt)
    ) {
      throw new DesignModeGrantConflictError(
        "PageSnapshot was captured outside the Design Mode Grant"
      );
    }
    if (
      grant.browserSessionId !== snapshot.binding.browserSessionId ||
      grant.profileId !== snapshot.binding.profileId ||
      grant.tabId !== snapshot.binding.tabId ||
      grant.origin !== snapshot.origin ||
      grant.pageEpoch !== snapshot.binding.pageEpoch
    ) {
      throw new DesignModeGrantConflictError(
        "PageSnapshot does not match the exact Design Mode binding"
      );
    }
    const evidence = this.#db
      .prepare("SELECT * FROM evidence_transfers WHERE evidence_id = ?")
      .get(snapshot.captureSource.evidenceId) as SqlRow | undefined;
    if (
      !evidence ||
      !["acknowledged", "linked"].includes(String(evidence.state)) ||
      String(evidence.run_id) !== snapshot.captureSource.runId ||
      String(evidence.node_execution_id) !==
        snapshot.captureSource.nodeExecutionId ||
      String(evidence.session_id) !== snapshot.binding.browserSessionId ||
      String(evidence.digest) !== snapshot.captureSource.assetRef.digest
    ) {
      throw new AuthoringConflictError(
        "PageSnapshot Evidence provenance is incomplete or foreign"
      );
    }
    const asset = this.#db
      .prepare(
        `SELECT
           asset_id, digest, classification, retention_policy, retain_until
         FROM asset_records
         WHERE asset_id = ?`
      )
      .get(snapshot.captureSource.assetRef.id) as SqlRow | undefined;
    if (
      !asset ||
      String(asset.digest) !== snapshot.captureSource.assetRef.digest
    ) {
      throw new AuthoringConflictError(
        "PageSnapshot Asset provenance is incomplete or foreign"
      );
    }
    if (
      String(asset.classification) !== snapshot.classification ||
      String(asset.retention_policy) !== "restricted_24h" ||
      asset.retain_until == null ||
      Date.parse(String(asset.retain_until)) >
        Date.parse(snapshot.capturedAt) + 24 * 60 * 60 * 1000
    ) {
      throw new AuthoringConflictError(
        "PageSnapshot Asset retention or classification is invalid"
      );
    }
    const rawLifetime =
      Date.parse(snapshot.rawEvidenceExpiresAt) -
      Date.parse(snapshot.capturedAt);
    if (rawLifetime <= 0 || rawLifetime > 24 * 60 * 60 * 1000) {
      throw new AuthoringConflictError(
        "PageSnapshot raw Evidence retention exceeds 24 hours"
      );
    }
    if (snapshot.screenshotEvidenceRef) {
      if (!grant.allowedOperations.includes("screenshot_once")) {
        throw new DesignModeGrantConflictError(
          "Screenshot capture was not approved for this Design Mode Grant"
        );
      }
      const priorScreenshot = this.#db
        .prepare(
          `SELECT 1 FROM authoring_page_snapshots
           WHERE design_grant_id = ?
             AND json_type(canonical_json, '$.screenshotEvidenceRef')
               IS NOT NULL
           LIMIT 1`
        )
        .get(grant.grantId);
      if (priorScreenshot) {
        throw new DesignModeGrantConflictError(
          "The one-time screenshot approval was already consumed"
        );
      }
      const screenshot = this.#db
        .prepare(
          `SELECT * FROM evidence_transfers WHERE evidence_id = ?`
        )
        .get(snapshot.screenshotEvidenceRef.id) as SqlRow | undefined;
      if (
        !screenshot ||
        !["acknowledged", "linked"].includes(String(screenshot.state)) ||
        String(screenshot.session_id) !==
          snapshot.binding.browserSessionId ||
        String(screenshot.digest) !==
          snapshot.screenshotEvidenceRef.digest ||
        Number(screenshot.size) !==
          snapshot.screenshotEvidenceRef.sizeBytes ||
        !["restricted", "confidential"].includes(
          String(screenshot.classification)
        )
      ) {
        throw new AuthoringConflictError(
          "Screenshot Evidence provenance is incomplete or foreign"
        );
      }
    }
  }

  #assertCandidateBundleInput(
    input: SaveCandidateBundleInput,
    recordDigest: string
  ): void {
    const bundle = input.bundle;
    if (
      bundle.authoringSession.id !== input.sessionId ||
      bundle.authoringSession.revision !== input.expectedRevision
    ) {
      throw new CandidateBundleConflictError(
        "Candidate Bundle source revision does not match the mutation"
      );
    }
    if (
      input.next.state !== "candidate" ||
      input.next.candidateBundleRef?.id !== bundle.metadata.id ||
      input.next.candidateBundleRef?.digest !== recordDigest
    ) {
      throw new CandidateBundleConflictError(
        "Candidate Session transition does not reference the exact bundle"
      );
    }
    const expectedTypes = [
      "contracts",
      "permissions",
      "replay",
      "risk",
      "schema"
    ] as const;
    const receivedTypes = input.validationResults
      .map((item) => item.checkType)
      .sort();
    if (
      receivedTypes.length !== expectedTypes.length ||
      receivedTypes.some((item, index) => item !== expectedTypes[index])
    ) {
      throw new CandidateBundleConflictError(
        "Candidate Bundle requires exactly one result for every validation check"
      );
    }
    for (const validation of input.validationResults) {
      assertTimestamp(validation.createdAt, "validation.createdAt");
      const summary = bundle.validation[validation.checkType];
      if (
        validation.bundleId !== bundle.metadata.id ||
        validation.valid !== summary.valid ||
        validation.issueCount !== summary.issueCount
      ) {
        throw new CandidateBundleConflictError(
          `Candidate validation mismatch: ${validation.checkType}`
        );
      }
    }
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
        : { disconnectedAt: String(row.disconnected_at) }),
      ...(Number(row.observation_revision ?? 0) === 0 &&
      String(row.observation_state ?? "unknown") === "unknown"
        ? {}
        : {
            observationRevision: Number(row.observation_revision),
            observationState: String(
              row.observation_state
            ) as NonNullable<BrowserSessionRecord["observationState"]>
          }),
      ...(row.session_role == null
        ? {}
        : {
            role: String(
              row.session_role
            ) as NonNullable<BrowserSessionRecord["role"]>
          }),
      ...(row.observed_origin == null
        ? {}
        : { observedOrigin: String(row.observed_origin) }),
      ...(row.observed_authentication == null
        ? {}
        : {
            observedAuthentication: String(
              row.observed_authentication
            ) as ResourceAuthentication
          }),
      ...(row.observed_at == null
        ? {}
        : { observedAt: String(row.observed_at) })
    };
  }

  #assertExternalDomainLeaseBinding(input: {
    requestId: string;
    expectedRevision: number;
    fencingToken: number;
    serverNow: string;
    expiresAt: string;
    updatedAt: string;
  }): void {
    assertAuthoringId(input.requestId, "requestId");
    assertRevision(input.expectedRevision, "expectedRevision");
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error("fencingToken must be a positive safe integer");
    }
    assertTimestamp(input.serverNow, "serverNow");
    assertTimestamp(input.expiresAt, "expiresAt");
    assertTimestamp(input.updatedAt, "updatedAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.serverNow)) {
      throw new Error("External domain lease expiresAt must be after serverNow");
    }
  }

  #readExternalDomainLease(row: SqlRow): ExternalDomainLeaseRecord {
    return {
      requestId: String(row.request_id),
      providerId: String(row.provider_id),
      domainKey: String(row.domain_key),
      occurrenceId: String(row.occurrence_id),
      ownerId: String(row.proposed_owner_id),
      ...(row.trigger_attempt_id == null
        ? {}
        : { triggerAttemptId: String(row.trigger_attempt_id) }),
      ...(row.workflow_run_id == null
        ? {}
        : { runId: String(row.workflow_run_id) }),
      state: String(row.state) as ExternalDomainLeaseRecord["state"],
      revision: Number(row.revision),
      ...(row.fencing_token == null
        ? {}
        : { fencingToken: Number(row.fencing_token) }),
      ...(row.server_now == null ? {} : { serverNow: String(row.server_now) }),
      ...(row.expires_at == null ? {} : { expiresAt: String(row.expires_at) }),
      ...(row.diagnostic == null
        ? {}
        : { diagnostic: String(row.diagnostic) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.reconciliation_required_at == null
        ? {}
        : {
            reconciliationRequiredAt: String(
              row.reconciliation_required_at
            )
          }),
      ...(row.released_at == null
        ? {}
        : { releasedAt: String(row.released_at) })
    };
  }

  #readInventoryEffectReconciliation(
    row: SqlRow
  ): InventoryEffectReconciliationRecord {
    return {
      requestId:String(row.request_id),
      resolutionToken:String(row.resolution_token),
      runId:String(row.workflow_run_id),
      ownerId:String(row.owner_id),
      fencingToken:Number(row.fencing_token),
      leaseRevision:Number(row.lease_revision),
      expectedEffectSetDigest:String(row.expected_effect_set_digest),
      remoteReportDigest:String(row.remote_report_digest),
      expectedEffectCount:Number(row.expected_effect_count),
      remoteEffectCount:Number(row.remote_effect_count),
      succeededEffectCount:Number(row.succeeded_effect_count),
      failedEffectCount:Number(row.failed_effect_count),
      missingEffectCount:Number(row.missing_effect_count),
      succeededItemCount:Number(row.succeeded_item_count),
      failedItemCount:Number(row.failed_item_count),
      classification:String(row.classification) as
        InventoryEffectReconciliationClassification,
      inspectedAt:String(row.inspected_at),
      resolvedAt:String(row.resolved_at),
      resolvedBy:String(row.resolved_by)
    };
  }

  #readBrowserPageObservation(row: SqlRow): BrowserPageObservationRecord {
    return {
      sessionId: String(row.session_id),
      browserInstanceId: String(row.browser_instance_id),
      tabId: Number(row.tab_id),
      ...(row.window_id == null ? {} : { windowId: Number(row.window_id) }),
      origin: String(row.origin),
      pathname: String(row.pathname),
      contentScriptReady: Number(row.content_script_ready) === 1,
      authentication:
        String(row.authentication) as BrowserPageObservationRecord["authentication"],
      ...(row.authentication_context_ref == null
        ? {}
        : {
            authenticationContextRef: String(
              row.authentication_context_ref
            )
          }),
      observationState:
        String(
          row.observation_state
        ) as BrowserPageObservationRecord["observationState"],
      pageEpoch: String(row.page_epoch),
      observerCapabilityId: String(row.observer_capability_id),
      revision: Number(row.revision),
      observedAt: String(row.observed_at),
      ...(row.reason_code == null
        ? {}
        : { reasonCode: String(row.reason_code) })
    };
  }
}

export * from "./migrations.js";
