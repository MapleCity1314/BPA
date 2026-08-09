import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ExecutionPlan } from "@bpa/workflow-ir";
import { RuntimeResourceBindingService } from "./runtime-resource-bindings.js";

const digest = `sha256:${"a".repeat(64)}`;
const adapterDigest = `sha256:${"c".repeat(64)}`;
const adapterRef = {
  kind: "adapter" as const,
  id: "fictional-site",
  version: "2.0.0",
  digest: adapterDigest
};

function plan(
  allowedOrigins = ["https://example.com"],
  authentication:
    | "optional"
    | "anonymous"
    | "authenticated"
    | "membership" = "authenticated"
): ExecutionPlan {
  return {
    irVersion: "bpa.workflow-ir/2",
    workflow: { id: "workflow", version: "1.0.0", digest },
    artifactClosure: { entries: [] },
    riskSnapshot: [],
    resourceSlots: {
      source: {
        kind: "browser",
        capabilities: ["browser.dom.read"],
        allowedOrigins,
        authentication,
        purpose: "Read the selected source"
      }
    },
    limits: { maxDepth: 1, maxStepExecutions: 2 },
    entry: "done",
    steps: {
      done: { key: "done", kind: "terminal", status: "succeeded" }
    }
  };
}

function planWithBrowserCall(withAdapter = false): ExecutionPlan {
  const source = plan();
  return {
    ...source,
    artifactClosure: withAdapter
      ? { entries: [adapterRef] }
      : source.artifactClosure,
    entry: "read",
    steps: {
      read: {
        key: "read",
        kind: "call",
        node: {
          kind: "node",
          id: "browser.read",
          version: "1.0.0",
          digest
        },
        resourceMappings: {
          page: { slotName: "source" }
        },
        ...(withAdapter
          ? { dependencies: { adapters: [adapterRef], policies: [], datasetProfiles: [] } }
          : {})
      },
      ...source.steps
    }
  } as unknown as ExecutionPlan;
}

function database(options: {
  extensionVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
} = {}): SqlitePersistence {
  const persistence = new SqlitePersistence({ path: ":memory:" });
  persistence.openBrowserSession({
    session: {
      id: "session",
      browserInstanceId: "browser",
      extensionId: "extension",
      extensionVersion: options.extensionVersion ?? "0.4.0",
      protocolVersion: "1.0.0",
      incomingSeq: 0,
      outgoingSeq: 0,
      lastAckedCommandSeq: 0,
      capabilityDigest: digest,
      resumeTokenDigest: `sha256:${"b".repeat(64)}`,
      resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
      connectedAt: "2026-07-30T00:00:00.000Z"
    },
    now: "2026-07-30T00:00:00.000Z"
  });
  persistence.replaceBrowserCapabilities("session", [
    {
      nodeId: "browser.read",
      nodeVersion: "1.0.0",
      riskLevel: "R1",
      permissions: ["browser.dom.read"],
      routes: [
        {
          origin: "https://example.com",
          pathnamePrefixes: ["/source"],
          observerCapabilityId: "test.page"
        }
      ],
      ...(options.adapterId === ""
        ? {}
        : { adapterId: options.adapterId ?? "fictional-site" }),
      ...(options.adapterVersion === ""
        ? {}
        : { adapterVersion: options.adapterVersion ?? "1.0.0" })
    }
  ]);
  persistence.upsertBrowserPageObservation({
    sessionId: "session",
    browserInstanceId: "browser",
    tabId: 42,
    windowId: 7,
    origin: "https://example.com",
    pathname: "/source",
    contentScriptReady: true,
    authentication: "authenticated",
    authenticationContextRef: "auth-context-test",
    observationState: "ready",
    pageEpoch: "tab-42:1:test",
    observerCapabilityId: "test.page",
    revision: 1,
    observedAt: new Date().toISOString()
  });
  return persistence;
}

function publishAdapter(persistence: SqlitePersistence): void {
  persistence.publish({
    assetType: "adapter",
    assetId: adapterRef.id,
    version: adapterRef.version,
    digest: adapterRef.digest,
    content: { extension: { minimumVersion: "0.6.1" } },
    actor: "test"
  });
}

const selection = {
  source: {
    sessionId: "session",
    browserInstanceId: "browser",
    tabId: 42,
    observationRevision: 1
  }
};

