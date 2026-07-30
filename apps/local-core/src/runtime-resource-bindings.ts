import type {
  BrowserSessionRole,
  Persistence
} from "@bpa/persistence";
import type { ObservedBrowserSession } from "@bpa/resource-binding";
import type {
  BrowserResourceRequirementSnapshot,
  ExecutionPlan,
  ResourceAuthentication,
  ResourceBindingRef,
  ResourceBindingSnapshot
} from "@bpa/workflow-ir";

const AUTHENTICATION_RANK: Record<ResourceAuthentication, number> = {
  anonymous: 0,
  optional: 1,
  authenticated: 2,
  membership: 3
};

interface PreparedBinding {
  requirement: BrowserResourceRequirementSnapshot;
  binding: Omit<ResourceBindingRef, "bindingId" | "frozenAt">;
}

export class RuntimeResourceBindingService {
  constructor(private readonly persistence: Persistence) {}

  resolveBrowserSession(
    sessionId: string
  ): ObservedBrowserSession | undefined {
    const session = this.persistence.getBrowserSession(sessionId);
    if (
      !session ||
      !session.capabilityDigest ||
      !session.observedOrigin ||
      !session.observedAuthentication
    ) {
      return undefined;
    }
    const capabilities = [
      ...new Set(
        this.persistence
          .listBrowserCapabilities(sessionId)
          .flatMap((capability) => capability.permissions)
      )
    ].sort();
    return {
      sessionId,
      capabilityDigest: session.capabilityDigest,
      capabilities,
      origin: session.observedOrigin,
      authentication: session.observedAuthentication,
      state:
        session.disconnectedAt || session.observationState === "revoked"
          ? "revoked"
          : session.observationState === "available"
            ? "available"
            : "auth_required"
    };
  }

  prepare(
    plan: ExecutionPlan,
    selectionValue: unknown,
    actor: string
  ): ((runId: string) => ResourceBindingSnapshot) | undefined {
    const slots = plan.resourceSlots ?? {};
    const slotNames = Object.keys(slots).sort();
    const selection =
      selectionValue === undefined || selectionValue === null
        ? {}
        : selectionValue;
    if (typeof selection !== "object" || Array.isArray(selection)) {
      throw new Error("Browser Resource Bindings must be an object");
    }
    const selected = selection as Record<string, unknown>;
    const selectedNames = Object.keys(selected).sort();
    if (JSON.stringify(slotNames) !== JSON.stringify(selectedNames)) {
      throw new Error(
        "Browser Resource Bindings must cover the exact Workflow resource slots"
      );
    }
    if (slotNames.length === 0) return undefined;
    if (!actor.trim()) {
      throw new Error("Browser Resource Bindings require an approving actor");
    }

    const prepared = new Map<string, PreparedBinding>();
    for (const slotName of slotNames) {
      const requirement = slots[slotName]!;
      const sessionId = selected[slotName];
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error(
          `Browser Resource Binding ${slotName} requires a Session ID`
        );
      }
      let session = this.persistence.getBrowserSession(sessionId);
      if (
        !session ||
        session.disconnectedAt ||
        !session.capabilityDigest
      ) {
        throw new Error(
          `Browser Session is unavailable for resource slot ${slotName}`
        );
      }
      const reportedPermissions = new Set(
        this.persistence
          .listBrowserCapabilities(sessionId)
          .flatMap((capability) => capability.permissions)
      );
      const missingCapabilities = requirement.capabilities.filter(
        (capability) => !reportedPermissions.has(capability)
      );
      if (missingCapabilities.length > 0) {
        throw new Error(
          `Browser Session lacks capabilities for ${slotName}: ${missingCapabilities.join(", ")}`
        );
      }

      if ((session.observationState ?? "unknown") === "unknown") {
        // The Run wizard freezes the operator's expected context. Extension
        // handlers still verify the live tab and page before reading it.
        if (requirement.allowedOrigins.length !== 1) {
          throw new Error(
            `Browser Session ${sessionId} requires an explicit Origin observation for ${slotName}`
          );
        }
        session = this.persistence.updateBrowserSessionObservation({
          id: sessionId,
          expectedRevision: session.observationRevision ?? 0,
          role: browserSessionRole(slotName),
          observedOrigin: requirement.allowedOrigins[0]!,
          observedAuthentication: requirement.authentication,
          observationState: "available",
          observedAt: new Date().toISOString()
        });
      }
      if (
        session.observationState !== "available" ||
        !session.capabilityDigest ||
        !session.observedOrigin ||
        !session.observedAuthentication ||
        !requirement.allowedOrigins.includes(session.observedOrigin) ||
        AUTHENTICATION_RANK[session.observedAuthentication] <
          AUTHENTICATION_RANK[requirement.authentication]
      ) {
        throw new Error(
          `Browser Session observation does not satisfy resource slot ${slotName}`
        );
      }
      prepared.set(slotName, {
        requirement,
        binding: {
          revision: session.observationRevision ?? 0,
          slotName,
          sessionId,
          capabilityDigest: session.capabilityDigest,
          origin: session.observedOrigin,
          authentication: session.observedAuthentication,
          approvedBy: actor
        }
      });
    }

    return (runId) => {
      const frozenAt = Date.now();
      const resourceSlots: Record<
        string,
        BrowserResourceRequirementSnapshot
      > = {};
      const bindings: Record<string, ResourceBindingRef> = {};
      for (const slotName of slotNames) {
        const item = prepared.get(slotName)!;
        resourceSlots[slotName] = structuredClone(item.requirement);
        bindings[slotName] = {
          ...item.binding,
          bindingId: `binding:${runId}:${slotName}`,
          frozenAt
        };
      }
      return {
        snapshotVersion: "bpa.resource-binding/1",
        runId,
        resourceSlots,
        bindings
      };
    };
  }
}

function browserSessionRole(slotName: string): BrowserSessionRole {
  if (slotName === "metrics_source") return "metrics_source";
  if (slotName === "public_asset_source") return "public_asset_source";
  if (slotName === "design_mode") return "design_mode";
  return "general";
}
