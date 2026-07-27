#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { extname } from "node:path";
import { Command } from "commander";
import { parse } from "yaml";
import { sendControlRequest } from "@bpa/local-core/control";
import { resolveBpaPaths } from "@bpa/local-core/paths";

const program = new Command();
const paths = resolveBpaPaths();

program
  .name("bpa")
  .description("BPA local control CLI")
  .version("0.1.0", "--cli-version", "show CLI version");

function output(value: unknown): void {
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

program
  .command("doctor")
  .description("check Local Core and persistence")
  .action(async () => output(await sendControlRequest(paths.socket, "doctor")));

program
  .command("validate")
  .argument("<asset-type>", "workflow or node")
  .argument("<path>", "YAML or JSON asset")
  .action(async (assetType, path) => {
    output(
      await sendControlRequest(paths.socket, "asset.validate", {
        assetType,
        content: await readAsset(path)
      })
    );
  });

program
  .command("publish")
  .argument("<asset-type>", "workflow or node")
  .argument("<path>", "YAML or JSON asset")
  .requiredOption("--yes", "confirm human publication")
  .action(async (assetType, path) => {
    output(
      await sendControlRequest(paths.socket, "asset.publish", {
        assetType,
        content: await readAsset(path),
        actor: userInfo().username
      })
    );
  });

program
  .command("catalog")
  .option("--type <asset-type>", "filter by asset type")
  .action(async (options) => {
    output(
      await sendControlRequest(paths.socket, "catalog.list", {
        ...(options.type ? { assetType: options.type } : {})
      })
    );
  });

program
  .command("audit")
  .option("--target <target>", "filter by exact audit target")
  .action(async (options) => {
    output(
      await sendControlRequest(paths.socket, "audit.list", {
        ...(options.target ? { target: options.target } : {})
      })
    );
  });

program
  .command("run")
  .argument("<workflow>", "workflow id")
  .requiredOption("--version <version>", "published workflow version")
  .option("--input <json>", "workflow input JSON", "{}")
  .action(async (workflow, options) => {
    output(
      await sendControlRequest(paths.socket, "run.create", {
        workflowId: workflow,
        workflowVersion: options.version,
        input: JSON.parse(options.input)
      })
    );
  });

program
  .command("inspect")
  .argument("<run-id>")
  .action(async (runId) =>
    output(
      await sendControlRequest(paths.socket, "run.inspect", { runId })
    )
  );

program
  .command("events")
  .argument("<run-id>")
  .action(async (runId) =>
    output(await sendControlRequest(paths.socket, "run.events", { runId }))
  );

program
  .command("cancel")
  .argument("<run-id>")
  .action(async (runId) =>
    output(
      await sendControlRequest(paths.socket, "run.cancel", {
        runId,
        actor: userInfo().username
      })
    )
  );

program
  .command("resume-human")
  .argument("<node-execution-id>")
  .option("--approve", "approve the human step")
  .option("--reject", "reject the human step")
  .option("--output <json>", "human review output JSON", "{}")
  .action(async (nodeExecutionId, options) => {
    if (Boolean(options.approve) === Boolean(options.reject)) {
      throw new Error("Choose exactly one of --approve or --reject");
    }
    output(
      await sendControlRequest(paths.socket, "run.human.complete", {
        nodeExecutionId,
        approved: Boolean(options.approve),
        output: JSON.parse(options.output)
      })
    );
  });

await program.parseAsync();
