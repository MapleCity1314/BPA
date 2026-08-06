import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCliProgram,
  type ControlRequester
} from "./program.js";

class RecordingClient implements ControlRequester {
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];

  async request<TResult>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === "run.node.preview") {
      return {
        previewDigest: "sha256:preview",
        requiresConfirmation: false
      } as TResult;
    }
    if (method === "browser.resource-binding.resolve") {
      return {
        browserInstanceId: "browser-instance-1",
        resourceBindings: {
          alliance_browser: {
            sessionId: "browser-session-1",
            browserInstanceId: "browser-instance-1",
            tabId: 42,
            observationRevision: 3
          }
        }
      } as TResult;
    }
    if (method === "run.create") {
      return {
        id: "run-monitor",
        workflowId: "doudian.alliance-retired-products-monitor",
        workflowVersion: "2.0.0",
        status: "succeeded",
        output: {
          alert: false,
          scan: {
            businessDate: "2026-07-31",
            status: "complete_empty",
            retiredProductCount: 0
          }
        }
      } as TResult;
    }
    return { ok: true } as TResult;
  }
}

function fixture(options: {
  launchConsole?: () => Promise<{ url: string }>;
} = {}) {
  const client = new RecordingClient();
  const output: unknown[] = [];
  const program = createCliProgram({
    client,
    actor: "cli-user",
    writeOutput: (value) => output.push(value),
    ...options
  });
  return { client, output, program };
}

describe("operator Console CLI", () => {
  it("starts the temporary local host without a Control mutation", async () => {
    let launches = 0;
    const { client, output, program } = fixture({
      async launchConsole() {
        launches += 1;
        return { url: "http://127.0.0.1:43123/#token=one-time" };
      }
    });

    await program.parseAsync(["node", "bpa", "console"]);

    expect(launches).toBe(1);
    expect(client.calls).toEqual([]);
    expect(output).toEqual([
      { url: "http://127.0.0.1:43123/#token=one-time" }
    ]);
  });
});

