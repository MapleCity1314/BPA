import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stringify } from "yaml";
import { sendControlRequest } from "@bpa/local-core/control";
import { resolveBpaPaths } from "@bpa/local-core/paths";
import type { ArtifactRecord } from "@bpa/persistence";
import type { NodeDefinition, RiskLevel, WorkflowDefinition } from "@bpa/schemas";

const server = new McpServer({
  name: "bpa-local",
  version: "0.1.0"
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
      "Create a candidate-only Workflow draft from exact published Node references. This tool never publishes.",
    inputSchema: {
      id: z.string(),
      version: z.string().default("0.1.0"),
      title: z.string(),
      description: z.string(),
      node_refs: z.array(z.string()).default([]),
      risk_level: z.enum(["R0", "R1", "R2", "R3", "R4"]).default("R0")
    }
  },
  async ({ id, version, title, description, node_refs, risk_level }) => {
    const nodes: WorkflowDefinition["spec"]["nodes"] = {
      start: {
        use: "control.start@1.0.0",
        next: node_refs.length > 0 ? "step_1" : "finish"
      }
    };
    node_refs.forEach((reference, index) => {
      nodes[`step_${index + 1}`] = {
        use: reference,
        next:
          index === node_refs.length - 1
            ? "finish"
            : `step_${index + 2}`,
        on: {
          failure: "finish",
          timeout: "finish",
          rejected: "finish",
          uncertain: "finish"
        }
      };
    });
    nodes.finish = { use: "control.succeed@1.0.0" };
    const workflow: WorkflowDefinition = {
      apiVersion: "bpa/v1alpha1",
      kind: "Workflow",
      metadata: { id, version, title, description },
      spec: {
        riskLevel: risk_level as RiskLevel,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        start: "start",
        nodes
      }
    };
    const candidate = await core("asset.candidate", {
      assetType: "workflow",
      content: workflow,
      actor: "codex:mcp"
    });
    return result({
      candidate,
      workflow,
      yaml: stringify(workflow),
      tests: [
        "validate exact Node versions",
        "simulate success and each declared failure edge",
        "confirm permissions are no broader than referenced Nodes"
      ],
      risks: [
        "Candidate is not approved or published.",
        "Generated failure edges should be reviewed for business semantics."
      ],
      capability_gaps: []
    });
  }
);

server.registerTool(
  "node_gen",
  {
    title: "Generate BPA node candidate",
    description:
      "Create a candidate Node contract and implementation skeleton. Browser and team code remains disabled until reviewed and published manually.",
    inputSchema: {
      id: z.string(),
      version: z.string().default("0.1.0"),
      title: z.string(),
      description: z.string(),
      runtime: z
        .enum(["composite", "browser", "engine_team", "human"])
        .default("composite"),
      risk_level: z.enum(["R0", "R1", "R2", "R3", "R4"]).default("R0"),
      permissions: z.array(z.string()).default([]),
      domains: z.array(z.string().url()).default([])
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
    domains
  }) => {
    const node: NodeDefinition = {
      apiVersion: "bpa/v1alpha1",
      kind: "Node",
      metadata: { id, version, title, description },
      runtime,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      risk: {
        level: risk_level as RiskLevel,
        permissions,
        ...(runtime === "browser" ? { domains } : {})
      },
      execution: {
        timeoutDefault: "30s",
        idempotency: runtime === "browser" ? "repeatable_read" : "pure",
        cancellable: true
      },
      errors: ["NOT_IMPLEMENTED"]
    };
    const candidate = await core("asset.candidate", {
      assetType: "node",
      content: node,
      actor: "codex:mcp"
    });
    return result({
      candidate,
      node,
      yaml: stringify(node),
      implementation_skeleton: {
        execute:
          "async function execute(input, context) { throw new Error('NOT_IMPLEMENTED'); }"
      },
      contract_tests: [
        "reject malformed input",
        "enforce timeout and cancellation",
        "verify declared permission boundary",
        "verify idempotency behavior"
      ],
      permission_report: {
        risk_level,
        permissions,
        domains,
        publishable: false,
        reason: "Manual review and CLI publish are required."
      }
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
        { nodeId: string; nodeVersion: string; next?: string; on: unknown }
      >;
    };
    const order: unknown[] = [];
    const seen = new Set<string>();
    let key: string | undefined = compiled.start;
    while (key && !seen.has(key)) {
      seen.add(key);
      const node = compiled.nodes[key]!;
      order.push({
        key,
        node: `${node.nodeId}@${node.nodeVersion}`,
        on: node.on
      });
      key = node.next;
    }
    return result({ valid: true, mode: "static-no-side-effects", order });
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
    return result({
      published: published?.content,
      candidate,
      identical:
        published != null &&
        JSON.stringify(published.content) === JSON.stringify(candidate)
    });
  }
);

await server.connect(new StdioServerTransport());
