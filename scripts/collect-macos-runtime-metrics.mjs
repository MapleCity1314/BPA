#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "bpa.runtime-resource-sample/2";
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

function isNodeProcess(process) {
  const executable = process.command.trim().split(/\s+/u)[0]?.replace(
    /^['"]|['"]$/gu,
    ""
  );
  if (!executable) return false;
  return /^node(?:-[a-z0-9._-]+)?$/iu.test(basename(executable));
}

function isNativeHostProcess(process) {
  const executable = process.command.trim().split(/\s+/u)[0]?.replace(
    /^['"]|['"]$/gu,
    ""
  );
  if (!executable) return false;
  return (
    basename(executable) === "bpa-native-host" ||
    (isNodeProcess(process) &&
      process.command.includes("apps/native-host/src/main.ts"))
  );
}

export function classifyRuntimeProcesses(processes, services, metrics) {
  if (metrics?.status !== "available") return null;
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const nativeHostPids = metrics.browserGateway.nativeHostPids;
  const nativeHostProcesses = nativeHostPids.flatMap((pid) => {
    const process = byPid.get(pid);
    return process && isNativeHostProcess(process)
      ? [publicProcess(process)]
      : [];
  });
  const teamWorkerPid = metrics.teamWorker.pid;
  const corePid = services["com.bpa.core"]?.pid;
  const teamWorkerCandidate = teamWorkerPid === null
    ? undefined
    : byPid.get(teamWorkerPid);
  const teamWorkerProcess =
    teamWorkerCandidate && teamWorkerCandidate.parentPid === corePid
      ? publicProcess(teamWorkerCandidate)
      : null;
  const rootPids = [
    services["com.bpa.core"]?.pid,
    services["com.bpa.inventory-monitor"]?.pid
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const descendantPids = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (
        descendantPids.has(process.pid) ||
        (!rootPids.includes(process.parentPid) &&
          !descendantPids.has(process.parentPid))
      ) {
        continue;
      }
      descendantPids.add(process.pid);
      changed = true;
    }
  }
  const excludedPids = new Set([
    ...rootPids,
    ...nativeHostPids,
    ...(teamWorkerPid === null ? [] : [teamWorkerPid])
  ]);
  const shortLivedNodeChildren = processes
    .filter(
      (process) =>
        descendantPids.has(process.pid) &&
        !excludedPids.has(process.pid) &&
        isNodeProcess(process)
    )
    .sort((left, right) => left.pid - right.pid)
    .map(publicProcess);
  return {
    nativeHosts: {
      declaredPids: [...nativeHostPids],
      missingPids: nativeHostPids.filter(
        (pid) => !nativeHostProcesses.some((process) => process.pid === pid)
      ),
      processes: nativeHostProcesses
    },
    teamWorker: {
      state: metrics.teamWorker.state,
      declaredPid: teamWorkerPid,
      process: teamWorkerProcess
    },
    shortLivedNodeChildren
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

function safeNumber(value, minimum = 0) {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum
  );
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
  const eventLoop = document?.eventLoop;
  const activity = document?.activity;
  const browserGateway = document?.browserGateway;
  const gatewayQueue = browserGateway?.queue;
  const pageProbes = browserGateway?.pageProbes;
  const extension = browserGateway?.extension;
  const teamWorker = document?.teamWorker;
  const pacingReservations = extension?.pacingReservations;
  const extensionProbes = extension?.probes;
  const valid =
    document?.schema === "bpa.core-runtime-metrics/4" &&
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
    eventLoop?.resolutionMs === 20 &&
    safeInteger(eventLoop?.sampleCount) &&
    safeNumber(eventLoop?.minimumMs) &&
    safeNumber(eventLoop?.maximumMs) &&
    safeNumber(eventLoop?.meanMs) &&
    safeNumber(eventLoop?.p50Ms) &&
    safeNumber(eventLoop?.p95Ms) &&
    safeNumber(eventLoop?.p99Ms) &&
    eventLoop.minimumMs <= eventLoop.maximumMs &&
    eventLoop.minimumMs <= eventLoop.meanMs &&
    eventLoop.meanMs <= eventLoop.maximumMs &&
    eventLoop.minimumMs <= eventLoop.p50Ms &&
    eventLoop.p50Ms <= eventLoop.p95Ms &&
    eventLoop.p95Ms <= eventLoop.p99Ms &&
    eventLoop.p99Ms <= eventLoop.maximumMs &&
    activity &&
    [
      activity.activeRunCount,
      activity.activeTriggerOccurrenceCount,
      activity.activeTriggerAttemptCount,
      activity.pendingEngineOutboxCount,
      activity.activeControlLeaseCount,
      activity.activeExternalDomainLeaseCount,
      activity.activeStagingLeaseCount,
      activity.activeRecoverySessionCount,
      activity.activeAttentionDeliveryCount,
      activity.terminalRunCount
    ].every((value) => safeInteger(value)) &&
    ((activity.terminalRunCount === 0) ===
      (activity.latestTerminalRunAt === null)) &&
    (activity.latestTerminalRunAt === null ||
      (Number.isFinite(Date.parse(activity.latestTerminalRunAt)) &&
        Date.parse(activity.latestTerminalRunAt) <=
          Date.parse(document.sampledAt))) &&
    teamWorker &&
    ["stopped", "starting", "ready"].includes(teamWorker.state) &&
    safeInteger(teamWorker.pendingInvocationCount) &&
    ((teamWorker.state === "stopped" &&
      teamWorker.pid === null &&
      teamWorker.pendingInvocationCount === 0) ||
      (teamWorker.state !== "stopped" && safeInteger(teamWorker.pid, 1))) &&
    safeInteger(browserGateway?.connectionCount) &&
    safeInteger(browserGateway?.readySessionCount) &&
    browserGateway.readySessionCount <= browserGateway.connectionCount &&
    safeInteger(browserGateway?.pendingCancelRequestCount) &&
    Array.isArray(browserGateway?.nativeHostPids) &&
    browserGateway.nativeHostPids.length === browserGateway.connectionCount &&
    browserGateway.nativeHostPids.every((pid) => safeInteger(pid, 1)) &&
    new Set(browserGateway.nativeHostPids).size ===
      browserGateway.nativeHostPids.length &&
    browserGateway.nativeHostPids.every(
      (pid, index, values) => index === 0 || values[index - 1] < pid
    ) &&
    safeInteger(gatewayQueue?.pendingBrowserOutbox) &&
    safeInteger(gatewayQueue?.queuedCommands) &&
    safeInteger(gatewayQueue?.inFlightCommands) &&
    safeInteger(gatewayQueue?.terminalResultsPendingApplication) &&
    safeInteger(gatewayQueue?.totalPending) &&
    gatewayQueue.totalPending ===
      gatewayQueue.pendingBrowserOutbox +
        gatewayQueue.queuedCommands +
        gatewayQueue.inFlightCommands +
        gatewayQueue.terminalResultsPendingApplication &&
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
    safeInteger(extension.profileTabs) &&
    extension.profileTabs <= 1024 &&
    safeInteger(extension.managedTabs) &&
    safeInteger(extension.managedTabReservations) &&
    extension.managedTabCapacity === 8 &&
    extension.managedTabs + extension.managedTabReservations <=
      extension.managedTabCapacity &&
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
    eventLoop: {
      resolutionMs: eventLoop.resolutionMs,
      sampleCount: eventLoop.sampleCount,
      minimumMs: eventLoop.minimumMs,
      maximumMs: eventLoop.maximumMs,
      meanMs: eventLoop.meanMs,
      p50Ms: eventLoop.p50Ms,
      p95Ms: eventLoop.p95Ms,
      p99Ms: eventLoop.p99Ms
    },
    activity: {
      activeRunCount: activity.activeRunCount,
      activeTriggerOccurrenceCount: activity.activeTriggerOccurrenceCount,
      activeTriggerAttemptCount: activity.activeTriggerAttemptCount,
      pendingEngineOutboxCount: activity.pendingEngineOutboxCount,
      activeControlLeaseCount: activity.activeControlLeaseCount,
      activeExternalDomainLeaseCount:
        activity.activeExternalDomainLeaseCount,
      activeStagingLeaseCount: activity.activeStagingLeaseCount,
      activeRecoverySessionCount: activity.activeRecoverySessionCount,
      activeAttentionDeliveryCount: activity.activeAttentionDeliveryCount,
      terminalRunCount: activity.terminalRunCount,
      latestTerminalRunAt: activity.latestTerminalRunAt
    },
    teamWorker: {
      state: teamWorker.state,
      pid: teamWorker.pid,
      pendingInvocationCount: teamWorker.pendingInvocationCount
    },
    browserGateway: {
      connectionCount: browserGateway.connectionCount,
      readySessionCount: browserGateway.readySessionCount,
      pendingCancelRequestCount:
        browserGateway.pendingCancelRequestCount,
      nativeHostPids: [...browserGateway.nativeHostPids],
      queue: {
        pendingBrowserOutbox: gatewayQueue.pendingBrowserOutbox,
        queuedCommands: gatewayQueue.queuedCommands,
        inFlightCommands: gatewayQueue.inFlightCommands,
        terminalResultsPendingApplication:
          gatewayQueue.terminalResultsPendingApplication,
        totalPending: gatewayQueue.totalPending
      },
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
        profileTabs: extension.profileTabs,
        managedTabs: extension.managedTabs,
        managedTabReservations: extension.managedTabReservations,
        managedTabCapacity: extension.managedTabCapacity,
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
  const collectedCoreMetrics = coreMetrics(options.coreMetricsPath);
  return {
    schema: SCHEMA,
    sampledAt: new Date().toISOString(),
    services,
    chromeProfile: aggregateChrome(processes, options.chromeProfile),
    sqlite: sqliteFiles(options.sqlitePath),
    coreMetrics: collectedCoreMetrics,
    runtimeProcesses: classifyRuntimeProcesses(
      processes,
      services,
      collectedCoreMetrics
    )
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
