import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider,
  RuntimeProviderRegistry
} from "@bpa/node-runtime";
import type { ArtifactRef } from "@bpa/workflow-ir";
import {
  TeamWorkerClient,
  type TeamWorkerClientOptions
} from "./client.js";
import { teamNodeRef } from "./protocol.js";

export const TEAM_RUNTIME_PROVIDER_ID = "team";

export class TeamRuntimeProvider implements RuntimeProvider {
  readonly id = TEAM_RUNTIME_PROVIDER_ID;
  readonly #handlerRefs: ReadonlySet<string>;

  constructor(readonly client: TeamWorkerClient) {
    this.#handlerRefs = new Set(client.options.expectedHandlerRefs);
  }

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return this.#handlerRefs.has(teamNodeRef(node));
  }

  invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (invocation.providerId !== this.id) {
      return Promise.resolve({
        status: "rejected",
        error: {
          code: "TEAM_PROVIDER_ID_MISMATCH",
          message: `Invocation provider is ${invocation.providerId}, expected ${this.id}`,
          retryable: false
        },
        evidence: [],
        riskSignals: []
      });
    }
    return this.client.invoke(invocation, signal);
  }

  async cancel(invocationId: string, fencingToken: number): Promise<void> {
    this.client.cancel(invocationId, fencingToken);
  }

  dispose(): void {
    this.client.stop();
  }
}

export function registerTeamRuntimeProvider(
  registry: RuntimeProviderRegistry,
  options: TeamWorkerClientOptions
): TeamRuntimeProvider {
  const provider = new TeamRuntimeProvider(new TeamWorkerClient(options));
  registry.register(provider);
  return provider;
}
