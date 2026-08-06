/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;
export type Digest = string;
export type Semver = string;
export type BoundedText = string;

export interface BPAAuthoringPageSnapshotV1Alpha1 {
  apiVersion: "bpa.authoring/v1alpha1";
  kind: "PageSnapshot";
  snapshotId: Id;
  pageState: Id;
  capturedAt: string;
  origin: string;
  path: string;
  binding: {
    designGrantId: Id;
    browserSessionId: Id;
    profileId: string;
    tabId: number;
    pageEpoch: string;
  };
  captureSource: {
    runId: Id;
    nodeExecutionId: Id;
    evidenceId: Id;
    assetRef: ContentRef;
  };
  classification: "restricted" | "confidential";
  untrusted: true;
  redaction: {
    applied: true;
    policyVersion: Semver;
    coverage: {
      passwords: true;
      tokens: true;
      cookies: true;
      hiddenInputs: true;
      personalData: true;
      largeText: true;
    };
  };
  /**
   * @maxItems 5000
   */
  semanticNodes: SemanticNode[];
  contentDigest: Digest;
  sizeBytes: number;
  screenshotEvidenceRef?: ContentRef;
  rawEvidenceExpiresAt: string;
}
export interface ContentRef {
  id: Id;
  digest: Digest;
  sizeBytes: number;
}
export interface SemanticNode {
  id: Id;
  parentId?: Id | null;
  order: number;
  role?: BoundedText;
  accessibleName?: BoundedText;
  label?: BoundedText;
  text?: BoundedText;
  region?: BoundedText;
  stableAttributes?: {
    [k: string]: BoundedText;
  };
  states: {
    visible: boolean;
    interactive: boolean;
    enabled?: boolean;
    required?: boolean;
    checked?: boolean;
    selected?: boolean;
  };
  cssDiagnostic?: string;
  digest: Digest;
}
