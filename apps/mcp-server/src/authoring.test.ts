import type { ArtifactRecord } from "@bpa/persistence";
import type { NodeDefinition } from "@bpa/schemas";
import { describe, expect, it } from "vitest";
import {
  diffArtifacts,
  generateNodeDraft,
  generateWorkflowDraft,
  simulateCompiledWorkflow
} from "./authoring.js";

function nodeArtifact(
  id: string,
  version: string,
  options: Partial<NodeDefinition> = {}
): ArtifactRecord {
  const node: NodeDefinition = {
    apiVersion: "bpa/v1alpha1",
    kind: "Node",
    metadata: { id, version, title: id },
    runtime: "engine_builtin",
    inputSchema: { type: "object" },
    outputSchema: {},
    risk: { level: "R0", permissions: [] },
    execution: { timeoutDefault: "1s", idempotency: "pure" },
    errors: [],
    ...options
  };
  return {
    recordId: `${id}-${version}`,
    assetType: "node",
    assetId: id,
    version,
    digest: `sha256:${id}`,
    status: "published",
    content: node,
    createdAt: new Date(0).toISOString(),
    publishedAt: new Date(0).toISOString()
  };
}

const defaultCatalog = [
  nodeArtifact("control.start", "1.1.0"),
  nodeArtifact("control.succeed", "1.1.0"),
  nodeArtifact("control.fail", "1.0.0")
];

describe("MCP authoring helpers", () => {
  it("omits the failure terminal when an empty workflow cannot reach it", () => {
    const result = generateWorkflowDraft(
      {
        id: "empty.workflow",
        version: "0.1.0",
        title: "Empty",
        description: "Return workflow input",
        nodeRefs: []
      },
      defaultCatalog
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.workflow.spec.nodes.fail).toBeUndefined();
    expect(result.workflow.spec.nodes.start?.next).toBe("finish");
  });

  it("generates conservative failure routing and preserves uncertain terminal state", () => {
    const read = nodeArtifact("doudian.shop.read", "1.0.0", {
      runtime: "browser",
      risk: {
        level: "R1",
        permissions: ["browser.dom.read"],
        domains: ["https://fxg.jinritemai.com"]
      }
    });
    const result = generateWorkflowDraft(
      {
        id: "doudian.read",
        version: "0.1.0",
        title: "Read",
        description: "Read shop",
        nodeRefs: ["doudian.shop.read@1.0.0"]
      },
      [...defaultCatalog, read]
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.workflow.spec.riskLevel).toBe("R1");
    expect(result.workflow.spec.nodes.step_1?.on).toMatchObject({
      failure: "fail",
      timeout: "fail",
      rejected: "fail",
      cancelled: "fail"
    });
    expect(result.workflow.spec.nodes.step_1?.on?.uncertain).toBeUndefined();
    expect(result.workflow.spec.nodes.fail?.use).toBe("control.fail@1.0.0");
  });

  it("reports missing capabilities and refuses understated workflow risk", () => {
    expect(
      generateWorkflowDraft(
        {
          id: "missing.workflow",
          version: "0.1.0",
          title: "Missing",
          description: "Missing",
          nodeRefs: ["missing.node@1.0.0"]
        },
        defaultCatalog
      )
    ).toMatchObject({
      status: "rejected",
      capabilityGaps: ["Published Node is missing: missing.node@1.0.0"]
    });
    const write = nodeArtifact("doudian.item.write", "1.0.0", {
      runtime: "browser",
      risk: {
        level: "R3",
        permissions: ["browser.dom.write"],
        domains: ["https://fxg.jinritemai.com"]
      }
    });
    expect(
      generateWorkflowDraft(
        {
          id: "unsafe.workflow",
          version: "0.1.0",
          title: "Unsafe",
          description: "Unsafe",
          nodeRefs: ["doudian.item.write@1.0.0"],
          riskLevel: "R1"
        },
        [...defaultCatalog, write]
      )
    ).toMatchObject({ status: "rejected" });
  });

  it("infers Node risk and protects reserved namespaces and origins", () => {
    expect(
      generateNodeDraft({
        id: "team.publish",
        version: "0.1.0",
        title: "Publish",
        description: "Publish",
        runtime: "browser",
        permissions: ["browser.dom.write", "product.publish"],
        domains: ["https://example.com"],
        riskLevel: "R1"
      })
    ).toMatchObject({ status: "rejected" });
    expect(
      generateNodeDraft({
        id: "control.custom",
        version: "0.1.0",
        title: "Reserved",
        description: "Reserved",
        runtime: "composite",
        permissions: [],
        domains: []
      })
    ).toMatchObject({ status: "rejected" });
    expect(
      generateNodeDraft({
        id: "shop.context.read",
        version: "0.1.0",
        title: "Read",
        description: "Read",
        runtime: "browser",
        permissions: ["browser.dom.read"],
        domains: ["https://example.com/path"]
      })
    ).toMatchObject({ status: "rejected" });
  });

  it("simulates every declared edge and returns path-level artifact differences", () => {
    expect(
      simulateCompiledWorkflow({
        start: "start",
        nodes: {
          start: {
            nodeId: "control.start",
            nodeVersion: "1.1.0",
            next: "finish",
            on: { failure: "fail" }
          },
          finish: {
            nodeId: "control.succeed",
            nodeVersion: "1.1.0",
            on: {}
          },
          fail: {
            nodeId: "control.fail",
            nodeVersion: "1.0.0",
            on: {}
          }
        }
      }).nodes
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "start",
          edges: { success: "finish", failure: "fail" }
        }),
        expect.objectContaining({ key: "fail", terminal: true })
      ])
    );
    expect(
      diffArtifacts(
        { metadata: { version: "1.0.0" }, risk: "R0" },
        { metadata: { version: "1.1.0" }, risk: "R1" }
      )
    ).toEqual([
      {
        path: "/metadata/version",
        kind: "changed",
        before: "1.0.0",
        after: "1.1.0"
      },
      {
        path: "/risk",
        kind: "changed",
        before: "R0",
        after: "R1"
      }
    ]);
  });
});
