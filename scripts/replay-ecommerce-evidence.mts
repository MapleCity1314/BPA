import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  RuntimeProviderRegistry,
  type RuntimeInvocation,
  type RuntimeOutcome,
  type RuntimeProvider
} from "@bpa/node-runtime";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import {
  type ArtifactRef,
  type JsonValue
} from "@bpa/workflow-ir";
import { teamHandlerRegistry } from "../apps/team-worker/src/handlers.js";
import { LocalCoreService } from "../apps/local-core/src/control.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument ${name}`);
  return resolve(value);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function source(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(content) : parse(content);
}

class TrustedTeamReplayProvider implements RuntimeProvider {
  readonly id = "team";

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return teamHandlerRegistry.has(node);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    try {
      const handler = teamHandlerRegistry.get(invocation.node);
      return {
        status: "succeeded",
        output: json(await handler.invoke(invocation.input, signal)),
        evidence: [],
        riskSignals: []
      };
    } catch (error) {
      const teamError = error as {
        code?: unknown;
        retryable?: unknown;
      };
      return {
        status: "failed",
        error: {
          code:
            typeof teamError.code === "string"
              ? teamError.code
              : "TEAM_HANDLER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable:
            typeof teamError.retryable === "boolean"
              ? teamError.retryable
              : false
        },
        evidence: [],
        riskSignals: []
      };
    }
  }
}

