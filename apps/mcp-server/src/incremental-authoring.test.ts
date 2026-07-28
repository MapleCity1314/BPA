import { describe, expect, it } from "vitest";
import {
  addOrReplaceStepOperation,
  optionalOperationId,
  parseAdapterRef,
  setBindingOperation,
  setExceptionPolicyOperation
} from "./incremental-authoring.js";

describe("MCP typed Draft protocol payloads", () => {
  it("builds small Candidate-only operations without a full Workflow body", () => {
    expect(
      addOrReplaceStepOperation({
        operationId: "add-inspect",
        step: {
          key: "inspect",
          nodeRef: "doudian.editor.priority-items.inspect@1.0.0",
          config: {},
          inputBindings: {}
        }
      })
    ).toMatchObject({
      type: "step.add-or-replace",
      step: { key: "inspect" }
    });
    expect(
      setBindingOperation({
        operationId: "bind-product",
        stepKey: "inspect",
        bindingKey: "product",
        value: "${item}"
      })
    ).toEqual({
      operationId: "bind-product",
      type: "binding.set",
      stepKey: "inspect",
      bindingKey: "product",
      value: "${item}"
    });
    expect(
      setExceptionPolicyOperation({
        operationId: "exceptions-inspect",
        stepKey: "inspect",
        policy: {
          failure: "collect",
          timeout: "collect",
          rejected: "fail",
          cancelled: "fail",
          uncertain: "stop_uncertain"
        }
      })
    ).toMatchObject({
      type: "exception-policy.set",
      policy: { uncertain: "stop_uncertain" }
    });
  });

  it("pins adapter versions and preserves optional idempotency keys exactly", () => {
    expect(parseAdapterRef("doudian@2.0.0")).toEqual({
      id: "doudian",
      version: "2.0.0"
    });
    expect(parseAdapterRef(undefined)).toBeUndefined();
    expect(() => parseAdapterRef("doudian@latest")).toThrow(/exact-semver/);
    expect(optionalOperationId("retry-stable-id")).toEqual({
      operationId: "retry-stable-id"
    });
    expect(optionalOperationId(undefined)).toEqual({});
  });
});
