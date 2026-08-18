import { describe, expect, it } from "vitest";
import type {
  DesignModeGrantRecord,
  Persistence
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import { validateDesignCaptureInvocation } from "./browser-gateway.js";

const grant: DesignModeGrantRecord = {
  grantId: "design.grant-1",
  authoringSessionId: "authoring.session-1",
  revision: 1,
  state: "active",
  approvedBy: "operator",
  browserSessionId: "browser-session-1",
  profileId: "chanmama.product-metrics",
  tabId: 7,
  origin: "https://www.chanmama.com",
  pageEpoch: "tab-7:1999999999999:design-1",
  allowedOperations: ["semantic_snapshot"],
  issuedAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2099-07-30T00:15:00.000Z",
  updatedAt: "2026-07-30T00:00:01.000Z"
};

function invocation(
  patch: Partial<RuntimeInvocation> = {}
): RuntimeInvocation {
  return {
    invocationId: "invocation-1",
    identity: {
      runId: "run-1",
      scopePath: [],
      iterationKey: "root",
      stepKey: "capture",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "browser.design.snapshot.capture",
      version: "1.0.0",
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    providerId: "browser",
    input: {
      authoringSessionId: grant.authoringSessionId,
      designGrantId: grant.grantId,
      profileId: grant.profileId,
      pageState: "product.detail",
      pageEpoch: grant.pageEpoch
    },
    permissionSnapshot: {
      riskLevel: "R0",
      permissions: [
        "browser.dom.read",
        "browser.tabs.read",
        "page-model.design.read"
      ],
      domains: [grant.origin]
    },
    resourceBindings: {
      design_page: {
        requirementName: "design_page",
        slotName: "design_mode",
        requirementDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        continuity: "fixed",
        requirement: {
          kind: "browser",
          capabilities: ["page-model.design.read"],
          allowedOrigins: [grant.origin],
          authentication: "optional",
          purpose: "Design Mode"
        },
        binding: {
          bindingId: "binding-1",
          revision: 1,
          slotName: "design_mode",
          sessionId: grant.browserSessionId,
          browserInstanceId: "browser-1",
          tabId: grant.tabId,
          capabilityDigest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          origin: grant.origin,
          pathname: "/ffa/g/create",
          pageEpoch: grant.pageEpoch,
          authentication: "authenticated",
          approvedBy: "operator",
          frozenAt: 1
        }
      }
    },
    deadlineAt: Date.parse("2099-07-30T00:10:00.000Z"),
    idempotencyKey: "capture-1",
    fencingToken: 1,
    traceId: "trace-1",
    ...patch
  };
}

function store(
  value: DesignModeGrantRecord | undefined
): Pick<Persistence, "getDesignModeGrant"> {
  return {
    getDesignModeGrant: () => value
  };
}

describe("Design Mode browser dispatch guard", () => {
  it("accepts only an exact active grant and frozen Browser Resource", () => {
    expect(
      validateDesignCaptureInvocation(store(grant), invocation())
    ).toBeUndefined();
  });

  it("rejects inactive, expired, and missing grants", () => {
    expect(
      validateDesignCaptureInvocation(
        store({ ...grant, state: "stopped" }),
        invocation()
      )
    ).toMatchObject({
      status: "rejected",
      error: { code: "DESIGN_GRANT_INACTIVE" }
    });
    expect(
      validateDesignCaptureInvocation(store(undefined), invocation())
    ).toMatchObject({
      status: "rejected",
      error: { code: "DESIGN_GRANT_MISSING" }
    });
  });

  it("rejects a different Session, Origin, profile, or PageEpoch", () => {
    expect(
      validateDesignCaptureInvocation(
        store(grant),
        invocation({
          input: {
            authoringSessionId: grant.authoringSessionId,
            designGrantId: grant.grantId,
            profileId: "different-profile",
            pageState: "product.detail",
            pageEpoch: "tab-8:1999999999999:stale"
          }
        })
      )
    ).toMatchObject({
      status: "rejected",
      error: { code: "DESIGN_GRANT_CONTEXT_MISMATCH" }
    });
    expect(
      validateDesignCaptureInvocation(
        store(grant),
        invocation({
          resourceBindings: {
            design_page: {
              ...invocation().resourceBindings!.design_page!,
              binding: {
                ...invocation().resourceBindings!.design_page!.binding,
                sessionId: "browser-session-2"
              }
            }
          }
        })
      )
    ).toMatchObject({
      status: "rejected",
      error: { code: "DESIGN_GRANT_RESOURCE_MISMATCH" }
    });
  });
});
