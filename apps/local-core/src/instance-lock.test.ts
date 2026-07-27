import { mkdtempSync, rmSync } from "node:fs";
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
    expect(() => second.acquire()).toThrow(/already running/);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
    rmSync(directory, { recursive: true, force: true });
  });
});
