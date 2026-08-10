export interface RuntimeMetricCollectorOptions {
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
  readonly output?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeMetricCollectorDependencies<TSample> {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly collect?: (options: RuntimeMetricCollectorOptions) => TSample;
  readonly write?: (sample: TSample, output?: string) => void;
}

export interface RuntimeProcessInput {
  readonly pid: number;
  readonly parentPid: number;
  readonly cpuPercent: number;
  readonly rssKiB: number;
  readonly elapsed: string;
  readonly command: string;
}

export function classifyRuntimeProcesses(
  processes: readonly RuntimeProcessInput[],
  services: Readonly<Record<string, { readonly pid: number } | null>>,
  metrics: unknown
): unknown;

export function collectUntilComplete<TSample extends { readonly sampledAt: string }>(
  options: RuntimeMetricCollectorOptions,
  dependencies?: RuntimeMetricCollectorDependencies<TSample>
): Promise<void>;
