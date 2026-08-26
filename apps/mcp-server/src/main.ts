import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { z } from "zod";
import { stringify } from "yaml";
import type { ArtifactRecord } from "@bpa/persistence";
import {
  diffArtifacts,
  generateNodeDraft,
  generateWorkflowDraft,
  simulateCompiledWorkflow
} from "./authoring.js";
import {
  addOrReplaceStepOperation,
  optionalOperationId,
  parseAdapterRef,
  setBindingOperation,
  setExceptionPolicyOperation
} from "./incremental-authoring.js";
import { assertMcpControlMethodAllowed } from "./policy.js";

const server = new McpServer({
  name: "bpa-local",
  version: "0.6.8"
});
const socket =
  process.env.BPA_CONTROL_SOCKET ?? resolveControlSocketPath();
const control = new ControlClient(
  new UnixSocketControlTransport(socket, {
    runtime: { name: "bpa-mcp", version: "0.6.8" },
    features: ["evidence_refs", "resource_bindings", "staging_leases"]
  }),
  { timeoutMs: 10_000 }
);

function result(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: { result: value }
  };
}

async function core<TResult = unknown>(
  method: string,
  params?: Record<string, unknown>
): Promise<TResult> {
  assertMcpControlMethodAllowed(method);
  return control.request<TResult>(method, params);
}

