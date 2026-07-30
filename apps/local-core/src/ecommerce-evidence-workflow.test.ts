import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  RuntimeProviderRegistry,
  type RuntimeInvocation,
  type RuntimeOutcome,
  type RuntimeProvider
} from "@bpa/node-runtime";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  TeamHandlerError,
  type TeamHandlerDefinition
} from "@bpa/team-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { teamHandlerRegistry } from "../../team-worker/src/handlers.js";
import { LocalCoreService } from "./control.js";

const root = new URL("../../../", import.meta.url);

function source(path: string): unknown {
  const content = readFileSync(new URL(path, root), "utf8");
  return path.endsWith(".json") ? JSON.parse(content) : parse(content);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

class TrustedTeamFixtureProvider implements RuntimeProvider {
  readonly id = "team";

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return teamHandlerRegistry.has(node);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    let handler: TeamHandlerDefinition;
    try {
      handler = teamHandlerRegistry.get(invocation.node);
      const output = await handler.invoke(invocation.input, signal);
      return {
        status: "succeeded",
        output: json(output),
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      return {
        status: "failed",
        error: {
          code:
            error instanceof TeamHandlerError
              ? error.code
              : "TEAM_HANDLER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable:
            error instanceof TeamHandlerError ? error.retryable : false
        },
        evidence: [],
        riskSignals: []
      };
    }
  }
}

function publish(
  service: LocalCoreService,
  assetType: string,
  path: string
): void {
  const response = service.handle({
    id: `publish:${path}`,
    method: "asset.publish",
    params: { assetType, content: source(path), actor: "test" }
  });
  if (!response.ok) {
    throw new Error(`${path}: ${JSON.stringify(response.error)}`);
  }
  expect(response, path).toMatchObject({ ok: true });
}

describe("Local Core ecommerce evidence-chain workflow", () => {
  it("replays frozen product snapshots through five trusted nodes", async () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const providers = new RuntimeProviderRegistry();
    providers.register(new TrustedTeamFixtureProvider());
    const service = new LocalCoreService(store, undefined, providers);

    for (const id of [
      "ecommerce.intent.normalize",
      "ecommerce.category-space.build",
      "ecommerce.comparable-pool.build",
      "ecommerce.evidence.evaluate",
      "ecommerce.reference-pack.build"
    ]) {
      publish(service, "node", `nodes/core/${id}.node.yaml`);
    }
    publish(
      service,
      "workflow",
      "workflows/examples/ecommerce.evidence-chain-replay.workflow.yaml"
    );

    const created = service.handle({
      id: "run:ecommerce-evidence-chain",
      method: "run.create",
      params: {
        workflowId: "ecommerce.evidence-chain-replay",
        workflowVersion: "1.0.0",
        input: source(
          "packages/ecommerce-evidence-domain/src/fixtures/prepackaged-jianbing.input.json"
        )
      }
    });
    expect(created).toMatchObject({ ok: true });
    expect(["running", "waiting_runtime"]).toContain(
      (created.result as { status: string }).status
    );
    const runId = String((created.result as { id: string }).id);

    for (let turn = 0; turn < 20; turn += 1) {
      await service.ir2Runtime.drainOnce();
      const status = store.getRun(runId)?.status;
      if (
        status === "succeeded" ||
        status === "failed" ||
        status === "uncertain"
      ) {
        break;
      }
    }

    const run = store.getRun(runId);
    if (run?.status !== "succeeded") {
      const events = store.listEvents(runId);
      const failedInvocation = events
        .map((event) => event.payload as Record<string, unknown>)
        .find((payload) => typeof payload.invocationId === "string")
        ?.invocationId;
      throw new Error(
        JSON.stringify({
          run,
          events,
          inbox:
            typeof failedInvocation === "string"
              ? store.getInboxMessage(`result:${failedInvocation}`)
              : undefined
        })
      );
    }
    expect(run).toMatchObject({
      status: "succeeded",
      output: {
        categorySpace: {
          primaryCategory:
            "食品饮料/粮油调味/速食冻品/方便速食/冷藏食品/方便面/拉面/面皮/面饼"
        },
        comparablePool: {
          tiers: [
            {
              tier: "DIRECT_COMPETITOR",
              products: ["heda", "chubei"]
            },
            {
              tier: "SUBSTITUTE_AND_CONTENT_REFERENCE",
              products: ["viji"]
            }
          ]
        },
        referencePack: {
          summary: {
            productCount: 3,
            directCompetitorCount: 2,
            carouselCount: 15,
            detailSliceCount: 21
          }
        }
      }
    });
    const output = run?.output as Record<string, JsonValue>;
    const evidence = output.evidenceClaims as Record<string, JsonValue>;
    const claims = evidence.claims as Array<Record<string, JsonValue>>;
    expect(
      claims.find((claim) => claim.id === "STRONGEST-OBSERVED-SALES")
    ).toMatchObject({ subjectProducts: ["viji"] });
    expect(
      store
        .listEvents(runId)
        .filter((event) => event.type === "RUNTIME_RESULT_APPLIED")
    ).toHaveLength(5);
    store.close();
  });
});
