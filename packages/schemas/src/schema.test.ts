import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateBrowserProtocolMessage,
  validateRiskSignal,
  validateTimingPolicy
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
