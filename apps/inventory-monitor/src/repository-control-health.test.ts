import type { Pool } from "pg";
import { describe,expect,it,vi } from "vitest";
import { InventoryRepository } from "./repository.js";

describe("inventory collection control health",() => {
  it("separates recent and stale running collection records",async () => {
    const query = vi.fn(async () => ({
      rows:[{
        active_collection_count:1,
        stale_collection_count:2,
        oldest_stale_started_at:new Date("2026-08-07T15:23:46.407Z")
      }]
    }));
    const repository = new InventoryRepository({ query } as unknown as Pool);

    await expect(repository.collectionControlHealth()).resolves.toEqual({
      activeCollectionCount:1,
      staleCollectionCount:2,
      oldestStaleStartedAt:"2026-08-07T15:23:46.407Z",
      staleAfterMinutes:120
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status='running'"),
      [120]
    );
  });
});
