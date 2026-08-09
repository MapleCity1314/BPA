/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPATriggerSpecV1Alpha2 = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa.trigger/v1alpha2";
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
  externalDomainLease?: {
    providerId: "inventory-postgres";
    resourceId: "inventory-production-cycle";
    ttlSeconds: 300;
  };
  idempotencyPolicy: "occurrence" | "dataset_version" | "request_key";
  retryPolicy: "none";
  missedRunPolicy?: "skip" | "run_once" | "bounded_catch_up";
  maxCatchUpOccurrences?: number;
  schedule?:
    | {
        type: "daily";
        timezone: string;
        localTime: string;
        onTimeWindowSeconds: number;
      }
    | {
        type: "interval";
        anchorAt: string;
        intervalSeconds: number;
        onTimeWindowSeconds: number;
      };
  dataset?: {
    id: string;
  };
};
