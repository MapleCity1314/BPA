import type {
  BrowserObservationStore,
  BrowserPageObservationRecord
} from "@bpa/persistence";
import type { ObservedBrowserSession } from "@bpa/resource-binding";
import type {
  BrowserResourceRequirementSnapshot,
  ExecutionPlan,
  ResourceBindingRef,
  ResourceBindingSnapshot
} from "@bpa/workflow-ir";

interface PreparedBinding {
  requirement: BrowserResourceRequirementSnapshot;
  binding: Omit<ResourceBindingRef, "bindingId" | "frozenAt">;
}

interface BrowserPageSelection {
  readonly sessionId: string;
  readonly browserInstanceId: string;
  readonly tabId: number;
  readonly observationRevision: number;
}

export interface BrowserResourceResolution {
  readonly browserInstanceId: string;
  readonly resourceBindings: Readonly<
    Record<string, BrowserPageSelection>
  >;
}

const MAX_OBSERVATION_AGE_MS = 30_000;

function authenticationSatisfies(
  required: BrowserResourceRequirementSnapshot["authentication"],
  observed: BrowserPageObservationRecord["authentication"]
): boolean {
  if (required === "anonymous" || required === "optional") return true;
  if (required === "authenticated") {
    return observed === "authenticated" || observed === "membership";
  }
  return observed === "membership";
}

export class RuntimeResourceBindingService {
  constructor(private readonly persistence: BrowserObservationStore) {}

  resolveForPlan(
    plan: ExecutionPlan,
    requestedBrowserInstanceId?: string
  ): BrowserResourceResolution {
    const slots = plan.resourceSlots ?? {};
    const slotNames = Object.keys(slots).sort();
    if (slotNames.length === 0) {
      throw new Error("BROWSER_RESOURCE_NOT_REQUIRED");
    }
    const sessions = this.persistence
      .listBrowserSessions({ limit: 200 })
      .records.filter(
        (session) =>
          !session.disconnectedAt && Boolean(session.capabilityDigest)
      );
    if (sessions.length === 0) {
      throw new Error("BROWSER_BRIDGE_DISCONNECTED");
    }
    const instanceIds = [
      ...new Set(sessions.map((session) => session.browserInstanceId))
    ].sort();
    if (
      requestedBrowserInstanceId &&
      !instanceIds.includes(requestedBrowserInstanceId)
    ) {
      throw new Error("BROWSER_BRIDGE_DISCONNECTED");
    }
    if (!requestedBrowserInstanceId && instanceIds.length > 1) {
      throw new Error("BROWSER_SESSION_AMBIGUOUS");
    }
    const browserInstanceId =
      requestedBrowserInstanceId ?? instanceIds[0]!;
    const instanceSessions = sessions.filter(
      (session) => session.browserInstanceId === browserInstanceId
    );
    const now = Date.now();
    const resourceBindings: Record<string, BrowserPageSelection> = {};

    for (const slotName of slotNames) {
      const requirement = slots[slotName]!;
      const requiredNodes = Object.values(plan.steps).flatMap((step) => {
        if (step.kind !== "call" || !step.resourceMappings) return [];
        return Object.values(step.resourceMappings).some(
          (mapping) => mapping.slotName === slotName
        )
          ? [step.node]
          : [];
      });
      const candidates = instanceSessions.flatMap((session) => {
        const capabilities = this.persistence.listBrowserCapabilities(
          session.id
        );
        const permissionSet = new Set(
          capabilities.flatMap((capability) => capability.permissions)
        );
        if (
          requirement.capabilities.some(
            (capability) => !permissionSet.has(capability)
          )
        ) {
          return [];
        }
        const nodeCapabilities = requiredNodes.map((node) =>
          capabilities.find(
            (capability) =>
              capability.nodeId === node.id &&
              capability.nodeVersion === node.version
          )
        );
        if (nodeCapabilities.some((capability) => !capability)) return [];
        return this.persistence
          .listBrowserPageObservations({
            limit: 200,
            sessionId: session.id,
            browserInstanceId
          })
          .filter((page) => {
            if (!requirement.allowedOrigins.includes(page.origin)) {
              return false;
            }
            return nodeCapabilities.every((capability) =>
              (capability?.routes ?? []).some(
                (route) =>
                  route.origin === page.origin &&
                  route.observerCapabilityId ===
                    page.observerCapabilityId &&
                  route.pathnamePrefixes.some((prefix) =>
                    page.pathname.startsWith(prefix)
                  )
              )
            );
          });
      });
      const ready = candidates
        .filter(
          (page) =>
            page.observationState === "ready" &&
            page.contentScriptReady &&
            now - Date.parse(page.observedAt) <= MAX_OBSERVATION_AGE_MS &&
            authenticationSatisfies(
              requirement.authentication,
              page.authentication
            ) &&
            (!["authenticated", "membership"].includes(
              page.authentication
            ) || Boolean(page.authenticationContextRef))
        )
        .sort(
          (left, right) =>
            Date.parse(right.observedAt) - Date.parse(left.observedAt)
        );
      const page = ready[0];
      if (!page) {
        const latest = [...candidates].sort(
          (left, right) =>
            Date.parse(right.observedAt) - Date.parse(left.observedAt)
        )[0];
        if (!latest) throw new Error(`BROWSER_PAGE_NOT_FOUND:${slotName}`);
        if (latest.observationState === "challenge") {
          throw new Error(`BROWSER_CHALLENGE_REQUIRED:${slotName}`);
        }
        if (
          latest.observationState === "auth_required" ||
          !authenticationSatisfies(
            requirement.authentication,
            latest.authentication
          )
        ) {
          throw new Error(`BROWSER_AUTH_REQUIRED:${slotName}`);
        }
        if (
          latest.observationState === "content_script_missing" ||
          !latest.contentScriptReady
        ) {
          throw new Error(`BROWSER_CONTENT_SCRIPT_MISSING:${slotName}`);
        }
        if (["loading", "probing"].includes(latest.observationState)) {
          throw new Error(`BROWSER_OBSERVATION_PENDING:${slotName}`);
        }
        throw new Error(`BROWSER_OBSERVATION_STALE:${slotName}`);
      }
      resourceBindings[slotName] = {
        sessionId: page.sessionId,
        browserInstanceId: page.browserInstanceId,
        tabId: page.tabId,
        observationRevision: page.revision
      };
    }
    return { browserInstanceId, resourceBindings };
  }

