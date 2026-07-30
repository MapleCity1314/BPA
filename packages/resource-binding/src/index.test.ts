import { describe, expect, it } from "vitest";
import type {
  BrowserResourceRequirementSnapshot,
  InvocationResourceBinding,
  ResourceBindingRef
} from "@bpa/workflow-ir";
import {
  freezeResourceBinding,
  createResourceBindingSnapshot,
  InvalidResourceBindingTransitionError,
  makeResourceBindingAvailable,
  requestResourceBinding,
  requireResourceAuthentication,
  revokeResourceBinding,
  validateInvocationResourceBinding,
  validateResourceBinding
} from "./index.js";

const clock = {
  value: 1_000,
  now() {
    return this.value++;
  }
};

const requirement: BrowserResourceRequirementSnapshot = {
  kind: "browser",
  capabilities: ["browser.dom.read"],
  allowedOrigins: ["https://www.chanmama.com"],
  authentication: "authenticated",
  purpose: "Read metrics"
};

const binding: ResourceBindingRef = {
  bindingId: "binding-1",
  revision: 1,
  slotName: "metrics_source",
  sessionId: "session-1",
  capabilityDigest: "a".repeat(64),
  origin: "https://www.chanmama.com",
  authentication: "membership",
  frozenAt: 1_002,
  approvedBy: "user:test"
};

describe("Resource Binding state", () => {
  it("moves through requested, validated, frozen and available with injected time", () => {
    const requested = requestResourceBinding(
      {
        bindingId: "binding-1",
        runId: "run-1",
        slotName: "metrics_source",
        requirement
      },
      clock
    );
    const validated = validateResourceBinding(
      requested.record,
      binding,
      clock
    );
    const frozen = freezeResourceBinding(validated.record, clock);
    const available = makeResourceBindingAvailable(frozen.record, clock);
    expect([
      requested.event.to,
      validated.event.to,
      frozen.event.to,
      available.event.to
    ]).toEqual(["requested", "validated", "frozen", "available"]);
    expect(available.record.frozen).toEqual(binding);
    expect(
      createResourceBindingSnapshot("run-1", [available.record])
    ).toEqual({
      snapshotVersion: "bpa.resource-binding/1",
      runId: "run-1",
      resourceSlots: { metrics_source: requirement },
      bindings: { metrics_source: binding }
    });

    const authRequired = requireResourceAuthentication(
      available.record,
      "SESSION_EXPIRED",
      clock
    );
    expect(
      makeResourceBindingAvailable(authRequired.record, clock).record.state
    ).toBe("available");
    expect(
      revokeResourceBinding(
        authRequired.record,
        "USER_REVOKED",
        clock
      ).record.state
    ).toBe("revoked");
  });

  it("rejects skipped and terminal transitions", () => {
    const requested = requestResourceBinding(
      {
        bindingId: "binding-1",
        runId: "run-1",
        slotName: "metrics_source",
        requirement
      },
      clock
    );
    expect(() =>
      makeResourceBindingAvailable(requested.record, clock)
    ).toThrow(InvalidResourceBindingTransitionError);
    const revoked = revokeResourceBinding(
      requested.record,
      "CANCELLED",
      clock
    );
    expect(() =>
      revokeResourceBinding(revoked.record, "AGAIN", clock)
    ).toThrow(InvalidResourceBindingTransitionError);
  });
});

describe("invocation Resource Binding validation", () => {
  const resource: InvocationResourceBinding = {
    requirementName: "page_session",
    slotName: "metrics_source",
    requirement,
    requirementDigest: "b".repeat(64),
    binding
  };
  const session = {
    sessionId: "session-1",
    capabilityDigest: "a".repeat(64),
    capabilities: ["browser.dom.read", "browser.evidence.write"],
    origin: "https://www.chanmama.com",
    authentication: "membership" as const,
    state: "available" as const
  };

  it("accepts only the exact frozen session context", () => {
    expect(validateInvocationResourceBinding(resource, session)).toEqual([]);
  });

  it.each([
    ["sessionId", "other", "SESSION_MISMATCH"],
    ["capabilityDigest", "c".repeat(64), "CAPABILITY_DIGEST_MISMATCH"],
    ["origin", "https://example.com", "ORIGIN_MISMATCH"],
    ["authentication", "authenticated", "AUTHENTICATION_MISMATCH"],
    ["state", "auth_required", "SESSION_NOT_AVAILABLE"]
  ] as const)("rejects changed %s", (field, value, code) => {
    const issues = validateInvocationResourceBinding(resource, {
      ...session,
      [field]: value
    });
    expect(issues.map((issue) => issue.code)).toContain(code);
  });
});
