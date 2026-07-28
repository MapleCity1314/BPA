/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Digest = string;

export interface BPAPageModelV1Alpha1 {
  apiVersion: "bpa.page/v1alpha1";
  kind: "PageModel";
  metadata: Metadata;
  adapter: {
    id: Id;
    version: Semver;
    digest: Digest;
  };
  /**
   * @minItems 1
   * @maxItems 20
   */
  origins: string[];
  /**
   * @minItems 1
   * @maxItems 100
   */
  states: {
    id: Id;
    pathPattern: string;
    fingerprint: Digest;
  }[];
  /**
   * @minItems 1
   * @maxItems 1000
   */
  elements: {
    id: Id;
    contract: {
      id: Id;
      version: Semver;
      digest: Digest;
    };
  }[];
  /**
   * @minItems 2
   * @maxItems 100
   */
  fixtureDigests: Digest[];
}
export interface Metadata {
  id: Id;
  version: Semver;
  title: string;
  description?: string;
}
