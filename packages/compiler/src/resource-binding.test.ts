import { describe, expect, it } from "vitest";
import type {
  NodeDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha2,
  WorkflowDefinitionV1Alpha3
} from "@bpa/schemas";
import { createExecutionPlan, type ExecutionPlan } from "@bpa/workflow-ir";
import {
  compileWorkflowV1Alpha2,
  compileWorkflowV1Alpha3,
  contentDigest,
  type CatalogResolver
} from "./index.js";

const node = (): NodeDefinitionV1Alpha2 => ({
  apiVersion: "bpa/v1alpha2",
  kind: "Node",
  metadata: {
    id: "chanmama.product.metrics.read",
    version: "1.0.0",
    title: "Read metrics"
  },
  runtime: "browser",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  risk: {
    level: "R1",
    permissions: ["browser.dom.read"],
    domains: [
      "https://fxg.jinritemai.com",
      "https://www.chanmama.com"
    ]
  },
  execution: {
    timeoutDefault: "30s",
    idempotency: "repeatable_read"
  },
  errors: [],
  resources: {
    page_session: {
      kind: "browser",
      capabilities: ["browser.dom.read", "browser.navigation.read"],
      allowedOrigins: [
        "https://fxg.jinritemai.com",
        "https://www.chanmama.com"
      ],
      authentication: "authenticated",
      purpose: "Read authenticated product metrics"
    }
  }
});

const workflow = (): WorkflowDefinitionV1Alpha3 => ({
  apiVersion: "bpa/v1alpha3",
  kind: "Workflow",
  metadata: {
    id: "research.metrics",
    version: "1.0.0",
    title: "Research metrics"
  },
  spec: {
    riskLevel: "R1",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    limits: { maxDepth: 1, maxStepExecutions: 10 },
    resourceSlots: {
      metrics_source: {
        kind: "browser",
        capabilities: [
          "browser.dom.read",
          "browser.evidence.write",
          "browser.navigation.read"
        ],
        allowedOrigins: ["https://www.chanmama.com"],
        authentication: "membership",
        purpose: "Authenticated research source"
      }
    },
    root: {
      kind: "sequence",
      steps: [
        {
          key: "metrics",
          kind: "call",
          use: "chanmama.product.metrics.read@1.0.0",
          resourceMappings: { page_session: "metrics_source" }
        },
        { key: "done", kind: "terminal", status: "succeeded" }
      ]
    }
  }
});

function catalog(): CatalogResolver {
  const published = node();
  return {
    getNode: (id, version) =>
      id === published.metadata.id && version === published.metadata.version
        ? published
        : undefined,
    getNodeExecution: () => ({
      providerId: "browser",
      adapters: [],
      policies: [],
      datasetProfiles: []
    })
  };
}

describe("v1alpha3 Resource Binding compiler", () => {
  it("freezes requirements, slots and deterministic mappings into IR2", () => {
    const source = workflow();
    const plan = compileWorkflowV1Alpha3(source, catalog());
    expect(plan.resourceSlots).toEqual(source.spec.resourceSlots);
    const call = plan.steps.metrics;
    expect(call).toMatchObject({
      kind: "call",
      resourceRequirements: {
        page_session: node().resources!.page_session
      },
      resourceMappings: {
        page_session: {
          requirementName: "page_session",
          slotName: "metrics_source",
          requirement: node().resources!.page_session,
          requirementDigest: contentDigest(node().resources!.page_session)
        }
      }
    });
    expect(compileWorkflowV1Alpha3(source, catalog())).toEqual(plan);
  });

  it("requires an exact mapping for every Node requirement", () => {
    const source = workflow();
    const call = source.spec.root.steps[0]!;
    if (call.kind !== "call") throw new Error("fixture changed");
    delete call.resourceMappings;
    expect(() => compileWorkflowV1Alpha3(source, catalog())).toThrow(
      /resourceMappings\/page_session is required/
    );
  });

  it("rejects missing slots, capability gaps, origin expansion and auth downgrade", () => {
    const missing = workflow();
    const missingCall = missing.spec.root.steps[0]!;
    if (missingCall.kind !== "call") throw new Error("fixture changed");
    missingCall.resourceMappings = { page_session: "unknown_slot" };
    expect(() => compileWorkflowV1Alpha3(missing, catalog())).toThrow(
      /missing Workflow resource slot/
    );

    const capability = workflow();
    capability.spec.resourceSlots!.metrics_source!.capabilities = [
      "browser.dom.read"
    ];
    expect(() => compileWorkflowV1Alpha3(capability, catalog())).toThrow(
      /does not include capabilities/
    );

    const origin = workflow();
    origin.spec.resourceSlots!.metrics_source!.allowedOrigins = [
      "https://example.com"
    ];
    expect(() => compileWorkflowV1Alpha3(origin, catalog())).toThrow(
      /expands Node allowed origins/
    );

    const authentication = workflow();
    authentication.spec.resourceSlots!.metrics_source!.authentication =
      "optional";
    expect(() => compileWorkflowV1Alpha3(authentication, catalog())).toThrow(
      /downgrades authentication/
    );
  });

  it("keeps v1alpha2 plans free of Resource Binding fields", () => {
    const legacy: WorkflowDefinitionV1Alpha2 = {
      ...workflow(),
      apiVersion: "bpa/v1alpha2",
      spec: {
        riskLevel: "R0",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        limits: { maxDepth: 1, maxStepExecutions: 2 },
        root: {
          kind: "sequence",
          steps: [
            { key: "done", kind: "terminal", status: "succeeded" }
          ]
        }
      }
    };
    const plan = compileWorkflowV1Alpha2(legacy, catalog());
    expect("resourceSlots" in plan).toBe(false);
    expect(JSON.stringify(plan)).not.toContain("resourceMappings");
    expect(JSON.stringify(plan)).not.toContain("resourceRequirements");
  });

  it("rejects a changed requirement after its digest was frozen", () => {
    const plan = structuredClone(
      compileWorkflowV1Alpha3(workflow(), catalog())
    ) as ExecutionPlan;
    const call = plan.steps.metrics;
    if (call?.kind !== "call" || !call.resourceMappings) {
      throw new Error("fixture changed");
    }
    (
      call.resourceMappings.page_session!
        .requirement as { purpose: string }
    ).purpose = "Changed after compilation";
    expect(() => createExecutionPlan(plan)).toThrow(
      /requirementDigest does not match/
    );
  });

  it("requires every Browser Node v1alpha2 to declare resources", () => {
    const source = workflow();
    const invalidNode = node();
    delete invalidNode.resources;
    expect(() =>
      compileWorkflowV1Alpha3(source, {
        ...catalog(),
        getNode: () => invalidNode
      })
    ).toThrow(/required property 'resources'/);
  });

  it("does not let a Node resource expand its published risk domains", () => {
    const invalidNode = node();
    invalidNode.risk.domains = ["https://www.chanmama.com"];
    expect(() =>
      compileWorkflowV1Alpha3(workflow(), {
        ...catalog(),
        getNode: () => invalidNode
      })
    ).toThrow(/expands published risk domains/);
  });
});
