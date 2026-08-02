import { describe, expect, it } from "vitest";
import type {
  BrowserResourceRequirementSnapshot,
  ExecutionPlan,
  InvocationResourceBinding,
  ResourceBindingRef
} from "@bpa/workflow-ir";
import {
  assertResourceBindingSnapshotForPlan,
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

function createClock() {
  return {
    value: 1_000,
    now() {
      return this.value++;
    }
  };
}

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
  browserInstanceId: "browser-1",
  tabId: 42,
  capabilityDigest: "a".repeat(64),
  origin: "https://www.chanmama.com",
  pathname: "/metrics",
  pageEpoch: "tab-42:1:test",
  observerCapabilityId: "chanmama.page",
  authentication: "membership",
  authenticationContextRef: "auth-context-member",
  frozenAt: 1_002,
  approvedBy: "user:test"
};

describe("Resource Binding state", () => {
  it("moves through requested, validated, frozen and available with injected time", () => {
    const clock = createClock();
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
    const clock = createClock();
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
    browserInstanceId: "browser-1",
    tabId: 42,
    observationRevision: 1,
    capabilityDigest: "a".repeat(64),
    capabilities: ["browser.dom.read", "browser.evidence.write"],
    origin: "https://www.chanmama.com",
    pathname: "/metrics",
    pageEpoch: "tab-42:1:test",
    observerCapabilityId: "chanmama.page",
    authentication: "membership" as const,
    authenticationContextRef: "auth-context-member",
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

describe("Run Resource Binding Snapshot", () => {
  const plan: ExecutionPlan = {
    irVersion: "bpa.workflow-ir/2",
    workflow: {
      id: "workflow:test",
      version: "1.0.0",
      digest: `sha256:${"1".repeat(64)}`
    },
    artifactClosure: { entries: [] },
    riskSnapshot: [],
    limits: { maxDepth: 1, maxStepExecutions: 1 },
    resourceSlots: { metrics_source: requirement },
    entry: "done",
    steps: {
      done: { key: "done", kind: "terminal", status: "succeeded" }
    }
  };
  const snapshot = {
    snapshotVersion: "bpa.resource-binding/1" as const,
    runId: "run-1",
    resourceSlots: { metrics_source: requirement },
    bindings: {
      metrics_source: {
        ...binding,
        capabilityDigest: `sha256:${"a".repeat(64)}`
      }
    }
  };

  it("requires exact IR slots and frozen requirements", () => {
    expect(() =>
      assertResourceBindingSnapshotForPlan("run-1", snapshot, plan)
    ).not.toThrow();
    expect(() =>
      assertResourceBindingSnapshotForPlan(
        "run-1",
        {
          ...snapshot,
          bindings: {}
        },
        plan
      )
    ).toThrow("exact IR resource slots");
    expect(() =>
      assertResourceBindingSnapshotForPlan(
        "run-1",
        {
          ...snapshot,
          resourceSlots: {
            metrics_source: {
              ...requirement,
              authentication: "anonymous"
            }
          }
        },
        plan
      )
    ).toThrow("requirement drifted");
  });
});
