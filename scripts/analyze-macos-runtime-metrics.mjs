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

function sqliteSummary(samples) {
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
  return {
    measurementBoundary: "file_sizes_only",
    databaseBytes: summarizeFile("databaseBytes"),
    walBytes: summarizeFile("walBytes"),
    shmBytes: summarizeFile("shmBytes"),
    pageCache: {
      status: "not_measured",
      configuredBytes: null,
      actualBytes: null
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
      nodeAndChromeMeasurable: windowComplete && continuityComplete,
      sqlitePageCacheMeasurable: false,
      phaseZeroResourceMeasurementComplete: false,
      blockers: [
        ...(!windowComplete ? ["minimum_duration_not_reached"] : []),
        ...(!continuityComplete ? ["sampling_gaps_exceed_limit"] : []),
        "sqlite_page_cache_not_measured"
      ]
    },
    services: Object.fromEntries(
      serviceLabels.map((label) => [
        label,
        processSummary(samples, (sample) => sample.services[label] ?? null)
      ])
    ),
    chromeProfile: chromeSummary(samples),
    sqlite: sqliteSummary(samples)
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const samples = parseSamples(await readFile(options.input, "utf8"));
  const result = `${JSON.stringify(analyze(samples, options), null, 2)}\n`;
  if (options.output) await writeFile(options.output, result, { mode: 0o600 });
  else process.stdout.write(result);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
