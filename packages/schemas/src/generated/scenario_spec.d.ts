/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Risk = "R0" | "R1" | "R2" | "R3" | "R4";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };

export interface BPAAuthoringScenarioSpecV1Alpha1 {
  apiVersion: "bpa.authoring/v1alpha1";
  kind: "ScenarioSpec";
  metadata: Metadata;
  businessGoal: string;
  platform: {
    id: Id;
    /**
     * @minItems 1
     * @maxItems 20
     */
    origins: string[];
  };
  riskCeiling: Risk;
  /**
   * @maxItems 100
   */
  inputs: IoField[];
  /**
   * @minItems 1
   * @maxItems 100
   */
  outputs: IoField[];
  /**
   * @maxItems 20
   */
  resourceRequirements: {
    slot: Id;
    purpose: string;
    origin: string;
    authentication: "public" | "authenticated" | "membership";
  }[];
  /**
   * @minItems 1
   * @maxItems 100
   */
  successCriteria: string[];
  failurePolicy: {
    failure: "fail" | "request_assistance";
    timeout: "fail" | "request_assistance";
    cancelled: "cancel";
    uncertain: "stop_uncertain" | "request_assistance";
  };
  evidencePolicy: {
    classification: "public" | "restricted" | "confidential";
    rawRetentionHours: number;
    screenshotDefault: false;
  };
  /**
   * @minItems 1
   * @maxItems 200
   */
  acceptanceTests: {
    id: Id;
    scenario: "success" | "business_failure" | "timeout" | "cancelled" | "uncertain" | "page_change";
    input: JsonValue;
    expected: JsonValue;
  }[];
}
export interface Metadata {
  id: Id;
  version: Semver;
  title: string;
  description?: string;
}
export interface IoField {
  name: Id;
  type: string;
  required: boolean;
  description?: string;
}