async function publish(
  service: LocalCoreService,
  assetType: string,
  path: string
): Promise<void> {
  const response = service.handle({
    id: `publish:${path}`,
    method: "asset.publish",
    params: {
      assetType,
      content: await source(path),
      actor: "ecommerce-evidence-replay"
    }
  });
  if (!response.ok) {
    throw new Error(
      `Failed to publish ${path}: ${JSON.stringify(response.error)}`
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return value as Array<Record<string, unknown>>;
}

function productSet(
  pool: Record<string, unknown>,
  tierName: string
): string[] {
  const tier = rows(pool.tiers).find((entry) => entry.tier === tierName);
  return [...((tier?.products as string[]) ?? [])].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function compareBaseline(
  output: Record<string, unknown>,
  baselineDirectory: string
): Promise<Record<string, unknown>> {
  const baselineCategory = record(
    await source(resolve(baselineDirectory, "category-space.json"))
  );
  const baselinePool = record(
    await source(resolve(baselineDirectory, "comparable-pool.json"))
  );
  const baselinePack = record(
    await source(resolve(baselineDirectory, "reference-pack/manifest.json"))
  );
  const actualCategory = record(output.categorySpace);
  const actualPool = record(output.comparablePool);
  const actualEvidence = record(output.evidenceClaims);
  const actualPack = record(output.referencePack);
  const baselinePrimary = rows(
    baselineCategory.platformCategoryBranches
  ).find((branch) => branch.role === "PRIMARY_DIRECT_BOUNDARY")?.path;
  const strongest = rows(actualEvidence.claims).find(
    (claim) => claim.id === "STRONGEST-OBSERVED-SALES"
  );
  const newProducts = rows(actualEvidence.claims).find(
    (claim) => claim.id === "NEW-PRODUCT-SAMPLE"
  );
  const actualSummary = record(actualPack.summary);
  const baselineGroups = rows(baselinePack.assetGroups);
  const baselineSelected = new Map(
    rows(baselinePack.selectedAssets).map((asset) => [
      String(asset.productId),
      String(asset.sha256)
    ])
  );
  const actualSelected = new Map(
    rows(actualPack.selectedAssets).map((asset) => [
      String(asset.productId),
      String(asset.sha256)
    ])
  );
  const checks = [
    {
      id: "PRIMARY_CATEGORY",
      passed: actualCategory.primaryCategory === baselinePrimary,
      expected: baselinePrimary,
      actual: actualCategory.primaryCategory
    },
    {
      id: "DIRECT_COMPETITORS",
      passed: sameStrings(
        productSet(actualPool, "DIRECT_COMPETITOR"),
        productSet(baselinePool, "DIRECT_COMPETITOR")
      ),
      expected: productSet(baselinePool, "DIRECT_COMPETITOR"),
      actual: productSet(actualPool, "DIRECT_COMPETITOR")
    },
    {
      id: "CONTENT_REFERENCES",
      passed: sameStrings(
        productSet(actualPool, "SUBSTITUTE_AND_CONTENT_REFERENCE"),
        productSet(baselinePool, "SUBSTITUTE_AND_CONTENT_REFERENCE")
      ),
      expected: productSet(
        baselinePool,
        "SUBSTITUTE_AND_CONTENT_REFERENCE"
      ),
      actual: productSet(actualPool, "SUBSTITUTE_AND_CONTENT_REFERENCE")
    },
    {
      id: "STRONGEST_SAMPLE",
      passed: sameStrings(
        (strongest?.subjectProducts as string[]) ?? [],
        ["viji"]
      ),
      expected: ["viji"],
      actual: strongest?.subjectProducts
    },
    {
      id: "NEW_PRODUCT_SAMPLE",
      passed: sameStrings(
        (newProducts?.subjectProducts as string[]) ?? [],
        ["chubei"]
      ),
      expected: ["chubei"],
      actual: newProducts?.subjectProducts
    },
    {
      id: "PRODUCT_COUNT",
      passed: actualSummary.productCount === baselineGroups.length,
      expected: baselineGroups.length,
      actual: actualSummary.productCount
    },
    {
      id: "DIRECT_COUNT",
      passed:
        actualSummary.directCompetitorCount ===
        baselineGroups.filter(
          (group) => group.comparisonTier === "DIRECT_COMPETITOR"
        ).length,
      expected: baselineGroups.filter(
        (group) => group.comparisonTier === "DIRECT_COMPETITOR"
      ).length,
      actual: actualSummary.directCompetitorCount
    },
    {
      id: "CAROUSEL_COUNT",
      passed:
        actualSummary.carouselCount ===
        baselineGroups.reduce(
          (sum, group) => sum + Number(group.carouselCount),
          0
        ),
      expected: baselineGroups.reduce(
        (sum, group) => sum + Number(group.carouselCount),
        0
      ),
      actual: actualSummary.carouselCount
    },
    {
      id: "DETAIL_SLICE_COUNT",
      passed:
        actualSummary.detailSliceCount ===
        baselineGroups.reduce(
          (sum, group) => sum + Number(group.detailSliceCount),
          0
        ),
      expected: baselineGroups.reduce(
        (sum, group) => sum + Number(group.detailSliceCount),
        0
      ),
      actual: actualSummary.detailSliceCount
    },
    {
      id: "SELECTED_MAIN_HASHES",
      passed:
        baselineSelected.size === actualSelected.size &&
        [...baselineSelected].every(
          ([productId, digest]) => actualSelected.get(productId) === digest
        ),
      expected: Object.fromEntries(baselineSelected),
      actual: Object.fromEntries(actualSelected)
    }
  ];
  const passed = checks.filter((check) => check.passed).length;
  return {
    schemaVersion: "ecommerce-evidence-reproduction/1",
    status: passed === checks.length ? "REPRODUCED" : "MISMATCH",
    passed,
    total: checks.length,
    reproductionRate: passed / checks.length,
    exactDocumentMatch: false,
    exactDocumentMatchReason:
      "工作流输出使用 v0.2 结构化 Schema；人工基线为 v0.1 文档，不要求逐字节相同。",
    checks
  };
}

async function main(): Promise<void> {
  const inputPath = argument("--input");
  const outputDirectory = argument("--output-dir");
  const baselineDirectory = argument("--baseline-dir");
  const input = await source(inputPath);
  const store = new SqlitePersistence({ path: ":memory:" });
  const providers = new RuntimeProviderRegistry();
  providers.register(new TrustedTeamReplayProvider());
  const service = new LocalCoreService(store, undefined, providers);

  for (const id of [
    "ecommerce.intent.normalize",
    "ecommerce.category-space.build",
    "ecommerce.comparable-pool.build",
    "ecommerce.evidence.evaluate",
    "ecommerce.reference-pack.build"
  ]) {
    await publish(
      service,
      "node",
      resolve(repositoryRoot, `nodes/core/${id}.node.yaml`)
    );
  }
  await publish(
    service,
    "workflow",
    resolve(
      repositoryRoot,
      "workflows/examples/ecommerce.evidence-chain-replay.workflow.yaml"
    )
  );

  const created = service.handle({
    id: "run:ecommerce-evidence-replay",
    method: "run.create",
    params: {
      workflowId: "ecommerce.evidence-chain-replay",
      workflowVersion: "1.0.0",
      input
    }
  });
  if (!created.ok) {
    throw new Error(`Run creation failed: ${JSON.stringify(created.error)}`);
  }
  const runId = String((created.result as { id: string }).id);
  for (let turn = 0; turn < 30; turn += 1) {
    await service.ir2Runtime.drainOnce();
    const status = store.getRun(runId)?.status;
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "uncertain" ||
      status === "cancelled"
    ) {
      break;
    }
  }
  const run = store.getRun(runId);
  if (!run || run.status !== "succeeded") {
    throw new Error(`Replay failed: ${JSON.stringify(run)}`);
  }
  const output = record(run.output);
  const report = await compareBaseline(output, baselineDirectory);
  const trace = {
    schemaVersion: "bpa-replay-trace/1",
    runId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    workflowDigest: run.workflowDigest,
    status: run.status,
    events: store.listEvents(runId).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      payload: event.payload
    }))
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "workflow-output.json"),
      `${JSON.stringify(output, null, 2)}\n`
    ),
    writeFile(
      resolve(outputDirectory, "run-trace.json"),
      `${JSON.stringify(trace, null, 2)}\n`
    ),
    writeFile(
      resolve(outputDirectory, "reproduction-report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    )
  ]);
  process.stdout.write(
    `${JSON.stringify({ runId, status: run.status, report }, null, 2)}\n`
  );
  store.close();
}

await main();
