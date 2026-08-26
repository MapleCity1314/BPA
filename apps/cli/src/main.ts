#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleLaunchHandle } from "@bpa/operator-console-contracts";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { createCliProgram } from "./program.js";

const controlClient = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(), {
    runtime: { name: "bpa-cli", version: "0.6.8" },
    features: [
      "evidence_refs",
      "resource_bindings",
      "staging_leases"
    ]
  })
);
let consoleHost: ConsoleLaunchHandle | undefined;

async function launchConsoleHostProcess(): Promise<ConsoleLaunchHandle> {
  const packagedEntry = resolve(import.meta.dirname, "bpa-console-host.js");
  const configuredEntry = process.env.BPA_CONSOLE_HOST_ENTRY?.trim();
  const entry = configuredEntry
    ? resolve(configuredEntry)
    : existsSync(packagedEntry)
      ? packagedEntry
      : undefined;
  if (!entry) {
    throw new Error(
      "BPA Console Host executable is unavailable; set BPA_CONSOLE_HOST_ENTRY"
    );
  }
  const development = entry.endsWith(".ts");
  const child = spawn(
    process.execPath,
    [...(development ? ["--import", "tsx"] : []), entry],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BPA_CONSOLE_STATIC_ROOT: consoleStaticRoot(),
        BPA_ACTOR_ID: userInfo().username
      }
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const launchUrl = await new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("BPA Console Host startup timed out"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u)[0]?.trim();
      if (line?.startsWith("http://127.0.0.1:")) {
        clearTimeout(timer);
        resolveUrl(line);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `BPA Console Host exited before readiness (${String(code)}): ${stderr}`
        )
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    launchUrl,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolveClosed) => {
        child.once("exit", () => resolveClosed());
        setTimeout(resolveClosed, 2_000);
      });
    }
  };
}

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
    consoleHost = await launchConsoleHostProcess();
    if (process.env.BPA_CONSOLE_NO_OPEN !== "1") {
      openConsoleUrl(consoleHost.launchUrl);
    }
    return { url: consoleHost.launchUrl };
  }
})
  .version("0.6.8", "--cli-version", "show CLI version")
  .parseAsync();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void consoleHost?.close().finally(() => process.exit(0));
  });
}
