import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  validateAdapterManifest,
  validateAssetRecord,
  validateAssistanceProfile,
  validateAssistanceTask,
  validateBrowserProtocolMessage,
  validateDataset,
  validateDecisionRecord,
  validateDeterministicResultValidatorPolicy,
  validateElementContract,
  validateEvidenceLink,
  validateNodeV1Alpha2,
  validateRiskSignal,
  validateSourceRecord,
  validateTimingPolicy,
  validateWorkflowV1Alpha2,
  validateWorkflowV1Alpha3
} from "./index.js";

const examples = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/protocols/examples/browser-protocol-v1.messages.json",
      import.meta.url
    ),
    "utf8"
  )
) as Array<Record<string, any>>;

describe("timing and risk schemas", () => {
  it("accepts bounded deterministic validator policies", () => {
    const policy = JSON.parse(
      readFileSync(
        new URL(
          "../../../policies/core/packaging_match_review.validator.policy.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(validateDeterministicResultValidatorPolicy(policy)).toBe(true);
    expect(
      validateDeterministicResultValidatorPolicy({
        ...policy,
        implementation: {
          ...policy.implementation,
          provider: "dynamic-module"
        }
      })
    ).toBe(false);
  });

  it("accepts bounded policies and rejects unbounded values", () => {
    expect(
      validateTimingPolicy({
        readiness: {
          timeoutMs: 8000,
          stableForMs: 300,
          pollIntervalMs: 200
        },
        dispatchJitter: {
          minMs: 100,
          maxMs: 500,
          distribution: "uniform"
        }
      })
    ).toBe(true);
    expect(
      validateTimingPolicy({
        dispatchJitter: {
          minMs: 0,
          maxMs: 60000,
          distribution: "uniform"
        }
      })
    ).toBe(false);
  });

  it("accepts known risk signals and rejects arbitrary evasion signals", () => {
    expect(
      validateRiskSignal({
        code: "CAPTCHA_REQUIRED",
        category: "challenge",
        severity: "blocking",
        source: "page",
        detected_at: "2026-07-27T00:00:00.000Z"
      })
    ).toBe(true);
    expect(
      validateRiskSignal({
        code: "BYPASS_CAPTCHA",
        category: "challenge",
        severity: "warning",
        source: "page",
        detected_at: "2026-07-27T00:00:00.000Z"
      })
    ).toBe(false);
  });

  it("carries timing policies and risk signals in protocol v1 messages", () => {
    const command = structuredClone(
      examples.find((example) => example.type === "command.dispatch")!
    );
    command.payload.timing_policy = {
      readiness: {
        timeoutMs: 8000,
        stableForMs: 300,
        pollIntervalMs: 200
      }
    };
    expect(validateBrowserProtocolMessage(command)).toBe(true);

    const result = structuredClone(
      examples.find((example) => example.type === "command.result")!
    );
    result.payload.risk_signals = [
      {
        code: "RATE_LIMITED",
        category: "throttle",
        severity: "blocking",
        source: "page",
        detected_at: "2026-07-27T00:00:00.000Z",
        retry_after_ms: 30000
      }
    ];
    result.payload.timing_observation = {
      rate_limit_wait_ms: 350,
      readiness_wait_ms: 420,
      stable_for_ms: 300
    };
    expect(validateBrowserProtocolMessage(result)).toBe(true);
  });
});

const protocolExample = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../docs/protocols/examples/${name}`, import.meta.url),
      "utf8"
    )
  );

describe("strong iteration contract schemas", () => {
  it("validates immutable Adapter and Assistance Profile assets", () => {
    const adapter = {
      apiVersion: "bpa.adapter/v1alpha1",
      kind: "Adapter",
      metadata: {
        id: "doudian",
        version: "1.1.0",
        title: "Doudian Adapter"
      },
      platform: "doudian",
      origins: ["https://fxg.jinritemai.com"],
      capabilities: [
        {
          nodeId: "doudian.product.scope.collect",
          nodeVersions: ["1.0.0"],
          handlerId: "doudian.product.scope.collect",
          handlerVersion: "1.0.0",
          implementationDigest: `sha256:${"a".repeat(64)}`,
          permissions: ["browser.dom.read", "browser.tabs.read"]
        }
      ]
    };
    expect(validateAdapterManifest(adapter)).toBe(true);
    expect(
      validateAdapterManifest({
        ...adapter,
        origins: ["http://fxg.jinritemai.com"]
      })
    ).toBe(false);

    const profile = {
      apiVersion: "bpa.assistance/v1alpha1",
      kind: "AssistanceProfile",
      metadata: {
        id: "packaging-match-review",
        version: "1.0.0",
        title: "Packaging match review"
      },
      taskKind: "ai_review",
      riskLevel: "R1",
      outputSchema: { type: "object" },
      policySnapshot: {
        autoContinue: false,
        r1ProfileApproved: false,
        durableDecision: false,
        onUnavailable: "continue_unresolved"
      }
    };
    expect(validateAssistanceProfile(profile)).toBe(true);
    expect(
      validateAssistanceProfile({
        ...profile,
        policySnapshot: {
          ...profile.policySnapshot,
          unexpected: true
        }
      })
    ).toBe(false);
  });

  it("accepts a bounded structured Workflow and rejects unbounded foreach", () => {
    const source = readFileSync(
      new URL(
        "../../../docs/protocols/examples/workflow-v1alpha2.example.yaml",
        import.meta.url
      ),
      "utf8"
    );
    const workflow = parse(source) as Record<string, any>;
    expect(validateWorkflowV1Alpha2(workflow)).toBe(true);

    const unbounded = structuredClone(workflow);
    delete unbounded.spec.root.steps[1].maxItems;
    expect(validateWorkflowV1Alpha2(unbounded)).toBe(false);
  });

  it("accepts structured decisions and rejects executable browser primitives", () => {
    const source = readFileSync(
      new URL(
        "../../../docs/protocols/examples/workflow-v1alpha2.example.yaml",
        import.meta.url
      ),
      "utf8"
    );
    const workflow = parse(source) as Record<string, any>;
    workflow.spec.root.steps.splice(1, 0, {
      key: "has_products",
      kind: "decision",
      condition: {
        kind: "compare",
        operator: "exists",
        left: {
          kind: "binding",
          binding: "${steps.collect.output.products}"
        }
      },
      then: {
        kind: "sequence",
        steps: [{ key: "yes", kind: "terminal", status: "succeeded" }]
      },
      else: {
        kind: "sequence",
        steps: [{ key: "no", kind: "terminal", status: "failed" }]
      }
    });
    expect(validateWorkflowV1Alpha2(workflow)).toBe(true);

    const executable = structuredClone(workflow);
    executable.spec.root.steps[0].with = {
      selector: "#unsafe",
      script: "return document.body"
    };
    expect(validateWorkflowV1Alpha2(executable)).toBe(false);

    const invalidExists = structuredClone(workflow);
    invalidExists.spec.root.steps[1].condition.right = {
      kind: "literal",
      value: true
    };
    expect(validateWorkflowV1Alpha2(invalidExists)).toBe(false);
  });

  it("accepts AssistanceTask and Dataset examples", () => {
    const assistance = protocolExample(
      "assistance-task-v1alpha1.example.json"
    ) as Record<string, any>;
    expect(validateAssistanceTask(assistance)).toBe(true);
    const missingLease = structuredClone(assistance);
    missingLease.status = "processing";
    delete missingLease.lease;
    expect(validateAssistanceTask(missingLease)).toBe(false);
    const prematureResolution = structuredClone(assistance);
    prematureResolution.resolution = {
      resolverType: "ai",
      resolverId: "codex:local",
      output: {},
      submittedAt: "2026-07-28T09:00:00.000Z"
    };
    expect(validateAssistanceTask(prematureResolution)).toBe(false);
    expect(
      validateDataset(protocolExample("dataset-v1alpha1.example.json"))
    ).toBe(true);
  });

  it("requires a stable non-CSS ElementContract strategy", () => {
    const contract = protocolExample(
      "element-contract-v1alpha1.example.json"
    ) as Record<string, any>;
    expect(validateElementContract(contract)).toBe(true);
    contract.candidates = [
      {
        strategy: "css-diagnostic",
        selector: ".temporary-class"
      }
    ];
    expect(validateElementContract(contract)).toBe(false);
  });

  it("validates an exact reusable DecisionRecord", () => {
    expect(
      validateDecisionRecord({
        apiVersion: "bpa.decision/v1alpha1",
        decisionId: "decision:binding:001",
        decisionType: "packaging.master.binding",
        status: "active",
        scope: {
          shop_id: "shop-1",
          product_id: "product-1"
        },
        preconditions: {
          normalized_title:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          target_record:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          matcher:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          rules:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        },
        value: { master_record_id: "record-1" },
        confirmedBy: "user:local",
        confirmedAt: "2026-07-28T09:00:00.000Z"
      })
    ).toBe(true);
  });
});

describe("0.5 source, asset, and resource contract candidates", () => {
  it("accepts exact SourceRecord variants and rejects locator confusion", () => {
    const source = protocolExample(
      "source-record-v1alpha1.example.json"
    ) as Record<string, any>;
    expect(validateSourceRecord(source)).toBe(true);

    const wrongLocator = structuredClone(source);
    wrongLocator.sourceType = "public_url";
    expect(validateSourceRecord(wrongLocator)).toBe(false);

    const missingProvenance = structuredClone(source);
    delete missingProvenance.adapter;
    delete missingProvenance.rawDigest;
    expect(validateSourceRecord(missingProvenance)).toBe(false);

    const missingAccess = structuredClone(source);
    delete missingAccess.accessScope;
    expect(validateSourceRecord(missingAccess)).toBe(false);

    const unsafeFile = {
      ...source,
      sourceType: "user_file",
      locator: {
        originalFileName: "../master.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 1024,
        digest: `sha256:${"a".repeat(64)}`
      }
    };
    expect(validateSourceRecord(unsafeFile)).toBe(false);

    const dotFile = structuredClone(unsafeFile);
    dotFile.locator.originalFileName = "..";
    expect(validateSourceRecord(dotFile)).toBe(false);
  });

  it("accepts immutable AssetRecord metadata and enforces object limits", () => {
    const asset = protocolExample(
      "asset-record-v1alpha1.example.json"
    ) as Record<string, any>;
    expect(validateAssetRecord(asset)).toBe(true);

    const oversized = structuredClone(asset);
    oversized.size = 26214401;
    expect(validateAssetRecord(oversized)).toBe(false);

    const callerPath = structuredClone(asset);
    callerPath.storageRef = "/tmp/caller-selected.jpg";
    expect(validateAssetRecord(callerPath)).toBe(false);

    const manualRetentionWithDeadline = structuredClone(asset);
    manualRetentionWithDeadline.retention = {
      policy: "manual",
      retainUntil: "2026-08-29T08:00:02.000Z"
    };
    expect(validateAssetRecord(manualRetentionWithDeadline)).toBe(false);

  });

  it("accepts EvidenceLink lineage and rejects empty or extended records", () => {
    const link = protocolExample(
      "evidence-link-v1alpha1.example.json"
    ) as Record<string, any>;
    expect(validateEvidenceLink(link)).toBe(true);

    const noSource = structuredClone(link);
    noSource.sourceIds = [];
    expect(validateEvidenceLink(noSource)).toBe(false);

    const detachedFromExecution = structuredClone(link);
    delete detachedFromExecution.runId;
    delete detachedFromExecution.nodeExecutionId;
    expect(validateEvidenceLink(detachedFromExecution)).toBe(false);

    const extended = structuredClone(link);
    extended.rawDom = "<html />";
    expect(validateEvidenceLink(extended)).toBe(false);
  });

  it("requires bounded browser resources on Node v1alpha2", () => {
    const node = protocolExample(
      "node-v1alpha2.example.json"
    ) as Record<string, any>;
    expect(validateNodeV1Alpha2(node)).toBe(true);

    const withoutResource = structuredClone(node);
    delete withoutResource.resources;
    expect(validateNodeV1Alpha2(withoutResource)).toBe(false);

    const insecureOrigin = structuredClone(node);
    insecureOrigin.resources.page.allowedOrigins = [
      "http://www.chanmama.com"
    ];
    expect(validateNodeV1Alpha2(insecureOrigin)).toBe(false);

    const nonBrowserWithResource = structuredClone(node);
    nonBrowserWithResource.runtime = "engine_team";
    delete nonBrowserWithResource.risk.domains;
    expect(validateNodeV1Alpha2(nonBrowserWithResource)).toBe(false);

    const tooManyCapabilities = structuredClone(node);
    tooManyCapabilities.resources.page.capabilities = Array.from(
      { length: 33 },
      (_, index) => `browser.capability_${index}`
    );
    expect(validateNodeV1Alpha2(tooManyCapabilities)).toBe(false);
  });

  it("accepts Workflow v1alpha3 slots and per-call mappings", () => {
    const workflow = parse(
      readFileSync(
        new URL(
          "../../../docs/protocols/examples/workflow-v1alpha3.example.yaml",
          import.meta.url
        ),
        "utf8"
      )
    ) as Record<string, any>;
    expect(validateWorkflowV1Alpha3(workflow)).toBe(true);

    const insecureOrigin = structuredClone(workflow);
    insecureOrigin.spec.resourceSlots.metrics_source.allowedOrigins = [
      "http://www.chanmama.com"
    ];
    expect(validateWorkflowV1Alpha3(insecureOrigin)).toBe(false);

    const invalidMapping = structuredClone(workflow);
    invalidMapping.spec.root.steps[0].resourceMappings = {
      "not-a-requirement": "metrics_source"
    };
    expect(validateWorkflowV1Alpha3(invalidMapping)).toBe(false);

    const unexpectedField = structuredClone(workflow);
    unexpectedField.spec.resourceSlots.metrics_source.sessionId =
      "browser-session-1";
    expect(validateWorkflowV1Alpha3(unexpectedField)).toBe(false);
  });

  it("keeps old Workflow v1alpha2 compatible and versions disjoint", () => {
    const legacy = parse(
      readFileSync(
        new URL(
          "../../../docs/protocols/examples/workflow-v1alpha2.example.yaml",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(validateWorkflowV1Alpha2(legacy)).toBe(true);
    expect(validateWorkflowV1Alpha3(legacy)).toBe(false);

    const current = parse(
      readFileSync(
        new URL(
          "../../../docs/protocols/examples/workflow-v1alpha3.example.yaml",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(validateWorkflowV1Alpha3(current)).toBe(true);
    expect(validateWorkflowV1Alpha2(current)).toBe(false);
  });
});