server.registerTool(
  "catalog_search",
  {
    title: "Search BPA catalog",
    description: "Search immutable published BPA nodes and workflows.",
    inputSchema: {
      query: z.string().default(""),
      asset_type: z
        .enum([
          "node",
          "workflow",
          "adapter",
          "policy",
          "assistance_profile",
          "dataset_profile",
          "page_model",
          "element_contract"
        ])
        .optional(),
      capability: z.string().optional(),
      capabilities: z.array(z.string()).default([]),
      platform: z.string().optional(),
      runtime: z
        .enum(["builtin", "browser", "team", "assistance", "composite"])
        .optional(),
      available_input_types: z.array(z.string()).default([]),
      required_output_types: z.array(z.string()).default([]),
      maximum_risk: z.enum(["R0", "R1", "R2", "R3", "R4"]).optional(),
      permissions: z.array(z.string()).default([]),
      allowed_permissions: z.array(z.string()).default([]),
      adapter_ref: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({
    query,
    asset_type,
    capability,
    capabilities,
    platform,
    runtime,
    available_input_types,
    required_output_types,
    maximum_risk,
    permissions,
    allowed_permissions,
    adapter_ref,
    limit
  }) => {
    const requestedCapabilities = [
      ...(capability ? [capability] : []),
      ...capabilities
    ];
    const permissionBoundary =
      allowed_permissions.length > 0 ? allowed_permissions : permissions;
    const adapter = parseAdapterRef(adapter_ref);
    if (
      requestedCapabilities.length > 0 ||
      platform ||
      runtime ||
      maximum_risk ||
      permissionBoundary.length > 0 ||
      adapter_ref ||
      available_input_types.length > 0 ||
      required_output_types.length > 0
    ) {
      return result(
        await core("catalog.search.v2", {
          query,
          ...(asset_type ? { assetType: asset_type } : {}),
          capabilityIds: requestedCapabilities,
          ...(platform ? { platform } : {}),
          ...(runtime ? { runtime } : {}),
          availableInputTypes: available_input_types,
          requiredOutputTypes: required_output_types,
          maximumRisk: maximum_risk ?? "R4",
          allowedPermissions: permissionBoundary,
          ...(adapter ? { adapter } : {}),
          limit
        })
      );
    }
    const artifacts = await core<ArtifactRecord[]>("catalog.list", {
      ...(asset_type ? { assetType: asset_type } : {})
    });
    const needle = query.toLowerCase();
    return result(
      artifacts.filter((artifact) => {
        const haystack =
          `${artifact.assetId} ${artifact.version} ${JSON.stringify(
            artifact.content
          )}`.toLowerCase();
        return haystack.includes(needle);
      }).slice(0, limit)
    );
  }
);

server.registerTool(
  "task_list",
  {
    title: "List BPA assistance tasks",
    description:
      "List provider-neutral AI review and human assistance tasks available through Core.",
    inputSchema: {
      statuses: z
        .array(
          z.enum([
            "queued",
            "claimed",
            "processing",
            "awaiting_human",
            "completed",
            "expired",
            "cancelled",
            "failed"
          ])
        )
        .optional(),
      modes: z
        .array(z.enum(["ai_review", "human_confirm", "human_action"]))
        .optional(),
      limit: z.number().int().min(1).max(1000).default(100)
    }
  },
  async ({ statuses, modes, limit }) =>
    result(
      await core("assistance.task.list", {
        ...(statuses ? { statuses } : {}),
        ...(modes ? { modes } : {}),
        limit
      })
    )
);

server.registerTool(
  "task_claim",
  {
    title: "Claim BPA assistance task",
    description:
      "Claim one task with an actor-bound lease and fencing token. AI actors cannot claim human-only tasks.",
    inputSchema: {
      task_id: z.string(),
      actor_id: z.string(),
      actor_type: z.enum(["ai", "human"]).default("ai"),
      lease_id: z.string(),
      operation_id: z.string().min(1).optional(),
      lease_duration_ms: z.number().int().min(1000).max(15 * 60 * 1000)
    }
  },
  async ({
    task_id,
    actor_id,
    actor_type,
    lease_id,
    operation_id,
    lease_duration_ms
  }) =>
    result(
      await core("assistance.task.claim", {
        taskId: task_id,
        actorId: actor_id,
        actorType: actor_type,
        leaseId: lease_id,
        ...optionalOperationId(operation_id),
        leaseDurationMs: lease_duration_ms
      })
    )
);

server.registerTool(
  "task_heartbeat",
  {
    title: "Heartbeat BPA assistance lease",
    description:
      "Extend an active lease only when actor, lease id, and fencing token still match.",
    inputSchema: {
      task_id: z.string(),
      actor_id: z.string(),
      lease_id: z.string(),
      fencing_token: z.number().int().positive(),
      operation_id: z.string().min(1).optional(),
      lease_duration_ms: z.number().int().min(1000).max(15 * 60 * 1000)
    }
  },
  async ({
    task_id,
    actor_id,
    lease_id,
    fencing_token,
    operation_id,
    lease_duration_ms
  }) =>
    result(
      await core("assistance.task.heartbeat", {
        taskId: task_id,
        actorId: actor_id,
        leaseId: lease_id,
        fencingToken: fencing_token,
        ...optionalOperationId(operation_id),
        leaseDurationMs: lease_duration_ms
      })
    )
);

server.registerTool(
  "task_submit",
  {
    title: "Submit BPA assistance task",
    description:
      "Submit schema-validated output under the current lease. Core decides whether deterministic auto-continuation is allowed.",
    inputSchema: {
      task_id: z.string(),
      actor_id: z.string(),
      actor_type: z.enum(["ai", "human", "human_ai"]),
      lease_id: z.string(),
      fencing_token: z.number().int().positive(),
      operation_id: z.string().min(1).optional(),
      output: z.unknown(),
      provider: z.string().optional(),
      model: z.string().optional(),
      confidence: z.number().min(0).max(1).optional()
    }
  },
  async ({
    task_id,
    actor_id,
    actor_type,
    lease_id,
    fencing_token,
    operation_id,
    output,
    provider,
    model,
    confidence
  }) =>
    result(
      await core("assistance.task.submit", {
        taskId: task_id,
        actorId: actor_id,
        resolverType: actor_type,
        leaseId: lease_id,
        fencingToken: fencing_token,
        ...optionalOperationId(operation_id),
        output,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(confidence === undefined ? {} : { confidence })
      })
    )
);

server.registerTool(
  "workflow_draft_create",
  {
    title: "Create incremental Workflow Draft",
    description:
      "Create an editable Workflow Draft. The draft remains non-executable and cannot be published by Codex.",
    inputSchema: {
      id: z.string(),
      title: z.string(),
      description: z.string()
    }
  },
  async ({ id, title, description }) =>
    result(
      await core("authoring.workflow-draft.create", {
        id,
        title,
        description,
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "workflow_draft_get",
  {
    title: "Get Workflow Draft",
    description: "Read one Workflow Draft and its current CAS revision.",
    inputSchema: { draft_id: z.string() }
  },
  async ({ draft_id }) =>
    result(
      await core("authoring.workflow-draft.get", { draftId: draft_id })
    )
);

server.registerTool(
  "workflow_draft_apply",
  {
    title: "Apply Workflow Draft operation",
    description:
      "Apply one typed incremental edit using the expected revision. This never publishes.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation: z.record(z.unknown())
    }
  },
  async ({ draft_id, expected_revision, operation }) =>
    result(
      await core("authoring.workflow-draft.apply", {
        draftId: draft_id,
        expectedRevision: expected_revision,
        operation,
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "workflow_draft_add_or_replace_step",
  {
    title: "Add or replace one Workflow Draft step",
    description:
      "CAS-edit exactly one semantic step using an exact Node version. This avoids regenerating the full Workflow JSON.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation_id: z.string(),
      step_key: z.string(),
      node_ref: z.string(),
      config: z.record(z.unknown()).default({}),
      input_bindings: z.record(z.unknown()).default({})
    }
  },
  async ({
    draft_id,
    expected_revision,
    operation_id,
    step_key,
    node_ref,
    config,
    input_bindings
  }) =>
    result(
      await core("authoring.workflow-draft.apply", {
        draftId: draft_id,
        expectedRevision: expected_revision,
        operation: addOrReplaceStepOperation({
          operationId: operation_id,
          step: {
            key: step_key,
            nodeRef: node_ref,
            config: config as never,
            inputBindings: input_bindings as never
          }
        }),
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "workflow_draft_set_binding",
  {
    title: "Set one Workflow Draft binding",
    description:
      "CAS-edit one named input binding on one step without replacing unrelated configuration.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation_id: z.string(),
      step_key: z.string(),
      binding_key: z.string(),
      value: z.unknown()
    }
  },
  async ({
    draft_id,
    expected_revision,
    operation_id,
    step_key,
    binding_key,
    value
  }) =>
    result(
      await core("authoring.workflow-draft.apply", {
        draftId: draft_id,
        expectedRevision: expected_revision,
        operation: setBindingOperation({
          operationId: operation_id,
          stepKey: step_key,
          bindingKey: binding_key,
          value: value as never
        }),
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "workflow_draft_set_exception_policy",
  {
    title: "Set one Workflow Draft exception policy",
    description:
      "CAS-edit deterministic failure, timeout, cancellation, and uncertain handling for one step. Rejected is an immutable terminal outcome.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation_id: z.string(),
      step_key: z.string(),
      failure: z.enum(["fail", "collect", "request_assistance"]),
      timeout: z.enum(["fail", "collect", "request_assistance"]),
      cancelled: z.enum(["fail", "collect", "request_assistance"]),
      uncertain: z.enum(["request_assistance", "stop_uncertain"])
    }
  },
  async ({
    draft_id,
    expected_revision,
    operation_id,
    step_key,
    failure,
    timeout,
    cancelled,
    uncertain
  }) =>
    result(
      await core("authoring.workflow-draft.apply", {
        draftId: draft_id,
        expectedRevision: expected_revision,
        operation: setExceptionPolicyOperation({
          operationId: operation_id,
          stepKey: step_key,
          policy: {
            failure,
            timeout,
            cancelled,
            uncertain
          }
        }),
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "workflow_draft_diff",
  {
    title: "Diff Workflow Draft revisions",
    description:
      "Return a bounded semantic diff between two stored revisions without sending or regenerating the full Draft.",
    inputSchema: {
      draft_id: z.string(),
      from_revision: z.number().int().nonnegative(),
      to_revision: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(1000).default(200)
    }
  },
  async ({ draft_id, from_revision, to_revision, limit }) =>
    result(
      await core("authoring.workflow-draft.diff", {
        draftId: draft_id,
        fromRevision: from_revision,
        toRevision: to_revision,
        limit
      })
    )
);

server.registerTool(
  "workflow_candidate_validate",
  {
    title: "Validate Workflow Candidate revision",
    description:
      "Validate one stored Draft revision for Candidate creation. This does not save, approve, or publish an asset.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative()
    }
  },
  async ({ draft_id, expected_revision }) =>
    result(
      await core("authoring.workflow-draft.validate-candidate", {
        draftId: draft_id,
        expectedRevision: expected_revision
      })
    )
);

server.registerTool(
  "workflow_candidate_save",
  {
    title: "Save Workflow Candidate",
    description:
      "Freeze a validated Draft revision as a Candidate. Codex cannot publish it.",
    inputSchema: {
      draft_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      candidate_id: z.string()
    }
  },
  async ({ draft_id, expected_revision, candidate_id }) =>
    result(
      await core("authoring.workflow-candidate.save", {
        draftId: draft_id,
        expectedRevision: expected_revision,
        candidateId: candidate_id,
        actor: { type: "ai", id: "codex:mcp" }
      })
    )
);

server.registerTool(
  "authoring_session_create",
  {
    title: "Create BPA Authoring Session",
    description:
      "Validate a ScenarioSpec and create a durable CAS Authoring Session. This creates no executable or published asset.",
    inputSchema: {
      session_id: z.string(),
      scenario: z.record(z.unknown())
    }
  },
  async ({ session_id, scenario }) =>
    result(
      await core("authoring.session.create", {
        sessionId: session_id,
        scenario,
        actor: { type: "ai", id: "codex:mcp" },
        occurredAt: new Date().toISOString()
      })
    )
);

server.registerTool(
  "authoring_session_get",
  {
    title: "Get BPA Authoring Session",
    description:
      "Read the current CAS revision, Catalog selections, capability gaps, Design Grants and Candidate references.",
    inputSchema: { session_id: z.string() }
  },
  async ({ session_id }) =>
    result(
      await core("authoring.session.get", { sessionId: session_id })
    )
);

server.registerTool(
  "authoring_session_apply",
  {
    title: "Apply Authoring Session operation",
    description:
      "Apply one allowlisted, operation-idempotent CAS transition or capability-gap edit. Page text cannot add operation types.",
    inputSchema: {
      session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation: z.record(z.unknown())
    }
  },
  async ({ session_id, expected_revision, operation }) =>
    result(
      await core("authoring.session.apply", {
        sessionId: session_id,
        expectedRevision: expected_revision,
        operation,
        actor: "codex:mcp",
        occurredAt: new Date().toISOString()
      })
    )
);

server.registerTool(
  "design_mode_start",
  {
    title: "Use an operator-approved Design Mode Grant",
    description:
      "Verify that the exact Grant created in the local Operator Console is active. MCP cannot approve or broaden the Grant.",
    inputSchema: { grant_id: z.string() }
  },
  async ({ grant_id }) => {
    const grant = await core<Record<string, unknown>>(
      "authoring.design-mode.get",
      { grantId: grant_id }
    );
    if (grant.state !== "active") {
      return result({
        status: "authorization_required",
        grantId: grant_id,
        state: grant.state,
        next:
          "Open BPA Console → 创作授权 and approve the exact target page."
      });
    }
    return result({
      status: "active",
      grant: {
        grantId: grant.grantId,
        authoringSessionId: grant.authoringSessionId,
        browserSessionId: grant.browserSessionId,
        profileId: grant.profileId,
        origin: grant.origin,
        tabId: grant.tabId,
        pageEpoch: grant.pageEpoch,
        allowedOperations: grant.allowedOperations,
        expiresAt: grant.expiresAt,
        revision: grant.revision
      }
    });
  }
);

server.registerTool(
  "design_snapshot_capture",
  {
    title: "Capture or finalize a governed semantic snapshot",
    description:
      "Without run_id, start the exact published capture Node under an active Design Grant and frozen Browser Session. With run_id, finalize its trusted Evidence as a PageSnapshot.",
    inputSchema: {
      authoring_session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      grant_id: z.string(),
      profile_id: z.string(),
      page_state: z.string(),
      browser_session_id: z.string(),
      run_id: z.string().optional(),
      snapshot_id: z.string().optional(),
      operation_id: z.string().optional()
    }
  },
  async ({
    authoring_session_id,
    expected_revision,
    grant_id,
    profile_id,
    page_state,
    browser_session_id,
    run_id,
    snapshot_id,
    operation_id
  }) => {
    if (run_id) {
      if (!snapshot_id || !operation_id) {
        return result({
          status: "rejected",
          errors: [
            "snapshot_id and operation_id are required when finalizing run_id"
          ]
        });
      }
      return result(
        await core("authoring.snapshot.complete", {
          sessionId: authoring_session_id,
          expectedRevision: expected_revision,
          operationId: operation_id,
          actor: "codex:mcp",
          occurredAt: new Date().toISOString(),
          runId: run_id,
          snapshotId: snapshot_id
        })
      );
    }
    const grant = await core<Record<string, unknown>>(
      "authoring.design-mode.get",
      { grantId: grant_id }
    );
    if (
      grant.state !== "active" ||
      grant.authoringSessionId !== authoring_session_id ||
      grant.profileId !== profile_id ||
      grant.browserSessionId !== browser_session_id
    ) {
      return result({
        status: "authorization_required",
        reason:
          "The active Grant does not match the requested session, profile, or Browser Session."
      });
    }
    const captureInput = {
      authoringSessionId: authoring_session_id,
      designGrantId: grant_id,
      profileId: profile_id,
      pageState: page_state,
      pageEpoch: grant.pageEpoch
    };
    const preview = await core<{
      previewDigest: string;
      requiresConfirmation: boolean;
      resourceSlots: Record<string, unknown>;
    }>("run.node.preview", {
      nodeId: "browser.design.snapshot.capture",
      nodeVersion: "1.0.0",
      input: captureInput
    });
    if (preview.requiresConfirmation) {
      return result({
        status: "rejected",
        reason:
          "The built-in Design capture Node unexpectedly requires R1 confirmation."
      });
    }
    const observations = await core<Array<Record<string, unknown>>>(
      "browser.page-observation.list",
      {
        sessionId: browser_session_id,
        limit: 200
      }
    );
    const pageObservation = observations.find(
      (observation) =>
        observation.sessionId === browser_session_id &&
        observation.tabId === grant.tabId &&
        observation.origin === grant.origin &&
        observation.pageEpoch === grant.pageEpoch &&
        observation.observationState === "ready" &&
        observation.contentScriptReady === true &&
        typeof observation.observedAt === "string" &&
        Date.now() - Date.parse(observation.observedAt) <= 30_000
    );
    if (
      !pageObservation ||
      typeof pageObservation.browserInstanceId !== "string" ||
      typeof pageObservation.tabId !== "number" ||
      typeof pageObservation.revision !== "number"
    ) {
      return result({
        status: "authorization_required",
        reason:
          "BROWSER_OBSERVATION_STALE: the authorized page is no longer available at the frozen tab binding."
      });
    }
    const run = await core("run.node.create", {
      nodeId: "browser.design.snapshot.capture",
      nodeVersion: "1.0.0",
      input: captureInput,
      expectedPreviewDigest: preview.previewDigest,
      confirmed: false,
      resourceBindings: {
        design_page: {
          sessionId: browser_session_id,
          browserInstanceId: pageObservation.browserInstanceId,
          tabId: pageObservation.tabId,
          observationRevision: pageObservation.revision
        }
      },
      actor: "codex:mcp"
    });
    return result({
      status: "capture_started",
      preview,
      run,
      next:
        "Wait for the Run to succeed, then call design_snapshot_capture again with run_id, snapshot_id and operation_id."
    });
  }
);

server.registerTool(
  "design_snapshot_query",
  {
    title: "Query bounded semantic snapshot nodes",
    description:
      "Return snapshot metadata and at most 200 untrusted semantic nodes. Use role/text filters instead of loading the entire page.",
    inputSchema: {
      snapshot_id: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(100),
      role: z.string().optional(),
      text: z.string().optional()
    }
  },
  async ({ snapshot_id, offset, limit, role, text }) =>
    result(
      await core("authoring.snapshot.query", {
        snapshotId: snapshot_id,
        offset,
        limit,
        ...(role ? { role } : {}),
        ...(text ? { text } : {})
      })
    )
);

server.registerTool(
  "design_mode_stop",
  {
    title: "Stop Design Mode",
    description:
      "Stop an active operator-approved Grant. Stopped Grants and page-binding codes cannot be reused.",
    inputSchema: {
      grant_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      reason: z.string().default("authoring_capture_complete")
    }
  },
  async ({ grant_id, expected_revision, reason }) =>
    result(
      await core("authoring.design-mode.stop", {
        grantId: grant_id,
        expectedRevision: expected_revision,
        actor: "codex:mcp",
        occurredAt: new Date().toISOString(),
        reason
      })
    )
);

server.registerTool(
  "page_candidate_validate",
  {
    title: "Validate PageModel and ElementContract Candidate",
    description:
      "Validate a candidate against the exact governed PageSnapshots attached to one Authoring Session. CSS-only or single-state contracts are rejected.",
    inputSchema: {
      authoring_session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      candidate: z.record(z.unknown())
    }
  },
  async ({
    authoring_session_id,
    expected_revision,
    candidate
  }) =>
    result(
      await core("authoring.page-candidate.validate", {
        sessionId: authoring_session_id,
        expectedRevision: expected_revision,
        candidate
      })
    )
);

server.registerTool(
  "page_candidate_gen",
  {
    title: "Save PageModel and ElementContract Candidate",
    description:
      "Validate and save page assets as Registry Candidates only. Generated Handler code is never executed and no asset is published.",
    inputSchema: {
      authoring_session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      candidate: z.record(z.unknown())
    }
  },
  async ({
    authoring_session_id,
    expected_revision,
    candidate
  }) =>
    result(
      await core("authoring.page-candidate.save", {
        sessionId: authoring_session_id,
        expectedRevision: expected_revision,
        actor: "codex:mcp",
        candidate
      })
    )
);

server.registerTool(
  "candidate_bundle_validate",
  {
    title: "Validate immutable Candidate Bundle",
    description:
      "Check Schema, exact Scenario and Session revision, R0/R1 ceiling, Registry closure and CAS-backed file metadata before saving.",
    inputSchema: {
      authoring_session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      bundle: z.record(z.unknown())
    }
  },
  async ({
    authoring_session_id,
    expected_revision,
    bundle
  }) =>
    result(
      await core("authoring.candidate-bundle.validate", {
        sessionId: authoring_session_id,
        expectedRevision: expected_revision,
        bundle
      })
    )
);

server.registerTool(
  "candidate_bundle_save",
  {
    title: "Save immutable Candidate Bundle",
    description:
      "Save a fully valid Candidate Bundle and CAS-transition the Authoring Session to candidate. This never applies source, executes code or publishes assets.",
    inputSchema: {
      authoring_session_id: z.string(),
      expected_revision: z.number().int().nonnegative(),
      operation_id: z.string(),
      bundle: z.record(z.unknown())
    }
  },
  async ({
    authoring_session_id,
    expected_revision,
    operation_id,
    bundle
  }) =>
    result(
      await core("authoring.candidate-bundle.save", {
        sessionId: authoring_session_id,
        expectedRevision: expected_revision,
        operationId: operation_id,
        actor: "codex:mcp",
        occurredAt: new Date().toISOString(),
        bundle
      })
    )
);

server.registerTool(
  "candidate_bundle_export",
  {
    title: "Export checksummed Candidate Bundle",
    description:
      "Export an already-saved Candidate Bundle to the Core-owned exports directory as a deterministic tar. The archive is not applied to the repository and publishes nothing.",
    inputSchema: {
      candidate_id: z.string()
    }
  },
  async ({ candidate_id }) =>
    result(
      await core("authoring.candidate-bundle.export", {
        bundleId: candidate_id,
        actor: "codex:mcp",
        occurredAt: new Date().toISOString()
      })
    )
);

server.registerTool(
  "workflow_validate",
  {
    title: "Validate BPA workflow",
    description:
      "Validate and compile a Workflow draft against exact published Node versions.",
    inputSchema: {
      workflow: z.record(z.unknown())
    }
  },
  async ({ workflow }) =>
    result(
      await core("asset.validate", {
        assetType: "workflow",
        content: workflow
      })
    )
);

server.registerTool(
  "workflow_gen",
  {
    title: "Generate BPA workflow candidate",
    description:
      "Create, validate and save a candidate-only Workflow from exact published business Node references. Risk and failure routing are derived conservatively. This tool never publishes.",
    inputSchema: {
      id: z.string(),
      version: z.string().default("0.1.0"),
      title: z.string(),
      description: z.string(),
      node_refs: z.array(z.string()).default([]),
      risk_level: z.enum(["R0", "R1", "R2", "R3", "R4"]).optional(),
      input_schema: z.record(z.unknown()).optional(),
      output_schema: z.record(z.unknown()).optional()
    }
  },
  async ({
    id,
    version,
    title,
    description,
    node_refs,
    risk_level,
    input_schema,
    output_schema
  }) => {
    const published = (await core("catalog.list", {
      assetType: "node"
    })) as ArtifactRecord[];
    const draft = generateWorkflowDraft(
      {
        id,
        version,
        title,
        description,
        nodeRefs: node_refs,
        ...(risk_level ? { riskLevel: risk_level } : {}),
        ...(input_schema ? { inputSchema: input_schema } : {}),
        ...(output_schema ? { outputSchema: output_schema } : {})
      },
      published
    );
    if (draft.status === "rejected") return result(draft);
    const validation = (await core("asset.validate", {
      assetType: "workflow",
      content: draft.workflow
    })) as { valid: boolean; errors?: string[] };
    if (!validation.valid) {
      return result({
        status: "rejected",
        errors: validation.errors ?? ["Workflow validation failed"],
        review: draft.review
      });
    }
    const candidate = await core("asset.candidate", {
      assetType: "workflow",
      content: draft.workflow,
      actor: "codex:mcp"
    });
    return result({
      status: "candidate",
      candidate,
      workflow: draft.workflow,
      yaml: stringify(draft.workflow),
      review: draft.review
    });
  }
);

server.registerTool(
  "node_gen",
  {
    title: "Generate BPA node candidate",
    description:
      "Create and validate a candidate Node contract with conservative risk inference, permission checks and implementation boundaries. This tool never publishes.",
    inputSchema: {
      id: z.string(),
      version: z.string().default("0.1.0"),
      title: z.string(),
      description: z.string(),
      runtime: z
        .enum(["composite", "browser", "engine_team", "human"])
        .default("composite"),
      risk_level: z.enum(["R0", "R1", "R2", "R3", "R4"]).optional(),
      permissions: z.array(z.string()).default([]),
      domains: z.array(z.string().url()).default([]),
      input_schema: z.record(z.unknown()).optional(),
      output_schema: z.record(z.unknown()).optional(),
      config_schema: z.record(z.unknown()).optional()
    }
  },
  async ({
    id,
    version,
    title,
    description,
    runtime,
    risk_level,
    permissions,
    domains,
    input_schema,
    output_schema,
    config_schema
  }) => {
    const draft = generateNodeDraft({
      id,
      version,
      title,
      description,
      runtime,
      ...(risk_level ? { riskLevel: risk_level } : {}),
      permissions,
      domains,
      ...(input_schema ? { inputSchema: input_schema } : {}),
      ...(output_schema ? { outputSchema: output_schema } : {}),
      ...(config_schema ? { configSchema: config_schema } : {})
    });
    if (draft.status === "rejected") return result(draft);
    const validation = (await core("asset.validate", {
      assetType: "node",
      content: draft.node
    })) as { valid: boolean; errors?: string[] };
    if (!validation.valid) {
      return result({
        status: "rejected",
        errors: validation.errors ?? ["Node validation failed"],
        review: draft.review
      });
    }
    const candidate = await core("asset.candidate", {
      assetType: "node",
      content: draft.node,
      actor: "codex:mcp"
    });
    return result({
      status: "candidate",
      candidate,
      node: draft.node,
      yaml: stringify(draft.node),
      review: draft.review
    });
  }
);

server.registerTool(
  "node_requirement_create",
  {
    title: "Create Node requirement candidate",
    description:
      "Record a missing capability as a candidate requirement without enabling code execution.",
    inputSchema: {
      id: z.string(),
      title: z.string(),
      description: z.string(),
      permissions: z.array(z.string()).default([])
    }
  },
  async ({ id, title, description, permissions }) => {
    const content = {
      apiVersion: "bpa/v1alpha1",
      kind: "NodeRequirement",
      metadata: { id, version: "0.1.0", title },
      spec: { description, permissions, status: "unreviewed" }
    };
    return result(
      await core("asset.candidate", {
        assetType: "policy",
        content,
        actor: "codex:mcp"
      })
    );
  }
);

server.registerTool(
  "workflow_simulate",
  {
    title: "Simulate BPA workflow",
    description:
      "Return the static execution order and declared outcomes without executing browser or write actions.",
    inputSchema: {
      workflow: z.record(z.unknown())
    }
  },
  async ({ workflow }) => {
    const validation = await core<{
      valid: boolean;
      errors?: string[];
      compiled?: {
        start: string;
        nodes: Record<
          string,
          {
            nodeId: string;
            nodeVersion: string;
            next?: string;
            on: Record<string, string>;
          }
        >;
      };
    }>("asset.validate", {
      assetType: "workflow",
      content: workflow
    });
    if (!validation.valid) return result(validation);
    if (!validation.compiled) {
      return result({
        valid: false,
        errors: ["Core did not return a compiled Workflow"]
      });
    }
    return result({
      valid: true,
      ...simulateCompiledWorkflow(validation.compiled)
    });
  }
);

server.registerTool(
  "artifact_diff",
  {
    title: "Diff BPA artifact",
    description:
      "Compare a candidate body with a published immutable artifact.",
    inputSchema: {
      asset_type: z.enum([
        "node",
        "workflow",
        "adapter",
        "policy",
        "assistance_profile",
        "dataset_profile",
        "page_model",
        "element_contract"
      ]),
      asset_id: z.string(),
      version: z.string(),
      candidate: z.record(z.unknown())
    }
  },
  async ({ asset_type, asset_id, version, candidate }) => {
    const artifacts = (await core("catalog.list", {
      assetType: asset_type
    })) as ArtifactRecord[];
    const published = artifacts.find(
      (artifact) =>
        artifact.assetId === asset_id && artifact.version === version
    );
    const differences = diffArtifacts(published?.content, candidate);
    return result({
      published: published?.content,
      candidate,
      identical: published != null && differences.length === 0,
      differences,
      truncated: differences.length >= 200
    });
  }
);

await server.connect(new StdioServerTransport());
