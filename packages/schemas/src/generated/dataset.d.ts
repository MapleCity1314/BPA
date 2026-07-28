/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Digest = string;

export interface BPADatasetVersionV1Alpha1 {
  apiVersion: "bpa.data/v1alpha1";
  kind: "DatasetVersion";
  metadata: {
    id: Id;
    version: Semver;
    title: string;
    description?: string;
  };
  profile: VersionedRef;
  source: {
    fileName: string;
    mediaType: string;
    size: number;
    digest: Digest;
  };
  recordSchema: {
    [k: string]: unknown;
  };
  recordCount: number;
  recordsDigest: Digest;
}
export interface VersionedRef {
  id: Id;
  version: Semver;
}
