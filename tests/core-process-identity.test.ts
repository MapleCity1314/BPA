import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: Array<ReturnType<typeof spawn>> = [];
const verifier = resolve("scripts/verify-core-process-identity.mjs");

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe.runIf(process.platform !== "win32")(
  "Core process identity verifier",
  () => {
    it("requires the lock, expected release, and live command to agree", async () => {
      const root = mkdtempSync(join(tmpdir(), "bpa-core-identity-"));
      try {
        const entryPointPath = join(root, "core-fixture.mjs");
        const lockPath = join(root, "core.lock");
        writeFileSync(entryPointPath, "setInterval(() => {}, 1000);\n");
        const child = spawn(process.execPath, ["core-fixture.mjs"], {
          cwd: root,
          stdio: "ignore"
        });
        children.push(child);
        await new Promise<void>((resolveReady, reject) => {
          child.once("spawn", resolveReady);
          child.once("error", reject);
        });
        if (!child.pid) throw new Error("fixture did not start");
        writeFileSync(
          lockPath,
          `${JSON.stringify({
            version: 1,
            pid: child.pid,
            instanceToken: "0123456789abcdef",
            startedAt: "2026-08-06T00:00:00.000Z",
            executablePath: resolve(process.execPath),
            entryPointPath: resolve(entryPointPath),
            runtimeIdentity: "v0.6.0-rc.123456789abc.node24.18.0"
          })}\n`
        );

        const result = JSON.parse(
          execFileSync(
            process.execPath,
            [
              verifier,
              "--lock",
              lockPath,
              "--pid",
              String(child.pid),
              "--identity",
              "v0.6.0-rc.123456789abc.node24.18.0",
              "--executable",
              process.execPath,
              "--entrypoint",
              entryPointPath
            ],
            { encoding: "utf8" }
          )
        );
        expect(result).toMatchObject({ status: "verified", pid: child.pid });
        const mismatch = spawnSync(
          process.execPath,
          [
            verifier,
            "--lock",
            lockPath,
            "--pid",
            String(child.pid),
            "--identity",
            "v0.6.0-rc.ffffffffffff.node24.18.0"
          ],
          { encoding: "utf8" }
        );
        expect(mismatch.status).toBe(1);
        expect(mismatch.stderr).toContain("runtime identity");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
);
