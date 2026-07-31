import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface CoreInstanceLockRecord {
  version: 1;
  pid: number;
  instanceToken: string;
  startedAt: string;
  executablePath: string;
  entryPointPath?: string;
  runtimeIdentity?: string;
}

function parseOwner(content: string): {
  pid: number;
  instanceToken?: string;
} {
  const trimmed = content.trim();
  if (/^[1-9][0-9]*$/u.test(trimmed)) {
    return { pid: Number(trimmed) };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    throw new Error("BPA Core lock record is not valid JSON");
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("version" in candidate) ||
    candidate.version !== 1 ||
    !("pid" in candidate) ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    !("instanceToken" in candidate) ||
    typeof candidate.instanceToken !== "string" ||
    candidate.instanceToken.length < 16
  ) {
    throw new Error("BPA Core lock record is invalid");
  }
  return {
    pid: candidate.pid,
    instanceToken: candidate.instanceToken
  };
}

export class CoreInstanceLock {
  #fd: number | undefined;
  #instanceToken: string | undefined;

  constructor(readonly path: string) {}

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#fd = openSync(this.path, "wx", 0o600);
        this.#instanceToken = randomUUID();
        const entryPoint = process.argv[1]?.trim();
        const runtimeIdentity = process.env.BPA_RUNTIME_ID?.trim();
        const record: CoreInstanceLockRecord = {
          version: 1,
          pid: process.pid,
          instanceToken: this.#instanceToken,
          startedAt: new Date().toISOString(),
          executablePath: resolve(process.execPath),
          ...(entryPoint ? { entryPointPath: resolve(entryPoint) } : {}),
          ...(runtimeIdentity ? { runtimeIdentity } : {})
        };
        try {
          writeFileSync(this.#fd, `${JSON.stringify(record)}\n`);
        } catch (writeError) {
          closeSync(this.#fd);
          this.#fd = undefined;
          this.#instanceToken = undefined;
          try {
            unlinkSync(this.path);
          } catch {
            // Preserve the original write failure.
          }
          throw writeError;
        }
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        let owner: { pid: number; instanceToken?: string };
        try {
          owner = parseOwner(readFileSync(this.path, "utf8"));
        } catch {
          throw new Error(`BPA Core lock is invalid: ${this.path}`);
        }
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            throw new Error(
              `BPA Local Core is already running with PID ${owner.pid}`
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
      const owner = parseOwner(readFileSync(this.path, "utf8"));
      if (
        owner.pid === process.pid &&
        owner.instanceToken === this.#instanceToken
      ) {
        unlinkSync(this.path);
      }
    } catch {
      // A missing lock already represents the released state.
    }
    this.#instanceToken = undefined;
  }
}
