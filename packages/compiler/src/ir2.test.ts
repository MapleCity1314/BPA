import { describe, expect, it } from "vitest";
import type {
  NodeDefinition,
  WorkflowDefinitionV1Alpha2
} from "@bpa/schemas";
import type { ArtifactRef } from "@bpa/workflow-ir";
import {
  compileCanonicalWorkflow,
  compileWorkflowV1Alpha2,
  contentDigest,
  MemoryNodeCatalog,
  parseCanonicalDuration,
  WorkflowCompileError,
  type CatalogResolver
} from "./index.js";

const browserNode = (id: string): NodeDefinition => ({
  apiVersion: "bpa/v1alpha1",
  kind: "Node",
  metadata: { id, version: "1.0.0", title: id },
  runtime: "browser",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  risk: {
    level: "R1",
    permissions: ["browser.dom.read"],
    domains: ["https://fxg.jinritemai.com"]
  },
  execution: {
    timeoutDefault: "30s",
    idempotency: "repeatable_read",
    retryableErrors: ["PAGE_LOADING"],
    timingPolicy: {
      readiness: {
        timeoutMs: 5_000,
        stableForMs: 300,
        pollIntervalMs: 100
      }
    }
  },
  errors: ["PAGE_LOADING"],
  adapter: { id: "doudian", versions: ["1.0.0"] }
});

const adapter: ArtifactRef & { kind: "adapter" } = {
  kind: "adapter",
  id: "doudian",
  version: "1.0.0",
  digest: "a".repeat(64)
};
const policy: ArtifactRef & { kind: "policy" } = {
  kind: "policy",
  id: "readonly",
  version: "1.0.0",
  digest: "b".repeat(64)
};
const assistanceProfile: ArtifactRef & {
  kind: "assistance_profile";
} = {
  kind: "assistance_profile",
  id: "assist.packaging-match.review",
  version: "1.0.0",
  digest: "c".repeat(64)
};

const workflow = (): WorkflowDefinitionV1Alpha2 => ({
  apiVersion: "bpa/v1alpha2",
  kind: "Workflow",
  metadata: {
    id: "test.priority-check",
    version: "1.0.0",
    title: "Priority check"
  },
  spec: {
    riskLevel: "R1",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    limits: { maxDepth: 3, maxStepExecutions: 10_000 },
    root: {
      kind: "sequence",
      steps: [
        {
          key: "collect",
          kind: "call",
          use: "scope.collect@1.0.0",
          timeout: "2m",
          retry: {
            maxAttempts: 2,
            backoff: "1s",
            retryableErrors: ["PAGE_LOADING"]
          }
        },
        {
          key: "inspect_products",
          kind: "foreach",
          items: "${steps.collect.output.products}",
          itemName: "product",
          indexName: "product_index",
          itemKey: "${item.id}",
          maxItems: 500,
          maxDuration: "6h",
          onItemError: "collect",
          body: {
            kind: "sequence",
            steps: [
              {
                key: "inspect",
                kind: "call",
                use: "editor.inspect@1.0.0",
                with: { product: "${item}" }
              }
            ]
          }
        },
        {
          key: "review",
          kind: "wait.assistance",
          use: "assist.packaging-match.review@1.0.0",
          with: {
            matches: "${steps.inspect_products.output}"
          },
          blocking: true,
          deadline: "10m",
          onUnavailable: "continue_unresolved"
        },
        {
          key: "finish",
          kind: "terminal",
          status: "succeeded",
          output: { reviewed: "${steps.review.output}" }
        }
      ]
    }
  }
});

function catalog(): CatalogResolver {
  const nodes = new Map(
    [browserNode("scope.collect"), browserNode("editor.inspect")].map(
      (node) => [`${node.metadata.id}@${node.metadata.version}`, node]
    )
  );
  return {
    getNode: (id, version) => nodes.get(`${id}@${version}`),
    getNodeExecution: () => ({
      providerId: "browser",
      adapters: [adapter],
      policies: [policy],
      datasetProfiles: []
    }),
    getAssistanceProfile: (id, version) =>
      id === assistanceProfile.id && version === assistanceProfile.version
        ? { artifact: assistanceProfile, taskKind: "ai_review" }
        : undefined
  };
}

