import { execFileSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import {
  assertManagedChromeManifest,
  assertManagedChromeProcessCommand,
  assertRuntimeMaintenanceReadiness,
  MACOS_MANAGED_CHROME_CONTRACT,
  renderManagedChromeLaunchAgent
} from "./macos-runtime-install-contract.mjs";

function absolutePath(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    resolve(value) !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${name} must be an absolute single-line path`);
  }
  return value;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Managed Chrome gate options are invalid");
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function exactOptions(options, expected) {
  if (
    JSON.stringify(Object.keys(options).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new Error("Managed Chrome gate option fields are invalid");
  }
}

function readAndAssertManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.platform !== "darwin" || manifest.architecture !== "arm64") {
    throw new Error("Managed Chrome requires a macOS arm64 Runtime closure");
  }
  assertManagedChromeManifest(manifest.managedChrome);
}

function writeLaunchAgent(path, source) {
  const target = absolutePath(path, "Launch Agent path");
  const temporary = `${target}.next.${process.pid}`;
  writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function verifyLaunchAgent(path, source) {
  const target = absolutePath(path, "Launch Agent path");
  if (readFileSync(target, "utf8") !== source) {
    throw new Error("Installed managed Chrome Launch Agent differs from closure");
  }
  const metadata = statSync(target);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Installed managed Chrome Launch Agent mode is invalid");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Installed managed Chrome Launch Agent owner is invalid");
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "maintenance") {
    if (rest.length !== 1) throw new Error("maintenance requires one JSON path");
    const status = assertRuntimeMaintenanceReadiness(
      JSON.parse(readFileSync(rest[0], "utf8"))
    );
    process.stdout.write(`${status.ready ? "ready" : "waiting"}\n`);
    return;
  }
  if (command !== "chrome-write" && command !== "chrome-verify") {
    throw new Error("Unknown macOS Runtime install gate command");
  }
  const options = parseOptions(rest);
  exactOptions(
    options,
    command === "chrome-verify"
      ? ["manifest", "path", "bpa-home", "runtime-root", "log-root", "pid"]
      : ["manifest", "path", "bpa-home", "runtime-root", "log-root"]
  );
  readAndAssertManifest(absolutePath(options.manifest, "Runtime manifest"));
  const source = renderManagedChromeLaunchAgent({
    bpaHome: options["bpa-home"],
    runtimeRoot: options["runtime-root"],
    logRoot: options["log-root"]
  });
  if (command === "chrome-write") {
    writeLaunchAgent(options.path, source);
    return;
  }
  verifyLaunchAgent(options.path, source);
  const pid = Number(options.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Managed Chrome PID is invalid");
  }
  process.kill(pid, 0);
  const commandLine = execFileSync(
    "ps",
    ["-p", String(pid), "-o", "command="],
    { encoding: "utf8" }
  ).trim();
  assertManagedChromeProcessCommand(commandLine, options["bpa-home"]);
  process.stdout.write(
    `${JSON.stringify({ status: "verified", pid, label: MACOS_MANAGED_CHROME_CONTRACT.launchAgentLabel })}\n`
  );
}

main(process.argv.slice(2));
