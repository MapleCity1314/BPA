import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stringify } from "yaml";
import { sendControlRequest } from "@bpa/local-core/control";
import { resolveBpaPaths } from "@bpa/local-core/paths";
import type { ArtifactRecord } from "@bpa/persistence";
import {
  diffArtifacts,
  generateNodeDraft,
  generateWorkflowDraft,
  simulateCompiledWorkflow
} from "./authoring.js";

const server = new McpServer({
  name: "bpa-local",
  version: "0.3.0"
});
const socket = resolveBpaPaths().socket;

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

async function core(
  method: string,
  params?: Record<string, unknown>
): Promise<any> {
  return sendControlRequest(socket, method, params);
}

server.registerTool(
  "catalog_search",
  {
    title: "Search BPA catalog",
    description: "Search immutable published BPA nodes and workflows.",
    inputSchema: {
      query: z.string().default(""),
      asset_type: z.enum(["node", "workflow", "adapter", "policy"]).optional()
    }
  },
  async ({ query, asset_type }) => {
    const artifacts = (await core("catalog.list", {
      ...(asset_type ? { assetType: asset_type } : {})
    })) as ArtifactRecord[];
    const needle = query.toLowerCase();
    return result(
      artifacts.filter((artifact) =>
        `${artifact.assetId} ${artifact.version} ${JSON.stringify(
          artifact.content
        )}`
          .toLowerCase()
          .includes(needle)
      )
    );
  }
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
    const validation = await core("asset.validate", {
      assetType: "workflow",
      content: workflow
    });
    if (!validation.valid) return result(validation);
    const compiled = validation.compiled as {
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
    return result({
      valid: true,
      ...simulateCompiledWorkflow(compiled)
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
