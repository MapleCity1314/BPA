/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Semver = string;
export type Candidate =
  | {
      strategy: "business-id";
      value: string;
    }
  | {
      strategy: "role-name";
      role: string;
      name: string;
    }
  | {
      strategy: "label";
      label: string;
    }
  | {
      strategy: "attribute";
      name: string;
      value: string;
    }
  | {
      strategy: "relative-anchor";
      anchor: Id;
      role: string;
      name: string;
    }
  | {
      strategy: "css-diagnostic";
      selector: string;
    };
export type Digest = string;

export interface BPAElementContractV1Alpha1 {
  apiVersion: "bpa.page/v1alpha1";
  kind: "ElementContract";
  metadata: Metadata;
  intent: string;
  scope: {
    /**
     * @minItems 1
     * @maxItems 20
     */
    origins: string[];
    pathPattern: string;
    pageState: Id;
    frame: "top" | "same-origin-child";
  };
  expectedCount: {
    minimum: number;
    maximum: number;
  };
  /**
   * @minItems 1
   * @maxItems 20
   */
  candidates: Candidate[];
  /**
   * @maxItems 50
   */
  preconditions: Id[];
  /**
   * @maxItems 50
   */
  postconditions: Id[];
  volatility: "low" | "medium" | "high";
  /**
   * @minItems 2
   * @maxItems 100
   */
  validatedSnapshots: Digest[];
}
export interface Metadata {
  id: Id;
  version: Semver;
  title: string;
  description?: string;
}
