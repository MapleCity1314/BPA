/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Digest = string;

export interface BPAAdapterManifestV1Alpha1 {
  apiVersion: "bpa.adapter/v1alpha1";
  kind: "Adapter";
  metadata: {
    id: Id;
    version: Semver;
    title: string;
    description?: string;
  };
  platform: Id;
  /**
   * @minItems 1
   * @maxItems 20
   */
  origins: string[];
  extension?: {
    minimumVersion: Semver;
  };
  /**
   * @minItems 1
   * @maxItems 500
   */
  capabilities: {
    nodeId: Id;
    /**
     * @minItems 1
     * @maxItems 50
     */
    nodeVersions: Semver[];
    handlerId: Id;
    handlerVersion: Semver;
    implementationDigest: Digest;
    /**
     * @maxItems 100
     */
    permissions: Id[];
  }[];
}
