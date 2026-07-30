import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { parse } from "yaml";
import { compareShadowRuns } from "@bpa/shadow-run";

export interface ControlRequester {
  request<TResult>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
}

export interface CliProgramOptions {
  readonly client: ControlRequester;
  readonly actor: string;
  readonly writeOutput?: (value: unknown) => void;
  readonly launchConsole?: () => Promise<{ url: string }>;
}

function defaultOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readAsset(path: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  return extname(path).toLowerCase() === ".json"
    ? JSON.parse(source)
    : parse(source, {
        customTags: [],
        maxAliasCount: 0,
        merge: false,
        schema: "core",
        uniqueKeys: true
      });
}

function integerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new InvalidArgumentError("must be an integer between 1 and 1000");
  }
  return parsed;
}

export function createCliProgram(options: CliProgramOptions): Command {
  const { client, actor } = options;
  const output = options.writeOutput ?? defaultOutput;
  const program = new Command()
    .name("bpa")
    .description("BPA local control CLI");

  program
    .command("doctor")
    .description("check Local Core and persistence")
    .action(async () => output(await client.request("doctor")));

  program
    .command("console")
    .description("open the local BPA business workspace")
    .action(async () => {
      if (!options.launchConsole) {
        throw new Error("The BPA Console launcher is unavailable.");
      }
      output(await options.launchConsole());
    });

  program
    .command("validate")
    .argument("<asset-type>", "workflow, node, adapter, profile, policy, or page asset")
    .argument("<path>", "YAML or JSON asset")
    .action(async (assetType, path) => {
      output(
        await client.request("asset.validate", {
          assetType,
          content: await readAsset(path)
        })
      );
    });

  program
    .command("publish")
    .argument("<asset-type>", "workflow, node, adapter, profile, policy, or page asset")
    .argument("<path>", "YAML or JSON asset")
    .requiredOption("--yes", "confirm human publication")
    .action(async (assetType, path) => {
      output(
        await client.request("asset.publish", {
          assetType,
          content: await readAsset(path),
          actor
        })
      );
    });

  program
    .command("catalog")
    .option("--type <asset-type>", "filter by asset type")
    .action(async (commandOptions) => {
      output(
        await client.request("catalog.list", {
          ...(commandOptions.type
            ? { assetType: commandOptions.type as string }
            : {})
        })
      );
    });

  program
    .command("audit")
    .option("--target <target>", "filter by exact audit target")
    .action(async (commandOptions) => {
      output(
        await client.request("audit.list", {
          ...(commandOptions.target
            ? { target: commandOptions.target as string }
            : {})
        })
      );
    });

  const dataset = program
    .command("dataset")
    .description("import and inspect immutable datasets");

  dataset
    .command("import")
    .description("validate and publish a local packaging-master-v1 workbook")
    .argument("<path>", "explicit local .xlsx path")
    .requiredOption("--id <dataset-id>", "immutable dataset id")
    .requiredOption("--version <version>", "immutable dataset version")
    .requiredOption("--yes", "confirm dataset publication")
    .action(async (path, commandOptions) => {
      output(
        await client.request("dataset.import", {
          path: resolve(path),
          id: commandOptions.id as string,
          version: commandOptions.version as string,
          actor
        })
      );
    });

  dataset
    .command("inspect")
    .description("inspect one immutable dataset definition")
    .argument("<id>", "dataset id")
    .requiredOption("--version <version>", "dataset version")
    .action(async (id, commandOptions) => {
      output(
        await client.request("dataset.inspect", {
          id,
          version: commandOptions.version as string
        })
      );
    });

  dataset
    .command("read")
    .description("read one bounded page of normalized dataset records")
    .argument("<id>", "dataset id")
    .requiredOption("--version <version>", "dataset version")
    .option("--after-record-key <key>", "exclusive pagination cursor")
    .option("--limit <count>", "page size (1-1000)", integerOption, 100)
    .action(async (id, commandOptions) => {
      output(
        await client.request("dataset.read", {
          id,
          version: commandOptions.version as string,
          ...(commandOptions.afterRecordKey
            ? { afterRecordKey: commandOptions.afterRecordKey as string }
            : {}),
          limit: commandOptions.limit as number
        })
      );
    });

  program
    .command("run")
    .argument("<workflow>", "workflow id")
    .requiredOption("--version <version>", "published workflow version")
    .option("--input <json>", "workflow input JSON", "{}")
    .action(async (workflow, commandOptions) => {
      output(
        await client.request("run.create", {
          workflowId: workflow,
          workflowVersion: commandOptions.version as string,
          input: JSON.parse(commandOptions.input as string)
        })
      );
    });

  program
    .command("shadow-compare")
    .description(
      "compare one legacy-plugin result with one BPA read-only result"
    )
    .argument("<legacy-result>", "legacy plugin result JSON or YAML")
    .argument("<bpa-result>", "BPA result JSON or YAML")
    .action(async (legacyResult, bpaResult) => {
      output(
        compareShadowRuns({
          legacyPlugin: await readAsset(legacyResult),
          bpa: await readAsset(bpaResult)
        })
      );
    });

  program
    .command("node-preview")
    .description("preview the exact closure and permissions for one published Node")
    .argument("<node>", "published node id")
    .requiredOption("--version <version>", "published node version")
    .option("--input <json>", "node input JSON", "{}")
    .action(async (node, commandOptions) => {
      output(
        await client.request("run.node.preview", {
          nodeId: node,
          nodeVersion: commandOptions.version as string,
          input: JSON.parse(commandOptions.input as string)
        })
      );
    });

  program
    .command("run-node")
    .description(
      "run one exact R0/R1 published Node through a generated bounded Workflow"
    )
    .argument("<node>", "published node id")
    .requiredOption("--version <version>", "published node version")
    .option("--input <json>", "node input JSON", "{}")
    .option("--yes", "confirm an R1 permission preview")
    .action(async (node, commandOptions) => {
      const input = JSON.parse(commandOptions.input as string);
      const preview = await client.request<{
        previewDigest: string;
        requiresConfirmation: boolean;
      }>("run.node.preview", {
        nodeId: node,
        nodeVersion: commandOptions.version as string,
        input
      });
      if (preview.requiresConfirmation && !commandOptions.yes) {
        throw new Error(
          `R1 Node requires --yes after reviewing preview ${preview.previewDigest}`
        );
      }
      const run = await client.request("run.node.create", {
        nodeId: node,
        nodeVersion: commandOptions.version as string,
        input,
        expectedPreviewDigest: preview.previewDigest,
        confirmed: Boolean(commandOptions.yes),
        actor
      });
      output({ preview, run });
    });

  program
    .command("inspect")
    .argument("<run-id>")
    .action(async (runId) =>
      output(await client.request("run.inspect", { runId }))
    );

  program
    .command("events")
    .argument("<run-id>")
    .action(async (runId) =>
      output(await client.request("run.events", { runId }))
    );

  program
    .command("cancel")
    .argument("<run-id>")
    .action(async (runId) =>
      output(
        await client.request("run.cancel", {
          runId,
          actor
        })
      )
    );

  program
    .command("resume-human")
    .argument("<node-execution-id>")
    .option("--approve", "approve the human step")
    .option("--reject", "reject the human step")
    .option("--output <json>", "human review output JSON", "{}")
    .action(async (nodeExecutionId, commandOptions) => {
      if (
        Boolean(commandOptions.approve) === Boolean(commandOptions.reject)
      ) {
        throw new Error("Choose exactly one of --approve or --reject");
      }
      output(
        await client.request("run.human.complete", {
          nodeExecutionId,
          approved: Boolean(commandOptions.approve),
          output: JSON.parse(commandOptions.output as string)
        })
      );
    });

  return program;
}
