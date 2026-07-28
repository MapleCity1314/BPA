export const MCP_TOOL_NAMES = [
  "catalog_search",
  "task_list",
  "task_claim",
  "task_heartbeat",
  "task_submit",
  "workflow_draft_create",
  "workflow_draft_get",
  "workflow_draft_apply",
  "workflow_draft_add_or_replace_step",
  "workflow_draft_set_binding",
  "workflow_draft_set_exception_policy",
  "workflow_draft_diff",
  "workflow_candidate_validate",
  "workflow_candidate_save",
  "workflow_validate",
  "workflow_gen",
  "node_gen",
  "node_requirement_create",
  "workflow_simulate",
  "artifact_diff"
] as const;

export function assertMcpControlMethodAllowed(method: string): void {
  if (/(?:^|[._-])(?:publish|approve)(?:$|[._-])/.test(method)) {
    throw new Error(
      "MCP authoring is Candidate-only; approve and publish require separate human actions"
    );
  }
}
