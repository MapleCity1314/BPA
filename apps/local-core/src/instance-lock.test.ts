import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreInstanceLock } from "./instance-lock.js";

describe("core instance lock", () => {
  it("allows only one Core owner and releases cleanly", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-lock-"));
    const path = join(directory, "core.lock");
    const first = new CoreInstanceLock(path);
    const second = new CoreInstanceLock(path);
    first.acquire();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      pid: process.pid,
      executablePath: process.execPath
    });
    expect(() => second.acquire()).toThrow(/already running/);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not remove a lock replaced by a different owner token", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-lock-token-"));
    const path = join(directory, "core.lock");
    const lock = new CoreInstanceLock(path);
    lock.acquire();
    const replacement = {
      ...JSON.parse(readFileSync(path, "utf8")),
      instanceToken: "replacement-owner-token"
    };
    writeFileSync(path, `${JSON.stringify(replacement)}\n`);
    lock.release();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps legacy live-PID locks compatible and rejects malformed locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-lock-legacy-"));
    const path = join(directory, "core.lock");
    writeFileSync(path, `${process.pid}\n`);
    expect(() => new CoreInstanceLock(path).acquire()).toThrow(
      /already running/
    );
    writeFileSync(path, "{\"version\":1,\"pid\":\"not-a-pid\"}\n");
    expect(() => new CoreInstanceLock(path).acquire()).toThrow(
      /lock is invalid/
    );
    expect(readFileSync(path, "utf8")).toContain("not-a-pid");
    rmSync(directory, { recursive: true, force: true });
  });
});
