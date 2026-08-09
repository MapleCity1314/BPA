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

export function collectUntilComplete<TSample extends { readonly sampledAt: string }>(
  options: RuntimeMetricCollectorOptions,
  dependencies?: RuntimeMetricCollectorDependencies<TSample>
): Promise<void>;