describe("RuntimeResourceBindingService", () => {
  it("resolves a fictional Adapter through public capabilities only", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    expect(service.resolveForPlan(planWithBrowserCall())).toEqual({
      browserInstanceId: "browser",
      resourceBindings: selection
    });
    persistence.close();
  });

  it("refuses to guess between ready tabs with different authentication contexts", () => {
    const persistence = database();
    persistence.upsertBrowserPageObservation({
      sessionId: "session",
      browserInstanceId: "browser",
      tabId: 43,
      windowId: 7,
      origin: "https://example.com",
      pathname: "/source",
      contentScriptReady: true,
      authentication: "authenticated",
      authenticationContextRef: "auth-context-other",
      observationState: "ready",
      pageEpoch: "tab-43:1:test",
      observerCapabilityId: "test.page",
      revision: 1,
      observedAt: new Date().toISOString()
    });
    const service = new RuntimeResourceBindingService(persistence);
    expect(() => service.resolveForPlan(planWithBrowserCall())).toThrow(
      "BROWSER_PAGE_AMBIGUOUS:source"
    );
    persistence.close();
  });

  it("freezes an explicit single-Origin selection and resolves live state", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    const createSnapshot = service.prepare(
      plan(),
      selection,
      "operator"
    );
    expect(createSnapshot?.("run")).toMatchObject({
      runId: "run",
      bindings: {
        source: {
          sessionId: "session",
          browserInstanceId: "browser",
          tabId: 42,
          capabilityDigest: digest,
          origin: "https://example.com",
          pathname: "/source",
          pageEpoch: "tab-42:1:test",
          authentication: "authenticated"
        }
      }
    });
    const binding = createSnapshot?.("run").bindings.source!;
    expect(service.resolveBrowserBinding(binding)).toEqual({
      sessionId: "session",
      browserInstanceId: "browser",
      tabId: 42,
      windowId: 7,
      observationRevision: 1,
      capabilityDigest: digest,
      capabilities: ["browser.dom.read"],
      origin: "https://example.com",
      pathname: "/source",
      pageEpoch: "tab-42:1:test",
      observerCapabilityId: "test.page",
      authentication: "authenticated",
      authenticationContextRef: "auth-context-test",
      state: "available"
    });
    persistence.updateBrowserSession({
      id: "session",
      disconnectedAt: "2026-07-30T01:00:00.000Z"
    });
    expect(service.resolveBrowserBinding(binding)?.state).toBe("revoked");
    persistence.close();
  });

  it("binds one observed source among multiple allowed Origins and rejects missing capabilities", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    expect(
      service.prepare(
        plan(["https://example.com", "https://other.example"]),
        selection,
        "operator"
      )
    ).toBeTypeOf("function");
    expect(() =>
      service.prepare(
        plan(["https://other.example"]),
        selection,
        "operator"
      )
    ).toThrow("BROWSER_ORIGIN_MISMATCH");
    persistence.replaceBrowserCapabilities("session", []);
    expect(() =>
      service.prepare(plan(), selection, "operator")
    ).toThrow("lacks capabilities");
    persistence.close();
  });

  it("binds an optional generic page without Doudian authentication or shop identity", () => {
    const persistence = database();
    persistence.upsertBrowserPageObservation({
      sessionId: "session",
      browserInstanceId: "browser",
      tabId: 42,
      windowId: 7,
      origin: "https://example.com",
      pathname: "/source",
      contentScriptReady: true,
      authentication: "unknown",
      observationState: "ready",
      pageEpoch: "tab-42:1:test",
      observerCapabilityId: "test.page",
      revision: 2,
      observedAt: new Date().toISOString()
    });
    const service = new RuntimeResourceBindingService(persistence);
    const createSnapshot = service.prepare(
      plan(["https://example.com"], "optional"),
      {
        source: {
          ...selection.source,
          observationRevision: 2
        }
      },
      "operator"
    );
    expect(createSnapshot?.("generic-run").bindings.source).toMatchObject({
      authentication: "anonymous",
      origin: "https://example.com"
    });
    persistence.close();
  });

  it("requires membership evidence when the slot requires membership", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    expect(() =>
      service.prepare(
        plan(["https://example.com"], "membership"),
        selection,
        "operator"
      )
    ).toThrow("BROWSER_OBSERVATION_STALE");
    persistence.close();
  });

  it("requires the exact Node capability, not only aggregate permissions", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    expect(
      service.prepare(planWithBrowserCall(), selection, "operator")
    ).toBeTypeOf("function");
    persistence.replaceBrowserCapabilities("session", [
      {
        nodeId: "different.browser.read",
        nodeVersion: "1.0.0",
        riskLevel: "R1",
        permissions: ["browser.dom.read"]
      }
    ]);
    expect(() =>
      service.prepare(planWithBrowserCall(), selection, "operator")
    ).toThrow("BROWSER_NODE_CAPABILITY_MISSING");
    persistence.close();
  });

  it("requires exact Adapter identity and its minimum Extension version", () => {
    const exact = database({
      extensionVersion: "0.6.1",
      adapterVersion: "2.0.0"
    });
    publishAdapter(exact);
    expect(
      new RuntimeResourceBindingService(exact).prepare(
        planWithBrowserCall(true),
        selection,
        "operator"
      )
    ).toBeTypeOf("function");
    exact.close();

    for (const persistence of [
      database({
        extensionVersion: "0.6.1",
        adapterId: "",
        adapterVersion: ""
      }),
      database({
        extensionVersion: "0.6.1",
        adapterVersion: "1.0.0"
      }),
      database({
        extensionVersion: "0.6.0",
        adapterVersion: "2.0.0"
      })
    ]) {
      publishAdapter(persistence);
      expect(() =>
        new RuntimeResourceBindingService(persistence).prepare(
          planWithBrowserCall(true),
          selection,
          "operator"
        )
      ).toThrow("BROWSER_NODE_CAPABILITY_MISSING:source:browser.read@1.0.0");
      persistence.close();
    }
  });
});
