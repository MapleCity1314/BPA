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
import { assertMcpControlMethodAllowed } from "./policy.js";

const server = new McpServer({
  name: "bpa-local",
  version: "0.3.0"
});
const socket =
  process.env.BPA_CONTROL_SOCKET ?? resolveControlSocketPath();
const control = new ControlClient(new UnixSocketControlTransport(socket), {
  timeoutMs: 10_000
});

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
      asset_type: z.enum(["node", "workflow", "adapter", "policy"]).optional(),
      capability: z.string().optional(),
      platform: z.string().optional(),
      runtime: z
        .enum(["builtin", "browser", "team", "assistance", "composite"])
        .optional(),
      maximum_risk: z.enum(["R0", "R1", "R2", "R3", "R4"]).optional(),
      permissions: z.array(z.string()).default([]),
      adapter_ref: z.string().optional()
    }
  },
  async ({
    query,
    asset_type,
    capability,
    platform,
    runtime,
    maximum_risk,
    permissions,
    adapter_ref
  }) => {
    if (
      capability ||
      platform ||
      runtime ||
      maximum_risk ||
      permissions.length > 0 ||
      adapter_ref
    ) {
      return result(
        await core("catalog.search.v2", {
          query,
          ...(asset_type ? { assetType: asset_type } : {}),
          ...(capability ? { capability } : {}),
          ...(platform ? { platform } : {}),
          ...(runtime ? { runtime } : {}),
          ...(maximum_risk ? { maximumRisk: maximum_risk } : {}),
          ...(permissions.length > 0 ? { permissions } : {}),
          ...(adapter_ref ? { adapterRef: adapter_ref } : {})
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
      })
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
      lease_duration_ms: z.number().int().min(1000).max(15 * 60 * 1000)
    }
  },
  async ({
    task_id,
    actor_id,
    actor_type,
    lease_id,
    lease_duration_ms
  }) =>
    result(
      await core("assistance.task.claim", {
        taskId: task_id,
        actorId: actor_id,
        actorType: actor_type,
        leaseId: lease_id,
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
      lease_duration_ms: z.number().int().min(1000).max(15 * 60 * 1000)
    }
  },
  async ({
    task_id,
    actor_id,
    lease_id,
    fencing_token,
    lease_duration_ms
  }) =>
    result(
      await core("assistance.task.heartbeat", {
        taskId: task_id,
        actorId: actor_id,
        leaseId: lease_id,
        fencingToken: fencing_token,
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
      asset_type: z.enum(["node", "workflow", "adapter", "policy"]),
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
