#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const INPUT_SCHEMA = "bpa.runtime-resource-sample/2";
const OUTPUT_SCHEMA = "bpa.runtime-resource-analysis/2";
const CORE_STABILITY_WINDOW_HOURS = 168;
const CORE_RSS_BASELINE_WINDOW_HOURS = 24;
const CORE_RSS_ABSOLUTE_GROWTH_LIMIT_KIB = 8 * 1024;
const CORE_RSS_RELATIVE_GROWTH_LIMIT = 0.1;
const CORE_RSS_MONOTONIC_RATIO_LIMIT = 0.8;
const CORE_RSS_MONOTONIC_GROWTH_FLOOR_KIB = 4 * 1024;
const RUNTIME_QUIESCENCE_REQUIRED_MS = 15 * 60 * 1_000;

function usage() {
  return [
    "Usage: node scripts/analyze-macos-runtime-metrics.mjs --input <path> [options]",
    "",
    "Options:",
    "  --input <path>                    Read JSONL resource samples",
    "  --output <path>                   Write the JSON analysis instead of stdout",
    "  --expected-interval-seconds <n>   Expected sampling interval, default 60",
    "  --minimum-duration-hours <n>      Required conclusion window, default 24",
    "  --require-complete                Exit non-zero unless the resource gate is complete",
    "  --require-stable                  Exit non-zero unless the Core 7-day gate is complete",
    "  --help                            Show this help"
  ].join("\n");
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    expectedIntervalSeconds: 60,
    minimumDurationHours: 24
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--require-complete") {
      options.requireComplete = true;
      continue;
    }
    if (argument === "--require-stable") {
      options.requireStable = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--input") options.input = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--expected-interval-seconds") {
      options.expectedIntervalSeconds = positiveNumber(value, argument);
    } else if (argument === "--minimum-duration-hours") {
      options.minimumDurationHours = positiveNumber(value, argument);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.help && !options.input) throw new Error("--input is required");
  return options;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function parseSamples(source) {
  const samples = source
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let sample;
      try {
        sample = JSON.parse(line);
      } catch {
        throw new Error(`Sample line ${index + 1} is not valid JSON`);
      }
      if (sample?.schema !== INPUT_SCHEMA) {
        throw new Error(`Sample line ${index + 1} has an unsupported schema`);
      }
      const timestamp = Date.parse(sample.sampledAt);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Sample line ${index + 1} has an invalid sampledAt`);
      }
      if (!sample.services || typeof sample.services !== "object") {
        throw new Error(`Sample line ${index + 1} has invalid services`);
      }
      return { sample, timestamp, line: index + 1 };
    });
  if (samples.length < 2) throw new Error("At least two samples are required");
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestamp <= samples[index - 1].timestamp) {
      throw new Error(`Sample line ${samples[index].line} is not chronological`);
    }
  }
  return samples;
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function seriesSummary(points, durationHours) {
  if (points.length === 0) return null;
  const values = points.map((point) => point.value);
  const start = values[0];
  const end = values.at(-1);
  const meanX = points.reduce((sum, point) => sum + point.hour, 0) / points.length;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  const denominator = points.reduce(
    (sum, point) => sum + (point.hour - meanX) ** 2,
    0
  );
  const slope = denominator === 0
    ? 0
    : points.reduce(
        (sum, point) =>
          sum + (point.hour - meanX) * (point.value - meanY),
        0
      ) / denominator;
  return {
    observedSamples: points.length,
    start,
    end,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    change: end - start,
    slopePerHour: rounded(slope),
    trendStatus: durationHours >= 24 ? "measured" : "insufficient_window"
  };
}

function processSummary(samples, select) {
  const firstTimestamp = samples[0].timestamp;
  const durationHours =
    (samples.at(-1).timestamp - firstTimestamp) / (60 * 60 * 1_000);
  const observations = samples.map(({ sample, timestamp }) => ({
    process: select(sample),
    hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000)
  }));
  const available = observations.filter(({ process }) => process !== null);
  const pids = available
    .map(({ process }) => process.pid)
    .filter((pid) => Number.isSafeInteger(pid));
  let pidChanges = 0;
  for (let index = 1; index < pids.length; index += 1) {
    if (pids[index] !== pids[index - 1]) pidChanges += 1;
  }
  return {
    availableSamples: available.length,
    missingSamples: observations.length - available.length,
    uniquePids: [...new Set(pids)],
    pidChanges,
    rssKiB: seriesSummary(
      available.map(({ process, hour }) => ({
        hour,
        value: finiteNumber(process.rssKiB, "process rssKiB")
      })),
      durationHours
    ),
    cpuPercent: seriesSummary(
      available.map(({ process, hour }) => ({
        hour,
        value: finiteNumber(process.cpuPercent, "process cpuPercent")
      })),
      durationHours
    )
  };
}

function publicProcessIsValid(process) {
  return (
    process !== null &&
    typeof process === "object" &&
    Number.isSafeInteger(process.pid) &&
    process.pid > 0 &&
    Number.isSafeInteger(process.parentPid) &&
    process.parentPid >= 0 &&
    typeof process.cpuPercent === "number" &&
    Number.isFinite(process.cpuPercent) &&
    process.cpuPercent >= 0 &&
    Number.isSafeInteger(process.rssKiB) &&
    process.rssKiB >= 0 &&
    typeof process.elapsed === "string" &&
    process.elapsed.length > 0
  );
}

function runtimeProcessRolesSummary(samples) {
  const observations = samples.map(({ sample, timestamp }) => {
    const metrics = sample.coreMetrics;
    const roles = sample.runtimeProcesses;
    const nativeHosts = roles?.nativeHosts;
    const teamWorker = roles?.teamWorker;
    const shortLived = roles?.shortLivedNodeChildren;
    const declaredNativePids = nativeHosts?.declaredPids;
    const missingNativePids = nativeHosts?.missingPids;
    const nativeProcesses = nativeHosts?.processes;
    const valid =
      metrics?.status === "available" &&
      roles &&
      nativeHosts &&
      teamWorker &&
      Array.isArray(declaredNativePids) &&
      Array.isArray(missingNativePids) &&
      Array.isArray(nativeProcesses) &&
      Array.isArray(shortLived) &&
      declaredNativePids.every(
        (pid) => Number.isSafeInteger(pid) && pid > 0
      ) &&
      new Set(declaredNativePids).size === declaredNativePids.length &&
      declaredNativePids.every(
        (pid, index) => index === 0 || declaredNativePids[index - 1] < pid
      ) &&
      missingNativePids.every((pid) => declaredNativePids.includes(pid)) &&
      new Set(missingNativePids).size === missingNativePids.length &&
      nativeProcesses.every(publicProcessIsValid) &&
      nativeProcesses.every((process) =>
        declaredNativePids.includes(process.pid)
      ) &&
      missingNativePids.every(
        (pid) => !nativeProcesses.some((process) => process.pid === pid)
      ) &&
      new Set(nativeProcesses.map((process) => process.pid)).size ===
        nativeProcesses.length &&
      nativeProcesses.length + missingNativePids.length ===
        declaredNativePids.length &&
      JSON.stringify(declaredNativePids) ===
        JSON.stringify(metrics.browserGateway?.nativeHostPids) &&
      ["stopped", "starting", "ready"].includes(teamWorker.state) &&
      teamWorker.state === metrics.teamWorker?.state &&
      teamWorker.declaredPid === metrics.teamWorker?.pid &&
      (teamWorker.process === null || publicProcessIsValid(teamWorker.process)) &&
      (teamWorker.declaredPid === null
        ? teamWorker.process === null && teamWorker.state === "stopped"
        : Number.isSafeInteger(teamWorker.declaredPid) &&
          teamWorker.declaredPid > 0 &&
          (teamWorker.process === null ||
            (teamWorker.process.pid === teamWorker.declaredPid &&
              teamWorker.process.parentPid ===
                sample.services["com.bpa.core"]?.pid))) &&
      shortLived.every(publicProcessIsValid) &&
      new Set(shortLived.map((process) => process.pid)).size ===
        shortLived.length &&
      shortLived.every(
        (process) =>
          !declaredNativePids.includes(process.pid) &&
          process.pid !== teamWorker.declaredPid
      );
    return valid ? { timestamp, roles } : null;
  });
  const measured = observations.filter((value) => value !== null);
  const nativeProcesses = measured.flatMap(
    ({ roles }) => roles.nativeHosts.processes
  );
  const teamProcesses = measured.flatMap(({ roles }) =>
    roles.teamWorker.process ? [roles.teamWorker.process] : []
  );
  const shortLivedProcesses = measured.flatMap(
    ({ roles }) => roles.shortLivedNodeChildren
  );
  const uniqueSortedPids = (processes) =>
    [...new Set(processes.map((process) => process.pid))].sort(
      (left, right) => left - right
    );
  const collectionPoints = (select) =>
    measured.map(({ timestamp, roles }) => ({
      timestamp,
      processes: select(roles)
    }));
  const summarizeCollection = (points) => {
    const firstTimestamp = samples[0].timestamp;
    const durationHours =
      (samples.at(-1).timestamp - firstTimestamp) / (60 * 60 * 1_000);
    return {
      processCount: seriesSummary(
        points.map(({ timestamp, processes }) => ({
          hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000),
          value: processes.length
        })),
        durationHours
      ),
      rssKiB: seriesSummary(
        points.map(({ timestamp, processes }) => ({
          hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000),
          value: processes.reduce((sum, process) => sum + process.rssKiB, 0)
        })),
        durationHours
      ),
      cpuPercent: seriesSummary(
        points.map(({ timestamp, processes }) => ({
          hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000),
          value: processes.reduce(
            (sum, process) => sum + process.cpuPercent,
            0
          )
        })),
        durationHours
      )
    };
  };
  const nativePoints = collectionPoints((roles) => roles.nativeHosts.processes);
  const teamPoints = collectionPoints((roles) =>
    roles.teamWorker.process ? [roles.teamWorker.process] : []
  );
  const shortLivedPoints = collectionPoints(
    (roles) => roles.shortLivedNodeChildren
  );
  const missingNativeSamples = measured.filter(
    ({ roles }) => roles.nativeHosts.missingPids.length > 0
  ).length;
  const unexpectedNativeHostCountSamples = measured.filter(
    ({ roles }) => roles.nativeHosts.processes.length !== 1
  ).length;
  const missingTeamSamples = measured.filter(
    ({ roles }) =>
      roles.teamWorker.declaredPid !== null &&
      roles.teamWorker.process === null
  ).length;
  const complete =
    measured.length === samples.length &&
    missingNativeSamples === 0 &&
    unexpectedNativeHostCountSamples === 0 &&
    missingTeamSamples === 0;
  return {
    status: complete ? "measured" : "not_measured",
    measuredSamples: measured.length,
    missingSamples: samples.length - measured.length,
    nativeHosts: {
      ...summarizeCollection(nativePoints),
      uniquePids: uniqueSortedPids(nativeProcesses),
      missingDeclaredSamples: missingNativeSamples,
      unexpectedProcessCountSamples: unexpectedNativeHostCountSamples
    },
    teamWorker: {
      ...summarizeCollection(teamPoints),
      uniquePids: uniqueSortedPids(teamProcesses),
      missingDeclaredSamples: missingTeamSamples
    },
    shortLivedNodeChildren: {
      ...summarizeCollection(shortLivedPoints),
      uniquePids: uniqueSortedPids(shortLivedProcesses)
    }
  };
}

function chromeSummary(samples) {
  const firstTimestamp = samples[0].timestamp;
  const durationHours =
    (samples.at(-1).timestamp - firstTimestamp) / (60 * 60 * 1_000);
  const available = samples
    .map(({ sample, timestamp }) => ({
      chrome: sample.chromeProfile,
      hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000)
    }))
    .filter(({ chrome }) => chrome !== null && chrome !== undefined);
  return {
    availableSamples: available.length,
    missingSamples: samples.length - available.length,
    rssKiB: seriesSummary(
      available.map(({ chrome, hour }) => ({
        hour,
        value: finiteNumber(chrome.rssKiB, "Chrome rssKiB")
      })),
      durationHours
    ),
    cpuPercent: seriesSummary(
      available.map(({ chrome, hour }) => ({
        hour,
        value: finiteNumber(chrome.cpuPercent, "Chrome cpuPercent")
      })),
      durationHours
    ),
    processCount: seriesSummary(
      available.map(({ chrome, hour }) => ({
        hour,
        value: finiteNumber(chrome.processCount, "Chrome processCount")
      })),
      durationHours
    )
  };
}

function coreIdentitySummary(samples, expectedIntervalSeconds) {
  const pids = [];
  const runtimeIdentities = [];
  const runtimeIdentityExpected = samples.some(
    ({ sample }) => sample.coreMetrics !== undefined && sample.coreMetrics !== null
  );
  let missingPidSamples = 0;
  let missingRuntimeIdentitySamples = 0;
  for (const { sample, timestamp } of samples) {
    const corePid = sample.services["com.bpa.core"]?.pid;
    if (!Number.isSafeInteger(corePid) || corePid <= 0) {
      missingPidSamples += 1;
    } else {
      pids.push(corePid);
    }
    const metrics = sample.coreMetrics;
    const metricsTimestamp = Date.parse(metrics?.sampledAt);
    const ageSeconds = (timestamp - metricsTimestamp) / 1_000;
    const identityIsFresh =
      metrics?.status === "available" &&
      Number.isFinite(metricsTimestamp) &&
      ageSeconds >= -5 &&
      ageSeconds <= expectedIntervalSeconds * 2 &&
      metrics.pid === corePid &&
      typeof metrics.runtimeIdentity === "string" &&
      metrics.runtimeIdentity.length > 0;
    if (!identityIsFresh) {
      missingRuntimeIdentitySamples += 1;
    } else {
      runtimeIdentities.push(metrics.runtimeIdentity);
    }
  }
  const uniquePids = [...new Set(pids)];
  const uniqueRuntimeIdentities = [...new Set(runtimeIdentities)];
  return {
    missingPidSamples,
    uniquePids,
    pidStable: missingPidSamples === 0 && uniquePids.length === 1,
    missingRuntimeIdentitySamples,
    runtimeIdentities: uniqueRuntimeIdentities,
    runtimeIdentityExpected,
    runtimeIdentityStable:
      runtimeIdentityExpected &&
      missingRuntimeIdentitySamples === 0 &&
      uniqueRuntimeIdentities.length === 1
  };
}

function sqliteSummary(samples, expectedIntervalSeconds) {
  const firstTimestamp = samples[0].timestamp;
  const durationHours =
    (samples.at(-1).timestamp - firstTimestamp) / (60 * 60 * 1_000);
  const available = samples
    .map(({ sample, timestamp }) => ({
      sqlite: sample.sqlite,
      hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000)
    }))
    .filter(({ sqlite }) => sqlite !== null && sqlite !== undefined);
  const summarizeFile = (key) => {
    const points = available
      .filter(({ sqlite }) => sqlite[key] !== null)
      .map(({ sqlite, hour }) => ({
        hour,
        value: finiteNumber(sqlite[key], `SQLite ${key}`)
      }));
    return seriesSummary(points, durationHours);
  };
  const connectionObservations = samples.map(({ sample, timestamp }) => {
    const metrics = sample.coreMetrics;
    if (metrics?.status !== "available") {
      return { status: metrics?.status ?? "not_collected" };
    }
    const metricsTimestamp = Date.parse(metrics.sampledAt);
    if (!Number.isFinite(metricsTimestamp)) return { status: "invalid" };
    const ageSeconds = (timestamp - metricsTimestamp) / 1_000;
    const corePid = sample.services["com.bpa.core"]?.pid;
    const fresh =
      ageSeconds >= -5 && ageSeconds <= expectedIntervalSeconds * 2;
    const identityValid =
      typeof metrics.runtimeIdentity === "string" &&
      metrics.runtimeIdentity.length > 0;
    const pidMatches =
      Number.isSafeInteger(corePid) && metrics.pid === corePid;
    if (!fresh) return { status: "stale" };
    if (!identityValid || !pidMatches) return { status: "identity_mismatch" };
    return {
      status: "measured",
      metrics,
      hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000)
    };
  });
  const measured = connectionObservations.filter(
    (observation) => observation.status === "measured"
  );
  const complete = measured.length === samples.length;
  const summarizeMetric = (key) =>
    complete
      ? seriesSummary(
          measured.map(({ metrics, hour }) => ({
            hour,
            value: finiteNumber(
              metrics.sqlite[key],
              `SQLite connection metric ${key}`
            )
          })),
          durationHours
        )
      : null;
  return {
    measurementBoundary: complete
      ? "same_connection_db_status64"
      : "file_sizes_only",
    databaseBytes: summarizeFile("databaseBytes"),
    walBytes: summarizeFile("walBytes"),
    shmBytes: summarizeFile("shmBytes"),
    pageCache: {
      status: complete ? "measured" : "not_measured",
      measuredSamples: measured.length,
      missingSamples: samples.length - measured.length,
      configuredBytes: summarizeMetric("configuredCacheBytes"),
      actualBytes: summarizeMetric("cacheUsedBytes"),
      schemaBytes: summarizeMetric("schemaUsedBytes"),
      statementBytes: summarizeMetric("statementUsedBytes"),
      runtimeIdentities: complete
        ? [...new Set(measured.map(({ metrics }) => metrics.runtimeIdentity))]
        : []
    }
  };
}

function coreResidentSummary(samples, expectedIntervalSeconds) {
  const firstTimestamp = samples[0].timestamp;
  const durationHours =
    (samples.at(-1).timestamp - firstTimestamp) / (60 * 60 * 1_000);
  const measured = samples.flatMap(({ sample, timestamp }) => {
    const metrics = sample.coreMetrics;
    const metricsTimestamp = Date.parse(metrics?.sampledAt);
    const corePid = sample.services["com.bpa.core"]?.pid;
    const ageSeconds = (timestamp - metricsTimestamp) / 1_000;
    const processMetrics = metrics?.process;
    const eventLoop = metrics?.eventLoop;
    const activity = metrics?.activity;
    const teamWorker = metrics?.teamWorker;
    const browserGateway = metrics?.browserGateway;
    const gatewayQueue = browserGateway?.queue;
    const pageProbes = browserGateway?.pageProbes;
    const extension = browserGateway?.extension;
    const pacingReservations = extension?.pacingReservations;
    const extensionProbes = extension?.probes;
    const valid =
      metrics?.status === "available" &&
      Number.isFinite(metricsTimestamp) &&
      ageSeconds >= -5 &&
      ageSeconds <= expectedIntervalSeconds * 2 &&
      metrics.pid === corePid &&
      processMetrics &&
      eventLoop &&
      activity &&
      teamWorker &&
      browserGateway &&
      gatewayQueue &&
      pageProbes &&
      extension &&
      pacingReservations &&
      extensionProbes &&
      [
        processMetrics.rssBytes,
        processMetrics.heapTotalBytes,
        processMetrics.heapUsedBytes,
        processMetrics.externalBytes,
        processMetrics.arrayBuffersBytes,
        eventLoop.resolutionMs,
        eventLoop.sampleCount,
        activity.activeRunCount,
        activity.activeTriggerOccurrenceCount,
        activity.activeTriggerAttemptCount,
        activity.pendingEngineOutboxCount,
        activity.activeControlLeaseCount,
        activity.activeExternalDomainLeaseCount,
        activity.activeStagingLeaseCount,
        activity.activeRecoverySessionCount,
        activity.activeAttentionDeliveryCount,
        activity.terminalRunCount,
        teamWorker.pendingInvocationCount,
        browserGateway.connectionCount,
        browserGateway.readySessionCount,
        browserGateway.pendingCancelRequestCount,
        gatewayQueue.pendingBrowserOutbox,
        gatewayQueue.queuedCommands,
        gatewayQueue.inFlightCommands,
        gatewayQueue.terminalResultsPendingApplication,
        gatewayQueue.totalPending,
        pageProbes.active,
        pageProbes.capacity,
        pageProbes.ttlMs,
        extension.activeCommands,
        extension.activeTabCommands,
        extension.activeAllianceStages,
        extension.cancellationRequests,
        extension.cancellationStopBarriers,
        extension.observedTabs,
        extension.observationCapacity,
        extension.profileTabs,
        extension.managedTabs,
        extension.managedTabReservations,
        extension.managedTabCapacity,
        pacingReservations.active,
        pacingReservations.capacity,
        pacingReservations.ttlMs,
        extensionProbes.active,
        extensionProbes.capacity,
        extensionProbes.ttlMs
      ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
      (activity.latestTerminalRunAt === null ||
        (Number.isFinite(Date.parse(activity.latestTerminalRunAt)) &&
          Date.parse(activity.latestTerminalRunAt) <= metricsTimestamp)) &&
      ((activity.terminalRunCount === 0) ===
        (activity.latestTerminalRunAt === null)) &&
      ["stopped", "starting", "ready"].includes(teamWorker.state) &&
      ((teamWorker.state === "stopped" &&
        teamWorker.pid === null &&
        teamWorker.pendingInvocationCount === 0) ||
        (teamWorker.state !== "stopped" &&
          Number.isSafeInteger(teamWorker.pid) &&
          teamWorker.pid > 0)) &&
      Array.isArray(browserGateway.nativeHostPids) &&
      browserGateway.nativeHostPids.length ===
        browserGateway.connectionCount &&
      browserGateway.nativeHostPids.every(
        (pid) => Number.isSafeInteger(pid) && pid > 0
      ) &&
      new Set(browserGateway.nativeHostPids).size ===
        browserGateway.nativeHostPids.length &&
      browserGateway.nativeHostPids.every(
        (pid, index, values) => index === 0 || values[index - 1] < pid
      ) &&
      [
        eventLoop.minimumMs,
        eventLoop.maximumMs,
        eventLoop.meanMs,
        eventLoop.p50Ms,
        eventLoop.p95Ms,
        eventLoop.p99Ms
      ].every((value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
      ) &&
      processMetrics.heapUsedBytes <= processMetrics.heapTotalBytes &&
      eventLoop.resolutionMs === 20 &&
      eventLoop.minimumMs <= eventLoop.maximumMs &&
      eventLoop.minimumMs <= eventLoop.meanMs &&
      eventLoop.meanMs <= eventLoop.maximumMs &&
      eventLoop.minimumMs <= eventLoop.p50Ms &&
      eventLoop.p50Ms <= eventLoop.p95Ms &&
      eventLoop.p95Ms <= eventLoop.p99Ms &&
      eventLoop.p99Ms <= eventLoop.maximumMs &&
      browserGateway.readySessionCount <= browserGateway.connectionCount &&
      gatewayQueue.totalPending ===
        gatewayQueue.pendingBrowserOutbox +
          gatewayQueue.queuedCommands +
          gatewayQueue.inFlightCommands +
          gatewayQueue.terminalResultsPendingApplication &&
      pageProbes.capacity >= 1 &&
      pageProbes.active <= pageProbes.capacity &&
      pageProbes.ttlMs >= 1 &&
      extension.activeTabCommands <= extension.activeCommands &&
      extension.activeAllianceStages <= extension.activeCommands &&
      extension.cancellationRequests <= extension.activeCommands &&
      extension.cancellationStopBarriers ===
        extension.cancellationRequests &&
      extension.observationCapacity >= 1 &&
      extension.observedTabs <= extension.observationCapacity &&
      extension.profileTabs <= 1024 &&
      extension.managedTabCapacity === 8 &&
      extension.managedTabs + extension.managedTabReservations <=
        extension.managedTabCapacity &&
      pacingReservations.capacity >= 1 &&
      pacingReservations.active <= pacingReservations.capacity &&
      pacingReservations.ttlMs >= 1 &&
      extensionProbes.capacity >= 1 &&
      extensionProbes.active <= extensionProbes.capacity &&
      extensionProbes.ttlMs >= 1;
    return valid
      ? [{ metrics, hour: (timestamp - firstTimestamp) / (60 * 60 * 1_000) }]
      : [];
  });
  const eventLoopObserved = measured.some(
    ({ metrics }) => metrics.eventLoop.sampleCount > 0
  );
  const complete = measured.length === samples.length && eventLoopObserved;
  const summarize = (select, label) =>
    complete
      ? seriesSummary(
          measured.map(({ metrics, hour }) => ({
            hour,
            value: finiteNumber(select(metrics), label)
          })),
          durationHours
        )
      : null;
  return {
    status: complete ? "measured" : "not_measured",
    measuredSamples: measured.length,
    missingSamples: samples.length - measured.length,
    eventLoopObserved,
    process: {
      rssBytes: summarize(
        (metrics) => metrics.process.rssBytes,
        "Core process rssBytes"
      ),
      heapTotalBytes: summarize(
        (metrics) => metrics.process.heapTotalBytes,
        "Core process heapTotalBytes"
      ),
      heapUsedBytes: summarize(
        (metrics) => metrics.process.heapUsedBytes,
        "Core process heapUsedBytes"
      ),
      externalBytes: summarize(
        (metrics) => metrics.process.externalBytes,
        "Core process externalBytes"
      ),
      arrayBuffersBytes: summarize(
        (metrics) => metrics.process.arrayBuffersBytes,
        "Core process arrayBuffersBytes"
      )
    },
    eventLoop: {
      sampleCount: summarize(
        (metrics) => metrics.eventLoop.sampleCount,
        "Core event-loop sampleCount"
      ),
      minimumMs: summarize(
        (metrics) => metrics.eventLoop.minimumMs,
        "Core event-loop minimumMs"
      ),
      maximumMs: summarize(
        (metrics) => metrics.eventLoop.maximumMs,
        "Core event-loop maximumMs"
      ),
      meanMs: summarize(
        (metrics) => metrics.eventLoop.meanMs,
        "Core event-loop meanMs"
      ),
      p50Ms: summarize(
        (metrics) => metrics.eventLoop.p50Ms,
        "Core event-loop p50Ms"
      ),
      p95Ms: summarize(
        (metrics) => metrics.eventLoop.p95Ms,
        "Core event-loop p95Ms"
      ),
      p99Ms: summarize(
        (metrics) => metrics.eventLoop.p99Ms,
        "Core event-loop p99Ms"
      ),
      resolutionMs: complete
        ? [
            ...new Set(
              measured.map(({ metrics }) => metrics.eventLoop.resolutionMs)
            )
          ]
        : []
    },
    activity: {
      activeRuns: summarize(
        (metrics) => metrics.activity.activeRunCount,
        "Active Runs"
      ),
      activeTriggerOccurrences: summarize(
        (metrics) => metrics.activity.activeTriggerOccurrenceCount,
        "Active Trigger Occurrences"
      ),
      activeTriggerAttempts: summarize(
        (metrics) => metrics.activity.activeTriggerAttemptCount,
        "Active Trigger Attempts"
      ),
      pendingEngineOutbox: summarize(
        (metrics) => metrics.activity.pendingEngineOutboxCount,
        "Pending Engine outbox"
      ),
      activeControlLeases: summarize(
        (metrics) => metrics.activity.activeControlLeaseCount,
        "Active control leases"
      ),
      activeExternalDomainLeases: summarize(
        (metrics) => metrics.activity.activeExternalDomainLeaseCount,
        "Active external domain leases"
      ),
      activeStagingLeases: summarize(
        (metrics) => metrics.activity.activeStagingLeaseCount,
        "Active staging leases"
      ),
      activeRecoverySessions: summarize(
        (metrics) => metrics.activity.activeRecoverySessionCount,
        "Active recovery sessions"
      ),
      activeAttentionDeliveries: summarize(
        (metrics) => metrics.activity.activeAttentionDeliveryCount,
        "Active Attention deliveries"
      ),
      terminalRuns: summarize(
        (metrics) => metrics.activity.terminalRunCount,
        "Terminal Runs"
      )
    },
    teamWorker: {
      pendingInvocations: summarize(
        (metrics) => metrics.teamWorker.pendingInvocationCount,
        "Team Worker pending invocations"
      ),
      states: complete
        ? [...new Set(measured.map(({ metrics }) => metrics.teamWorker.state))]
        : [],
      pids: complete
        ? [...new Set(
            measured
              .map(({ metrics }) => metrics.teamWorker.pid)
              .filter((pid) => pid !== null)
          )]
        : []
    },
    browserGateway: {
      connectionCount: summarize(
        (metrics) => metrics.browserGateway.connectionCount,
        "Browser Gateway connectionCount"
      ),
      readySessionCount: summarize(
        (metrics) => metrics.browserGateway.readySessionCount,
        "Browser Gateway readySessionCount"
      ),
      pendingCancelRequestCount: summarize(
        (metrics) => metrics.browserGateway.pendingCancelRequestCount,
        "Browser Gateway pendingCancelRequestCount"
      ),
      queue: {
        pendingBrowserOutbox: summarize(
          (metrics) => metrics.browserGateway.queue.pendingBrowserOutbox,
          "Browser Gateway pending browser outbox"
        ),
        queuedCommands: summarize(
          (metrics) => metrics.browserGateway.queue.queuedCommands,
          "Browser Gateway queued commands"
        ),
        inFlightCommands: summarize(
          (metrics) => metrics.browserGateway.queue.inFlightCommands,
          "Browser Gateway in-flight commands"
        ),
        terminalResultsPendingApplication: summarize(
          (metrics) =>
            metrics.browserGateway.queue.terminalResultsPendingApplication,
          "Browser Gateway terminal results pending application"
        ),
        totalPending: summarize(
          (metrics) => metrics.browserGateway.queue.totalPending,
          "Browser Gateway total pending"
        )
      },
      activePageProbes: summarize(
        (metrics) => metrics.browserGateway.pageProbes.active,
        "Browser Gateway active page probes"
      ),
      pageProbeCapacity: complete
        ? [...new Set(measured.map(({ metrics }) =>
            metrics.browserGateway.pageProbes.capacity
          ))]
        : [],
      pageProbeTtlMs: complete
        ? [...new Set(measured.map(({ metrics }) =>
            metrics.browserGateway.pageProbes.ttlMs
          ))]
        : [],
      extension: {
        activeCommands: summarize(
          (metrics) => metrics.browserGateway.extension.activeCommands,
          "Extension activeCommands"
        ),
        activeTabCommands: summarize(
          (metrics) => metrics.browserGateway.extension.activeTabCommands,
          "Extension activeTabCommands"
        ),
        activeAllianceStages: summarize(
          (metrics) => metrics.browserGateway.extension.activeAllianceStages,
          "Extension activeAllianceStages"
        ),
        cancellationRequests: summarize(
          (metrics) => metrics.browserGateway.extension.cancellationRequests,
          "Extension cancellationRequests"
        ),
        cancellationStopBarriers: summarize(
          (metrics) =>
            metrics.browserGateway.extension.cancellationStopBarriers,
          "Extension cancellationStopBarriers"
        ),
        observedTabs: summarize(
          (metrics) => metrics.browserGateway.extension.observedTabs,
          "Extension observedTabs"
        ),
        profileTabs: summarize(
          (metrics) => metrics.browserGateway.extension.profileTabs,
          "Extension profileTabs"
        ),
        managedTabs: summarize(
          (metrics) => metrics.browserGateway.extension.managedTabs,
          "Extension managedTabs"
        ),
        managedTabReservations: summarize(
          (metrics) =>
            metrics.browserGateway.extension.managedTabReservations,
          "Extension managedTabReservations"
        ),
        pacingReservations: summarize(
          (metrics) =>
            metrics.browserGateway.extension.pacingReservations.active,
          "Extension pacingReservations"
        ),
        probes: summarize(
          (metrics) => metrics.browserGateway.extension.probes.active,
          "Extension probes"
        ),
        observationCapacity: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.observationCapacity
            ))]
          : [],
        managedTabCapacity: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.managedTabCapacity
            ))]
          : [],
        pacingCapacity: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.pacingReservations.capacity
            ))]
          : [],
        pacingTtlMs: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.pacingReservations.ttlMs
            ))]
          : [],
        probeCapacity: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.probes.capacity
            ))]
          : [],
        probeTtlMs: complete
          ? [...new Set(measured.map(({ metrics }) =>
              metrics.browserGateway.extension.probes.ttlMs
            ))]
          : []
      }
    }
  };
}

function runtimeQuiescenceSummary(samples, expectedIntervalSeconds) {
  let measuredSamples = 0;
  let previousTimestamp;
  let candidate;
  let markedTerminalIdentity;
  const markers = [];
  let currentState = "not_measured";
  let latestTerminalRunAt = null;

  for (const { sample, timestamp } of samples) {
    const metrics = sample.coreMetrics;
    const metricsTimestamp = Date.parse(metrics?.sampledAt);
    const corePid = sample.services["com.bpa.core"]?.pid;
    const activity = metrics?.activity;
    const teamWorker = metrics?.teamWorker;
    const browserGateway = metrics?.browserGateway;
    const queue = browserGateway?.queue;
    const pageProbes = browserGateway?.pageProbes;
    const extension = browserGateway?.extension;
    const pacing = extension?.pacingReservations;
    const probes = extension?.probes;
    const activityCounts = activity
      ? [
          activity.activeRunCount,
          activity.activeTriggerOccurrenceCount,
          activity.activeTriggerAttemptCount,
          activity.pendingEngineOutboxCount,
          activity.activeControlLeaseCount,
          activity.activeExternalDomainLeaseCount,
          activity.activeStagingLeaseCount,
          activity.activeRecoverySessionCount,
          activity.activeAttentionDeliveryCount
        ]
      : [];
    const transientCounts = [
      browserGateway?.pendingCancelRequestCount,
      queue?.pendingBrowserOutbox,
      queue?.queuedCommands,
      queue?.inFlightCommands,
      queue?.terminalResultsPendingApplication,
      queue?.totalPending,
      pageProbes?.active,
      extension?.activeCommands,
      extension?.activeTabCommands,
      extension?.activeAllianceStages,
      extension?.cancellationRequests,
      extension?.cancellationStopBarriers,
      extension?.managedTabReservations,
      pacing?.active,
      probes?.active
    ];
    const valid =
      metrics?.status === "available" &&
      Number.isFinite(metricsTimestamp) &&
      timestamp - metricsTimestamp >= -5_000 &&
      timestamp - metricsTimestamp <= expectedIntervalSeconds * 2_000 &&
      metrics.pid === corePid &&
      activity &&
      teamWorker &&
      browserGateway &&
      queue &&
      pageProbes &&
      extension &&
      pacing &&
      probes &&
      activityCounts.length === 9 &&
      activityCounts.every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) &&
      transientCounts.every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) &&
      Number.isSafeInteger(teamWorker.pendingInvocationCount) &&
      teamWorker.pendingInvocationCount >= 0 &&
      ["stopped", "starting", "ready"].includes(teamWorker.state) &&
      ((teamWorker.state === "stopped" &&
        teamWorker.pid === null &&
        teamWorker.pendingInvocationCount === 0) ||
        (teamWorker.state !== "stopped" &&
          Number.isSafeInteger(teamWorker.pid) &&
          teamWorker.pid > 0)) &&
      Array.isArray(browserGateway.nativeHostPids) &&
      browserGateway.nativeHostPids.length ===
        browserGateway.connectionCount &&
      browserGateway.nativeHostPids.every(
        (pid) => Number.isSafeInteger(pid) && pid > 0
      ) &&
      new Set(browserGateway.nativeHostPids).size ===
        browserGateway.nativeHostPids.length &&
      browserGateway.nativeHostPids.every(
        (pid, index, values) => index === 0 || values[index - 1] < pid
      ) &&
      queue.totalPending ===
        queue.pendingBrowserOutbox +
          queue.queuedCommands +
          queue.inFlightCommands +
          queue.terminalResultsPendingApplication &&
      extension.activeTabCommands <= extension.activeCommands &&
      extension.activeAllianceStages <= extension.activeCommands &&
      extension.cancellationRequests <= extension.activeCommands &&
      extension.cancellationStopBarriers ===
        extension.cancellationRequests &&
      (activity.latestTerminalRunAt === null ||
        (Number.isFinite(Date.parse(activity.latestTerminalRunAt)) &&
          Date.parse(activity.latestTerminalRunAt) <= metricsTimestamp)) &&
      Number.isSafeInteger(activity.terminalRunCount) &&
      activity.terminalRunCount >= 0 &&
      ((activity.terminalRunCount === 0) ===
        (activity.latestTerminalRunAt === null));
    if (!valid) {
      candidate = undefined;
      previousTimestamp = undefined;
      continue;
    }
    measuredSamples += 1;
    const gapTooLarge =
      previousTimestamp !== undefined &&
      timestamp - previousTimestamp > expectedIntervalSeconds * 2_000;
    previousTimestamp = timestamp;
    if (gapTooLarge) candidate = undefined;
    latestTerminalRunAt = activity.latestTerminalRunAt;
    if (latestTerminalRunAt === null) {
      candidate = undefined;
      currentState = "no_terminal_run";
      continue;
    }
    const quiet =
      activityCounts.every((value) => value === 0) &&
      teamWorker.pendingInvocationCount === 0 &&
      browserGateway.pendingCancelRequestCount === 0 &&
      queue.totalPending === 0 &&
      pageProbes.active === 0 &&
      extension.activeCommands === 0 &&
      extension.activeTabCommands === 0 &&
      extension.activeAllianceStages === 0 &&
      extension.cancellationRequests === 0 &&
      extension.cancellationStopBarriers === 0 &&
      extension.managedTabReservations === 0 &&
      pacing.active === 0 &&
      probes.active === 0;
    if (!quiet) {
      candidate = undefined;
      currentState = "busy";
      continue;
    }
    if (
      !candidate ||
      candidate.terminalAt !== latestTerminalRunAt ||
      candidate.terminalRunCount !== activity.terminalRunCount
    ) {
      candidate = {
        terminalAt: latestTerminalRunAt,
        terminalRunCount: activity.terminalRunCount,
        quietStartedAt: timestamp
      };
    }
    const quietDurationMs = timestamp - candidate.quietStartedAt;
    currentState =
      quietDurationMs >= RUNTIME_QUIESCENCE_REQUIRED_MS
        ? "quiescent"
        : "pending";
    if (
      currentState === "quiescent" &&
      markedTerminalIdentity !==
        `${activity.terminalRunCount}:${latestTerminalRunAt}`
    ) {
      markedTerminalIdentity =
        `${activity.terminalRunCount}:${latestTerminalRunAt}`;
      markers.push({
        terminalAt: latestTerminalRunAt,
        terminalRunCount: activity.terminalRunCount,
        quietStartedAt: new Date(candidate.quietStartedAt).toISOString(),
        observedAt: new Date(timestamp).toISOString(),
        quietDurationMs
      });
    }
  }

  const complete = measuredSamples === samples.length;
  const quietDurationMs =
    complete && candidate
      ? samples.at(-1).timestamp - candidate.quietStartedAt
      : null;
  return {
    status: complete ? "measured" : "not_measured",
    requiredQuietMs: RUNTIME_QUIESCENCE_REQUIRED_MS,
    measuredSamples,
    missingSamples: samples.length - measuredSamples,
    currentState: complete ? currentState : "not_measured",
    latestTerminalRunAt: complete ? latestTerminalRunAt : null,
    terminalRunCount:
      complete ? samples.at(-1).sample.coreMetrics.activity.terminalRunCount : null,
    quietStartedAt:
      complete && candidate
        ? new Date(candidate.quietStartedAt).toISOString()
        : null,
    quietDurationMs,
    observedMarkerCount: markers.length,
    lastObservedMarker: markers.at(-1) ?? null
  };
}

function coreStabilitySummary(
  samples,
  durationHours,
  continuityComplete,
  coreIdentity
) {
  const firstTimestamp = samples[0].timestamp;
  const lastTimestamp = samples.at(-1).timestamp;
  const observations = samples.map(({ sample, timestamp }) => {
    const rssKiB = sample.services["com.bpa.core"]?.rssKiB;
    return {
      timestamp,
      rssKiB:
        typeof rssKiB === "number" && Number.isFinite(rssKiB)
          ? rssKiB
          : null
    };
  });
  const available = observations.filter(({ rssKiB }) => rssKiB !== null);
  const buckets = new Map();
  for (const observation of available) {
    const hour = Math.floor(
      (observation.timestamp - firstTimestamp) / (60 * 60 * 1_000)
    );
    const values = buckets.get(hour) ?? [];
    values.push(observation.rssKiB);
    buckets.set(hour, values);
  }
  const hourlyPoints = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, values]) => ({ hour, value: median(values) }));
  const firstWindowEnd =
    firstTimestamp + CORE_RSS_BASELINE_WINDOW_HOURS * 60 * 60 * 1_000;
  const lastWindowStart =
    lastTimestamp - CORE_RSS_BASELINE_WINDOW_HOURS * 60 * 60 * 1_000;
  const baselineMedianKiB = median(
    available
      .filter(({ timestamp }) => timestamp < firstWindowEnd)
      .map(({ rssKiB }) => rssKiB)
  );
  const terminalMedianKiB = median(
    available
      .filter(({ timestamp }) => timestamp > lastWindowStart)
      .map(({ rssKiB }) => rssKiB)
  );
  const observedGrowthKiB =
    baselineMedianKiB === null || terminalMedianKiB === null
      ? null
      : rounded(terminalMedianKiB - baselineMedianKiB);
  const observedGrowthRatio =
    observedGrowthKiB === null || !baselineMedianKiB
      ? null
      : rounded(observedGrowthKiB / baselineMedianKiB, 4);
  const allowedGrowthKiB = baselineMedianKiB === null
    ? null
    : rounded(Math.max(
        CORE_RSS_ABSOLUTE_GROWTH_LIMIT_KIB,
        baselineMedianKiB * CORE_RSS_RELATIVE_GROWTH_LIMIT
      ));
  const hourlyTrend = seriesSummary(hourlyPoints, durationHours);
  const projectedSevenDayGrowthKiB = hourlyTrend
    ? rounded(hourlyTrend.slopePerHour * CORE_STABILITY_WINDOW_HOURS)
    : null;
  const increasingSteps = hourlyPoints.slice(1).filter(
    (point, index) => point.value > hourlyPoints[index].value
  ).length;
  const positiveStepRatio = hourlyPoints.length < 2
    ? null
    : rounded(increasingSteps / (hourlyPoints.length - 1), 4);
  const persistentMonotonicGrowth =
    positiveStepRatio !== null &&
    observedGrowthKiB !== null &&
    positiveStepRatio >= CORE_RSS_MONOTONIC_RATIO_LIMIT &&
    observedGrowthKiB > CORE_RSS_MONOTONIC_GROWTH_FLOOR_KIB;
  const windowComplete = durationHours >= CORE_STABILITY_WINDOW_HOURS;
  const rssComplete = available.length === samples.length;
  const growthWithinLimit =
    observedGrowthKiB !== null &&
    allowedGrowthKiB !== null &&
    observedGrowthKiB <= allowedGrowthKiB;
  const trendWithinLimit =
    projectedSevenDayGrowthKiB !== null &&
    allowedGrowthKiB !== null &&
    projectedSevenDayGrowthKiB <= allowedGrowthKiB;
  const coreSevenDayStable =
    windowComplete &&
    continuityComplete &&
    coreIdentity.pidStable &&
    coreIdentity.runtimeIdentityStable &&
    rssComplete &&
    growthWithinLimit &&
    trendWithinLimit &&
    !persistentMonotonicGrowth;
  return {
    policy: {
      minimumDurationHours: CORE_STABILITY_WINDOW_HOURS,
      baselineWindowHours: CORE_RSS_BASELINE_WINDOW_HOURS,
      absoluteGrowthLimitKiB: CORE_RSS_ABSOLUTE_GROWTH_LIMIT_KIB,
      relativeGrowthLimit: CORE_RSS_RELATIVE_GROWTH_LIMIT,
      monotonicIncreaseRatioLimit: CORE_RSS_MONOTONIC_RATIO_LIMIT,
      monotonicGrowthFloorKiB: CORE_RSS_MONOTONIC_GROWTH_FLOOR_KIB
    },
    windowComplete,
    continuityComplete,
    corePidStable: coreIdentity.pidStable,
    coreRuntimeIdentityStable: coreIdentity.runtimeIdentityStable,
    rssComplete,
    observedSamples: available.length,
    missingSamples: samples.length - available.length,
    hourlyMedianBuckets: hourlyPoints.length,
    baselineMedianKiB,
    terminalMedianKiB,
    observedGrowthKiB,
    observedGrowthRatio,
    allowedGrowthKiB,
    slopePerHourKiB: hourlyTrend?.slopePerHour ?? null,
    projectedSevenDayGrowthKiB,
    positiveStepRatio,
    persistentMonotonicGrowth,
    growthWithinLimit,
    trendWithinLimit,
    coreSevenDayStable,
    blockers: [
      ...(!windowComplete ? ["seven_day_window_not_reached"] : []),
      ...(!continuityComplete ? ["sampling_gaps_exceed_limit"] : []),
      ...(coreIdentity.missingPidSamples > 0 ? ["core_pid_missing"] : []),
      ...(coreIdentity.uniquePids.length > 1 ? ["core_pid_changed"] : []),
      ...(!coreIdentity.runtimeIdentityExpected
        ? ["core_runtime_identity_not_measured"]
        : []),
      ...(coreIdentity.runtimeIdentityExpected &&
      coreIdentity.missingRuntimeIdentitySamples > 0
        ? ["core_runtime_identity_missing"]
        : []),
      ...(coreIdentity.runtimeIdentityExpected &&
      coreIdentity.runtimeIdentities.length > 1
        ? ["core_runtime_identity_changed"]
        : []),
      ...(!rssComplete ? ["core_rss_samples_missing"] : []),
      ...(rssComplete && !growthWithinLimit
        ? ["core_rss_growth_exceeds_limit"]
        : []),
      ...(rssComplete && !trendWithinLimit
        ? ["core_rss_trend_exceeds_limit"]
        : []),
      ...(persistentMonotonicGrowth ? ["core_rss_monotonic_growth"] : [])
    ]
  };
}

function analyze(samples, options) {
  const first = samples[0];
  const last = samples.at(-1);
  const gaps = [];
  for (let index = 1; index < samples.length; index += 1) {
    gaps.push((samples[index].timestamp - samples[index - 1].timestamp) / 1_000);
  }
  const durationHours = (last.timestamp - first.timestamp) / (60 * 60 * 1_000);
  const maximumGapSeconds = Math.max(...gaps);
  const serviceLabels = [...new Set(
    samples.flatMap(({ sample }) => Object.keys(sample.services))
  )].sort();
  const continuity = {
    maximumGapSeconds: rounded(maximumGapSeconds),
    gapsOverDoubleInterval: gaps.filter(
      (gap) => gap > options.expectedIntervalSeconds * 2
    ).length
  };
  const windowComplete = durationHours >= options.minimumDurationHours;
  const continuityComplete = continuity.gapsOverDoubleInterval === 0;
  const coreIdentity = coreIdentitySummary(
    samples,
    options.expectedIntervalSeconds
  );
  const coreIdentityStable =
    coreIdentity.pidStable && coreIdentity.runtimeIdentityStable;
  const inventoryMonitor = processSummary(
    samples,
    (sample) => sample.services["com.bpa.inventory-monitor"] ?? null
  );
  const inventoryMonitorComplete = inventoryMonitor.missingSamples === 0;
  const inventoryMonitorPidStable =
    inventoryMonitorComplete &&
    inventoryMonitor.uniquePids.length === 1 &&
    inventoryMonitor.pidChanges === 0;
  const chromeProfile = chromeSummary(samples);
  const chromeProfileComplete = chromeProfile.missingSamples === 0;
  const nodeAndChromeMeasurable =
    windowComplete &&
    continuityComplete &&
    coreIdentity.pidStable &&
    inventoryMonitorPidStable &&
    chromeProfileComplete;
  const sqlite = sqliteSummary(samples, options.expectedIntervalSeconds);
  const coreResident = coreResidentSummary(
    samples,
    options.expectedIntervalSeconds
  );
  const coreResidentMeasurable = coreResident.status === "measured";
  const runtimeProcessRoles = runtimeProcessRolesSummary(samples);
  const runtimeProcessRolesMeasurable =
    runtimeProcessRoles.status === "measured";
  const runtimeQuiescence = runtimeQuiescenceSummary(
    samples,
    options.expectedIntervalSeconds
  );
  const runtimeQuiescenceMeasurable =
    runtimeQuiescence.status === "measured";
  const sqlitePageCacheMeasurable =
    windowComplete &&
    continuityComplete &&
    coreIdentityStable &&
    sqlite.pageCache.status === "measured";
  const stabilityGate = coreStabilitySummary(
    samples,
    durationHours,
    continuityComplete,
    coreIdentity
  );
  return {
    schema: OUTPUT_SCHEMA,
    source: {
      schema: INPUT_SCHEMA,
      sampleCount: samples.length,
      firstSampledAt: first.sample.sampledAt,
      lastSampledAt: last.sample.sampledAt,
      durationHours: rounded(durationHours, 4),
      expectedIntervalSeconds: options.expectedIntervalSeconds,
      minimumDurationHours: options.minimumDurationHours,
      continuity
    },
    conclusionGate: {
      windowComplete,
      continuityComplete,
      corePidStable: coreIdentity.pidStable,
      coreRuntimeIdentityStable: coreIdentity.runtimeIdentityStable,
      inventoryMonitorComplete,
      inventoryMonitorPidStable,
      chromeProfileComplete,
      nodeAndChromeMeasurable,
      sqlitePageCacheMeasurable,
      coreResidentMeasurable,
      runtimeProcessRolesMeasurable,
      runtimeQuiescenceMeasurable,
      phaseZeroResourceMeasurementComplete:
        nodeAndChromeMeasurable &&
        coreIdentityStable &&
        coreResidentMeasurable &&
        runtimeProcessRolesMeasurable &&
        runtimeQuiescenceMeasurable &&
        sqlitePageCacheMeasurable,
      blockers: [
        ...(!windowComplete ? ["minimum_duration_not_reached"] : []),
        ...(!continuityComplete ? ["sampling_gaps_exceed_limit"] : []),
        ...(coreIdentity.missingPidSamples > 0 ? ["core_pid_missing"] : []),
        ...(coreIdentity.uniquePids.length > 1 ? ["core_pid_changed"] : []),
        ...(coreIdentity.runtimeIdentityExpected &&
        coreIdentity.missingRuntimeIdentitySamples > 0
          ? ["core_runtime_identity_missing"]
          : []),
        ...(coreIdentity.runtimeIdentityExpected &&
        coreIdentity.runtimeIdentities.length > 1
          ? ["core_runtime_identity_changed"]
          : []),
        ...(!inventoryMonitorComplete
          ? ["inventory_monitor_samples_missing"]
          : []),
        ...(inventoryMonitorComplete && !inventoryMonitorPidStable
          ? ["inventory_monitor_pid_changed"]
          : []),
        ...(!chromeProfileComplete ? ["chrome_profile_samples_missing"] : []),
        ...(!coreResidentMeasurable
          ? ["core_resident_metrics_not_measured"]
          : []),
        ...(!runtimeProcessRolesMeasurable
          ? ["runtime_process_roles_not_measured"]
          : []),
        ...(sqlite.pageCache.status !== "measured"
          ? ["sqlite_page_cache_not_measured"]
          : [])
      ]
    },
    coreIdentity,
    coreResident,
    runtimeProcessRoles,
    runtimeQuiescence,
    stabilityGate,
    services: Object.fromEntries(
      serviceLabels.map((label) => [
        label,
        processSummary(samples, (sample) => sample.services[label] ?? null)
      ])
    ),
    chromeProfile,
    sqlite
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const samples = parseSamples(await readFile(options.input, "utf8"));
  const analysis = analyze(samples, options);
  const result = `${JSON.stringify(analysis, null, 2)}\n`;
  if (options.output) await writeFile(options.output, result, { mode: 0o600 });
  else process.stdout.write(result);
  if (
    options.requireComplete &&
    !analysis.conclusionGate.phaseZeroResourceMeasurementComplete
  ) {
    process.stderr.write(
      `Resource measurement gate is incomplete: ${analysis.conclusionGate.blockers.join(", ")}\n`
    );
    process.exitCode = 2;
  }
  if (options.requireStable && !analysis.stabilityGate.coreSevenDayStable) {
    process.stderr.write(
      `Core stability gate is incomplete: ${analysis.stabilityGate.blockers.join(", ")}\n`
    );
    process.exitCode = 3;
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
