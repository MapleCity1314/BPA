import { rmSync } from "node:fs";
import Database from "better-sqlite3";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function integrity(database) {
  const rows = database.pragma("integrity_check");
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error("SQLITE_INTEGRITY_CHECK_FAILED");
  }
}

const [command, source, destination] = process.argv.slice(2);
try {
  if (command === "check-memory") {
    new Database(":memory:").close();
  } else if (command === "check" && source) {
    const database = new Database(source, { fileMustExist: true });
    database.pragma("wal_checkpoint(TRUNCATE)");
    integrity(database);
    database.close();
  } else if (command === "backup" && source && destination) {
    const database = new Database(source, { fileMustExist: true });
    database.pragma("wal_checkpoint(TRUNCATE)");
    integrity(database);
    rmSync(destination, { force: true });
    await database.backup(destination);
    database.close();
    const backup = new Database(destination, { readonly: true, fileMustExist: true });
    integrity(backup);
    backup.close();
  } else if (command === "quiescent" && source) {
    const database = new Database(source, { readonly: true, fileMustExist: true });
    const tables = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((row) => row.name)
    );
    const pendingCommands = tables.has("gateway_commands")
      ? database.prepare("SELECT count(*) AS count FROM gateway_commands WHERE state != 'terminal'").get().count
      : 0;
    const activeRuns = tables.has("workflow_runs")
      ? database.prepare(
          "SELECT count(*) AS count FROM workflow_runs WHERE status NOT IN ('succeeded','failed','cancelled','uncertain','rejected','timed_out')"
        ).get().count
      : 0;
    database.close();
    if (pendingCommands > 0 || activeRuns > 0) {
      throw new Error(
        `BPA_RUNTIME_BUSY: activeRuns=${activeRuns}, pendingCommands=${pendingCommands}`
      );
    }
  } else if (command === "schema-version" && source) {
    const database = new Database(source, { readonly: true, fileMustExist: true });
    integrity(database);
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get();
    const row = table
      ? database.prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
        ).get()
      : { version: 0 };
    database.close();
    process.stdout.write(String(row.version));
  } else {
    throw new Error("Usage: bpa-sqlite-tool <check-memory|check|backup|quiescent|schema-version> [source] [destination]");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
