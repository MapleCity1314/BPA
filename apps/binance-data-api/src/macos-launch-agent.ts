import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BINANCE_DATA_LAUNCH_AGENT_LABEL = "com.bpa.binance-data-api";

export interface BinanceDataLaunchAgentOptions {
  repoRoot: string;
  bpaHome: string;
  nodePath: string;
  envFile: string;
  logRoot: string;
}

function absolutePath(value: string, label: string): string {
  if (!value || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be an absolute single-line path`);
  }
  return value;
}

const xml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export function renderBinanceDataLaunchAgent(input: BinanceDataLaunchAgentOptions): string {
  const repoRoot = absolutePath(input.repoRoot, "Repository root");
  const bpaHome = absolutePath(input.bpaHome, "BPA home");
  const nodePath = absolutePath(input.nodePath, "Node path");
  const envFile = absolutePath(input.envFile, "Environment file");
  const logRoot = absolutePath(input.logRoot, "Log root");
  const loader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const entry = join(repoRoot, "apps", "binance-data-api", "src", "main.ts");
  const values = [nodePath, "--import", loader, entry].map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BINANCE_DATA_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${values}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BPA_HOME</key><string>${xml(bpaHome)}</string>
    <key>BINANCE_DATA_HOST</key><string>127.0.0.1</string>
    <key>BINANCE_DATA_PORT</key><string>43124</string>
    <key>BINANCE_DATA_ALLOWED_ORIGIN</key><string>zero://app</string>
    <key>BINANCE_DATA_ENV_FILE</key><string>${xml(envFile)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(join(logRoot, "binance-data-api.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logRoot, "binance-data-api.error.log"))}</string>
</dict>
</plist>
`;
}

function option(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function installBinanceDataLaunchAgent(argv: readonly string[]): string {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS");
  if (typeof process.getuid !== "function") throw new Error("LaunchAgent installation requires a user session");
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const repoRoot = absolutePath(option(argv, "--repo-root", sourceRoot), "Repository root");
  const bpaHome = absolutePath(option(argv, "--bpa-home", join(homedir(), "Library", "Application Support", "BPA")), "BPA home");
  const nodePath = absolutePath(option(argv, "--node", process.execPath), "Node path");
  const envFile = absolutePath(option(argv, "--env-file", ""), "Environment file");
  const logRoot = join(homedir(), "Library", "Logs", "BPA");

  for (const [path, label] of [[repoRoot, "Repository root"], [nodePath, "Node path"], [envFile, "Environment file"]] as const) {
    const metadata = statSync(path);
    if (label === "Repository root" ? !metadata.isDirectory() : !metadata.isFile()) throw new Error(`${label} is invalid`);
  }
  if ((statSync(envFile).mode & 0o077) !== 0) throw new Error("Environment file must not be group/world accessible");
  const nodeMajor = execFileSync(nodePath, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).trim();
  if (nodeMajor !== "24") throw new Error("Binance Data API LaunchAgent requires Node.js 24");
  for (const path of [join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"), join(repoRoot, "apps", "binance-data-api", "src", "main.ts")]) {
    if (!statSync(path).isFile()) throw new Error(`Runtime entry is missing: ${path}`);
  }

  mkdirSync(logRoot, { recursive: true });
  const launchAgentRoot = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(launchAgentRoot, { recursive: true });
  const target = join(launchAgentRoot, `${BINANCE_DATA_LAUNCH_AGENT_LABEL}.plist`);
  const source = renderBinanceDataLaunchAgent({ repoRoot, bpaHome, nodePath, envFile, logRoot });
  const temporary = `${target}.next.${process.pid}`;
  writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  if (readFileSync(target, "utf8") !== source) throw new Error("Installed LaunchAgent verification failed");

  const domain = `gui/${process.getuid()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${BINANCE_DATA_LAUNCH_AGENT_LABEL}`], { stdio: "ignore" }); } catch {}
  execFileSync("launchctl", ["bootstrap", domain, target], { stdio: "inherit" });
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${BINANCE_DATA_LAUNCH_AGENT_LABEL}`], { stdio: "inherit" });
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (command !== "install") throw new Error("Usage: install --env-file /absolute/path [--node /absolute/node24]");
    process.stdout.write(`${installBinanceDataLaunchAgent(argv)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "LaunchAgent installation failed"}\n`);
    process.exitCode = 1;
  }
}
