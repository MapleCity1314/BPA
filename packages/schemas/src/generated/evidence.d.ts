/* Generated from canonical JSON Schema. Do not edit manually. */

export interface BPAEvidenceMetadata {
  evidence_id: string;
  run_id: string;
  node_execution_id: string;
  kind: "dom_summary" | "screenshot" | "file" | "verification" | "error";
  digest: string;
  size: number;
  media_type?: string;
  storage_ref?: string;
  created_at: string;
  expires_at?: string;
  classification?: "public" | "internal" | "confidential" | "restricted";
}
