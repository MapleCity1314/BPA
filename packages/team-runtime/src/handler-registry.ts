import { createHash } from "node:crypto";
import type { JsonValue } from "@bpa/workflow-ir";
import { teamNodeRef } from "./protocol.js";

export interface TeamHandlerDefinition {
  readonly node: {
    readonly id: string;
    readonly version: string;
  };
  readonly implementationDigest: string;
  invoke(input: JsonValue, signal: AbortSignal): Promise<JsonValue> | JsonValue;
}

export class TeamHandlerRegistry {
  readonly #handlers = new Map<string, TeamHandlerDefinition>();

  constructor(handlers: readonly TeamHandlerDefinition[]) {
    for (const handler of handlers) {
      const ref = teamNodeRef(handler.node);
      if (
        !handler.node.id.trim() ||
        !handler.node.version.trim() ||
        !/^sha256:[a-f0-9]{64}$/u.test(handler.implementationDigest)
      ) {
        throw new Error(`Invalid Team Handler definition: ${ref}`);
      }
      if (this.#handlers.has(ref)) {
        throw new Error(`Duplicate Team Handler: ${ref}`);
      }
      this.#handlers.set(ref, handler);
    }
  }

  has(node: { readonly id: string; readonly version: string }): boolean {
    return this.#handlers.has(teamNodeRef(node));
  }

  get(node: {
    readonly id: string;
    readonly version: string;
  }): TeamHandlerDefinition {
    const ref = teamNodeRef(node);
    const handler = this.#handlers.get(ref);
    if (!handler) throw new Error(`Unknown Team Handler: ${ref}`);
    return handler;
  }

  refs(): readonly string[] {
    return [...this.#handlers.keys()].sort();
  }

  manifest(): readonly {
    readonly ref: string;
    readonly implementationDigest: string;
  }[] {
    return this.refs().map((ref) => ({
      ref,
      implementationDigest: this.#handlers.get(ref)!.implementationDigest
    }));
  }
}

export function teamCodeDigest(input: {
  readonly protocolVersion: string;
  readonly workerVersion: string;
  readonly handlers: readonly {
    readonly ref: string;
    readonly implementationDigest: string;
  }[];
}): string {
  const normalized = {
    protocolVersion: input.protocolVersion,
    workerVersion: input.workerVersion,
    handlers: [...input.handlers].sort((left, right) =>
      left.ref.localeCompare(right.ref)
    )
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")}`;
}

export class TeamHandlerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "TeamHandlerError";
  }
}

export function unavailableTeamHandler(input: {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: string;
}): TeamHandlerDefinition {
  return {
    node: { id: input.id, version: input.version },
    implementationDigest: input.implementationDigest,
    invoke() {
      throw new TeamHandlerError(
        "TEAM_HANDLER_NOT_IMPLEMENTED",
        `${input.id}@${input.version} is registered but not implemented`
      );
    }
  };
}
