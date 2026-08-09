#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

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
    "  --core-metrics <path>       Read allowlisted same-connection Core metrics",
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
    else if (argument === "--core-metrics") options.coreMetricsPath = value;
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

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function coreMetrics(path) {
  if (!path) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      status:
        error && typeof error === "object" && error.code === "ENOENT"
          ? "missing"
          : "invalid"
    };
  }
  const sqlite = document?.sqlite;
  const processMetrics = document?.process;
  const browserGateway = document?.browserGateway;
  const pageProbes = browserGateway?.pageProbes;
  const extension = browserGateway?.extension;
  const pacingReservations = extension?.pacingReservations;
  const extensionProbes = extension?.probes;
  const valid =
    document?.schema === "bpa.core-runtime-metrics/1" &&
    Number.isFinite(Date.parse(document.sampledAt)) &&
    safeInteger(document.pid, 1) &&
    (document.runtimeIdentity === null ||
      (typeof document.runtimeIdentity === "string" &&
        document.runtimeIdentity.length > 0 &&
        document.runtimeIdentity.length <= 200)) &&
    safeInteger(processMetrics?.rssBytes) &&
    safeInteger(processMetrics?.heapTotalBytes) &&
    safeInteger(processMetrics?.heapUsedBytes) &&
    processMetrics.heapUsedBytes <= processMetrics.heapTotalBytes &&
    safeInteger(processMetrics?.externalBytes) &&
    safeInteger(processMetrics?.arrayBuffersBytes) &&
    safeInteger(browserGateway?.connectionCount) &&
    safeInteger(browserGateway?.readySessionCount) &&
    browserGateway.readySessionCount <= browserGateway.connectionCount &&
    safeInteger(browserGateway?.pendingCancelRequestCount) &&
    safeInteger(pageProbes?.active) &&
    safeInteger(pageProbes?.capacity, 1) &&
    pageProbes.active <= pageProbes.capacity &&
    safeInteger(pageProbes?.ttlMs, 1) &&
    extension &&
    safeInteger(extension.activeCommands) &&
    safeInteger(extension.activeTabCommands) &&
    extension.activeTabCommands <= extension.activeCommands &&
    safeInteger(extension.activeAllianceStages) &&
    extension.activeAllianceStages <= extension.activeCommands &&
    safeInteger(extension.cancellationRequests) &&
    extension.cancellationRequests <= extension.activeCommands &&
    safeInteger(extension.cancellationStopBarriers) &&
    extension.cancellationStopBarriers === extension.cancellationRequests &&
    safeInteger(extension.observedTabs) &&
    safeInteger(extension.observationCapacity, 1) &&
    extension.observedTabs <= extension.observationCapacity &&
    safeInteger(extension.managedTabs) &&
    safeInteger(pacingReservations?.active) &&
    safeInteger(pacingReservations?.capacity, 1) &&
    pacingReservations.active <= pacingReservations.capacity &&
    safeInteger(pacingReservations?.ttlMs, 1) &&
    safeInteger(extensionProbes?.active) &&
    safeInteger(extensionProbes?.capacity, 1) &&
    extensionProbes.active <= extensionProbes.capacity &&
    safeInteger(extensionProbes?.ttlMs, 1) &&
    sqlite?.measurement === "same_connection_db_status64" &&
    safeInteger(sqlite.configuredCacheBytes) &&
    safeInteger(sqlite.pageSizeBytes, 1) &&
    Number.isSafeInteger(sqlite.cacheSizeSetting) &&
    safeInteger(sqlite.cacheUsedBytes) &&
    safeInteger(sqlite.schemaUsedBytes) &&
    safeInteger(sqlite.statementUsedBytes);
  if (!valid) return { status: "invalid" };
  return {
    status: "available",
    sampledAt: document.sampledAt,
    pid: document.pid,
    runtimeIdentity: document.runtimeIdentity,
    process: {
      rssBytes: processMetrics.rssBytes,
      heapTotalBytes: processMetrics.heapTotalBytes,
      heapUsedBytes: processMetrics.heapUsedBytes,
      externalBytes: processMetrics.externalBytes,
      arrayBuffersBytes: processMetrics.arrayBuffersBytes
    },
    browserGateway: {
      connectionCount: browserGateway.connectionCount,
      readySessionCount: browserGateway.readySessionCount,
      pendingCancelRequestCount:
        browserGateway.pendingCancelRequestCount,
      pageProbes: {
        active: pageProbes.active,
        capacity: pageProbes.capacity,
        ttlMs: pageProbes.ttlMs
      },
      extension: {
        activeCommands: extension.activeCommands,
        activeTabCommands: extension.activeTabCommands,
        activeAllianceStages: extension.activeAllianceStages,
        cancellationRequests: extension.cancellationRequests,
        cancellationStopBarriers: extension.cancellationStopBarriers,
        observedTabs: extension.observedTabs,
        observationCapacity: extension.observationCapacity,
        managedTabs: extension.managedTabs,
        pacingReservations: {
          active: pacingReservations.active,
          capacity: pacingReservations.capacity,
          ttlMs: pacingReservations.ttlMs
        },
        probes: {
          active: extensionProbes.active,
          capacity: extensionProbes.capacity,
          ttlMs: extensionProbes.ttlMs
        }
      }
    },
    sqlite: {
      measurement: sqlite.measurement,
      configuredCacheBytes: sqlite.configuredCacheBytes,
      pageSizeBytes: sqlite.pageSizeBytes,
      cacheSizeSetting: sqlite.cacheSizeSetting,
      cacheUsedBytes: sqlite.cacheUsedBytes,
      schemaUsedBytes: sqlite.schemaUsedBytes,
      statementUsedBytes: sqlite.statementUsedBytes
    }
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
    sqlite: sqliteFiles(options.sqlitePath),
    coreMetrics: coreMetrics(options.coreMetricsPath)
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

export async function collectUntilComplete(options, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const collect = dependencies.collect ?? collectSample;
  const write = dependencies.write ?? writeSample;
  const first = collect(options);
  write(first, options.output);
  if (options.durationSeconds === 0) return;

  const firstSampledAt = Date.parse(first.sampledAt);
  if (!Number.isFinite(firstSampledAt)) {
    throw new Error("The first resource sample has an invalid timestamp");
  }
  const intervalMilliseconds = options.intervalSeconds * 1_000;
  const deadline = firstSampledAt + options.durationSeconds * 1_000;
  let scheduledAt = Math.min(deadline, firstSampledAt + intervalMilliseconds);
  while (true) {
    await sleep(Math.max(0, scheduledAt - now()));
    const sample = collect(options);
    write(sample, options.output);
    const sampledAt = Date.parse(sample.sampledAt);
    if (!Number.isFinite(sampledAt)) {
      throw new Error("A resource sample has an invalid timestamp");
    }
    if (sampledAt >= deadline) return;
    const nextRegularSample = scheduledAt + intervalMilliseconds;
    scheduledAt = Math.min(
      deadline,
      nextRegularSample <= now()
        ? now() + intervalMilliseconds
        : nextRegularSample
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await collectUntilComplete(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
