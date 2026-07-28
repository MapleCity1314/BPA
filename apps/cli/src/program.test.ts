import { resolve } from "node:path";
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
    return { ok: true } as TResult;
  }
}

function fixture() {
  const client = new RecordingClient();
  const output: unknown[] = [];
  const program = createCliProgram({
    client,
    actor: "cli-user",
    writeOutput: (value) => output.push(value)
  });
  return { client, output, program };
}

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
