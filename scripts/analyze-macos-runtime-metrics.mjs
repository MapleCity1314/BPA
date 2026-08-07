#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const INPUT_SCHEMA = "bpa.runtime-resource-sample/1";
const OUTPUT_SCHEMA = "bpa.runtime-resource-analysis/1";

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
  const chromeProfile = chromeSummary(samples);
  const chromeProfileComplete = chromeProfile.missingSamples === 0;
  const nodeAndChromeMeasurable =
    windowComplete &&
    continuityComplete &&
    coreIdentity.pidStable &&
    chromeProfileComplete;
  const sqlite = sqliteSummary(samples, options.expectedIntervalSeconds);
  const sqlitePageCacheMeasurable =
    windowComplete &&
    continuityComplete &&
    coreIdentityStable &&
    sqlite.pageCache.status === "measured";
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
      chromeProfileComplete,
      nodeAndChromeMeasurable,
      sqlitePageCacheMeasurable,
      phaseZeroResourceMeasurementComplete:
        nodeAndChromeMeasurable &&
        coreIdentityStable &&
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
        ...(!chromeProfileComplete ? ["chrome_profile_samples_missing"] : []),
        ...(sqlite.pageCache.status !== "measured"
          ? ["sqlite_page_cache_not_measured"]
          : [])
      ]
    },
    coreIdentity,
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
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
