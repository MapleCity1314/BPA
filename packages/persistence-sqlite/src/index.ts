import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  ArtifactConflictError,
  RevisionConflictError,
  type ArtifactRecord,
  type ArtifactType,
  type AuditRecord,
  type BrowserCapabilityRecord,
  type BrowserSessionRecord,
  type CreateRunInput,
  type ExecutionEventRecord,
  type GatewayCommandRecord,
  type NodeExecutionRecord,
  type OpenBrowserSessionInput,
  type NodeTransitionInput,
  type OutboxMessage,
  type Persistence,
  type PublishArtifactInput,
  type RunRecord,
  type RunTransitionInput
} from "@bpa/persistence";
import { migrations } from "./migrations.js";

type SqlRow = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  return value == null ? undefined : JSON.parse(String(value));
}

function now(): string {
  return new Date().toISOString();
}

export interface SqlitePersistenceOptions {
  path: string;
  readonly?: boolean;
}

export class SqlitePersistence implements Persistence {
  readonly #db: Database.Database;

  constructor(options: SqlitePersistenceOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    }
    this.#db = new Database(options.path, {
      readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false,
      timeout: 5_000
    });
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    if (!(options.readonly ?? false)) {
      this.#db.pragma("journal_mode = WAL");
      this.#migrate();
    }
  }

  #migrate(): void {
    const hasMigrations = this.#db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      )
      .get();
    let current = 0;
    if (hasMigrations) {
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };
      current = row.version;
    }
    for (const migration of migrations.filter(
      (candidate) => candidate.version > current
    )) {
      this.#db.transaction(() => {
        this.#db.exec(migration.sql);
        this.#db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
          )
          .run(migration.version, now());
      })();
    }
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
      this.#db
        .prepare(
          `INSERT INTO workflow_runs(
            id, workflow_id, workflow_version, workflow_digest, status,
            revision, input_json, output_json, current_node_key, created_at, updated_at
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
      this.#insertEvent(input.event);
      return run;
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
        `SELECT gateway_commands.*
         FROM gateway_commands
         INNER JOIN node_executions
           ON node_executions.id = gateway_commands.node_execution_id
         WHERE node_executions.run_id = ?
         ORDER BY gateway_commands.command_seq`
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
      .run(randomUUID(), action, actor, target, json(detail), now());
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
