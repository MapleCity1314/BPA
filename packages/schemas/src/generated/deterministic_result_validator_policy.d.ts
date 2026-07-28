/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;

export interface BPADeterministicResultValidatorPolicyV1Alpha1 {
  apiVersion: "bpa.policy/v1alpha1";
  kind: "DeterministicResultValidatorPolicy";
  metadata: {
    id: Id;
    version: Semver;
    title: string;
    description?: string;
  };
  implementation: {
    provider: "builtin";
    validator: Id;
    maxBatchItems: number;
    maxCandidatesPerItem: number;
    /**
     * @minItems 1
     * @maxItems 100
     */
    constraints: string[];
  };
}
