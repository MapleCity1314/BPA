import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  LocalStagingTransferServer,
  StagingTransferService
} from "./staging-transfer.js";

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function send(
  socketPath: string,
  metadata: Record<string, unknown>,
  body: Uint8Array
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once("connect", () => {
      const encoded = Buffer.from(JSON.stringify(metadata), "utf8");
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(encoded.byteLength, 0);
      socket.end(Buffer.concat([header, encoded, Buffer.from(body)]));
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const response = Buffer.concat(chunks);
      const size = response.readUInt32BE(0);
      resolve(
        JSON.parse(response.subarray(4, 4 + size).toString("utf8")) as Record<
          string,
          any
        >
      );
    });
  });
}

describe("local staging transfer", () => {
  it("stores an authorized upload outside the Control Protocol", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-staging-service-"));
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new StagingTransferService(persistence, directory);
    const body = Buffer.from("trusted workbook bytes");
    const expected = sha256(body);
    const lease = service.issue({
      fileName: "packaging.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: body.byteLength,
      sha256: expected,
      purpose: "dataset"
    });
    expect(() =>
      service.upload(
        {
          protocol: "bpa.staging/1",
          leaseId: lease.leaseId,
          token: lease.transferToken,
          sizeBytes: body.byteLength,
          expectedSha256: "0".repeat(64)
        },
        body
      )
    ).toThrow("digest mismatch");
    const receipt = service.upload(
      {
        protocol: "bpa.staging/1",
        leaseId: lease.leaseId,
        token: lease.transferToken,
        sizeBytes: body.byteLength,
        expectedSha256: expected
      },
      body
    );
    expect(receipt).toEqual({
      leaseId: lease.leaseId,
      digest: `sha256:${expected}`,
      sizeBytes: body.byteLength
    });
    expect(persistence.getStagingLease(lease.leaseId)?.state).toBe("consumed");
    expect(persistence.getBlob(`sha256:${expected}`)).toMatchObject({
      size: body.byteLength
    });
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts one bounded framed upload over a mode-0600 Unix Socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-staging-socket-"));
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new StagingTransferService(persistence, directory);
    const server = new LocalStagingTransferServer(
      join(directory, "staging.sock"),
      service
    );
    await server.start();
    const body = Buffer.from("evidence bytes");
    const expected = sha256(body);
    const lease = service.issue({
      fileName: "evidence.json",
      mediaType: "application/json",
      sizeBytes: body.byteLength,
      sha256: expected,
      purpose: "evidence"
    });
    await expect(
      send(
        server.socketPath,
        {
          protocol: "bpa.staging/1",
          leaseId: lease.leaseId,
          token: lease.transferToken,
          sizeBytes: body.byteLength,
          expectedSha256: expected
        },
        body
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        leaseId: lease.leaseId,
        digest: `sha256:${expected}`
      }
    });
    await server.stop();
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
