import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type {
  NodeDefinition,
  WorkflowDefinitionV1Alpha2
} from "@bpa/schemas";
import { LocalCoreService } from "./control.js";

const constantNode: NodeDefinition = {
  apiVersion: "bpa/v1alpha1",
  kind: "Node",
  metadata: {
    id: "data.constant",
    version: "1.0.0",
    title: "Constant"
  },
  runtime: "engine_builtin",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: { value: {} }
  },
  outputSchema: {},
  risk: { level: "R0", permissions: [] },
  execution: {
    timeoutDefault: "1s",
    idempotency: "pure",
    cancellable: true
  },
  errors: []
};

const workflow: WorkflowDefinitionV1Alpha2 = {
  apiVersion: "bpa/v1alpha2",
  kind: "Workflow",
  metadata: {
    id: "test.ir2-control",
    version: "1.0.0",
    title: "IR2 control"
  },
  spec: {
    riskLevel: "R0",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    root: {
      kind: "sequence",
      steps: [
        {
          kind: "call",
          key: "constant",
          use: "data.constant@1.0.0",
          with: { value: { from: "ir2" } }
        },
        {
          kind: "terminal",
          key: "done",
          status: "succeeded",
          output: "${steps.constant.output}"
        }
      ]
    }
  }
};

describe("Local Core IR2 control integration", () => {
  it("validates, publishes, starts and completes a v1alpha2 workflow", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    persistence.publish({
      assetType: "node",
      assetId: constantNode.metadata.id,
      version: constantNode.metadata.version,
      digest: contentDigest(constantNode),
      content: constantNode,
      actor: "test"
    });
    const service = new LocalCoreService(persistence);
    const validation = service.handle({
      id: "validate",
      method: "asset.validate",
      params: { assetType: "workflow", content: workflow }
    });
    expect(validation).toMatchObject({
      ok: true,
      result: {
        valid: true,
        identity: "test.ir2-control@1.0.0",
        compiled: { irVersion: "bpa.workflow-ir/2" }
      }
    });
    expect(
      service.handle({
        id: "publish",
        method: "asset.publish",
        params: {
          assetType: "workflow",
          content: workflow,
          actor: "test"
        }
      })
    ).toMatchObject({ ok: true });
    expect(
      service.handle({
        id: "run-invalid-input",
        method: "run.create",
        params: {
          workflowId: workflow.metadata.id,
          workflowVersion: workflow.metadata.version,
          input: []
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Workflow input is invalid") }
    });
    const created = service.handle({
      id: "run",
      method: "run.create",
      params: {
        workflowId: workflow.metadata.id,
        workflowVersion: workflow.metadata.version,
        input: {}
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: { workflowId: workflow.metadata.id, status: "running" }
    });
    const runId = (created.result as { id: string }).id;
    await expect(service.ir2Runtime.drainOnce()).resolves.toBe(1);
    expect(persistence.getRun(runId)).toMatchObject({
      status: "succeeded",
      output: { from: "ir2" }
    });
    expect(persistence.getRunPlanSnapshot(runId)?.planJson).toMatchObject({
      irVersion: "bpa.workflow-ir/2"
    });
    persistence.close();
  });

  it("previews and runs one exact R0 Node through a recoverable wrapper", async () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    persistence.publish({
      assetType: "node",
      assetId: constantNode.metadata.id,
      version: constantNode.metadata.version,
      digest: contentDigest(constantNode),
      content: constantNode,
      actor: "test"
    });
    const service = new LocalCoreService(persistence);
    const preview = service.handle({
      id: "preview",
      method: "run.node.preview",
      params: {
        nodeId: constantNode.metadata.id,
        nodeVersion: constantNode.metadata.version,
        input: { value: "standalone" }
      }
    });
    expect(preview).toMatchObject({
      ok: true,
      result: {
        mode: "single_node",
        node: {
          id: constantNode.metadata.id,
          version: constantNode.metadata.version
        },
        riskLevel: "R0",
        permissions: [],
        requiresConfirmation: false
      }
    });
    const previewDigest = (preview.result as { previewDigest: string })
      .previewDigest;
    const created = service.handle({
      id: "run-node",
      method: "run.node.create",
      params: {
        nodeId: constantNode.metadata.id,
        nodeVersion: constantNode.metadata.version,
        input: { value: "standalone" },
        expectedPreviewDigest: previewDigest,
        actor: "test"
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: { status: "running" }
    });
    const runId = (created.result as { id: string }).id;
    expect(
      persistence.getRunPlanSnapshot(runId)?.planJson.steps.invoke
    ).toMatchObject({
      kind: "call",
      schemaContract: {
        nodeDigest: contentDigest(constantNode),
        inputSchema: constantNode.inputSchema,
        inputSchemaDigest: contentDigest(constantNode.inputSchema),
        outputSchema: constantNode.outputSchema,
        outputSchemaDigest: contentDigest(constantNode.outputSchema)
      }
    });
    await expect(service.ir2Runtime.drainOnce()).resolves.toBe(1);
    expect(persistence.getRun(runId)).toMatchObject({
      status: "succeeded",
      output: "standalone"
    });
    expect(persistence.listEvents(runId)[0]).toMatchObject({
      type: "RUN_IR2_STARTED",
      payload: {
        startMetadata: {
          mode: "single_node",
          actor: "test",
          nodeId: constantNode.metadata.id,
          previewDigest
        }
      }
    });
    persistence.close();
  });

  it("rejects invalid input and stale standalone Node previews", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    persistence.publish({
      assetType: "node",
      assetId: constantNode.metadata.id,
      version: constantNode.metadata.version,
      digest: contentDigest(constantNode),
      content: constantNode,
      actor: "test"
    });
    const service = new LocalCoreService(persistence);
    expect(
      service.handle({
        id: "invalid",
        method: "run.node.preview",
        params: {
          nodeId: constantNode.metadata.id,
          nodeVersion: constantNode.metadata.version,
          input: {}
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("input is invalid") }
    });
    expect(
      service.handle({
        id: "stale",
        method: "run.node.create",
        params: {
          nodeId: constantNode.metadata.id,
          nodeVersion: constantNode.metadata.version,
          input: { value: "standalone" },
          expectedPreviewDigest: "sha256:stale",
          actor: "test"
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("preview is stale") }
    });
    persistence.close();
  });

  it("requires confirmation for R1 and refuses R2+ standalone Nodes", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const r1Node: NodeDefinition = {
      ...constantNode,
      metadata: {
        ...constantNode.metadata,
        id: "data.constant-r1",
        title: "Confirmed constant"
      },
      risk: {
        level: "R1",
        permissions: ["dataset.read"]
      }
    };
    const r2Node: NodeDefinition = {
      ...constantNode,
      metadata: {
        ...constantNode.metadata,
        id: "data.constant-r2",
        title: "Approved constant"
      },
      risk: {
        level: "R2",
        permissions: ["business.binding.persist"]
      }
    };
    for (const definition of [r1Node, r2Node]) {
      persistence.publish({
        assetType: "node",
        assetId: definition.metadata.id,
        version: definition.metadata.version,
        digest: contentDigest(definition),
        content: definition,
        actor: "test"
      });
    }
    const service = new LocalCoreService(persistence);
    const preview = service.handle({
      id: "r1-preview",
      method: "run.node.preview",
      params: {
        nodeId: r1Node.metadata.id,
        nodeVersion: r1Node.metadata.version,
        input: { value: "confirmed" }
      }
    });
    expect(preview).toMatchObject({
      ok: true,
      result: {
        riskLevel: "R1",
        permissions: ["dataset.read"],
        requiresConfirmation: true
      }
    });
    const expectedPreviewDigest = (
      preview.result as { previewDigest: string }
    ).previewDigest;
    expect(
      service.handle({
        id: "r1-unconfirmed",
        method: "run.node.create",
        params: {
          nodeId: r1Node.metadata.id,
          nodeVersion: r1Node.metadata.version,
          input: { value: "confirmed" },
          expectedPreviewDigest,
          actor: "test"
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("explicit human confirmation") }
    });
    expect(
      service.handle({
        id: "r1-confirmed",
        method: "run.node.create",
        params: {
          nodeId: r1Node.metadata.id,
          nodeVersion: r1Node.metadata.version,
          input: { value: "confirmed" },
          expectedPreviewDigest,
          confirmed: true,
          actor: "test"
        }
      })
    ).toMatchObject({ ok: true, result: { status: "running" } });
    expect(
      service.handle({
        id: "r2-preview",
        method: "run.node.preview",
        params: {
          nodeId: r2Node.metadata.id,
          nodeVersion: r2Node.metadata.version,
          input: { value: "blocked" }
        }
      })
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("limited to R0/R1") }
    });
    persistence.close();
  });
});
