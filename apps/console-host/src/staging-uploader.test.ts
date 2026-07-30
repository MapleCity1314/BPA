import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnixSocketStagingUploader } from "./staging-uploader.js";

describe("UnixSocketStagingUploader", () => {
  it("moves bytes through the staging socket and reads a bounded receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-uploader-"));
    const socketPath = join(directory, "staging.sock");
    const observed: { metadata?: Record<string, unknown>; body?: Buffer } = {};
    const server = createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength < 4) return;
        const metadataSize = buffered.readUInt32BE(0);
        if (buffered.byteLength < 4 + metadataSize) return;
        observed.metadata = JSON.parse(
          buffered.subarray(4, 4 + metadataSize).toString("utf8")
        ) as Record<string, unknown>;
        observed.body = buffered.subarray(4 + metadataSize);
        const response = Buffer.from(
          JSON.stringify({
            ok: true,
            result: {
              leaseId: "lease",
              digest: `sha256:${"a".repeat(64)}`,
              sizeBytes: observed.body.byteLength
            }
          }),
          "utf8"
        );
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(response.byteLength, 0);
        socket.end(Buffer.concat([header, response]));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    const body = new Uint8Array([4, 5, 6]);
    await expect(
      new UnixSocketStagingUploader(socketPath).upload({
        leaseId: "lease",
        token: "token",
        body,
        expectedSha256: "a".repeat(64)
      })
    ).resolves.toMatchObject({
      leaseId: "lease",
      sizeBytes: 3
    });
    expect(observed.metadata).toEqual({
      protocol: "bpa.staging/1",
      leaseId: "lease",
      token: "token",
      sizeBytes: 3,
      expectedSha256: "a".repeat(64)
    });
    expect(observed.body).toEqual(Buffer.from(body));

    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
});
