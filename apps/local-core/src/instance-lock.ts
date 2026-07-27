import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export class CoreInstanceLock {
  #fd: number | undefined;

  constructor(readonly path: string) {}

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#fd = openSync(this.path, "wx", 0o600);
        writeFileSync(this.#fd, `${process.pid}\n`);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        const owner = Number(readFileSync(this.path, "utf8").trim());
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
            throw new Error(
              `BPA Local Core is already running with PID ${owner}`
            );
          } catch (ownerError) {
            if (
              ownerError instanceof Error &&
              "code" in ownerError &&
              ownerError.code === "ESRCH"
            ) {
              unlinkSync(this.path);
              continue;
            }
            throw ownerError;
          }
        }
        throw new Error(`BPA Core lock is invalid: ${this.path}`);
      }
    }
    throw new Error(`Unable to acquire BPA Core lock: ${this.path}`);
  }

  release(): void {
    if (this.#fd == null) return;
    closeSync(this.#fd);
    this.#fd = undefined;
    try {
      const owner = Number(readFileSync(this.path, "utf8").trim());
      if (owner === process.pid) unlinkSync(this.path);
    } catch {
      // A missing lock already represents the released state.
    }
  }
}
