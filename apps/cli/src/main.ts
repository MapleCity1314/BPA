#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startConsoleHost,
  UnixSocketStagingUploader,
  UdsControlBackend,
  type ConsoleHostHandle
} from "@bpa/console-host";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { createCliProgram } from "./program.js";

const controlClient = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-cli", version: "0.6.0" },
    features: [
      "evidence_refs",
      "resource_bindings",
      "staging_leases"
    ]
  })
);
let consoleHost: ConsoleHostHandle | undefined;

function openConsoleUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", arguments: [url] }
      : process.platform === "win32"
        ? {
            file: "rundll32.exe",
            arguments: ["url.dll,FileProtocolHandler", url]
          }
        : { file: "xdg-open", arguments: [url] };
  execFile(command.file, command.arguments, (error) => {
    if (error) {
      process.stderr.write(
        "BPA Console 已启动，但无法自动打开浏览器；请复制上方 URL。\n"
      );
    }
  });
}

function consoleStaticRoot(): string {
  const configured = process.env.BPA_CONSOLE_STATIC_ROOT?.trim();
  if (configured) return resolve(configured);
  const installed = fileURLToPath(new URL("../console", import.meta.url));
  if (existsSync(resolve(installed, "index.html"))) return installed;
  return resolve(import.meta.dirname, "../../operator-console/dist");
}

await createCliProgram({
  client: controlClient,
  actor: userInfo().username,
  async launchConsole() {
    if (consoleHost) return { url: consoleHost.launchUrl };
    consoleHost = await startConsoleHost({
      backend: new UdsControlBackend(controlClient, {
        actorId: userInfo().username,
        stagingUploader: new UnixSocketStagingUploader()
      }),
      staticRoot: consoleStaticRoot()
    });
    if (process.env.BPA_CONSOLE_NO_OPEN !== "1") {
      openConsoleUrl(consoleHost.launchUrl);
    }
    return { url: consoleHost.launchUrl };
  }
})
  .version("0.6.0", "--cli-version", "show CLI version")
  .parseAsync();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void consoleHost?.close().finally(() => process.exit(0));
  });
}