  resolveBrowserBinding(
    binding: ResourceBindingRef
  ): ObservedBrowserSession | undefined {
    const session = this.persistence.getBrowserSession(binding.sessionId);
    const page = this.persistence.getBrowserPageObservation(
      binding.sessionId,
      binding.tabId
    );
    if (
      !session ||
      !page ||
      !session.capabilityDigest ||
      page.browserInstanceId !== binding.browserInstanceId
    ) {
      return undefined;
    }
    const capabilities = [
      ...new Set(
        this.persistence
          .listBrowserCapabilities(binding.sessionId)
          .flatMap((capability) => capability.permissions)
      )
    ].sort();
    return {
      sessionId: binding.sessionId,
      browserInstanceId: page.browserInstanceId,
      tabId: page.tabId,
      ...(page.windowId === undefined ? {} : { windowId: page.windowId }),
      observationRevision: page.revision,
      capabilityDigest: session.capabilityDigest,
      capabilities,
      origin: page.origin,
      pathname: page.pathname,
      pageEpoch: page.pageEpoch,
      observerCapabilityId: page.observerCapabilityId,
      authentication:
        page.authentication === "membership"
          ? "membership"
          : page.authentication === "authenticated"
            ? "authenticated"
          : "anonymous",
      ...(page.authenticationContextRef === undefined
        ? {}
        : { authenticationContextRef: page.authenticationContextRef }),
      state:
        session.disconnectedAt ||
        ["departed", "stale"].includes(page.observationState) ||
        Date.now() - Date.parse(page.observedAt) > MAX_OBSERVATION_AGE_MS
          ? "revoked"
          : page.observationState === "ready"
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
      const selectionCandidate = selected[slotName];
      if (
        !selectionCandidate ||
        typeof selectionCandidate !== "object" ||
        Array.isArray(selectionCandidate)
      ) {
        throw new Error(
          `Browser Resource Binding ${slotName} requires an exact page observation`
        );
      }
      const pageSelection = selectionCandidate as Partial<BrowserPageSelection>;
      if (
        typeof pageSelection.sessionId !== "string" ||
        typeof pageSelection.browserInstanceId !== "string" ||
        !Number.isSafeInteger(pageSelection.tabId) ||
        !Number.isSafeInteger(pageSelection.observationRevision)
      ) {
        throw new Error(
          `Browser Resource Binding ${slotName} is missing page identity`
        );
      }
      const sessionId = pageSelection.sessionId;
      const session = this.persistence.getBrowserSession(sessionId);
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
      const requiredNodes = Object.values(plan.steps).flatMap((step) => {
        if (step.kind !== "call" || !step.resourceMappings) return [];
        return Object.values(step.resourceMappings).some(
          (mapping) => mapping.slotName === slotName
        )
          ? [step.node]
          : [];
      });
      const reportedNodes = this.persistence.listBrowserCapabilities(
        sessionId
      );
      const missingNodes = requiredNodes.filter(
        (node) =>
          !reportedNodes.some(
            (reported) =>
              reported.nodeId === node.id &&
              reported.nodeVersion === node.version
          )
      );
      if (missingNodes.length > 0) {
        throw new Error(
          `BROWSER_NODE_CAPABILITY_MISSING:${slotName}:${missingNodes
            .map((node) => `${node.id}@${node.version}`)
            .join(",")}`
        );
      }

      const page = this.persistence.getBrowserPageObservation(
        sessionId,
        pageSelection.tabId!
      );
      if (
        !page ||
        page.browserInstanceId !== pageSelection.browserInstanceId ||
        page.revision !== pageSelection.observationRevision ||
        page.observationState !== "ready" ||
        !page.contentScriptReady ||
        !authenticationSatisfies(
          requirement.authentication,
          page.authentication
        ) ||
        (["authenticated", "membership"].includes(page.authentication) &&
          !page.authenticationContextRef) ||
        Date.now() - Date.parse(page.observedAt) > MAX_OBSERVATION_AGE_MS
      ) {
        throw new Error(`BROWSER_OBSERVATION_STALE:${slotName}`);
      }
      if (!requirement.allowedOrigins.includes(page.origin)) {
        throw new Error(`BROWSER_ORIGIN_MISMATCH:${slotName}`);
      }
      prepared.set(slotName, {
        requirement,
        binding: {
          revision: page.revision,
          slotName,
          sessionId,
          browserInstanceId: page.browserInstanceId,
          tabId: page.tabId,
          ...(page.windowId === undefined ? {} : { windowId: page.windowId }),
          capabilityDigest: session.capabilityDigest,
          origin: page.origin,
          pathname: page.pathname,
          pageEpoch: page.pageEpoch,
          observerCapabilityId: page.observerCapabilityId,
          authentication:
            page.authentication === "membership"
              ? "membership"
              : page.authentication === "authenticated"
                ? "authenticated"
                : "anonymous",
          ...(page.authenticationContextRef === undefined
            ? {}
            : {
                authenticationContextRef: page.authenticationContextRef
              }),
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
