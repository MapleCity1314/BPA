import { canonicalJson } from "@bpa/compiler";
import type { ArtifactRecord } from "@bpa/persistence";
import type {
  NodeDefinition,
  RiskLevel,
  WorkflowDefinition
} from "@bpa/schemas";

const RISK_RANK: Record<RiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4
};
const RISK_LEVELS = ["R0", "R1", "R2", "R3", "R4"] as const;
const DEFAULT_NODE_REFS = {
  start: "control.start@1.1.0",
  succeed: "control.succeed@1.1.0",
  fail: "control.fail@1.0.0"
} as const;

function splitNodeRef(reference: string): [string, string] | undefined {
  const match =
    /^([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)$/.exec(
      reference
    );
  return match ? [match[1]!, match[2]!] : undefined;
}

function publishedNodeMap(
  artifacts: ArtifactRecord[]
): Map<string, NodeDefinition> {
  return new Map(
    artifacts
      .filter((artifact) => artifact.assetType === "node")
      .map((artifact) => [
        `${artifact.assetId}@${artifact.version}`,
        artifact.content as NodeDefinition
      ])
  );
}

function maxRisk(levels: RiskLevel[]): RiskLevel {
  return levels.reduce(
    (highest, level) =>
      RISK_RANK[level] > RISK_RANK[highest] ? level : highest,
    "R0"
  );
}

export interface WorkflowDraftInput {
  id: string;
  version: string;
  title: string;
  description: string;
  nodeRefs: string[];
  riskLevel?: RiskLevel;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export type WorkflowDraftResult =
  | {
      status: "ready";
      workflow: WorkflowDefinition;
      review: {
        effectiveRiskLevel: RiskLevel;
        permissions: string[];
        executionPlan: Array<{
          key: string;
          use: string;
          failurePolicy: string;
        }>;
        tests: string[];
        risks: string[];
        capabilityGaps: string[];
      };
    }
  | {
      status: "rejected";
      errors: string[];
      capabilityGaps: string[];
    };

export function generateWorkflowDraft(
  input: WorkflowDraftInput,
  publishedArtifacts: ArtifactRecord[]
): WorkflowDraftResult {
  const catalog = publishedNodeMap(publishedArtifacts);
  const errors: string[] = [];
  const capabilityGaps: string[] = [];
  const requiredRefs = [
    DEFAULT_NODE_REFS.start,
    DEFAULT_NODE_REFS.succeed,
    ...(input.nodeRefs.length > 0 ? [DEFAULT_NODE_REFS.fail] : []),
    ...input.nodeRefs
  ];
  for (const reference of requiredRefs) {
    if (!splitNodeRef(reference)) {
      errors.push(`Node reference must pin an exact SemVer: ${reference}`);
    } else if (!catalog.has(reference)) {
      capabilityGaps.push(`Published Node is missing: ${reference}`);
    }
  }
  for (const reference of input.nodeRefs) {
    const parsed = splitNodeRef(reference);
    if (
      parsed &&
      (parsed[0].startsWith("control.") || parsed[0].startsWith("data."))
    ) {
      errors.push(
        `node_refs accepts business capability Nodes only; compose ${reference} explicitly after generation`
      );
    }
  }
  if (errors.length > 0 || capabilityGaps.length > 0) {
    return { status: "rejected", errors, capabilityGaps };
  }
  const referencedDefinitions = input.nodeRefs.map(
    (reference) => catalog.get(reference)!
  );
  const effectiveRiskLevel = maxRisk(
    referencedDefinitions.map((definition) => definition.risk.level)
  );
  if (
    input.riskLevel &&
    RISK_RANK[input.riskLevel] < RISK_RANK[effectiveRiskLevel]
  ) {
    return {
      status: "rejected",
      errors: [
        `Requested workflow risk ${input.riskLevel} is lower than referenced Node risk ${effectiveRiskLevel}`
      ],
      capabilityGaps: []
    };
  }
  const riskLevel = input.riskLevel ?? effectiveRiskLevel;
  const nodes: WorkflowDefinition["spec"]["nodes"] = {
    start: {
      use: DEFAULT_NODE_REFS.start,
      next: input.nodeRefs.length > 0 ? "step_1" : "finish"
    }
  };
  input.nodeRefs.forEach((reference, index) => {
    nodes[`step_${index + 1}`] = {
      use: reference,
      next:
        index === input.nodeRefs.length - 1
          ? "finish"
          : `step_${index + 2}`,
      on: {
        failure: "fail",
        timeout: "fail",
        rejected: "fail",
        cancelled: "fail"
      }
    };
  });
  nodes.finish = {
    use: DEFAULT_NODE_REFS.succeed,
    with: { output: "${previous}" }
  };
  if (input.nodeRefs.length > 0) {
    nodes.fail = {
      use: DEFAULT_NODE_REFS.fail,
      with: {
        code: "UPSTREAM_STEP_FAILED",
        message:
          "A Workflow step failed, timed out, was rejected, or was cancelled.",
        details: "${previous}"
      }
    };
  }
  const workflow: WorkflowDefinition = {
    apiVersion: "bpa/v1alpha1",
    kind: "Workflow",
    metadata: {
      id: input.id,
      version: input.version,
      title: input.title,
      description: input.description
    },
    spec: {
      riskLevel,
      inputSchema: input.inputSchema ?? {
        type: "object",
        additionalProperties: false
      },
      outputSchema: input.outputSchema ?? {},
      start: "start",
      nodes
    }
  };
  const permissions = [
    ...new Set(
      referencedDefinitions.flatMap(
        (definition) => definition.risk.permissions
      )
    )
  ].sort();
  return {
    status: "ready",
    workflow,
    review: {
      effectiveRiskLevel: riskLevel,
      permissions,
      executionPlan: Object.entries(nodes).map(([key, node]) => ({
        key,
        use: node.use,
        failurePolicy:
          key === "fail"
            ? "terminal-failed"
            : key === "finish"
              ? "terminal-succeeded"
              : node.on?.uncertain
                ? `uncertain->${node.on.uncertain}`
                : "uncertain remains terminal and requires human verification"
      })),
      tests: [
        "validate exact published Node versions and immutable digests",
        "simulate success, failure, timeout, rejected, cancelled and uncertain outcomes",
        "validate representative workflow inputs and terminal outputs",
        "confirm permission union and workflow risk are not weaker than any Node"
      ],
      risks: [
        "Candidate is not approved or published.",
        "The generated failure node is intentionally generic and must be specialized.",
        "Uncertain outcomes are not auto-routed or retried."
      ],
      capabilityGaps: []
    }
  };
}

function minimumRiskForPermissions(permissions: string[]): RiskLevel {
  let rank = 0;
  for (const permission of permissions) {
    if (/(?:payment|refund|budget|financial)/.test(permission)) {
      rank = Math.max(rank, 4);
    } else if (
      /(?:delete|publish|price[.:_-]write|browser\.dom\.write)/.test(
        permission
      )
    ) {
      rank = Math.max(rank, 3);
    } else if (/(?:write|navigate|download|upload)/.test(permission)) {
      rank = Math.max(rank, 2);
    }
  }
  return RISK_LEVELS[rank]!;
}

export interface NodeDraftInput {
  id: string;
  version: string;
  title: string;
  description: string;
  runtime: "composite" | "browser" | "engine_team" | "human";
  riskLevel?: RiskLevel;
  permissions: string[];
  domains: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
}

export type NodeDraftResult =
  | {
      status: "ready";
      node: NodeDefinition;
      review: {
        minimumRiskLevel: RiskLevel;
        publishable: false;
        contractTests: string[];
        implementationBoundary: string;
      };
    }
  | { status: "rejected"; errors: string[] };

export function generateNodeDraft(input: NodeDraftInput): NodeDraftResult {
  const errors: string[] = [];
  if (input.id.startsWith("control.") || input.id.startsWith("data.")) {
    errors.push(
      "control.* and data.* are reserved for reviewed BPA Core builtins"
    );
  }
  if (input.runtime === "browser" && input.domains.length === 0) {
    errors.push("Browser Nodes must declare at least one exact allowed origin");
  }
  for (const domain of input.domains) {
    try {
      const url = new URL(domain);
      if (url.origin !== domain || url.pathname !== "/") {
        errors.push(`Browser domain must be an exact origin: ${domain}`);
      }
    } catch {
      errors.push(`Browser domain is not a valid URL origin: ${domain}`);
    }
  }
  if (input.runtime !== "browser" && input.domains.length > 0) {
    errors.push("Only Browser Nodes may declare browser domains");
  }
  if (
    ["composite", "human"].includes(input.runtime) &&
    input.permissions.length > 0
  ) {
    errors.push(`${input.runtime} Nodes cannot declare executable permissions`);
  }
  const minimumRiskLevel = minimumRiskForPermissions(input.permissions);
  if (
    input.riskLevel &&
    RISK_RANK[input.riskLevel] < RISK_RANK[minimumRiskLevel]
  ) {
    errors.push(
      `Requested risk ${input.riskLevel} is lower than permission-derived minimum ${minimumRiskLevel}`
    );
  }
  if (errors.length > 0) return { status: "rejected", errors };
  const riskLevel = input.riskLevel ?? minimumRiskLevel;
  const node: NodeDefinition = {
    apiVersion: "bpa/v1alpha1",
    kind: "Node",
    metadata: {
      id: input.id,
      version: input.version,
      title: input.title,
      description: input.description
    },
    runtime: input.runtime,
    inputSchema: input.inputSchema ?? {
      type: "object",
      additionalProperties: false
    },
    outputSchema: input.outputSchema ?? {},
    ...(input.configSchema ? { configSchema: input.configSchema } : {}),
    risk: {
      level: riskLevel,
      permissions: [...new Set(input.permissions)].sort(),
      ...(input.runtime === "browser"
        ? { domains: [...new Set(input.domains)].sort() }
        : {})
    },
    execution: {
      timeoutDefault: input.runtime === "human" ? "30m" : "30s",
      idempotency:
        input.runtime === "browser" ? "repeatable_read" : "pure",
      cancellable: true
    },
    errors: ["NOT_IMPLEMENTED"]
  };
  return {
    status: "ready",
    node,
    review: {
      minimumRiskLevel,
      publishable: false,
      contractTests: [
        "reject malformed input and invalid output",
        "enforce cancellation and timeout at every await boundary",
        "deny undeclared domains and permissions",
        "prove idempotency behavior under duplicate delivery",
        "cover expected page change and recovery failure paths"
      ],
      implementationBoundary:
        input.runtime === "composite"
          ? "Compose published Nodes only; do not emit executable runtime code."
          : input.runtime === "browser"
            ? "Implement inside a reviewed Adapter; never accept arbitrary JavaScript."
            : input.runtime === "engine_team"
              ? "Keep disabled until an isolated team-node worker is available."
              : "Resume only from an explicit current-user decision."
    }
  };
}

export function simulateCompiledWorkflow(compiled: {
  start: string;
  nodes: Record<
    string,
    {
      nodeId: string;
      nodeVersion: string;
      next?: string;
      on: Record<string, string>;
    }
  >;
}): {
  mode: "static-no-side-effects";
  start: string;
  nodes: Array<{
    key: string;
    node: string;
    edges: Record<string, string>;
    terminal: boolean;
  }>;
} {
  return {
    mode: "static-no-side-effects",
    start: compiled.start,
    nodes: Object.entries(compiled.nodes).map(([key, node]) => {
      const edges = {
        ...(node.next ? { success: node.next } : {}),
        ...node.on
      };
      return {
        key,
        node: `${node.nodeId}@${node.nodeVersion}`,
        edges,
        terminal: Object.keys(edges).length === 0
      };
    })
  };
}

export interface ArtifactDifference {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export function diffArtifacts(
  before: unknown,
  after: unknown,
  path = "/",
  differences: ArtifactDifference[] = []
): ArtifactDifference[] {
  if (canonicalJson(before) === canonicalJson(after)) return differences;
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    differences.push({ path, kind: "changed", before, after });
    return differences;
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const childPath = `${path === "/" ? "" : path}/${key}`;
    if (!Object.hasOwn(left, key)) {
      differences.push({ path: childPath, kind: "added", after: right[key] });
    } else if (!Object.hasOwn(right, key)) {
      differences.push({ path: childPath, kind: "removed", before: left[key] });
    } else {
      diffArtifacts(left[key], right[key], childPath, differences);
    }
    if (differences.length >= 200) break;
  }
  return differences;
}
