#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = "bpa.runtime-resource-sample/1";
const DEFAULT_LABELS = [
  "com.bpa.core",
  "com.bpa.inventory-monitor",
  "com.bpa.inventory-chrome"
];

function usage() {
  return [
    "Usage: node scripts/collect-macos-runtime-metrics.mjs [options]",
    "",
    "Options:",
    "  --output <path>             Append JSONL samples to a mode-0600 file",
    "  --duration-seconds <n>      Total sampling duration; 0 records once",
    "  --interval-seconds <n>      Interval between samples, minimum 10",
    "  --chrome-profile <path>     Aggregate only Chrome processes for this profile",
    "  --sqlite <path>             Record database, WAL and SHM file sizes",
    "  --label <launchd-label>     Replace the default BPA launchd labels; repeatable",
    "  --help                      Show this help"
  ].join("\n");
}

function parsePositiveInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    labels: [],
    durationSeconds: 0,
    intervalSeconds: 60
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--output") options.output = value;
    else if (argument === "--duration-seconds") {
      options.durationSeconds = parsePositiveInteger(value, argument, 0);
    } else if (argument === "--interval-seconds") {
      options.intervalSeconds = parsePositiveInteger(value, argument, 10);
    } else if (argument === "--chrome-profile") options.chromeProfile = value;
    else if (argument === "--sqlite") options.sqlitePath = value;
    else if (argument === "--label") options.labels.push(value);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.labels.length === 0) options.labels = [...DEFAULT_LABELS];
  if (options.durationSeconds > 0 && !options.output) {
    throw new Error("--output is required for continuous sampling");
  }
  return options;
}

function commandOutput(command, arguments_) {
  try {
    return execFileSync(command, arguments_, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function launchdPids() {
  const pids = new Map();
  for (const line of commandOutput("launchctl", ["list"]).split("\n")) {
    const match = line.match(/^\s*(\d+|-)\s+[-\d]+\s+(\S+)\s*$/u);
    if (!match || match[1] === "-") continue;
    pids.set(match[2], Number(match[1]));
  }
  return pids;
}

function processTable() {
  const processes = [];
  const output = commandOutput("ps", [
    "-axo",
    "pid=,ppid=,%cpu=,rss=,etime=,command="
  ]);
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/u
    );
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssKiB: Number(match[4]),
      elapsed: match[5],
      command: match[6]
    });
  }
  return processes;
}

function publicProcess(process) {
  if (!process) return null;
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    cpuPercent: process.cpuPercent,
    rssKiB: process.rssKiB,
    elapsed: process.elapsed
  };
}

function aggregateChrome(processes, profilePath) {
  if (!profilePath) return null;
  const marker = `--user-data-dir=${profilePath}`;
  const selected = processes.filter((process) => process.command.includes(marker));
  return {
    processCount: selected.length,
    cpuPercent: Number(
      selected.reduce((sum, process) => sum + process.cpuPercent, 0).toFixed(2)
    ),
    rssKiB: selected.reduce((sum, process) => sum + process.rssKiB, 0)
  };
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function sqliteFiles(sqlitePath) {
  if (!sqlitePath) return null;
  return {
    databaseBytes: fileSize(sqlitePath),
    walBytes: fileSize(`${sqlitePath}-wal`),
    shmBytes: fileSize(`${sqlitePath}-shm`)
  };
}

function collectSample(options) {
  const pids = launchdPids();
  const processes = processTable();
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const services = Object.fromEntries(
    options.labels.map((label) => [label, publicProcess(byPid.get(pids.get(label)))])
  );
  return {
    schema: SCHEMA,
    sampledAt: new Date().toISOString(),
    services,
    chromeProfile: aggregateChrome(processes, options.chromeProfile),
    sqlite: sqliteFiles(options.sqlitePath)
  };
}

function writeSample(sample, output) {
  const line = `${JSON.stringify(sample)}\n`;
  if (!output) {
    process.stdout.write(line);
    return;
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  appendFileSync(output, line, { encoding: "utf8", mode: 0o600 });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const startedAt = Date.now();
  do {
    writeSample(collectSample(options), options.output);
    if (options.durationSeconds === 0) break;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (elapsedSeconds + options.intervalSeconds > options.durationSeconds) break;
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalSeconds * 1000)
    );
  } while (true);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
