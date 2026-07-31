import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type {
  NodeDefinition,
  NodeDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha3
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

const resourceNode: NodeDefinitionV1Alpha2 = {
  apiVersion: "bpa/v1alpha2",
  kind: "Node",
  metadata: {
    id: "browser.resource.read",
    version: "1.0.0",
    title: "Resource read"
  },
  runtime: "browser",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  risk: {
    level: "R1",
    permissions: ["browser.dom.read"],
    domains: ["https://example.com"]
  },
  execution: {
    timeoutDefault: "10s",
    idempotency: "repeatable_read"
  },
  errors: [],
  resources: {
    page_session: {
      kind: "browser",
      capabilities: ["browser.dom.read"],
      allowedOrigins: ["https://example.com"],
      authentication: "authenticated",
      purpose: "Read the bound authenticated page"
    }
  }
};

const resourceWorkflow: WorkflowDefinitionV1Alpha3 = {
  apiVersion: "bpa/v1alpha3",
  kind: "Workflow",
  metadata: {
    id: "test.resource-control",
    version: "1.0.0",
    title: "Resource control"
  },
  spec: {
    riskLevel: "R1",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    resourceSlots: {
      source: {
        kind: "browser",
        capabilities: ["browser.dom.read"],
        allowedOrigins: ["https://example.com"],
        authentication: "authenticated",
        purpose: "Bound source page"
      }
    },
    root: {
      kind: "sequence",
      steps: [
        {
          kind: "call",
          key: "read",
          use: "browser.resource.read@1.0.0",
          resourceMappings: { page_session: "source" }
        },
        {
          kind: "terminal",
          key: "done",
          status: "succeeded",
          output: "${steps.read.output}"
        }
      ]
    }
  }
};

describe("Local Core IR2 control integration", () => {
  it("publishes Node v1alpha2 and validates Workflow v1alpha3 assets", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);

    expect(
      service.handle({
        id: "publish-resource-node",
        method: "asset.publish",
        params: {
          assetType: "node",
          content: resourceNode,
          actor: "test"
        }
      })
    ).toMatchObject({ ok: true });
    expect(
      service.handle({
        id: "validate-resource-workflow",
        method: "asset.validate",
        params: { assetType: "workflow", content: resourceWorkflow }
      })
    ).toMatchObject({
      ok: true,
      result: {
        valid: true,
        identity: "test.resource-control@1.0.0",
        compiled: {
          irVersion: "bpa.workflow-ir/2",
          resourceSlots: resourceWorkflow.spec.resourceSlots
        }
      }
    });
    expect(
      service.handle({
        id: "publish-resource-workflow",
        method: "asset.publish",
        params: {
          assetType: "workflow",
          content: resourceWorkflow,
          actor: "test"
        }
      })
    ).toMatchObject({ ok: true });
    expect(
      service.handle({
        id: "create-resource-run-without-binding",
        method: "run.create",
        params: {
          workflowId: resourceWorkflow.metadata.id,
          workflowVersion: resourceWorkflow.metadata.version,
          input: {},
          resourceBindings: {},
          actor: "operator"
        }
      })
    ).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "must cover the exact Workflow resource slots"
        )
      }
    });
    persistence.openBrowserSession({
      session: {
        id: "session-resource",
        browserInstanceId: "browser-test",
        extensionId: "extension-test",
        extensionVersion: "0.4.0",
        protocolVersion: "1.0.0",
        incomingSeq: 0,
        outgoingSeq: 0,
        lastAckedCommandSeq: 0,
        capabilityDigest: `sha256:${"a".repeat(64)}`,
        resumeTokenDigest: `sha256:${"b".repeat(64)}`,
        resumeTokenExpiresAt: "2026-07-30T12:00:00.000Z",
        connectedAt: "2026-07-30T11:00:00.000Z"
      },
      now: "2026-07-30T11:00:00.000Z"
    });
    persistence.replaceBrowserCapabilities("session-resource", [
      {
        nodeId: resourceNode.metadata.id,
        nodeVersion: resourceNode.metadata.version,
        riskLevel: resourceNode.risk.level,
        permissions: [...resourceNode.risk.permissions]
      }
    ]);
    persistence.upsertBrowserPageObservation({
      sessionId: "session-resource",
      browserInstanceId: "browser-test",
      tabId: 42,
      origin: "https://example.com",
      pathname: "/source",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-resource",
      observationState: "ready",
      pageEpoch: "tab-42:1:test",
      observerCapabilityId: "test.page",
      revision: 1,
      observedAt: new Date().toISOString(),
    });
    const created = service.handle({
      id: "create-resource-run",
      method: "run.create",
      params: {
        workflowId: resourceWorkflow.metadata.id,
        workflowVersion: resourceWorkflow.metadata.version,
        input: {},
        resourceBindings: {
          source: {
            sessionId: "session-resource",
            browserInstanceId: "browser-test",
            tabId: 42,
            observationRevision: 1
          }
        },
        actor: "operator"
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: {
        workflowId: resourceWorkflow.metadata.id,
        status: "waiting_browser"
      }
    });
    const runId = (created.result as { id: string }).id;
    expect(persistence.getRunResourceBindingSnapshot(runId)).toMatchObject({
      snapshotVersion: "bpa.resource-binding/1",
      runId,
      resourceSlots: resourceWorkflow.spec.resourceSlots,
      bindings: {
        source: {
          sessionId: "session-resource",
          browserInstanceId: "browser-test",
          tabId: 42,
          origin: "https://example.com",
          pathname: "/source",
          pageEpoch: "tab-42:1:test",
          authentication: "authenticated",
          approvedBy: "operator"
        }
      }
    });
    expect(
      persistence.getBrowserPageObservation("session-resource", 42)
    ).toMatchObject({
      revision: 1,
      observationState: "ready",
      origin: "https://example.com",
      authentication: "authenticated"
    });
    persistence.close();
  });

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

  it("runs one resource-bearing Node only with an exact Browser Session binding", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    persistence.publish({
      assetType: "node",
      assetId: resourceNode.metadata.id,
      version: resourceNode.metadata.version,
      digest: contentDigest(resourceNode),
      content: resourceNode,
      actor: "test"
    });
    persistence.openBrowserSession({
      session: {
        id: "session-resource-node",
        browserInstanceId: "browser-test",
        extensionId: "extension-test",
        extensionVersion: "0.5.0",
        protocolVersion: "1.0.0",
        incomingSeq: 0,
        outgoingSeq: 0,
        lastAckedCommandSeq: 0,
        capabilityDigest: `sha256:${"a".repeat(64)}`,
        resumeTokenDigest: `sha256:${"b".repeat(64)}`,
        resumeTokenExpiresAt: "2099-07-30T12:00:00.000Z",
        connectedAt: "2026-07-30T11:00:00.000Z"
      },
      now: "2026-07-30T11:00:00.000Z"
    });
    persistence.replaceBrowserCapabilities("session-resource-node", [
      {
        nodeId: resourceNode.metadata.id,
        nodeVersion: resourceNode.metadata.version,
        riskLevel: resourceNode.risk.level,
        permissions: [...resourceNode.risk.permissions]
      }
    ]);
    persistence.upsertBrowserPageObservation({
      sessionId: "session-resource-node",
      browserInstanceId: "browser-test",
      tabId: 84,
      origin: "https://example.com",
      pathname: "/source",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-resource-node",
      observationState: "ready",
      pageEpoch: "tab-84:1:test",
      observerCapabilityId: "test.page",
      revision: 1,
      observedAt: new Date().toISOString(),
    });
    const service = new LocalCoreService(persistence);
    const preview = service.handle({
      id: "resource-node-preview",
      method: "run.node.preview",
      params: {
        nodeId: resourceNode.metadata.id,
        nodeVersion: resourceNode.metadata.version,
        input: {}
      }
    });
    expect(preview).toMatchObject({
      ok: true,
      result: {
        requiresConfirmation: true,
        resourceSlots: {
          page_session: resourceNode.resources!.page_session
        }
      }
    });
    const previewDigest = (preview.result as { previewDigest: string })
      .previewDigest;
    expect(
      service.handle({
        id: "resource-node-missing-binding",
        method: "run.node.create",
        params: {
          nodeId: resourceNode.metadata.id,
          nodeVersion: resourceNode.metadata.version,
          input: {},
          expectedPreviewDigest: previewDigest,
          confirmed: true,
          actor: "operator",
          resourceBindings: {}
        }
      })
    ).toMatchObject({ ok: false });
    const created = service.handle({
      id: "resource-node-run",
      method: "run.node.create",
      params: {
        nodeId: resourceNode.metadata.id,
        nodeVersion: resourceNode.metadata.version,
        input: {},
        expectedPreviewDigest: previewDigest,
        confirmed: true,
        actor: "operator",
        resourceBindings: {
          page_session: {
            sessionId: "session-resource-node",
            browserInstanceId: "browser-test",
            tabId: 84,
            observationRevision: 1
          }
        }
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: { status: "waiting_browser" }
    });
    const runId = (created.result as { id: string }).id;
    expect(
      persistence.getRunResourceBindingSnapshot(runId)
    ).toMatchObject({
      resourceSlots: {
        page_session: resourceNode.resources!.page_session
      },
      bindings: {
        page_session: {
          sessionId: "session-resource-node",
          origin: "https://example.com",
          approvedBy: "operator"
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
