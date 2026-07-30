export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE artifacts (
        record_id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        version TEXT NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'published')),
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        UNIQUE (asset_type, asset_id, version, status)
      ) STRICT;

      CREATE UNIQUE INDEX artifacts_published_identity
        ON artifacts(asset_type, asset_id, version)
        WHERE status = 'published';

      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        workflow_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        current_node_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE node_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        node_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_version TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        fencing_token INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE execution_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        node_execution_id TEXT REFERENCES node_executions(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      ) STRICT;

      CREATE TABLE idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        node_execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE engine_outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      ) STRICT;

      CREATE TABLE engine_inbox (
        message_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE gateway_commands (
        id TEXT PRIMARY KEY,
        node_execution_id TEXT NOT NULL UNIQUE,
        command_seq INTEGER NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE gateway_outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      ) STRICT;

      CREATE TABLE gateway_inbox (
        message_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE browser_sessions (
        id TEXT PRIMARY KEY,
        browser_instance_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        extension_version TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        capability_digest TEXT,
        connected_at TEXT NOT NULL,
        disconnected_at TEXT
      ) STRICT;

      CREATE TABLE browser_capabilities (
        session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_version TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id, node_version)
      ) STRICT;

      CREATE TABLE leases (
        resource_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        fencing_token INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE evidence_metadata (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_execution_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_ref TEXT,
        classification TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE TABLE audit_records (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        target TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE browser_sessions ADD COLUMN outgoing_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE browser_sessions ADD COLUMN last_acked_command_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE browser_sessions ADD COLUMN resume_token_digest TEXT;
      ALTER TABLE browser_sessions ADD COLUMN resume_token_expires_at TEXT;

      CREATE UNIQUE INDEX browser_sessions_resume_token
        ON browser_sessions(resume_token_digest)
        WHERE resume_token_digest IS NOT NULL;
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
      ALTER TABLE engine_inbox ADD COLUMN aggregate_id TEXT NOT NULL DEFAULT '';

      CREATE TABLE run_plan_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        ir_version TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        workflow_source_digest TEXT NOT NULL,
        artifact_closure_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        risk_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE execution_scopes (
        scope_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        scope_path TEXT NOT NULL,
        parent_scope_id TEXT REFERENCES execution_scopes(scope_id) ON DELETE RESTRICT,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('root', 'call', 'foreach')),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, scope_path)
      ) STRICT;

      CREATE TABLE iteration_instances (
        iteration_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        scope_id TEXT NOT NULL REFERENCES execution_scopes(scope_id) ON DELETE RESTRICT,
        iteration_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_id, iteration_key)
      ) STRICT;

      CREATE TABLE step_instances (
        step_instance_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        scope_id TEXT NOT NULL REFERENCES execution_scopes(scope_id) ON DELETE RESTRICT,
        iteration_id TEXT REFERENCES iteration_instances(iteration_id) ON DELETE RESTRICT,
        step_key TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        execution_identity TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        input_json TEXT NOT NULL,
        output_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE assistance_tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        step_instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        fencing_counter INTEGER NOT NULL CHECK (fencing_counter >= 0),
        canonical_json TEXT NOT NULL,
        private_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX assistance_tasks_run_status
        ON assistance_tasks(run_id, status);

      CREATE TABLE dataset_staging (
        staging_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        profile_version TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('staged', 'validated', 'rejected', 'published')
        ),
        validation_report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE dataset_versions (
        dataset_id TEXT NOT NULL,
        version TEXT NOT NULL,
        records_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        staging_id TEXT NOT NULL UNIQUE
          REFERENCES dataset_staging(staging_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(dataset_id, version)
      ) STRICT;

      CREATE TABLE dataset_record_index (
        dataset_id TEXT NOT NULL,
        version TEXT NOT NULL,
        record_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        record_digest TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY(dataset_id, version, record_key),
        UNIQUE(dataset_id, version, ordinal),
        FOREIGN KEY(dataset_id, version)
          REFERENCES dataset_versions(dataset_id, version) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE decision_records (
        decision_id TEXT PRIMARY KEY,
        decision_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'superseded', 'revoked')
        ),
        scope_digest TEXT NOT NULL,
        preconditions_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX decision_records_active_identity
        ON decision_records(decision_type, scope_digest, preconditions_digest)
        WHERE status = 'active';
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE assistance_task_request_results (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL
          REFERENCES assistance_tasks(task_id) ON DELETE RESTRICT,
        expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
        expected_fencing_counter INTEGER NOT NULL
          CHECK (expected_fencing_counter >= 0),
        result_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX assistance_task_request_results_task
        ON assistance_task_request_results(task_id, recorded_at);

      CREATE INDEX assistance_tasks_status_mode_created
        ON assistance_tasks(
          status,
          json_extract(canonical_json, '$.mode'),
          created_at,
          task_id
        );

      CREATE INDEX assistance_tasks_owner_type_created
        ON assistance_tasks(
          json_extract(private_state_json, '$.ownerType'),
          created_at,
          task_id
        );
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE engine_checkpoints (
        run_id TEXT PRIMARY KEY
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        state_version TEXT NOT NULL,
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 6,
    sql: `
      CREATE TABLE workflow_drafts (
        draft_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE workflow_draft_revisions (
        draft_id TEXT NOT NULL
          REFERENCES workflow_drafts(draft_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        operation_id TEXT,
        operation_digest TEXT,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(draft_id, revision),
        UNIQUE(draft_id, operation_id),
        CHECK (
          (revision = 0 AND operation_id IS NULL AND operation_digest IS NULL)
          OR
          (revision > 0 AND operation_id IS NOT NULL AND operation_digest IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE workflow_candidates (
        candidate_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        record_digest TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(draft_id, source_revision)
          REFERENCES workflow_draft_revisions(draft_id, revision)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX workflow_candidates_draft_revision
        ON workflow_candidates(draft_id, source_revision, created_at);

      CREATE TRIGGER workflow_draft_revisions_no_update
      BEFORE UPDATE ON workflow_draft_revisions
      BEGIN
        SELECT RAISE(ABORT, 'workflow draft revisions are append-only');
      END;

      CREATE TRIGGER workflow_draft_revisions_no_delete
      BEFORE DELETE ON workflow_draft_revisions
      BEGIN
        SELECT RAISE(ABORT, 'workflow draft revisions are append-only');
      END;

      CREATE TRIGGER workflow_candidates_no_update
      BEFORE UPDATE ON workflow_candidates
      BEGIN
        SELECT RAISE(ABORT, 'workflow candidates are immutable');
      END;

      CREATE TRIGGER workflow_candidates_no_delete
      BEFORE DELETE ON workflow_candidates
      BEGIN
        SELECT RAISE(ABORT, 'workflow candidates are immutable');
      END;
    `
  },
  {
    version: 7,
    sql: `
      CREATE TABLE source_records (
        source_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (
          classification IN ('public', 'internal', 'confidential', 'restricted')
        ),
        canonical_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE blobs (
        digest TEXT PRIMARY KEY CHECK (
          digest GLOB 'sha256:*' AND length(digest) = 71
        ),
        size INTEGER NOT NULL CHECK (size > 0 AND size <= 26214400),
        media_type TEXT NOT NULL,
        storage_ref TEXT NOT NULL UNIQUE CHECK (
          storage_ref GLOB 'asset-store:sha256:*' AND length(storage_ref) = 83
        ),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE asset_records (
        asset_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL REFERENCES blobs(digest) ON DELETE RESTRICT,
        classification TEXT NOT NULL CHECK (
          classification IN ('public', 'internal', 'confidential', 'restricted')
        ),
        retention_policy TEXT NOT NULL CHECK (
          retention_policy IN (
            'restricted_24h', 'public_30d', 'reference_pack', 'manual'
          )
        ),
        retain_until TEXT,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (retention_policy IN ('restricted_24h', 'public_30d')
            AND retain_until IS NOT NULL)
          OR
          (retention_policy IN ('reference_pack', 'manual')
            AND retain_until IS NULL)
        )
      ) STRICT;

      CREATE TABLE asset_sources (
        asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL
          REFERENCES source_records(source_id) ON DELETE RESTRICT,
        PRIMARY KEY(asset_id, source_id)
      ) STRICT;

      CREATE TABLE asset_derivations (
        asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        parent_asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        PRIMARY KEY(asset_id, parent_asset_id),
        CHECK(asset_id <> parent_asset_id)
      ) STRICT;

      CREATE TABLE asset_deletions (
        asset_id TEXT PRIMARY KEY
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        actor TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE staging_leases (
        lease_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        token_digest TEXT NOT NULL,
        max_bytes INTEGER NOT NULL CHECK (
          max_bytes > 0 AND max_bytes <= 26214400
        ),
        state TEXT NOT NULL CHECK (
          state IN ('active', 'consumed', 'expired', 'rejected')
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evidence_transfers (
        evidence_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        node_execution_id TEXT NOT NULL,
        session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE RESTRICT,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size > 0 AND size <= 26214400),
        digest TEXT NOT NULL CHECK (
          digest GLOB 'sha256:*' AND length(digest) = 71
        ),
        chunk_size INTEGER NOT NULL CHECK (chunk_size = 262144),
        chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
        next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (
          next_chunk_index >= 0 AND next_chunk_index <= chunk_count
        ),
        classification TEXT NOT NULL CHECK (
          classification IN ('public', 'internal', 'confidential', 'restricted')
        ),
        staging_lease_id TEXT NOT NULL
          REFERENCES staging_leases(lease_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (
          state IN (
            'declared', 'receiving', 'complete', 'acknowledged', 'linked',
            'rejected', 'expired'
          )
        ),
        storage_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE(run_id, evidence_id)
      ) STRICT;

      CREATE INDEX evidence_transfers_run_state
        ON evidence_transfers(run_id, state);

      CREATE TABLE evidence_chunks (
        evidence_id TEXT NOT NULL
          REFERENCES evidence_transfers(evidence_id) ON DELETE RESTRICT,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        digest TEXT NOT NULL CHECK (
          digest GLOB 'sha256:*' AND length(digest) = 71
        ),
        size INTEGER NOT NULL CHECK (size > 0 AND size <= 262144),
        received_at TEXT NOT NULL,
        PRIMARY KEY(evidence_id, chunk_index)
      ) STRICT;

      CREATE TABLE evidence_links (
        link_id TEXT PRIMARY KEY,
        evidence_id TEXT NOT NULL UNIQUE
          REFERENCES evidence_transfers(evidence_id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        node_execution_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        claim_ref TEXT,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evidence_link_sources (
        link_id TEXT NOT NULL
          REFERENCES evidence_links(link_id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL
          REFERENCES source_records(source_id) ON DELETE RESTRICT,
        PRIMARY KEY(link_id, source_id)
      ) STRICT;

      CREATE TABLE evidence_link_assets (
        link_id TEXT NOT NULL
          REFERENCES evidence_links(link_id) ON DELETE RESTRICT,
        asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        PRIMARY KEY(link_id, asset_id)
      ) STRICT;

      CREATE TABLE retention_jobs (
        job_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (
          target_type IN ('evidence', 'asset', 'blob')
        ),
        target_id TEXT NOT NULL,
        expected_policy TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('scheduled', 'running', 'completed', 'skipped', 'failed')
        ),
        not_before TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX retention_jobs_due
        ON retention_jobs(state, not_before, job_id);

      CREATE TRIGGER source_records_no_update
      BEFORE UPDATE ON source_records
      BEGIN
        SELECT RAISE(ABORT, 'source records are immutable');
      END;

      CREATE TRIGGER source_records_no_delete
      BEFORE DELETE ON source_records
      BEGIN
        SELECT RAISE(ABORT, 'source records are immutable');
      END;

      CREATE TRIGGER blobs_no_update
      BEFORE UPDATE ON blobs
      BEGIN
        SELECT RAISE(ABORT, 'blob metadata is immutable');
      END;

      CREATE TRIGGER blobs_no_delete
      BEFORE DELETE ON blobs
      BEGIN
        SELECT RAISE(ABORT, 'blob metadata is immutable');
      END;

      CREATE TRIGGER asset_records_no_update
      BEFORE UPDATE ON asset_records
      BEGIN
        SELECT RAISE(ABORT, 'asset records are immutable');
      END;

      CREATE TRIGGER asset_records_no_delete
      BEFORE DELETE ON asset_records
      BEGIN
        SELECT RAISE(ABORT, 'asset records are immutable');
      END;

      CREATE TRIGGER evidence_links_no_update
      BEFORE UPDATE ON evidence_links
      BEGIN
        SELECT RAISE(ABORT, 'evidence links are immutable');
      END;

      CREATE TRIGGER evidence_links_no_delete
      BEFORE DELETE ON evidence_links
      BEGIN
        SELECT RAISE(ABORT, 'evidence links are immutable');
      END;
    `
  }
];
