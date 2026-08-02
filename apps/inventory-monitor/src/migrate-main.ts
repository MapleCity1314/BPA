import { createAppPostgresPool, runAppMigrations } from "@bpa/app-postgres";
import { INVENTORY_MIGRATIONS } from "./migrations.js";

const connectionString = process.env.BPA_APP_MIGRATION_DATABASE_URL?.trim();
if (!connectionString) throw new Error("BPA_APP_MIGRATION_DATABASE_URL is required");
const pool = createAppPostgresPool({
  connectionString,
  applicationName: "bpa-inventory-migrator",
  maximumConnections: 2
});
try {
  await runAppMigrations(pool,INVENTORY_MIGRATIONS);
} finally {
  await pool.end();
}
