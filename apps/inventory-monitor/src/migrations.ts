import type { AppMigration } from "@bpa/app-postgres";

export const INVENTORY_MIGRATIONS: readonly AppMigration[] = [
  {
    version: 1,
    name: "inventory-shadow-v1",
    sql: `
      CREATE SCHEMA IF NOT EXISTS source;
      CREATE SCHEMA IF NOT EXISTS dataset;
      CREATE SCHEMA IF NOT EXISTS inventory;
      CREATE SCHEMA IF NOT EXISTS ops;
      CREATE SCHEMA IF NOT EXISTS audit;

      CREATE TABLE source.sync_run (
        sync_run_id text PRIMARY KEY,
        source_system text NOT NULL,
        shop_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('running','succeeded','failed','degraded')),
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        source_watermark text,
        inserted_count integer NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
        updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
      );

      CREATE TABLE source.watermark (
        source_system text NOT NULL,
        shop_id text NOT NULL,
        dataset_type text NOT NULL,
        watermark text NOT NULL,
        source_digest text NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (source_system, shop_id, dataset_type)
      );

      CREATE TABLE source.order_line_fact (
        source_item_key text PRIMARY KEY,
        shop_id text NOT NULL,
        shop_name text NOT NULL,
        child_order_id text NOT NULL,
        product_id text NOT NULL,
        merchant_code text NOT NULL,
        specification text NOT NULL,
        submitted_at timestamptz NOT NULL,
        paid_at timestamptz,
        shipped_at timestamptz,
        order_status text NOT NULL,
        aftersales_status text NOT NULL,
        source_quantity integer NOT NULL CHECK (source_quantity >= 0),
        demand_quantity integer NOT NULL CHECK (demand_quantity >= 0),
        source_batch_id bigint NOT NULL,
        source_row_hash text NOT NULL,
        source_loaded_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX order_line_fact_demand_idx
        ON source.order_line_fact(shop_id, product_id, merchant_code, paid_at)
        WHERE paid_at IS NOT NULL AND demand_quantity > 0;

      CREATE TABLE dataset.version (
        dataset_id text NOT NULL,
        data_version text NOT NULL,
        source_kind text NOT NULL,
        source_digest text NOT NULL,
        observed_at timestamptz NOT NULL,
        as_of timestamptz NOT NULL,
        record_count integer NOT NULL CHECK (record_count >= 0),
        algorithm_version text,
        lineage jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(dataset_id, data_version),
        UNIQUE(dataset_id, source_digest)
      );

      CREATE TABLE inventory.sku_binding (
        binding_id text PRIMARY KEY,
        shop_id text NOT NULL,
        product_id text NOT NULL,
        platform_sku_id text NOT NULL,
        merchant_code text NOT NULL,
        valid_from timestamptz NOT NULL,
        valid_to timestamptz,
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        source_digest text NOT NULL,
        CHECK (valid_to IS NULL OR valid_to >= valid_from)
      );
      CREATE UNIQUE INDEX sku_binding_active_idx
        ON inventory.sku_binding(shop_id, product_id, platform_sku_id)
        WHERE valid_to IS NULL;
      CREATE INDEX sku_binding_merchant_idx
        ON inventory.sku_binding(shop_id, product_id, merchant_code, valid_from);

      CREATE TABLE inventory.snapshot (
        snapshot_id text PRIMARY KEY,
        dataset_id text NOT NULL,
        data_version text NOT NULL,
        shop_id text NOT NULL,
        shop_name text NOT NULL,
        product_id text NOT NULL,
        product_title text NOT NULL,
        total_stock integer NOT NULL CHECK (total_stock >= 0),
        observed_at timestamptz NOT NULL,
        source_digest text NOT NULL,
        completeness numeric(5,4) NOT NULL CHECK (completeness >= 0 AND completeness <= 1),
        mapping_confidence text NOT NULL CHECK (mapping_confidence IN ('high','medium','low','unknown')),
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
        UNIQUE(shop_id, product_id, observed_at),
        FOREIGN KEY(dataset_id, data_version) REFERENCES dataset.version(dataset_id, data_version)
      );
      CREATE INDEX snapshot_latest_idx ON inventory.snapshot(shop_id, product_id, observed_at DESC);

      CREATE TABLE inventory.snapshot_sku (
        snapshot_id text NOT NULL REFERENCES inventory.snapshot(snapshot_id) ON DELETE CASCADE,
        platform_sku_id text NOT NULL,
        merchant_code text NOT NULL,
        current_stock integer NOT NULL CHECK (current_stock >= 0),
        occupied_stock integer NOT NULL CHECK (occupied_stock >= 0),
        unoccupied_stock integer NOT NULL CHECK (unoccupied_stock >= 0),
        PRIMARY KEY(snapshot_id, platform_sku_id),
        CHECK(current_stock = occupied_stock + unoccupied_stock)
      );

      CREATE TABLE inventory.snapshot_channel (
        snapshot_id text NOT NULL,
        platform_sku_id text NOT NULL,
        channel_goods_id text NOT NULL,
        stock integer NOT NULL CHECK(stock >= 0),
        PRIMARY KEY(snapshot_id, platform_sku_id, channel_goods_id),
        FOREIGN KEY(snapshot_id, platform_sku_id)
          REFERENCES inventory.snapshot_sku(snapshot_id, platform_sku_id) ON DELETE CASCADE
      );
      CREATE INDEX snapshot_channel_history_idx
        ON inventory.snapshot_channel(platform_sku_id, channel_goods_id, snapshot_id);

      CREATE TABLE inventory.demand_forecast (
        forecast_id text PRIMARY KEY,
        shop_id text NOT NULL,
        product_id text NOT NULL,
        platform_sku_id text NOT NULL,
        merchant_code text NOT NULL,
        as_of timestamptz NOT NULL,
        algorithm_version text NOT NULL,
        source_dataset_id text NOT NULL,
        source_data_version text NOT NULL,
        selected_model text NOT NULL,
        confidence text NOT NULL CHECK(confidence IN ('high','medium','low')),
        daily_p50 numeric NOT NULL CHECK(daily_p50 >= 0),
        daily_p90 numeric NOT NULL CHECK(daily_p90 >= daily_p50),
        horizons jsonb NOT NULL,
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(shop_id, product_id, platform_sku_id, as_of, algorithm_version)
      );

      CREATE TABLE inventory.risk_evaluation (
        evaluation_id text PRIMARY KEY,
        shop_id text NOT NULL,
        product_id text NOT NULL,
        snapshot_id text NOT NULL REFERENCES inventory.snapshot(snapshot_id),
        policy_version text NOT NULL,
        evaluated_at timestamptz NOT NULL,
        severity text NOT NULL CHECK(severity IN ('normal','warning','critical','unknown')),
        findings jsonb NOT NULL,
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
        source_digest text NOT NULL,
        UNIQUE(shop_id, product_id, snapshot_id, policy_version)
      );

      CREATE TABLE ops.lease (
        lease_key text PRIMARY KEY,
        holder_id text NOT NULL,
        fencing_token bigint NOT NULL CHECK(fencing_token >= 1),
        acquired_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        CHECK(expires_at > acquired_at)
      );

      CREATE TABLE ops.incident (
        incident_id text PRIMARY KEY,
        scope_key text NOT NULL,
        policy_version text NOT NULL,
        state text NOT NULL CHECK(state IN ('pending','open','resolved')),
        severity text NOT NULL CHECK(severity IN ('normal','warning','critical','unknown')),
        warning_streak integer NOT NULL DEFAULT 0,
        healthy_streak integer NOT NULL DEFAULT 0,
        revision integer NOT NULL DEFAULT 1,
        opened_at timestamptz,
        resolved_at timestamptz,
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        latest_evaluation_id text NOT NULL REFERENCES inventory.risk_evaluation(evaluation_id),
        UNIQUE(scope_key, policy_version)
      );

      CREATE TABLE ops.incident_transition (
        transition_id text PRIMARY KEY,
        incident_id text NOT NULL REFERENCES ops.incident(incident_id),
        from_state text,
        to_state text NOT NULL,
        from_severity text,
        to_severity text NOT NULL,
        evaluation_id text NOT NULL REFERENCES inventory.risk_evaluation(evaluation_id),
        occurred_at timestamptz NOT NULL,
        UNIQUE(incident_id, evaluation_id)
      );

      CREATE TABLE ops.review (
        review_id text PRIMARY KEY,
        incident_id text NOT NULL REFERENCES ops.incident(incident_id),
        decision text NOT NULL CHECK(decision IN ('valid','false_positive','needs_context')),
        note text NOT NULL DEFAULT '',
        actor_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE audit.change_event (
        event_id text PRIMARY KEY,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
    `
  },
  {
    version: 2,
    name: "inventory-scheduler-runs",
    sql: `
      CREATE TABLE ops.schedule_run (
        schedule_run_id text PRIMARY KEY,
        lease_key text NOT NULL,
        holder_id text NOT NULL,
        fencing_token bigint,
        scheduled_for timestamptz NOT NULL,
        status text NOT NULL CHECK(status IN ('running','succeeded','failed','degraded','skipped')),
        workflow_runs jsonb NOT NULL DEFAULT '[]'::jsonb,
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        UNIQUE(lease_key, scheduled_for)
      );
      CREATE INDEX schedule_run_recent_idx ON ops.schedule_run(lease_key, scheduled_for DESC);
    `
  },
  {
    version: 3,
    name: "order-source-completeness",
    sql: `
      ALTER TABLE source.order_line_fact
        ADD COLUMN IF NOT EXISTS source_period_end timestamptz;
      CREATE INDEX IF NOT EXISTS order_line_fact_period_end_idx
        ON source.order_line_fact(shop_id,source_period_end DESC);
    `
  },
  {
    version: 4,
    name: "inventory-production-cycle-v2",
    sql: `
      CREATE TABLE ops.collection_run (
        collection_run_id text PRIMARY KEY,
        trigger_kind text NOT NULL CHECK(trigger_kind IN ('manual','schedule','recovery')),
        status text NOT NULL CHECK(status IN (
          'running','succeeded','partial','blocked','degraded','failed','skipped'
        )),
        browser_instance_id text NOT NULL,
        fencing_token bigint NOT NULL CHECK(fencing_token >= 1),
        shop_count integer NOT NULL CHECK(shop_count >= 0),
        completed_shop_count integer NOT NULL DEFAULT 0 CHECK(completed_shop_count >= 0),
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );
      CREATE INDEX collection_run_recent_idx
        ON ops.collection_run(started_at DESC);

      CREATE TABLE ops.collection_step (
        collection_run_id text NOT NULL REFERENCES ops.collection_run(collection_run_id) ON DELETE RESTRICT,
        shop_id text NOT NULL,
        shop_name text NOT NULL,
        component text NOT NULL CHECK(component IN ('canary','orders','inventory','risk')),
        status text NOT NULL CHECK(status IN (
          'running','succeeded','fresh_reused','partial','blocked','degraded','failed','skipped'
        )),
        attempted integer NOT NULL DEFAULT 0 CHECK(attempted >= 0),
        persisted integer NOT NULL DEFAULT 0 CHECK(persisted >= 0),
        failed integer NOT NULL DEFAULT 0 CHECK(failed >= 0),
        coverage numeric(7,6) CHECK(coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
        diagnostic text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        PRIMARY KEY(collection_run_id,shop_id,component)
      );
      CREATE INDEX collection_step_shop_recent_idx
        ON ops.collection_step(shop_id,started_at DESC);
    `
  },
  {
    version: 5,
    name: "domain-lease-acquisition-requests",
    sql: `
      CREATE TABLE ops.lease_acquisition_request (
        lease_key text NOT NULL REFERENCES ops.lease(lease_key) ON DELETE RESTRICT,
        request_id text NOT NULL,
        holder_id text NOT NULL,
        fencing_token bigint NOT NULL CHECK(fencing_token >= 1),
        acquired_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY(lease_key,request_id),
        CHECK(expires_at > acquired_at)
      );
      CREATE INDEX lease_acquisition_request_holder_idx
        ON ops.lease_acquisition_request(lease_key,holder_id,acquired_at DESC);
    `
  },
  {
    version: 6,
    name: "published-order-staging",
    sql: `
      CREATE SCHEMA IF NOT EXISTS legacy;

      ALTER TABLE source.order_line_fact SET SCHEMA legacy;
      ALTER TABLE legacy.order_line_fact RENAME TO order_line_fact_v5;
      ALTER TABLE source.watermark SET SCHEMA legacy;
      ALTER TABLE legacy.watermark RENAME TO watermark_v5;

      CREATE TABLE source.watermark (
        source_system text NOT NULL,
        shop_id text NOT NULL,
        dataset_type text NOT NULL,
        watermark text NOT NULL,
        source_digest text NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (source_system, shop_id, dataset_type)
      );

      CREATE TABLE source.order_line_fact (
        source_item_key text PRIMARY KEY,
        source_system text NOT NULL,
        shop_id text NOT NULL,
        shop_name text NOT NULL,
        child_order_id text NOT NULL,
        product_id text NOT NULL,
        merchant_code text NOT NULL,
        specification text NOT NULL,
        submitted_at timestamptz NOT NULL,
        paid_at timestamptz,
        shipped_at timestamptz,
        order_status text NOT NULL,
        aftersales_status text NOT NULL,
        source_quantity integer NOT NULL CHECK (source_quantity >= 0),
        demand_quantity integer NOT NULL CHECK (demand_quantity >= 0),
        source_batch_id bigint NOT NULL,
        source_row_hash text NOT NULL,
        source_loaded_at timestamptz NOT NULL,
        source_period_end timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX order_line_fact_demand_idx
        ON source.order_line_fact(shop_id, product_id, merchant_code, paid_at)
        WHERE paid_at IS NOT NULL AND demand_quantity > 0;
      CREATE INDEX order_line_fact_period_end_idx
        ON source.order_line_fact(shop_id,source_period_end DESC);
      CREATE TABLE source.order_line_staging (
        sync_run_id text NOT NULL REFERENCES source.sync_run(sync_run_id) ON DELETE RESTRICT,
        source_item_key text NOT NULL,
        source_system text NOT NULL,
        shop_id text NOT NULL,
        shop_name text NOT NULL,
        child_order_id text NOT NULL,
        product_id text NOT NULL,
        merchant_code text NOT NULL,
        specification text NOT NULL,
        submitted_at timestamptz NOT NULL,
        paid_at timestamptz,
        shipped_at timestamptz,
        order_status text NOT NULL,
        aftersales_status text NOT NULL,
        source_quantity integer NOT NULL CHECK (source_quantity >= 0),
        demand_quantity integer NOT NULL CHECK (demand_quantity >= 0),
        source_batch_id bigint NOT NULL,
        source_row_hash text NOT NULL,
        source_loaded_at timestamptz NOT NULL,
        source_period_end timestamptz,
        staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(sync_run_id,source_item_key)
      );
      CREATE INDEX order_line_fact_published_cutoff_idx
        ON source.order_line_fact(shop_id,source_system,source_batch_id,product_id,merchant_code);
      CREATE INDEX order_line_staging_sync_idx
        ON source.order_line_staging(sync_run_id,source_batch_id);
    `
  }
];
