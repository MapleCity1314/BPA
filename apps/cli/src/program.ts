import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { parse } from "yaml";
import { verifyCandidateArchive } from "@bpa/candidate-archive";
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

function waitSecondsOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400) {
    throw new InvalidArgumentError("must be an integer between 1 and 86400");
  }
  return parsed;
}

const JSON_INPUT_LIMIT = 64 * 1024;

async function workflowInput(commandOptions: {
  input?: string;
  inputFile?: string;
}): Promise<unknown> {
  if (commandOptions.input !== undefined && commandOptions.inputFile) {
    throw new InvalidArgumentError(
      "--input and --input-file cannot be used together"
    );
  }
  let source = commandOptions.input ?? "{}";
  if (commandOptions.inputFile) {
    source = await readFile(resolve(commandOptions.inputFile), "utf8");
    if (Buffer.byteLength(source, "utf8") > JSON_INPUT_LIMIT) {
      throw new InvalidArgumentError(
        `--input-file must not exceed ${JSON_INPUT_LIMIT} bytes`
      );
    }
    source = source.replace(/^\uFEFF/u, "");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new InvalidArgumentError(
      commandOptions.inputFile
        ? "--input-file must contain valid JSON"
        : "--input must be valid JSON"
    );
  }
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

  const runtime = program
    .command("runtime")
    .description("inspect the resident BPA Runtime");

  runtime
    .command("maintenance-status")
    .description("verify that maintenance is held and business effects are drained")
    .action(async () => output(
      await client.request("runtime.maintenance.status", {})
    ));

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

  const trigger = program
    .command("trigger")
    .description("manage deterministic Manual, Schedule and Dataset Triggers");

  trigger
    .command("put")
    .argument("<path>", "TriggerSpec JSON or YAML")
    .requiredOption("--yes", "confirm audited Trigger configuration")
    .action(async (path) => {
      output(await client.request("trigger.put",{
        spec:await readAsset(path),actor
      }));
    });

  trigger
    .command("list")
    .action(async () => output(await client.request("trigger.list")));

  trigger
    .command("runs")
    .option("--id <trigger-id>", "filter by Trigger ID")
    .action(async (commandOptions) => output(await client.request(
      "trigger.runs",
      commandOptions.id ? { triggerId:commandOptions.id as string } : {}
    )));

  trigger
    .command("enable")
    .argument("<id>", "Trigger ID")
    .requiredOption("--revision <revision>", "expected revision", integerOption)
    .option("--disable", "disable instead of enable", false)
    .action(async (id,commandOptions) => output(await client.request(
      "trigger.enable",{
        id,expectedRevision:commandOptions.revision as number,
        enabled:commandOptions.disable !== true,actor
      }
    )));

  trigger
    .command("fire")
    .argument("<id>", "Manual Trigger ID")
    .requiredOption("--request-key <key>", "caller-owned idempotency key")
    .action(async (id,commandOptions) => output(await client.request(
      "trigger.fire",{ id,requestKey:commandOptions.requestKey as string,actor }
    )));

  const inventory = program
    .command("inventory")
    .description("inspect inventory production state and resolve verified effects");

  const reconciliation = inventory
    .command("reconciliation")
    .description("inspect or resolve an uncertain inventory write boundary");

  reconciliation
    .command("inspect")
    .description("read the exact PG receipt set without changing state")
    .action(async () => output(await client.request(
      "inventory.reconciliation.inspect",{}
    )));

  reconciliation
    .command("resolve")
    .description("resolve the exact inspected receipt set and release its old lease")
    .argument("<resolution-token>", "token returned by reconciliation inspect")
    .requiredOption("--yes", "confirm the verified reconciliation")
    .action(async (resolutionToken) => output(await client.request(
      "inventory.reconciliation.resolve",{ resolutionToken,confirmed:true }
    )));

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

  const candidate = program
    .command("candidate")
    .description("inspect, export and verify immutable Candidate Bundles");

  candidate
    .command("inspect")
    .argument("<candidate-id>", "Candidate Bundle id")
    .action(async (candidateId) => {
      output(
        await client.request(
          "authoring.candidate-bundle.inspect",
          { bundleId: candidateId }
        )
      );
    });

  candidate
    .command("export")
    .argument("<candidate-id>", "Candidate Bundle id")
    .action(async (candidateId) => {
      output(
        await client.request(
          "authoring.candidate-bundle.export",
          {
            bundleId: candidateId,
            actor
          }
        )
      );
    });

  candidate
    .command("verify")
    .argument("<archive>", "Candidate Bundle tar archive")
    .action(async (archive) => {
      output(
        verifyCandidateArchive(
          await readFile(resolve(archive))
        )
      );
    });

  program
    .command("run")
    .argument("<workflow>", "workflow id")
    .requiredOption("--version <version>", "published workflow version")
    .option("--input <json>", "workflow input JSON", "{}")
    .option(
      "--resource-bindings <json>",
      "exact Workflow resource-slot to Browser Session mapping",
      "{}"
    )
    .action(async (workflow, commandOptions) => {
      output(
        await client.request("run.create", {
          workflowId: workflow,
          workflowVersion: commandOptions.version as string,
          input: JSON.parse(commandOptions.input as string),
          resourceBindings: JSON.parse(
            commandOptions.resourceBindings as string
          )
        })
      );
    });

  program
    .command("browser-sessions")
    .description("list bounded local Browser Sessions")
    .option("--limit <limit>", "maximum sessions", integerOption, 100)
    .action(async (commandOptions) => {
      output(
        await client.request("browser.session.list", {
          limit: commandOptions.limit as number
        })
      );
    });

  program
    .command("browser-pages")
    .description("list bounded per-tab Browser page observations")
    .option("--limit <limit>", "maximum observations", integerOption, 200)
    .option("--browser-instance-id <instance>", "stable Browser Instance")
    .option(
      "--include-disconnected",
      "include retained observations from disconnected Sessions",
      false
    )
    .action(async (commandOptions) => {
      output(
        await client.request("browser.page-observation.list", {
          limit: commandOptions.limit as number,
          includeDisconnected:
            commandOptions.includeDisconnected === true,
          ...(commandOptions.browserInstanceId
            ? {
                browserInstanceId:
                  commandOptions.browserInstanceId as string
              }
            : {})
        })
      );
    });

  program
    .command("workflow-run")
    .description("resolve browser resources and run any published Workflow")
    .argument("<workflow-id>", "published Workflow ID")
    .requiredOption("--version <version>", "published Workflow version")
    .option("--input <json>", "Workflow input JSON")
    .option(
      "--input-file <path>",
      "Workflow input JSON file; avoids shell quoting"
    )
    .option(
      "--browser-instance-id <instance>",
      "stable Chrome Browser Instance"
    )
    .option(
      "--wait-seconds <seconds>",
      "terminal wait limit",
      waitSecondsOption,
      28_800
    )
    .action(async (workflowId, commandOptions) => {
      const workflowVersion = commandOptions.version as string;
      const input = await workflowInput(commandOptions);
      const observationDeadline = Date.now() + 10_000;
      let resourceBindings: Record<string, unknown> | undefined;
      let lastObservationError: unknown;
      while (!resourceBindings && Date.now() < observationDeadline) {
        try {
          const resolution = await client.request<{
            resourceBindings: Record<string, unknown>;
          }>("browser.resource-binding.resolve", {
            workflowId,
            workflowVersion,
            ...(commandOptions.browserInstanceId
              ? {
                  browserInstanceId:
                    commandOptions.browserInstanceId as string
                }
              : {})
          });
          resourceBindings = resolution.resourceBindings;
        } catch (error) {
          lastObservationError = error;
          if (
            error instanceof Error &&
            error.message === "BROWSER_SESSION_AMBIGUOUS"
          ) {
            throw error;
          }
          const pages = await client.request<
            Array<{
              sessionId: string;
              browserInstanceId: string;
              tabId: number;
              windowId?: number;
              origin: string;
            }>
          >("browser.page-observation.list", {
            limit: 200,
            ...(commandOptions.browserInstanceId
              ? {
                  browserInstanceId:
                    commandOptions.browserInstanceId as string
                }
              : {})
          });
          await Promise.allSettled(
            pages.map((page) =>
              client.request("browser.page-observation.probe", {
                sessionId: page.sessionId,
                browserInstanceId: page.browserInstanceId,
                tabId: page.tabId,
                ...(page.windowId === undefined
                  ? {}
                  : { windowId: page.windowId }),
                origin: page.origin,
                timeoutMs: 2_000
              })
            )
          );
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        }
      }
      if (!resourceBindings) {
        throw lastObservationError ?? new Error("BROWSER_OBSERVATION_PENDING");
      }
      let run = await client.request<{ id: string; status: string }>(
        "run.create",
        { workflowId, workflowVersion, input, resourceBindings, actor }
      );
      const terminal = new Set([
        "succeeded",
        "rejected",
        "failed",
        "cancelled",
        "uncertain"
      ]);
      const deadline =
        Date.now() + Number(commandOptions.waitSeconds) * 1_000;
      while (!terminal.has(run.status) && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
        run = await client.request("run.inspect", { runId: run.id });
      }
      if (!terminal.has(run.status)) throw new Error("WORKFLOW_RUN_TIMEOUT");
      output(run);
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
    .option(
      "--resource-bindings <json>",
      "exact Node requirement to Browser Session mapping",
      "{}"
    )
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
        resourceBindings: JSON.parse(
          commandOptions.resourceBindings as string
        ),
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
