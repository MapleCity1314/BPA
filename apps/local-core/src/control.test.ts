import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  LocalControlServer,
  LocalCoreService,
  sendControlRequest
} from "./control.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("local control socket", () => {
  it("serves doctor requests over a 0600 unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bpa-control-"));
    const socketPath = join(directory, "core.sock");
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const server = new LocalControlServer(
      socketPath,
      new LocalCoreService(persistence)
    );
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      persistence.close();
      await rm(directory, { recursive: true, force: true });
    });
    await expect(
      sendControlRequest(socketPath, "doctor")
    ).resolves.toMatchObject({
      status: "ok",
      persistence: { adapter: "sqlite", schemaVersion: 2 }
    });
  });
});
