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
  }
];
