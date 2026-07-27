import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredCommand } from "./gateway.js";

export interface GatewaySnapshot {
  nextCommandSeq: number;
  commands: StoredCommand[];
}

export interface GatewayStateStore {
  load(): Promise<GatewaySnapshot | undefined>;
  save(snapshot: GatewaySnapshot): Promise<void>;
}

export class MemoryGatewayStateStore implements GatewayStateStore {
  #snapshot: GatewaySnapshot | undefined;

  async load(): Promise<GatewaySnapshot | undefined> {
    return this.#snapshot
      ? structuredClone(this.#snapshot)
      : undefined;
  }

  async save(snapshot: GatewaySnapshot): Promise<void> {
    this.#snapshot = structuredClone(snapshot);
  }
}

export class JsonFileGatewayStateStore implements GatewayStateStore {
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<GatewaySnapshot | undefined> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<GatewaySnapshot>;
      if (
        typeof parsed.nextCommandSeq !== "number" ||
        !Array.isArray(parsed.commands)
      ) {
        throw new Error("Gateway snapshot has an invalid shape");
      }
      return {
        nextCommandSeq: parsed.nextCommandSeq,
        commands: parsed.commands
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async save(snapshot: GatewaySnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8"
    );
    await rename(temporary, this.#path);
  }
}