describe("dataset CLI control mapping", () => {
  it("maps confirmed imports to dataset.import with an absolute local path", async () => {
    const { client, output, program } = fixture();
    await program.parseAsync([
      "node",
      "bpa",
      "dataset",
      "import",
      "./packaging.xlsx",
      "--id",
      "packaging-master",
      "--version",
      "2026.07.28",
      "--yes"
    ]);
    expect(client.calls).toEqual([
      {
        method: "dataset.import",
        params: {
          path: resolve("./packaging.xlsx"),
          id: "packaging-master",
          version: "2026.07.28",
          actor: "cli-user"
        }
      }
    ]);
    expect(output).toEqual([{ ok: true }]);
  });

  it("requires explicit confirmation before requesting an import", async () => {
    const { client, program } = fixture();
    for (const command of [
      program,
      ...program.commands,
      ...program.commands.flatMap((command) => command.commands)
    ]) {
      command.exitOverride();
      command.configureOutput({
        writeErr: () => undefined,
        writeOut: () => undefined
      });
    }
    await expect(
      program.parseAsync([
        "node",
        "bpa",
        "dataset",
        "import",
        "./packaging.xlsx",
        "--id",
        "packaging-master",
        "--version",
        "1.0.0"
      ])
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(client.calls).toEqual([]);
  });

  it("maps inspect and bounded record reads to their control methods", async () => {
    const inspected = fixture();
    await inspected.program.parseAsync([
      "node",
      "bpa",
      "dataset",
      "inspect",
      "packaging-master",
      "--version",
      "1.0.0"
    ]);
    expect(inspected.client.calls).toEqual([
      {
        method: "dataset.inspect",
        params: { id: "packaging-master", version: "1.0.0" }
      }
    ]);

    const read = fixture();
    await read.program.parseAsync([
      "node",
      "bpa",
      "dataset",
      "read",
      "packaging-master",
      "--version",
      "1.0.0",
      "--after-record-key",
      "id:pack-one",
      "--limit",
      "250"
    ]);
    expect(read.client.calls).toEqual([
      {
        method: "dataset.read",
        params: {
          id: "packaging-master",
          version: "1.0.0",
          afterRecordKey: "id:pack-one",
          limit: 250
        }
      }
    ]);
  });
});

describe("Trigger CLI control mapping",() => {
  it("fires a Manual Trigger with a caller idempotency key",async () => {
    const { client,program } = fixture();
    await program.parseAsync([
      "node","bpa","trigger","fire","inventory.manual",
      "--request-key","operator-20260805-1"
    ]);
    expect(client.calls).toEqual([{
      method:"trigger.fire",
      params:{
        id:"inventory.manual",requestKey:"operator-20260805-1",actor:"cli-user"
      }
    }]);
  });
});

describe("single Node CLI control mapping", () => {
  it("previews an exact Node without starting it", async () => {
    const { client, program } = fixture();
    await program.parseAsync([
      "node",
      "bpa",
      "node-preview",
      "data.constant",
      "--version",
      "1.0.0",
      "--input",
      '{"value":"preview"}'
    ]);
    expect(client.calls).toEqual([
      {
        method: "run.node.preview",
        params: {
          nodeId: "data.constant",
          nodeVersion: "1.0.0",
          input: { value: "preview" }
        }
      }
    ]);
  });

  it("uses the exact preview digest when starting an R0 Node", async () => {
    const { client, output, program } = fixture();
    await program.parseAsync([
      "node",
      "bpa",
      "run-node",
      "data.constant",
      "--version",
      "1.0.0",
      "--input",
      '{"value":"run"}'
    ]);
    expect(client.calls).toEqual([
      {
        method: "run.node.preview",
        params: {
          nodeId: "data.constant",
          nodeVersion: "1.0.0",
          input: { value: "run" }
        }
      },
      {
        method: "run.node.create",
        params: {
          nodeId: "data.constant",
          nodeVersion: "1.0.0",
          input: { value: "run" },
          expectedPreviewDigest: "sha256:preview",
          confirmed: false,
          resourceBindings: {},
          actor: "cli-user"
        }
      }
    ]);
    expect(output).toEqual([
      {
        preview: {
          previewDigest: "sha256:preview",
          requiresConfirmation: false
        },
        run: { ok: true }
      }
    ]);
  });
});

describe("generic Workflow run CLI", () => {
  it("resolves public resource slots and runs an arbitrary Workflow", async () => {
    const { client, output, program } = fixture();
    await program.parseAsync([
      "node",
      "bpa",
      "workflow-run",
      "doudian.alliance-retired-products-monitor",
      "--version",
      "2.0.0",
      "--input",
      '{"maxShops":100}'
    ]);
    expect(client.calls).toEqual([
      {
        method: "browser.resource-binding.resolve",
        params: {
          workflowId: "doudian.alliance-retired-products-monitor",
          workflowVersion: "2.0.0"
        }
      },
      {
        method: "run.create",
        params: {
          workflowId: "doudian.alliance-retired-products-monitor",
          workflowVersion: "2.0.0",
          input: { maxShops: 100 },
          resourceBindings: {
            alliance_browser: {
              sessionId: "browser-session-1",
              browserInstanceId: "browser-instance-1",
              tabId: 42,
              observationRevision: 3
            }
          },
          actor: "cli-user"
        }
      }
    ]);
    expect(output).toEqual([
      expect.objectContaining({ id: "run-monitor", status: "succeeded" })
    ]);
  });

  it("reads Workflow input from a file without shell quote parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "bpa-cli-input-"));
    try {
      const inputPath = join(root, "workflow input.json");
      await writeFile(
        inputPath,
        '{"maxShops":100,"note":"双引号 \\"保留\\""}',
        "utf8"
      );
      const { client, program } = fixture();
      await program.parseAsync([
        "node",
        "bpa",
        "workflow-run",
        "doudian.alliance-retired-products-monitor",
        "--version",
        "2.0.0",
        "--input-file",
        inputPath
      ]);
      expect(client.calls).toContainEqual({
        method: "run.create",
        params: expect.objectContaining({
          input: { maxShops: 100, note: '双引号 "保留"' }
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