describe("IR2 compiler", () => {
  it("compiles canonical v1alpha2 into a closed deterministic IR2 plan", () => {
    const source = workflow();
    const plan = compileCanonicalWorkflow(source, catalog());
    expect(plan.irVersion).toBe("bpa.workflow-ir/2");
    expect(plan.workflow.digest).toBe(contentDigest(source));
    expect(plan.entry).toBe("collect");
    const collect = plan.steps.collect;
    expect(collect).toMatchObject({
      kind: "call",
      providerId: "browser",
      timeoutMs: 120_000,
      permissionSnapshot: {
        riskLevel: "R1",
        permissions: ["browser.dom.read"],
        domains: ["https://fxg.jinritemai.com"]
      },
      retry: {
        maxAttempts: 2,
        retryableErrorCodes: ["PAGE_LOADING"]
      }
    });
    expect(
      plan.artifactClosure.entries.map(
        (entry) => `${entry.kind}:${entry.id}`
      )
    ).toEqual(
      expect.arrayContaining([
        "adapter:doudian",
        "policy:readonly",
        "assistance_profile:assist.packaging-match.review",
        "node:scope.collect",
        "node:editor.inspect"
      ])
    );
    const foreach = plan.steps.inspect_products;
    expect(foreach?.kind).toBe("foreach");
    if (foreach?.kind !== "foreach") throw new Error("fixture changed");
    expect(foreach.limits).toMatchObject({
      maxItems: 500,
      maxDurationMs: 21_600_000
    });
    expect(foreach.body.steps.inspect).toMatchObject({
      kind: "call",
      input: {
        kind: "object",
        entries: {
          product: { kind: "reference", source: "scope_item" }
        }
      }
    });
  });

  it("is deterministic and supports hour durations", () => {
    expect(parseCanonicalDuration("6h")).toBe(21_600_000);
    expect(compileWorkflowV1Alpha2(workflow(), catalog())).toEqual(
      compileWorkflowV1Alpha2(workflow(), catalog())
    );
  });

  it("rejects selector/script authoring and unpinned adapter assets", () => {
    const unsafe = workflow();
    const collect = unsafe.spec.root.steps[0]!;
    if (collect.kind !== "call") throw new Error("fixture changed");
    collect.with = { selector: "#unsafe" };
    expect(() => compileWorkflowV1Alpha2(unsafe, catalog())).toThrow(
      WorkflowCompileError
    );

    const published = catalog();
    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        getNode: published.getNode,
        getAssistanceProfile: published.getAssistanceProfile!
      })
    ).toThrow(/did not pin/);
  });

  it("rejects duplicate nested keys and unstable index bindings", () => {
    const duplicate = workflow();
    const foreach = duplicate.spec.root.steps[1]!;
    if (foreach.kind !== "foreach") throw new Error("fixture changed");
    foreach.body.steps[0]!.key = "collect";
    expect(() =>
      compileWorkflowV1Alpha2(duplicate, catalog())
    ).toThrow(/duplicates globally unique/);

    const indexed = workflow();
    const indexedForeach = indexed.spec.root.steps[1]!;
    if (indexedForeach.kind !== "foreach") throw new Error("fixture changed");
    const inspect = indexedForeach.body.steps[0]!;
    if (inspect.kind !== "call") throw new Error("fixture changed");
    inspect.with = { unstable: "${index}" };
    expect(() =>
      compileWorkflowV1Alpha2(indexed, catalog())
    ).toThrow(/stable itemKey/);
  });

  it("adapts published v1alpha1 workflows into the same IR2", () => {
    const builtin = (id: string): NodeDefinition => {
      const { adapter: _adapter, ...base } = browserNode(id);
      return {
        ...base,
        runtime: "engine_builtin",
        risk: { level: "R0", permissions: [] }
      };
    };
    const legacy = {
      apiVersion: "bpa/v1alpha1",
      kind: "Workflow",
      metadata: {
        id: "test.legacy",
        version: "1.0.0",
        title: "Legacy"
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
    const plan = compileCanonicalWorkflow(
      legacy,
      new MemoryNodeCatalog([
        builtin("control.start"),
        builtin("control.succeed")
      ])
    );
    expect(plan).toMatchObject({
      irVersion: "bpa.workflow-ir/2",
      entry: "start",
      steps: {
        start: {
          kind: "call",
          providerId: "builtin",
          routes: { succeeded: "finish" }
        },
        finish: { kind: "terminal", status: "succeeded" }
      }
    });
  });

  it("compiles decisions and detached assistance into non-blocking IR", () => {
    const source = workflow();
    const review = source.spec.root.steps[2]!;
    if (review.kind !== "wait.assistance") throw new Error("fixture changed");
    review.blocking = false;
    source.spec.root.steps.splice(2, 0, {
      key: "choose",
      kind: "decision",
      condition: {
        kind: "compare",
        operator: "equals",
        left: { kind: "binding", binding: "${input.ready}" },
        right: { kind: "literal", value: true }
      },
      then: {
        kind: "sequence",
        steps: [
          {
            key: "then_check",
            kind: "call",
            use: "editor.inspect@1.0.0"
          }
        ]
      },
      else: {
        kind: "sequence",
        steps: [
          {
            key: "else_check",
            kind: "call",
            use: "editor.inspect@1.0.0"
          }
        ]
      }
    });
    const plan = compileWorkflowV1Alpha2(source, catalog());
    expect(plan.steps.choose).toMatchObject({
      kind: "decision",
      branches: [{ target: "then_check" }],
      defaultTarget: "else_check"
    });
    expect(plan.steps.review).toMatchObject({
      kind: "wait.assistance",
      blocking: false,
      next: "finish"
    });
  });

  it("rejects static execution budgets and detached completion handlers", () => {
    const overBudget = workflow();
    overBudget.spec.limits.maxStepExecutions = 10;
    expect(() =>
      compileWorkflowV1Alpha2(overBudget, catalog())
    ).toThrow(/upper bound/);

    const detached = workflow();
    const review = detached.spec.root.steps[2]!;
    if (review.kind !== "wait.assistance") throw new Error("fixture changed");
    review.blocking = false;
    review.handlers = {
      failure: {
        kind: "sequence",
        steps: [
          {
            key: "handle_failure",
            kind: "terminal",
            status: "failed",
            error: { code: "ASSISTANCE_FAILED", message: "failed" }
          }
        ]
      }
    };
    expect(() =>
      compileWorkflowV1Alpha2(detached, catalog())
    ).toThrow(/cannot route a detached/);
  });

  it("rejects mismatched catalog identities, risk and assistance profiles", () => {
    const published = catalog();
    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        ...published,
        getNode: () => browserNode("wrong.node")
      })
    ).toThrow(/mismatched node identity/);

    const highRisk = browserNode("scope.collect");
    highRisk.risk.level = "R2";
    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        ...published,
        getNode: (id, version) =>
          id === "scope.collect" && version === "1.0.0"
            ? highRisk
            : published.getNode(id, version)
      })
    ).toThrow(/exceeds workflow risk/);

    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        ...published,
        getNodeExecution: () => ({
          providerId: "browser",
          adapters: [
            { ...adapter, id: "wrong.adapter" }
          ],
          policies: [],
          datasetProfiles: []
        })
      })
    ).toThrow(/does not match published node dependencies/);

    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        ...published,
        getAssistanceProfile: () => undefined
      })
    ).toThrow(/not published and fixed/);
    expect(() =>
      compileWorkflowV1Alpha2(workflow(), {
        ...published,
        getAssistanceProfile: () => ({
          artifact: { ...assistanceProfile, id: "wrong.profile" },
          taskKind: "ai_review"
        })
      })
    ).toThrow(/mismatched assistance profile identity/);
  });

  it("rejects unsafe uncertain handlers and invalid duration ranges", () => {
    expect(() => parseCanonicalDuration("0s")).toThrow(/Invalid duration/);
    expect(() =>
      parseCanonicalDuration("999999999999999999999h")
    ).toThrow(/safe range/);

    const unsafeHandler = workflow();
    const collect = unsafeHandler.spec.root.steps[0]!;
    if (collect.kind !== "call") throw new Error("fixture changed");
    collect.handlers = {
      uncertain: {
        kind: "sequence",
        steps: [
          {
            key: "try_recovery",
            kind: "call",
            use: "editor.inspect@1.0.0"
          }
        ]
      }
    };
    expect(() =>
      compileWorkflowV1Alpha2(unsafeHandler, catalog())
    ).toThrow(/must be exactly one uncertain terminal/);
  });

  it("adapts legacy condition and nested binding values without code evaluation", () => {
    const builtin = (id: string): NodeDefinition => {
      const { adapter: _adapter, ...base } = browserNode(id);
      return {
        ...base,
        runtime: "engine_builtin",
        risk: { level: "R0", permissions: [] }
      };
    };
    const legacy = {
      apiVersion: "bpa/v1alpha1",
      kind: "Workflow",
      metadata: {
        id: "test.legacy-condition",
        version: "1.0.0",
        title: "Legacy condition"
      },
      spec: {
        riskLevel: "R0",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        start: "start",
        nodes: {
          start: {
            use: "control.start@1.0.0",
            next: "choose"
          },
          choose: {
            use: "control.condition@1.0.0",
            condition: "input.ready == true",
            next: "constant",
            on: { failure: "finish" }
          },
          constant: {
            use: "data.constant@1.0.0",
            with: {
              value: {
                input: "${input.value}",
                previous: "${previous.value}",
                list: ["${input.value}", 1]
              }
            },
            next: "finish"
          },
          finish: { use: "control.succeed@1.0.0" }
        }
      }
    };
    const plan = compileCanonicalWorkflow(
      legacy,
      new MemoryNodeCatalog([
        builtin("control.start"),
        builtin("control.condition"),
        builtin("data.constant"),
        builtin("control.succeed")
      ])
    );
    expect(plan.steps.choose).toMatchObject({
      kind: "decision",
      branches: [
        {
          condition: {
            kind: "compare",
            left: { source: "run_input", path: ["ready"] },
            right: { kind: "literal", value: true }
          }
        }
      ]
    });
    expect(plan.steps.constant).toMatchObject({
      kind: "call",
      input: {
        kind: "object",
        entries: {
          value: {
            kind: "object",
            entries: {
              previous: { source: "previous_output" },
              list: { kind: "array" }
            }
          }
        }
      }
    });
  });
});
