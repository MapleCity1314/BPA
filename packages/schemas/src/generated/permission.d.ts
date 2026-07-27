/* Generated from canonical JSON Schema. Do not edit manually. */

export interface BPAPermissionGrant {
  grant_id: string;
  subject: string;
  workflow: string;
  node: string;
  permissions: string[];
  domains?: string[];
  risk_level?: "R0" | "R1" | "R2" | "R3" | "R4";
  issued_at: string;
  expires_at: string;
  approval_ref?: string;
}
