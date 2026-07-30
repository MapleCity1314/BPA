/* Generated from canonical JSON Schema. Do not edit manually. */

export type BPASourceRecordV1Alpha1 = {
  [k: string]: unknown;
} & {
  apiVersion: "bpa.source/v1alpha1";
  kind: "SourceRecord";
  sourceId: Id;
  sourceType: "platform_page" | "public_url" | "third_party_estimate" | "user_file";
  locator: {
    [k: string]: unknown;
  };
  observedAt: Timestamp;
  recordedAt?: Timestamp;
  classification: "public" | "internal" | "confidential" | "restricted";
  title?: string;
};
export type Id = string;
export type Timestamp = string;
