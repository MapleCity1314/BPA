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
});
