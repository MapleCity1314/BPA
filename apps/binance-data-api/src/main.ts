import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { resolveDefaultBpaHome } from "@bpa/platform-runtime";
import { BinanceQueries } from "./application/binance-queries.js";
import { createBinanceDataHttpServer } from "./http/server.js";
import { openSqliteBinanceReadRepository } from "./infrastructure/sqlite-binance-read-repository.js";
import { BinanceSignedAccountClient } from "./infrastructure/binance-signed-account-client.js";

if (process.env.BINANCE_DATA_ENV_FILE?.trim()) {
  loadEnvFile(process.env.BINANCE_DATA_ENV_FILE.trim());
}

const bpaHome = resolveDefaultBpaHome(
  process.env.BPA_HOME ? { bpaHome: process.env.BPA_HOME } : {}
);
const databasePath = process.env.BINANCE_DATA_DATABASE?.trim() || join(bpaHome, "data", "bpa.sqlite");
const repository = openSqliteBinanceReadRepository(databasePath);
const schemaReady = repository.schemaVersion !== null && repository.schemaVersion >= 26;
const directAccount = process.env.BINANCE_API_KEY?.trim() && process.env.BINANCE_SECRET_KEY?.trim()
  ? new BinanceSignedAccountClient({
      apiKey: process.env.BINANCE_API_KEY.trim(),
      secretKey: process.env.BINANCE_SECRET_KEY.trim()
    })
  : undefined;
const server = createBinanceDataHttpServer({
  ...(repository.store && schemaReady ? { queries: new BinanceQueries(repository.store) } : {}),
  serviceReadiness: {
    ready: repository.store !== undefined && schemaReady,
    database_readable: repository.store !== undefined,
    schema_ready: schemaReady,
    schema_version: repository.schemaVersion
  },
  host: process.env.BINANCE_DATA_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.BINANCE_DATA_PORT?.trim() || "43124"),
  ...(process.env.BINANCE_DATA_ALLOWED_ORIGIN?.trim()
    ? { allowedOrigin: process.env.BINANCE_DATA_ALLOWED_ORIGIN.trim() }
    : {}),
  ...(process.env.BINANCE_DATA_TOKEN?.trim() ? { bearerToken: process.env.BINANCE_DATA_TOKEN.trim() } : {}),
  ...(directAccount ? { directAccount } : {})
});

const address = await server.listen();
process.stdout.write(`BPA Binance Data API listening on http://${address.host}:${address.port}\n`);

const shutdown = async (): Promise<void> => {
  await server.close();
  repository.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
