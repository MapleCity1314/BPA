import { createHash } from "node:crypto";
import {
  formatValidationErrors,
  validateWorkflow,
  type NodeDefinition,
  type WorkflowDefinition
} from "@bpa/schemas";
import {
  mergeTimingPolicy,
  timingOverrideIssues,
  timingPolicyIssues,
  type EffectiveTimingPolicy
} from "@bpa/node-runtime";
import { parse } from "yaml";

export interface CatalogLookup {
  getNode(id: string, version: string): NodeDefinition | undefined;
}

export interface CompiledNode {
  key: string;
  nodeId: string;
  nodeVersion: string;
  definitionDigest: string;
  runtime: NodeDefinition["runtime"];
  input: unknown;
  condition?: string;
  next?: string;
  on: NonNullable<WorkflowDefinition["spec"]["nodes"][string]["on"]>;
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    backoffMs: number;
    retryableErrors: string[];
  };
  timing?: EffectiveTimingPolicy;
}

export interface CompiledWorkflow {
  format: "bpa.workflow-ir/1";
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  riskLevel: WorkflowDefinition["spec"]["riskLevel"];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  start: string;
  nodes: Record<string, CompiledNode>;
}

export class WorkflowCompileError extends Error {
  constructor(readonly issues: string[]) {
    super(`Workflow compilation failed:\n${issues.join("\n")}`);
  }
}

export function parseWorkflowYaml(source: string): unknown {
  return parse(source, {
    customTags: [],
    maxAliasCount: 0,
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function contentDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function parseDuration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000);
}

function splitNodeRef(reference: string): [string, string] {
  const separator = reference.lastIndexOf("@");
  return [reference.slice(0, separator), reference.slice(separator + 1)];
}

export function compileWorkflow(
  candidate: unknown,
  catalog: CatalogLookup
): CompiledWorkflow {
  if (!validateWorkflow(candidate)) {
    throw new WorkflowCompileError(
      formatValidationErrors(validateWorkflow.errors)
    );
  }

  const workflow = candidate;
  const issues: string[] = [];
  if (!workflow.spec.nodes[workflow.spec.start]) {
    issues.push(`/spec/start references missing node ${workflow.spec.start}`);
  }

  const compiledNodes: Record<string, CompiledNode> = {};
  const edges = new Map<string, Set<string>>();
  for (const [key, node] of Object.entries(workflow.spec.nodes)) {
    const [nodeId, nodeVersion] = splitNodeRef(node.use);
    const definition = catalog.getNode(nodeId, nodeVersion);
    if (!definition) {
      issues.push(`/spec/nodes/${key}/use is not published: ${node.use}`);
      continue;
    }
    if (node.condition && definition.metadata.id !== "control.condition") {
      issues.push(
        `/spec/nodes/${key}/condition is only valid for control.condition`
      );
    }
    if (
      node.condition &&
      !/^(?:input|previous)(?:\.[A-Za-z_][A-Za-z0-9_]*)*\s*(?:==|!=)\s*(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|"(?:[^"\\]|\\.)*")$/.test(
        node.condition
      )
    ) {
      issues.push(
        `/spec/nodes/${key}/condition uses unsupported expression syntax`
      );
    }
    if (
      node.condition &&
      (!(node.next ?? node.on?.success) || !node.on?.failure)
    ) {
      issues.push(
        `/spec/nodes/${key}/condition requires a true target (next or on.success) and on.failure`
      );
    }
    const targets = [node.next, ...Object.values(node.on ?? {})].filter(
      (target): target is string => Boolean(target)
    );
    edges.set(key, new Set(targets));
    for (const target of targets) {
      if (!workflow.spec.nodes[target]) {
        issues.push(`/spec/nodes/${key} references missing node ${target}`);
      }
    }
    const baseTiming = mergeTimingPolicy(
      definition.execution.timingPolicy,
      undefined
    );
    const timing = mergeTimingPolicy(
      definition.execution.timingPolicy,
      node.timing
    );
    const timeoutMs = parseDuration(
      node.timeout,
      parseDuration(definition.execution.timeoutDefault, 30_000)
    );
    issues.push(
      ...timingPolicyIssues(
        timing,
        `/spec/nodes/${key}/timing`
      ),
      ...timingOverrideIssues(
        baseTiming,
        timing,
        `/spec/nodes/${key}/timing`
      )
    );
    const maximumBrowserWaitMs =
      (timing?.readiness?.timeoutMs ?? 0) +
      (timing?.rateLimit?.maxQueueMs ?? 0);
    if (maximumBrowserWaitMs > timeoutMs) {
      issues.push(
        `/spec/nodes/${key}/timing worst-case readiness and rate-limit wait (${maximumBrowserWaitMs}ms) exceeds node timeout (${timeoutMs}ms)`
      );
    }
    compiledNodes[key] = {
      key,
      nodeId,
      nodeVersion,
      definitionDigest: contentDigest(definition),
      runtime: definition.runtime,
      input: node.with ?? {},
      ...(node.condition ? { condition: node.condition } : {}),
      ...(node.next ? { next: node.next } : {}),
      on: node.on ?? {},
      timeoutMs,
      retry: {
        maxAttempts: node.retry?.maxAttempts ?? 1,
        backoffMs: parseDuration(node.retry?.backoff, 0),
        retryableErrors:
          node.retry?.retryableErrors ??
          definition.execution.retryableErrors ??
          []
      },
      ...(timing ? { timing } : {})
    };
  }

  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const target of edges.get(key) ?? []) visit(target);
  };
  if (workflow.spec.nodes[workflow.spec.start]) visit(workflow.spec.start);
  for (const key of Object.keys(workflow.spec.nodes)) {
    if (!reachable.has(key)) issues.push(`/spec/nodes/${key} is unreachable`);
  }

  if (issues.length > 0) throw new WorkflowCompileError(issues);
  return {
    format: "bpa.workflow-ir/1",
    workflowId: workflow.metadata.id,
    workflowVersion: workflow.metadata.version,
    workflowDigest: contentDigest(workflow),
    riskLevel: workflow.spec.riskLevel,
    inputSchema: workflow.spec.inputSchema,
    outputSchema: workflow.spec.outputSchema,
    start: workflow.spec.start,
    nodes: compiledNodes
  };
}

export class MemoryNodeCatalog implements CatalogLookup {
  readonly #nodes = new Map<string, NodeDefinition>();

  constructor(nodes: NodeDefinition[] = []) {
    for (const node of nodes) this.add(node);
  }

  add(node: NodeDefinition): void {
    this.#nodes.set(`${node.metadata.id}@${node.metadata.version}`, node);
  }

  getNode(id: string, version: string): NodeDefinition | undefined {
    return this.#nodes.get(`${id}@${version}`);
  }
}
