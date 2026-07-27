/* Generated from canonical JSON Schema. Do not edit manually. */

export type Id = string;

export interface BPASignedPermissionGrant {
  grant_id: Id;
  permissions: Id[];
  domains: string[];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  expires_at: string;
  run_id: Id;
  node_execution_id: Id;
  node_id: Id;
  node_version: Id;
  fencing_token: number;
  approval_ref?: Id;
  key_id: Id;
  grant_digest: string;
  authorization_tag: string;
}
