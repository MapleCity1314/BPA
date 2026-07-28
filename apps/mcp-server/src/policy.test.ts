import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_NAMES,
  assertMcpControlMethodAllowed
} from "./policy.js";

describe("MCP Candidate-only policy", () => {
  it("keeps legacy tools and exposes assistance plus incremental authoring", () => {
    expect(MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "catalog_search",
        "workflow_gen",
        "node_gen",
        "task_list",
        "task_claim",
        "task_heartbeat",
        "task_submit",
        "workflow_draft_create",
        "workflow_draft_apply",
        "workflow_draft_add_or_replace_step",
        "workflow_draft_set_binding",
        "workflow_draft_set_exception_policy",
        "workflow_draft_diff",
        "workflow_candidate_validate",
        "workflow_candidate_save"
      ])
    );
  });

  it("allows Candidate methods and refuses every publish control method", () => {
    expect(() =>
      assertMcpControlMethodAllowed("asset.candidate")
    ).not.toThrow();
    expect(() =>
      assertMcpControlMethodAllowed("authoring.workflow-candidate.save")
    ).not.toThrow();
    expect(() => assertMcpControlMethodAllowed("asset.publish")).toThrow(
      /Candidate-only/
    );
    expect(() =>
      assertMcpControlMethodAllowed("workflow_publish_now")
    ).toThrow(/Candidate-only/);
    expect(() =>
      assertMcpControlMethodAllowed("asset.approve")
    ).toThrow(/Candidate-only/);
  });
});
