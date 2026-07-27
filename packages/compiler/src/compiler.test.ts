import { describe, expect, it } from "vitest";
import type { NodeDefinition, WorkflowDefinition } from "@bpa/schemas";
import {
  compileWorkflow,
  contentDigest,
  MemoryNodeCatalog,
  WorkflowCompileError
} from "./index.js";

const node = (id: string): NodeDefinition => ({
  apiVersion: "bpa/v1alpha1",
  kind: "Node",
  metadata: { id, version: "1.0.0", title: id },
  runtime: "engine_builtin",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  risk: { level: "R0", permissions: [] },
  execution: { timeoutDefault: "5s", idempotency: "pure" },
  errors: []
});

const workflow: WorkflowDefinition = {
  apiVersion: "bpa/v1alpha1",
  kind: "Workflow",
  metadata: {
    id: "test.linear",
    version: "1.0.0",
    title: "Linear"
  },
  spec: {
    riskLevel: "R0",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    start: "start",
    nodes: {
      start: { use: "control.start@1.0.0", next: "finish" },
      finish: { use: "control.succeed@1.0.0" }
    }
  }
};

describe("workflow compiler", () => {
  it("pins published node definitions and produces a stable digest", () => {
    const catalog = new MemoryNodeCatalog([
      node("control.start"),
      node("control.succeed")
    ]);
    const compiled = compileWorkflow(workflow, catalog);
    expect(compiled.start).toBe("start");
    expect(compiled.nodes.start?.next).toBe("finish");
    expect(compiled.workflowDigest).toBe(contentDigest(workflow));
    expect(compiled.nodes.start?.definitionDigest).toMatch(/^sha256:/);
  });

  it("rejects missing node versions", () => {
    expect(() =>
      compileWorkflow(workflow, new MemoryNodeCatalog())
    ).toThrow(WorkflowCompileError);
  });

  it("rejects unreachable nodes", () => {
    const candidate = structuredClone(workflow);
    candidate.spec.nodes.orphan = { use: "control.succeed@1.0.0" };
    const catalog = new MemoryNodeCatalog([
      node("control.start"),
      node("control.succeed")
    ]);
    expect(() => compileWorkflow(candidate, catalog)).toThrow(/unreachable/);
  });

  it("rejects arbitrary condition code and incomplete branches", () => {
    const candidate = structuredClone(workflow);
    candidate.spec.nodes.start = {
      use: "control.condition@1.0.0",
      condition: "globalThis.process.exit()",
      next: "finish"
    };
    const catalog = new MemoryNodeCatalog([
      node("control.condition"),
      node("control.succeed")
    ]);
    expect(() => compileWorkflow(candidate, catalog)).toThrow(
      /unsupported expression syntax/
    );
    candidate.spec.nodes.start.condition = 'input.ready == true';
    expect(() => compileWorkflow(candidate, catalog)).toThrow(
      /requires a true target/
    );
  });

  it("merges timing policy overrides without allowing weaker pacing", () => {
    const timedStart = node("control.start");
    timedStart.execution.timingPolicy = {
      dispatchJitter: {
        minMs: 500,
        maxMs: 1000,
        distribution: "uniform"
      },
      rateLimit: {
        scope: "tab",
        minIntervalMs: 500,
        maxQueueMs: 2000
      }
    };
    const candidate = structuredClone(workflow);
    candidate.spec.nodes.start!.timing = {
      dispatchJitter: {
        minMs: 100,
        maxMs: 1000,
        distribution: "uniform"
      }
    };
    expect(() =>
      compileWorkflow(
        candidate,
        new MemoryNodeCatalog([timedStart, node("control.succeed")])
      )
    ).toThrow(/cannot weaken the published node minimum/);
    candidate.spec.nodes.start!.timing!.dispatchJitter!.minMs = 700;
    expect(
      compileWorkflow(
        candidate,
        new MemoryNodeCatalog([timedStart, node("control.succeed")])
      ).nodes.start?.timing?.dispatchJitter?.minMs
    ).toBe(700);
  });

  it("rejects timing bounds that are individually valid but contradictory", () => {
    const candidate = structuredClone(workflow);
    candidate.spec.nodes.start!.timing = {
      readiness: {
        timeoutMs: 500,
        stableForMs: 1000,
        pollIntervalMs: 100
      }
    };
    expect(() =>
      compileWorkflow(
        candidate,
        new MemoryNodeCatalog([
          node("control.start"),
          node("control.succeed")
        ])
      )
    ).toThrow(/stableForMs cannot exceed timeoutMs/);
  });
});
