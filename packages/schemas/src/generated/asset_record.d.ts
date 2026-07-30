/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Digest = string;
export type Timestamp = string;

export interface BPAAssetRecordV1Alpha1 {
  apiVersion: "bpa.asset/v1alpha1";
  kind: "AssetRecord";
  assetId: Id;
  digest: Digest;
  size: number;
  mediaType: string;
  storageRef: string;
  classification: "public" | "internal" | "confidential" | "restricted";
  /**
   * @minItems 1
   * @maxItems 100
   */
  sourceIds: Id[];
  /**
   * @minItems 1
   * @maxItems 100
   */
  derivedFromAssetIds?: Id[];
  createdAt: Timestamp;
  retention:
    | {
        policy: "restricted_24h" | "public_30d";
        retainUntil: Timestamp;
      }
    | {
        policy: "reference_pack" | "manual";
      };
}
