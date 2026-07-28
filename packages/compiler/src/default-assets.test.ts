import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compileDataValidator,
  formatValidationErrors,
  validateJsonSchemaDefinition,
  validateNode,
  validateWorkflow,
  validateWorkflowV1Alpha2,
  type NodeDefinition,
  type WorkflowDefinition
} from "@bpa/schemas";
import { compileWorkflow, MemoryNodeCatalog } from "./index.js";

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
      loadYaml<NodeDefinition>(`nodes/core/${filename}`)
    );
    expect(nodes.length).toBeGreaterThanOrEqual(11);
    for (const node of nodes) {
      expect(
        validateNode(node),
        `${node.metadata.id}: ${formatValidationErrors(validateNode.errors).join(
          "; "
        )}`
      ).toBe(true);
      for (const schema of [node.inputSchema, node.outputSchema]) {
        expect(validateJsonSchemaDefinition(schema)).toEqual({ valid: true });
        expect(() => compileDataValidator(schema)).not.toThrow();
      }
    }
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
        new MemoryNodeCatalog(nodes)
      );
      expect(compiled.workflowVersion).toBe(workflow.metadata.version);
    }

    const doudianWorkflow = loadYaml<WorkflowDefinition>(
      "workflows/examples/doudian.shop-context-observe.workflow.yaml"
    );
    const doudianCompiled = compileWorkflow(
      doudianWorkflow,
      new MemoryNodeCatalog(nodes)
    );
    expect(doudianCompiled.workflowVersion).toBe("1.2.0");
    expect(doudianCompiled.nodes.observe_shop?.nodeVersion).toBe("1.2.0");
    expect(doudianCompiled.nodes.finish?.input).toEqual({
      output: "${previous}"
    });
  });
});
