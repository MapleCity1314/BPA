import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { SqlitePersistence } from "../packages/persistence-sqlite/src/index.js";

const runCount = 10_000;
const eventsPerRun = 10;
const eventCount = runCount * eventsPerRun;
const taskCount = 10_000;
const maximumDatabaseBytes = 256 * 1024 * 1024;

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function measure(action: () => unknown, iterations = 40): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    action();
    samples.push(performance.now() - startedAt);
  }
  return percentile(samples, 0.95);
}

function requirePlan(
  database: Database.Database,
  sql: string,
  parameters: readonly unknown[],
  expectedIndex: string
): void {
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => String((row as { detail?: unknown }).detail ?? ""))
    .join("\n");
  if (!plan.includes(expectedIndex)) {
    throw new Error(
      `Scale query does not use ${expectedIndex}: ${plan || "empty plan"}`
    );
  }
}

const directory = await mkdtemp(join(tmpdir(), "bpa-persistence-scale-"));
const databasePath = join(directory, "scale.sqlite");

try {
  new SqlitePersistence({ path: databasePath }).close();
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");

  const insertRun = database.prepare(`
    INSERT INTO workflow_runs(
      id, workflow_id, workflow_version, workflow_digest, status, revision,
      input_json, output_json, current_node_key, created_at, updated_at
    ) VALUES (?, 'scale.workflow', '1.0.0', 'sha256:scale', ?, 0,
      '{}', NULL, NULL, ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO execution_events(
      id, run_id, node_execution_id, sequence, event_type, payload_json,
      occurred_at
    ) VALUES (?, ?, NULL, ?, 'SCALE_EVENT', '{}', ?)
  `);
  const insertTask = database.prepare(`
    INSERT INTO assistance_tasks(
      task_id, run_id, step_instance_id, status, revision, fencing_counter,
      canonical_json, private_state_json, created_at, updated_at
    ) VALUES (?, ?, 'scale-step', 'queued', 0, 0, ?, ?, ?, ?)
  `);
  const seedStartedAt = performance.now();
  database.transaction(() => {
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const runId = `scale-run-${runIndex.toString().padStart(5, "0")}`;
      const timestamp = `2026-07-${String((runIndex % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
      const status = runIndex % 10 === 0 ? "running" : "succeeded";
      insertRun.run(runId, status, timestamp, timestamp);
      for (let eventIndex = 1; eventIndex <= eventsPerRun; eventIndex += 1) {
        insertEvent.run(
          `${runId}:event:${eventIndex}`,
          runId,
          eventIndex,
          timestamp
        );
      }
      insertTask.run(
        `scale-task-${runIndex.toString().padStart(5, "0")}`,
        runId,
        JSON.stringify({
          taskId: `scale-task-${runIndex.toString().padStart(5, "0")}`,
          runId,
          mode: "ai_review",
          status: "queued"
        }),
        JSON.stringify({ ownerType: "ai", fencingCounter: 0 }),
        timestamp,
        timestamp
      );
    }
  })();
  const seedDurationMs = performance.now() - seedStartedAt;
  database.pragma("wal_checkpoint(TRUNCATE)");

  const activeRunSql = `
    SELECT id FROM workflow_runs
    WHERE status NOT IN (
      'succeeded', 'rejected', 'failed', 'cancelled', 'uncertain'
    )
    ORDER BY updated_at LIMIT ?
  `;
  const eventSql = `
    SELECT * FROM execution_events WHERE run_id = ? ORDER BY sequence
  `;
  const taskSql = `
    SELECT task_id FROM assistance_tasks
    WHERE status = ? AND json_extract(canonical_json, '$.mode') = ?
    ORDER BY created_at, task_id LIMIT ?
  `;
  requirePlan(
    database,
    activeRunSql,
    [100],
    "workflow_runs_active_updated"
  );
  requirePlan(
    database,
    eventSql,
    ["scale-run-09999"],
    "sqlite_autoindex_execution_events_2"
  );
  requirePlan(
    database,
    taskSql,
    ["queued", "ai_review", 100],
    "assistance_tasks_status_mode_created"
  );

  const activeStatement = database.prepare(activeRunSql);
  const eventStatement = database.prepare(eventSql);
  const taskStatement = database.prepare(taskSql);
  const activeRunsP95Ms = measure(() => activeStatement.all(100));
  const eventsP95Ms = measure(() => eventStatement.all("scale-run-09999"));
  const tasksP95Ms = measure(() =>
    taskStatement.all("queued", "ai_review", 100)
  );
  database.close();

  const sizeBytes = (await stat(databasePath)).size;
  const failures = [
    seedDurationMs > 30_000
      ? `seed exceeded 30000ms: ${seedDurationMs.toFixed(1)}ms`
      : undefined,
    activeRunsP95Ms > 100
      ? `active Runs p95 exceeded 100ms: ${activeRunsP95Ms.toFixed(2)}ms`
      : undefined,
    eventsP95Ms > 50
      ? `Run Events p95 exceeded 50ms: ${eventsP95Ms.toFixed(2)}ms`
      : undefined,
    tasksP95Ms > 100
      ? `Tasks p95 exceeded 100ms: ${tasksP95Ms.toFixed(2)}ms`
      : undefined,
    sizeBytes > maximumDatabaseBytes
      ? `database exceeded ${maximumDatabaseBytes} bytes: ${sizeBytes}`
      : undefined
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length > 0) {
    throw new Error(`Persistence scale gate failed:\n- ${failures.join("\n- ")}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        runCount,
        eventCount,
        taskCount,
        seedDurationMs: Number(seedDurationMs.toFixed(1)),
        activeRunsP95Ms: Number(activeRunsP95Ms.toFixed(2)),
        eventsP95Ms: Number(eventsP95Ms.toFixed(2)),
        tasksP95Ms: Number(tasksP95Ms.toFixed(2)),
        databaseBytes: sizeBytes
      },
      null,
      2
    )}\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
