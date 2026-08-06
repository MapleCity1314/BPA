/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPATriggerSpecV1Alpha1 = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa.trigger/v1alpha1";
  id: string;
  version: string;
  appId: string;
  kind: "manual" | "schedule" | "dataset";
  workflow: {
    id: string;
    version: string;
  };
  enabled: boolean;
  inputSchemaVersion: string;
  input: {
    [k: string]: unknown;
  };
  concurrencyKey: string;
  browserInstanceId?: string;
  idempotencyPolicy: "occurrence" | "dataset_version" | "request_key";
  retryPolicy: "none" | "safe_once";
  missedRunPolicy?: "skip" | "run_once" | "bounded_catch_up";
  schedule?: {
    intervalSeconds: number;
    timezone?: string;
  };
  dataset?: {
    id: string;
  };
};
