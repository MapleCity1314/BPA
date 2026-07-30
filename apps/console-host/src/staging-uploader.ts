import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UploadReceipt } from "@bpa/operator-console-contracts";

const RESPONSE_LIMIT_BYTES = 64 * 1024;

export interface StagingUploadInput {
  leaseId: string;
  token: string;
  body: Uint8Array;
  expectedSha256?: string;
}

export interface StagingUploader {
  upload(input: StagingUploadInput): Promise<UploadReceipt>;
}

export function resolveStagingSocketPath(
  root =
    process.env.BPA_HOME ??
    join(homedir(), "Library", "Application Support", "BPA")
): string {
  return process.env.BPA_STAGING_SOCKET ?? join(root, "run", "staging.sock");
}

export class UnixSocketStagingUploader implements StagingUploader {
  constructor(
    readonly socketPath = resolveStagingSocketPath(),
    readonly timeoutMs = 30_000
  ) {}

  upload(input: StagingUploadInput): Promise<UploadReceipt> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffered = Buffer.alloc(0);
      let responseSize: number | undefined;
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Staging transfer timed out"));
      }, this.timeoutMs);
      timer.unref();
      const finish = (
        outcome:
          | { ok: true; value: UploadReceipt }
          | { ok: false; error: Error }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        outcome.ok ? resolve(outcome.value) : reject(outcome.error);
      };
      socket.once("connect", () => {
        const metadata = Buffer.from(
          JSON.stringify({
            protocol: "bpa.staging/1",
            leaseId: input.leaseId,
            token: input.token,
            sizeBytes: input.body.byteLength,
            ...(input.expectedSha256
              ? { expectedSha256: input.expectedSha256 }
              : {})
          }),
          "utf8"
        );
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(metadata.byteLength, 0);
        socket.write(Buffer.concat([header, metadata, Buffer.from(input.body)]));
      });
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (responseSize === undefined && buffered.byteLength >= 4) {
          responseSize = buffered.readUInt32BE(0);
          buffered = buffered.subarray(4);
          if (responseSize < 2 || responseSize > RESPONSE_LIMIT_BYTES) {
            finish({
              ok: false,
              error: new Error("Staging transfer response is invalid")
            });
            return;
          }
        }
        if (
          responseSize !== undefined &&
          buffered.byteLength >= responseSize
        ) {
          if (buffered.byteLength !== responseSize) {
            finish({
              ok: false,
              error: new Error("Staging transfer response has trailing bytes")
            });
            return;
          }
          try {
            const response = JSON.parse(
              buffered.toString("utf8")
            ) as {
              ok?: unknown;
              result?: UploadReceipt;
              error?: { message?: unknown };
            };
            if (response.ok !== true || !response.result) {
              throw new Error(
                typeof response.error?.message === "string"
                  ? response.error.message
                  : "Staging transfer was rejected"
              );
            }
            finish({ ok: true, value: response.result });
          } catch (error) {
            finish({
              ok: false,
              error: error instanceof Error ? error : new Error(String(error))
            });
          }
        }
      });
      socket.once("error", (error) => finish({ ok: false, error }));
      socket.once("end", () => {
        if (responseSize === undefined || buffered.byteLength < responseSize) {
          finish({
            ok: false,
            error: new Error("Staging transfer ended before a response")
          });
        }
      });
    });
  }
}
