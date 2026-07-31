import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compileDataValidator,
  formatValidationErrors,
  validateJsonSchemaDefinition,
  validateNode,
  validateNodeV1Alpha2,
  validateWorkflow,
  validateWorkflowV1Alpha2,
  validateWorkflowV1Alpha3,
  type NodeDefinition,
  type NodeDefinitionV1Alpha2,
  type WorkflowDefinition,
  type WorkflowDefinitionV1Alpha2,
  type WorkflowDefinitionV1Alpha3
} from "@bpa/schemas";
import {
  compileCanonicalWorkflow,
  compileWorkflow,
  contentDigest,
  MemoryNodeCatalog,
  type CatalogResolver
} from "./index.js";

const root = new URL("../../../", import.meta.url);

function loadYaml<T>(path: string): T {
  return parse(readFileSync(new URL(path, root), "utf8")) as T;
}

describe("published default asset sources", () => {
  it("validates every core Node and compiles every example Workflow", () => {
    const filenames = readdirSync(new URL("nodes/core/", root))
      .filter((name) => name.endsWith(".node.yaml"))
      .sort();
    const nodes = filenames.map((filename) =>
      loadYaml<NodeDefinition | NodeDefinitionV1Alpha2>(
        `nodes/core/${filename}`
      )
    );
    expect(nodes.length).toBeGreaterThanOrEqual(11);
    for (const node of nodes) {
      const validator =
        node.apiVersion === "bpa/v1alpha2"
          ? validateNodeV1Alpha2
          : validateNode;
      expect(
        validator(node),
        `${node.metadata.id}: ${formatValidationErrors(validator.errors).join(
          "; "
        )}`
      ).toBe(true);
      for (const schema of [node.inputSchema, node.outputSchema]) {
        expect(validateJsonSchemaDefinition(schema)).toEqual({ valid: true });
        expect(() => compileDataValidator(schema)).not.toThrow();
      }
    }
    const legacyNodes = nodes.filter(
      (node): node is NodeDefinition =>
        node.apiVersion === "bpa/v1alpha1"
    );
    const nodeMap = new Map(
      nodes.map((node) => [
        `${node.metadata.id}@${node.metadata.version}`,
        node
      ])
    );
    const adapters = new Map(
      readdirSync(new URL("adapters/doudian/", root))
        .filter((name) => name.endsWith(".adapter.yaml"))
        .map((filename) => {
          const adapter = loadYaml<{
            metadata: { id: string; version: string };
          }>(`adapters/doudian/${filename}`);
          return [
            `${adapter.metadata.id}@${adapter.metadata.version}`,
            {
              kind: "adapter" as const,
              id: adapter.metadata.id,
              version: adapter.metadata.version,
              digest: contentDigest(adapter)
            }
          ];
        })
    );
    const assistanceProfiles = new Map(
      readdirSync(new URL("assistance-profiles/core/", root))
        .filter(
          (name) => name.endsWith(".yaml") || name.endsWith(".json")
        )
        .map((filename) => {
          const profile = loadYaml<{
            metadata: { id: string; version: string };
            taskKind: "ai_review" | "human_confirm" | "human_action";
          }>(`assistance-profiles/core/${filename}`);
          return [
            `${profile.metadata.id}@${profile.metadata.version}`,
            {
              artifact: {
                kind: "assistance_profile" as const,
                id: profile.metadata.id,
                version: profile.metadata.version,
                digest: contentDigest(profile)
              },
              taskKind: profile.taskKind
            }
          ];
        })
    );
    const catalog: CatalogResolver = {
      getNode: (id, version) => nodeMap.get(`${id}@${version}`),
      getNodeExecution: (id, version) => {
        const node = nodeMap.get(`${id}@${version}`);
        if (!node) return undefined;
        const adapterRefs = node.adapter
          ? node.adapter.versions.map((adapterVersion) => {
              const adapter = adapters.get(
                `${node.adapter!.id}@${adapterVersion}`
              );
              if (!adapter) {
                throw new Error(
                  `Missing Adapter ${node.adapter!.id}@${adapterVersion}`
                );
              }
              return adapter;
            })
          : [];
        return {
          providerId: node.runtime,
          adapters: adapterRefs,
          policies: [],
          datasetProfiles: []
        };
      },
      getAssistanceProfile: (id, version) =>
        assistanceProfiles.get(`${id}@${version}`)
    };
    const workflowFilenames = readdirSync(
      new URL("workflows/examples/", root)
    )
      .filter((name) => name.endsWith(".workflow.yaml"))
      .sort();
    expect(workflowFilenames.length).toBeGreaterThanOrEqual(2);
    for (const filename of workflowFilenames) {
      const candidate = loadYaml<unknown>(
        `workflows/examples/${filename}`
      );
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha2"
      ) {
        expect(
          validateWorkflowV1Alpha2(candidate),
          `${filename}: ${formatValidationErrors(
            validateWorkflowV1Alpha2.errors
          ).join("; ")}`
        ).toBe(true);
        expect(() =>
          compileCanonicalWorkflow(
            candidate as WorkflowDefinitionV1Alpha2,
            catalog
          )
        ).not.toThrow();
        continue;
      }
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha3"
      ) {
        expect(
          validateWorkflowV1Alpha3(candidate),
          `${filename}: ${formatValidationErrors(
            validateWorkflowV1Alpha3.errors
          ).join("; ")}`
        ).toBe(true);
        expect(() =>
          compileCanonicalWorkflow(
            candidate as WorkflowDefinitionV1Alpha3,
            catalog
          )
        ).not.toThrow();
        continue;
      }
      const workflow = candidate as WorkflowDefinition;
      expect(
        validateWorkflow(workflow),
        `${filename}: ${formatValidationErrors(validateWorkflow.errors).join(
          "; "
        )}`
      ).toBe(true);
      const compiled = compileWorkflow(
        workflow,
        new MemoryNodeCatalog(legacyNodes)
      );
      expect(compiled.workflowVersion).toBe(workflow.metadata.version);
    }

    const allianceMonitor = loadYaml<WorkflowDefinitionV1Alpha3>(
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    );
    const alliancePlan = compileCanonicalWorkflow(allianceMonitor, catalog);
    const scanShops = alliancePlan.steps.scan_shops;
    expect(scanShops?.kind).toBe("foreach");
    if (scanShops?.kind !== "foreach") throw new Error("fixture changed");
    expect(scanShops.onItemError).toBe("stop");
    const scanShop = scanShops.body.steps.scan_shop;
    expect(scanShop?.kind).toBe("call");
    if (scanShop?.kind !== "call") throw new Error("fixture changed");
    expect(scanShops.body.steps[scanShop.routes.rejected]).toMatchObject({
      kind: "terminal",
      status: "failed"
    });

    const doudianWorkflow = loadYaml<WorkflowDefinitionV1Alpha3>(
      "workflows/examples/doudian.shop-context-observe.workflow.yaml"
    );
    const doudianCompiled = compileCanonicalWorkflow(
      doudianWorkflow,
      catalog
    );
    expect(doudianCompiled.workflow.version).toBe("2.0.0");
    expect(doudianCompiled.steps.observe_shop).toMatchObject({
      kind: "call",
      node: { id: "doudian.shop.context.read", version: "1.3.0" },
      resourceMappings: { browser: { slotName: "doudian_page" } }
    });
  });
});
