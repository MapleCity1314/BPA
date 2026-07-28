import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  validateAssistanceTask,
  validateBrowserProtocolMessage,
  validateDataset,
  validateDecisionRecord,
  validateElementContract,
  validateRiskSignal,
  validateTimingPolicy,
  validateWorkflowV1Alpha2
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

  it("accepts AssistanceTask and Dataset examples", () => {
    expect(
      validateAssistanceTask(
        protocolExample("assistance-task-v1alpha1.example.json")
      )
    ).toBe(true);
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
