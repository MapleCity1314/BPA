export const MCP_TOOL_NAMES = [
  "catalog_search",
  "task_list",
  "task_claim",
  "task_heartbeat",
  "task_submit",
  "workflow_draft_create",
  "workflow_draft_get",
  "workflow_draft_apply",
  "workflow_candidate_save",
  "workflow_validate",
  "workflow_gen",
  "node_gen",
  "node_requirement_create",
  "workflow_simulate",
  "artifact_diff"
] as const;

export function assertMcpControlMethodAllowed(method: string): void {
  if (/(?:^|[._-])publish(?:$|[._-])/.test(method)) {
    throw new Error(
      "MCP authoring is Candidate-only; publish requires a separate human action"
    );
  }
}
