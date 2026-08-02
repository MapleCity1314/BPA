import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { resolveLocalIpcEndpoint } from "@bpa/platform-runtime";
import { describe, expect, it, vi } from "vitest";
import { InventoryServiceProtocol } from "./service-protocol.js";

async function request(socketPath: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve,reject) => {
    let body = "";
    const socket = createConnection(socketPath);
    socket.once("connect",() => socket.write(`${JSON.stringify(value)}\n`));
    socket.setEncoding("utf8");
    socket.on("data",(chunk) => { body += chunk; });
    socket.once("error",reject);
    socket.once("end",() => resolve(JSON.parse(body) as Record<string, unknown>));
  });
}

describe("inventory service protocol", () => {
  it("serves only allowlisted operations on a protected local IPC endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(),"bpa-inventory-test-"));
    await mkdir(directory,{ recursive:true });
    const socketPath = process.platform === "win32"
      ? resolveLocalIpcEndpoint(directory,"inventory","win32")
      : join(directory,"inventory.sock");
    const repository = { health:vi.fn(async () => ({ databaseTime:"2026-08-02T00:00:00.000Z" })) };
    const server = new InventoryServiceProtocol(socketPath,repository as never);
    await server.start();
    try {
      if (process.platform !== "win32") {
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      }
      await expect(request(socketPath,{ id:"1",operation:"health.read",input:{} })).resolves.toMatchObject({
        ok:true,id:"1",result:{ databaseTime:"2026-08-02T00:00:00.000Z" }
      });
      await expect(request(socketPath,{ id:"2",operation:"sql.execute",input:{ sql:"SELECT 1" } })).resolves.toMatchObject({
        ok:false,error:{ code:"OPERATION_NOT_ALLOWED" }
      });
      await expect(request(socketPath,{ id:"3",operation:"inventory.snapshot.persist",input:{ snapshot:{} } })).resolves.toMatchObject({
        ok:false,error:{ code:"LEASE_FENCE_INVALID" }
      });
    } finally {
      await server.close();
    }
  });
});
