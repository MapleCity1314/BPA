import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

export interface AppMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppPostgresOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maximumConnections?: number;
  readonly statementTimeoutMs?: number;
}

export function createAppPostgresPool(options: AppPostgresOptions): Pool {
  if (!options.connectionString.trim()) {
    throw new Error("PostgreSQL connection string is required");
  }
  const config: PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.maximumConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: false
  };
  return new Pool(config);
}

export async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function runAppMigrations(
  pool: Pool,
  migrations: readonly AppMigration[]
): Promise<readonly number[]> {
  const versions = migrations.map((migration) => migration.version);
  if (
    versions.some((version) => !Number.isSafeInteger(version) || version < 1) ||
    new Set(versions).size !== versions.length ||
    versions.some((version, index) => index > 0 && version <= versions[index - 1]!)
  ) {
    throw new Error("Application migrations must have unique ascending positive versions");
  }
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [0x425041]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS control;
      CREATE TABLE IF NOT EXISTS control.schema_migration (
        version integer PRIMARY KEY,
        name text NOT NULL,
        digest text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ version: number; digest: string }>(
      "SELECT version, digest FROM control.schema_migration ORDER BY version"
    );
    const applied = new Map(existing.rows.map((row) => [row.version, row.digest]));
    const completed: number[] = [];
    for (const migration of migrations) {
      const digest = await sha256(migration.sql);
      const prior = applied.get(migration.version);
      if (prior) {
        if (prior !== digest) {
          throw new Error(`Applied migration ${migration.version} digest changed`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO control.schema_migration(version, name, digest) VALUES ($1, $2, $3)",
        [migration.version, migration.name, digest]
      );
      completed.push(migration.version);
    }
    return completed;
  });
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function row<T extends QueryResultRow>(rows: readonly T[], label: string): T {
  if (rows.length !== 1 || !rows[0]) throw new Error(`${label} expected one row`);
  return rows[0];
}
