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
  },
  {
    version: 8,
    sql: `
      CREATE TABLE run_resource_binding_snapshots (
        run_id TEXT PRIMARY KEY
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        snapshot_version TEXT NOT NULL CHECK (
          snapshot_version = 'bpa.resource-binding/1'
        ),
        snapshot_digest TEXT NOT NULL CHECK (
          snapshot_digest GLOB 'sha256:*' AND length(snapshot_digest) = 71
        ),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE run_resource_bindings (
        run_id TEXT NOT NULL
          REFERENCES run_resource_binding_snapshots(run_id) ON DELETE RESTRICT,
        slot_name TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
        session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE RESTRICT,
        capability_digest TEXT NOT NULL,
        origin TEXT NOT NULL,
        authentication TEXT NOT NULL CHECK (
          authentication IN (
            'anonymous', 'optional', 'authenticated', 'membership'
          )
        ),
        frozen_at INTEGER NOT NULL CHECK (frozen_at >= 0),
        approved_by TEXT NOT NULL,
        requirement_json TEXT NOT NULL,
        PRIMARY KEY(run_id, slot_name),
        UNIQUE(run_id, binding_id)
      ) STRICT;

      CREATE INDEX run_resource_bindings_session
        ON run_resource_bindings(session_id, run_id, slot_name);

      ALTER TABLE browser_sessions
        ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 0
        CHECK (observation_revision >= 0);
      ALTER TABLE browser_sessions
        ADD COLUMN session_role TEXT CHECK (
          session_role IS NULL OR session_role IN (
            'general', 'metrics_source', 'public_asset_source', 'design_mode'
          )
        );
      ALTER TABLE browser_sessions ADD COLUMN observed_origin TEXT;
      ALTER TABLE browser_sessions
        ADD COLUMN observed_authentication TEXT CHECK (
          observed_authentication IS NULL OR observed_authentication IN (
            'anonymous', 'optional', 'authenticated', 'membership'
          )
        );
      ALTER TABLE browser_sessions
        ADD COLUMN observation_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
          observation_state IN (
            'unknown', 'available', 'auth_required', 'revoked'
          )
        );
      ALTER TABLE browser_sessions ADD COLUMN observed_at TEXT;

      CREATE INDEX browser_sessions_role_state
        ON browser_sessions(session_role, observation_state, observed_at);
      CREATE INDEX browser_sessions_connected
        ON browser_sessions(connected_at, id);

      CREATE TABLE export_records (
        export_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        export_type TEXT NOT NULL CHECK (
          export_type IN (
            'reference_asset_pack', 'issue_report',
            'evidence_bundle', 'dataset'
          )
        ),
        status TEXT NOT NULL CHECK (
          status IN ('ready', 'failed', 'archived')
        ),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE export_record_assets (
        export_id TEXT NOT NULL
          REFERENCES export_records(export_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        PRIMARY KEY(export_id, ordinal),
        UNIQUE(export_id, asset_id)
      ) STRICT;

      CREATE INDEX export_records_run_created
        ON export_records(run_id, created_at, export_id);
      CREATE INDEX evidence_transfers_run_created
        ON evidence_transfers(run_id, created_at, evidence_id);
      CREATE INDEX evidence_links_run_created
        ON evidence_links(run_id, created_at, link_id);
      CREATE INDEX evidence_link_sources_source
        ON evidence_link_sources(source_id, link_id);
      CREATE INDEX evidence_link_assets_asset
        ON evidence_link_assets(asset_id, link_id);

      CREATE TRIGGER run_resource_binding_snapshots_no_update
      BEFORE UPDATE ON run_resource_binding_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'run resource binding snapshots are immutable');
      END;

      CREATE TRIGGER run_resource_binding_snapshots_no_delete
      BEFORE DELETE ON run_resource_binding_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'run resource binding snapshots are immutable');
      END;

      CREATE TRIGGER run_resource_bindings_no_update
      BEFORE UPDATE ON run_resource_bindings
      BEGIN
        SELECT RAISE(ABORT, 'run resource bindings are immutable');
      END;

      CREATE TRIGGER run_resource_bindings_no_delete
      BEFORE DELETE ON run_resource_bindings
      BEGIN
        SELECT RAISE(ABORT, 'run resource bindings are immutable');
      END;

      CREATE TRIGGER export_records_no_update
      BEFORE UPDATE ON export_records
      BEGIN
        SELECT RAISE(ABORT, 'export records are immutable');
      END;

      CREATE TRIGGER export_records_no_delete
      BEFORE DELETE ON export_records
      BEGIN
        SELECT RAISE(ABORT, 'export records are immutable');
      END;
    `
  },
  {
    version: 9,
    sql: `
      CREATE TABLE authoring_scenarios (
        scenario_id TEXT NOT NULL,
        version TEXT NOT NULL,
        scenario_digest TEXT NOT NULL CHECK (
          scenario_digest GLOB 'sha256:*' AND length(scenario_digest) = 71
        ),
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scenario_id, version)
      ) STRICT;

      CREATE TABLE authoring_sessions (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state TEXT NOT NULL CHECK (
          state IN (
            'intake', 'catalog', 'discovery', 'modeling', 'assembly',
            'validation', 'candidate', 'closed', 'failed'
          )
        ),
        scenario_id TEXT NOT NULL,
        scenario_version TEXT NOT NULL,
        scenario_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(scenario_id, scenario_version)
          REFERENCES authoring_scenarios(scenario_id, version)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE authoring_session_revisions (
        session_id TEXT NOT NULL
          REFERENCES authoring_sessions(session_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        operation_id TEXT,
        operation_digest TEXT,
        state TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, revision),
        UNIQUE(session_id, operation_id),
        CHECK (
          (revision = 0 AND operation_id IS NULL AND operation_digest IS NULL)
          OR
          (revision > 0 AND operation_id IS NOT NULL AND operation_digest IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE design_mode_grants (
        grant_id TEXT PRIMARY KEY,
        authoring_session_id TEXT NOT NULL
          REFERENCES authoring_sessions(session_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state TEXT NOT NULL CHECK (
          state IN (
            'requested', 'active', 'stopped', 'expired', 'revoked', 'invalidated'
          )
        ),
        approved_by TEXT NOT NULL,
        browser_session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE RESTRICT,
        profile_id TEXT NOT NULL,
        tab_id INTEGER NOT NULL CHECK (tab_id >= 0),
        origin TEXT NOT NULL,
        page_epoch TEXT NOT NULL,
        allowed_operations_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_reason TEXT
      ) STRICT;

      CREATE TABLE design_mode_grant_revisions (
        grant_id TEXT NOT NULL
          REFERENCES design_mode_grants(grant_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, revision)
      ) STRICT;

      CREATE TABLE authoring_page_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        authoring_session_id TEXT NOT NULL
          REFERENCES authoring_sessions(session_id) ON DELETE RESTRICT,
        design_grant_id TEXT NOT NULL
          REFERENCES design_mode_grants(grant_id) ON DELETE RESTRICT,
        page_state TEXT NOT NULL,
        evidence_id TEXT NOT NULL UNIQUE
          REFERENCES evidence_transfers(evidence_id) ON DELETE RESTRICT,
        asset_id TEXT NOT NULL
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        content_digest TEXT NOT NULL CHECK (
          content_digest GLOB 'sha256:*' AND length(content_digest) = 71
        ),
        canonical_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        raw_evidence_expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX authoring_page_snapshots_session
        ON authoring_page_snapshots(
          authoring_session_id, captured_at, snapshot_id
        );

      CREATE TABLE candidate_bundles (
        bundle_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        authoring_session_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        record_digest TEXT NOT NULL CHECK (
          record_digest GLOB 'sha256:*' AND length(record_digest) = 71
        ),
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(authoring_session_id, source_revision)
          REFERENCES authoring_session_revisions(session_id, revision)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE candidate_bundle_items (
        bundle_id TEXT NOT NULL
          REFERENCES candidate_bundles(bundle_id) ON DELETE RESTRICT,
        item_type TEXT NOT NULL CHECK (item_type IN ('artifact', 'file')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        item_key TEXT NOT NULL,
        digest TEXT NOT NULL CHECK (
          digest GLOB 'sha256:*' AND length(digest) = 71
        ),
        canonical_json TEXT NOT NULL,
        PRIMARY KEY(bundle_id, item_type, ordinal),
        UNIQUE(bundle_id, item_type, item_key)
      ) STRICT;

      CREATE TABLE candidate_bundle_validations (
        bundle_id TEXT NOT NULL
          REFERENCES candidate_bundles(bundle_id) ON DELETE RESTRICT,
        check_type TEXT NOT NULL CHECK (
          check_type IN (
            'schema', 'contracts', 'replay', 'permissions', 'risk'
          )
        ),
        valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
        issue_count INTEGER NOT NULL CHECK (issue_count >= 0),
        report_asset_id TEXT
          REFERENCES asset_records(asset_id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(bundle_id, check_type)
      ) STRICT;

      CREATE TABLE candidate_exports (
        export_id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL
          REFERENCES candidate_bundles(bundle_id) ON DELETE RESTRICT,
        bundle_digest TEXT NOT NULL,
        archive_digest TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        destination_ref TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX candidate_exports_bundle
        ON candidate_exports(bundle_id, created_at, export_id);

      CREATE TRIGGER authoring_scenarios_no_update
      BEFORE UPDATE ON authoring_scenarios
      BEGIN
        SELECT RAISE(ABORT, 'authoring scenarios are immutable');
      END;

      CREATE TRIGGER authoring_scenarios_no_delete
      BEFORE DELETE ON authoring_scenarios
      BEGIN
        SELECT RAISE(ABORT, 'authoring scenarios are immutable');
      END;

      CREATE TRIGGER authoring_session_revisions_no_update
      BEFORE UPDATE ON authoring_session_revisions
      BEGIN
        SELECT RAISE(ABORT, 'authoring session revisions are append-only');
      END;

      CREATE TRIGGER authoring_session_revisions_no_delete
      BEFORE DELETE ON authoring_session_revisions
      BEGIN
        SELECT RAISE(ABORT, 'authoring session revisions are append-only');
      END;

      CREATE TRIGGER design_mode_grant_revisions_no_update
      BEFORE UPDATE ON design_mode_grant_revisions
      BEGIN
        SELECT RAISE(ABORT, 'design mode grant revisions are append-only');
      END;

      CREATE TRIGGER design_mode_grant_revisions_no_delete
      BEFORE DELETE ON design_mode_grant_revisions
      BEGIN
        SELECT RAISE(ABORT, 'design mode grant revisions are append-only');
      END;

      CREATE TRIGGER authoring_page_snapshots_no_update
      BEFORE UPDATE ON authoring_page_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'authoring page snapshots are immutable');
      END;

      CREATE TRIGGER authoring_page_snapshots_no_delete
      BEFORE DELETE ON authoring_page_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'authoring page snapshots are immutable');
      END;

      CREATE TRIGGER candidate_bundles_no_update
      BEFORE UPDATE ON candidate_bundles
      BEGIN
        SELECT RAISE(ABORT, 'candidate bundles are immutable');
      END;

      CREATE TRIGGER candidate_bundles_no_delete
      BEFORE DELETE ON candidate_bundles
      BEGIN
        SELECT RAISE(ABORT, 'candidate bundles are immutable');
      END;

      CREATE TRIGGER candidate_bundle_items_no_update
      BEFORE UPDATE ON candidate_bundle_items
      BEGIN
        SELECT RAISE(ABORT, 'candidate bundle items are immutable');
      END;

      CREATE TRIGGER candidate_bundle_items_no_delete
      BEFORE DELETE ON candidate_bundle_items
      BEGIN
        SELECT RAISE(ABORT, 'candidate bundle items are immutable');
      END;

      CREATE TRIGGER candidate_bundle_validations_no_update
      BEFORE UPDATE ON candidate_bundle_validations
      BEGIN
        SELECT RAISE(ABORT, 'candidate validation results are immutable');
      END;

      CREATE TRIGGER candidate_bundle_validations_no_delete
      BEFORE DELETE ON candidate_bundle_validations
      BEGIN
        SELECT RAISE(ABORT, 'candidate validation results are immutable');
      END;

      CREATE TRIGGER candidate_exports_no_update
      BEFORE UPDATE ON candidate_exports
      BEGIN
        SELECT RAISE(ABORT, 'candidate exports are immutable');
      END;

      CREATE TRIGGER candidate_exports_no_delete
      BEFORE DELETE ON candidate_exports
      BEGIN
        SELECT RAISE(ABORT, 'candidate exports are immutable');
      END;
    `
  },
  {
    version: 10,
    sql: `
      CREATE TABLE browser_page_observations (
        session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE CASCADE,
        browser_instance_id TEXT NOT NULL,
        tab_id INTEGER NOT NULL CHECK (tab_id >= 0),
        window_id INTEGER CHECK (window_id IS NULL OR window_id >= 0),
        origin TEXT NOT NULL,
        pathname TEXT NOT NULL,
        content_script_ready INTEGER NOT NULL CHECK (
          content_script_ready IN (0, 1)
        ),
        authentication TEXT NOT NULL CHECK (
          authentication IN (
            'unknown', 'anonymous', 'authenticated', 'membership'
          )
        ),
        observation_state TEXT NOT NULL CHECK (
          observation_state IN (
            'content_script_missing', 'loading', 'auth_required',
            'challenge', 'available', 'invalidated'
          )
        ),
        page_epoch TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        observed_at TEXT NOT NULL,
        shop_identity_json TEXT,
        reason_code TEXT,
        PRIMARY KEY(session_id, tab_id)
      ) STRICT;

      CREATE INDEX browser_page_observations_instance_page
        ON browser_page_observations(
          browser_instance_id, origin, pathname, observation_state, observed_at
        );
      CREATE INDEX browser_page_observations_session
        ON browser_page_observations(session_id, observed_at);
    `
  },
  {
    version: 11,
    sql: `
      ALTER TABLE browser_capabilities
        ADD COLUMN routes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE browser_capabilities ADD COLUMN adapter_id TEXT;
      ALTER TABLE browser_capabilities ADD COLUMN adapter_version TEXT;

      CREATE TABLE browser_page_observations_v11 (
        session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE CASCADE,
        browser_instance_id TEXT NOT NULL,
        tab_id INTEGER NOT NULL CHECK (tab_id >= 0),
        window_id INTEGER CHECK (window_id IS NULL OR window_id >= 0),
        origin TEXT NOT NULL,
        pathname TEXT NOT NULL,
        content_script_ready INTEGER NOT NULL CHECK (
          content_script_ready IN (0, 1)
        ),
        authentication TEXT NOT NULL CHECK (
          authentication IN (
            'unknown', 'anonymous', 'authenticated', 'membership'
          )
        ),
        authentication_context_ref TEXT,
        observation_state TEXT NOT NULL CHECK (
          observation_state IN (
            'content_script_missing', 'loading', 'probing',
            'auth_required', 'challenge', 'ready', 'departed', 'stale'
          )
        ),
        page_epoch TEXT NOT NULL,
        observer_capability_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        observed_at TEXT NOT NULL,
        reason_code TEXT,
        PRIMARY KEY(session_id, tab_id),
        CHECK (
          authentication NOT IN ('authenticated', 'membership') OR
          authentication_context_ref IS NOT NULL
        )
      ) STRICT;

      INSERT INTO browser_page_observations_v11(
        session_id, browser_instance_id, tab_id, window_id, origin, pathname,
        content_script_ready, authentication, authentication_context_ref,
        observation_state, page_epoch, observer_capability_id, revision,
        observed_at, reason_code
      )
      SELECT
        session_id, browser_instance_id, tab_id, window_id, origin, pathname,
        0, 'unknown', NULL, 'stale', page_epoch, 'legacy.unknown', revision + 1,
        observed_at, 'PROTOCOL_V2_REBIND_REQUIRED'
      FROM browser_page_observations;

      DROP TABLE browser_page_observations;
      ALTER TABLE browser_page_observations_v11
        RENAME TO browser_page_observations;

      CREATE INDEX browser_page_observations_instance_page
        ON browser_page_observations(
          browser_instance_id, origin, pathname, observation_state, observed_at
        );
      CREATE INDEX browser_page_observations_session
        ON browser_page_observations(session_id, observed_at);
      CREATE INDEX browser_page_observations_expiry
        ON browser_page_observations(observation_state, observed_at);
      CREATE INDEX workflow_runs_active_updated
        ON workflow_runs(status, updated_at)
        WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain');
    `
  },
  {
    version: 12,
    sql: `
      CREATE TABLE trigger_specs (
        trigger_id TEXT PRIMARY KEY,
        trigger_version TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL
      ) STRICT;

      CREATE TABLE trigger_runs (
        trigger_run_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL REFERENCES trigger_specs(trigger_id) ON DELETE RESTRICT,
        trigger_version TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'due', 'lease_acquired', 'run_created', 'running', 'complete',
          'partial', 'blocked', 'degraded', 'failed', 'skipped'
        )),
        workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1),
        dataset_id TEXT,
        dataset_version TEXT,
        diagnostic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(trigger_id, occurrence_key)
      ) STRICT;
      CREATE INDEX trigger_runs_recent
        ON trigger_runs(trigger_id, created_at DESC);

      CREATE TABLE trigger_leases (
        concurrency_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX trigger_leases_expiry ON trigger_leases(expires_at);

      CREATE TABLE browser_control_leases (
        resource_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX browser_control_leases_expiry
        ON browser_control_leases(expires_at);
    `
  },
  {
    version: 13,
    sql: `
      CREATE INDEX engine_outbox_pending_created
        ON engine_outbox(created_at, id)
        WHERE acknowledged_at IS NULL;

      CREATE INDEX gateway_commands_active_sequence
        ON gateway_commands(command_seq)
        WHERE state != 'terminal';

      CREATE INDEX gateway_commands_terminal_result_sequence
        ON gateway_commands(command_seq, node_execution_id)
        WHERE state = 'terminal' AND result_json IS NOT NULL;
    `
  },
  {
    version: 14,
    sql: `
      DROP INDEX workflow_runs_active_updated;
      CREATE INDEX workflow_runs_active_updated
        ON workflow_runs(status, updated_at)
        WHERE status NOT IN (
          'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
      );
    `
  },
  {
    version: 15,
    sql: `
      CREATE TABLE trigger_spec_versions (
        trigger_id TEXT NOT NULL,
        trigger_version TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY(trigger_id, trigger_version)
      ) STRICT;

      INSERT INTO trigger_spec_versions(
        trigger_id, trigger_version, spec_json, created_at, created_by
      )
      SELECT trigger_id, trigger_version, spec_json, created_at, created_by
      FROM trigger_specs;

      CREATE TABLE trigger_runs_v15 (
        trigger_run_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL REFERENCES trigger_specs(trigger_id) ON DELETE RESTRICT,
        trigger_version TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'due', 'lease_acquired', 'run_created', 'running', 'complete',
          'partial', 'blocked', 'degraded', 'rejected', 'uncertain',
          'cancelled', 'failed', 'skipped'
        )),
        workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1),
        dataset_id TEXT,
        dataset_version TEXT,
        diagnostic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(trigger_id, occurrence_key)
      ) STRICT;

      INSERT INTO trigger_runs_v15 SELECT * FROM trigger_runs;
      DROP TABLE trigger_runs;
      ALTER TABLE trigger_runs_v15 RENAME TO trigger_runs;
      CREATE INDEX trigger_runs_recent
        ON trigger_runs(trigger_id, created_at DESC);
    `
  },
  {
    version: 16,
    sql: `
      CREATE TABLE attention_records (
        attention_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE
          REFERENCES workflow_runs(id) ON DELETE RESTRICT,
        stage_key TEXT NOT NULL,
        group_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'information', 'review', 'action', 'approval', 'blocking'
        )),
        source TEXT NOT NULL CHECK (source IN (
          'assistance', 'browser', 'runtime', 'approval', 'business-rule'
        )),
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_action TEXT NOT NULL,
        blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
        batchable INTEGER NOT NULL CHECK (batchable IN (0, 1)),
        attempted_actions_json TEXT NOT NULL,
        resumes_automatically INTEGER NOT NULL CHECK (
          resumes_automatically IN (0, 1)
        ),
        state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        due_at TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        CHECK (
          (state = 'open' AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
          OR
          (state = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX attention_records_open_created
        ON attention_records(created_at, attention_id)
        WHERE state = 'open';
    `
  },
  {
    version: 17,
    sql: `
      CREATE TABLE attention_deliveries (
        delivery_id TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL UNIQUE
          REFERENCES attention_records(attention_id) ON DELETE RESTRICT,
        channel TEXT NOT NULL CHECK (channel = 'operator-notification'),
        idempotency_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'delivering', 'delivered', 'failed', 'uncertain'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        lease_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        provider_receipt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (
          (state = 'pending' AND attempt = 0)
          OR state != 'pending'
        ),
        CHECK (
          (state = 'delivering' AND lease_id IS NOT NULL
            AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR
          (state != 'delivering' AND lease_id IS NULL
            AND lease_owner IS NULL AND lease_expires_at IS NULL)
        ),
        CHECK (
          (state IN ('pending', 'delivering') AND completed_at IS NULL)
          OR
          (state IN ('delivered', 'failed', 'uncertain')
            AND completed_at IS NOT NULL)
        ),
        CHECK (
          (state IN ('failed', 'uncertain') AND last_error_code IS NOT NULL)
          OR state NOT IN ('failed', 'uncertain')
        )
      ) STRICT;

      CREATE INDEX attention_deliveries_pending_created
        ON attention_deliveries(created_at, delivery_id)
        WHERE state = 'pending';

      CREATE INDEX attention_deliveries_state_updated
        ON attention_deliveries(state, updated_at, delivery_id);
    `
  },
  {
    version: 18,
    sql: `
      CREATE TABLE recovery_sessions (
        recovery_session_id TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL UNIQUE
          REFERENCES attention_records(attention_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state TEXT NOT NULL CHECK (state IN (
          'issued', 'active', 'completed', 'expired', 'revoked', 'invalidated'
        )),
        requested_by TEXT NOT NULL,
        browser_session_id TEXT NOT NULL
          REFERENCES browser_sessions(id) ON DELETE RESTRICT,
        browser_instance_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        tab_id INTEGER NOT NULL CHECK (tab_id >= 0),
        origin TEXT NOT NULL,
        initial_page_epoch TEXT NOT NULL,
        token_digest TEXT NOT NULL,
        lease_resource_id TEXT NOT NULL,
        lease_owner_id TEXT NOT NULL,
        lease_fencing_token INTEGER NOT NULL CHECK (lease_fencing_token >= 1),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        completed_at TEXT,
        completion_page_epoch TEXT,
        terminal_reason TEXT,
        CHECK (expires_at > issued_at),
        CHECK (
          (state = 'issued' AND activated_at IS NULL AND completed_at IS NULL)
          OR
          (state = 'active' AND activated_at IS NOT NULL AND completed_at IS NULL)
          OR
          (state = 'completed' AND activated_at IS NOT NULL
            AND completed_at IS NOT NULL AND completion_page_epoch IS NOT NULL)
          OR
          (state IN ('expired', 'revoked', 'invalidated')
            AND completed_at IS NULL AND terminal_reason IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX recovery_sessions_state_expiry
        ON recovery_sessions(state, expires_at, recovery_session_id);
      CREATE INDEX recovery_sessions_browser_profile
        ON recovery_sessions(
          browser_instance_id, profile_id, state, expires_at
        );
    `
  }
];
