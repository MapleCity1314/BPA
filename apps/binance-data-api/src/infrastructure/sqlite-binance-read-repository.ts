import type { BinanceReadStore } from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";

export interface OpenBinanceReadRepositoryResult {
  store?: BinanceReadStore;
  schemaVersion: number | null;
  errorCode?: "DATABASE_UNREADABLE";
  close(): void;
}

export function openSqliteBinanceReadRepository(
  databasePath: string
): OpenBinanceReadRepositoryResult {
  try {
    const persistence = new SqlitePersistence({
      path: databasePath,
      readonly: true,
      fileMustExist: true
    });
    return {
      store: persistence,
      schemaVersion: persistence.health().schemaVersion,
      close: () => persistence.close()
    };
  } catch {
    return {
      schemaVersion: null,
      errorCode: "DATABASE_UNREADABLE",
      close: () => undefined
    };
  }
}
