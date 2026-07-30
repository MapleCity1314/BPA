import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import type { ExecutionPlan } from "@bpa/workflow-ir";
import { RuntimeResourceBindingService } from "./runtime-resource-bindings.js";

const digest = `sha256:${"a".repeat(64)}`;

function plan(
  allowedOrigins = ["https://example.com"]
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
        authentication: "authenticated",
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

function database(): SqlitePersistence {
  const persistence = new SqlitePersistence({ path: ":memory:" });
  persistence.openBrowserSession({
    session: {
      id: "session",
      browserInstanceId: "browser",
      extensionId: "extension",
      extensionVersion: "0.4.0",
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
      permissions: ["browser.dom.read"]
    }
  ]);
  return persistence;
}

describe("RuntimeResourceBindingService", () => {
  it("freezes an explicit single-Origin selection and resolves live state", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    const createSnapshot = service.prepare(
      plan(),
      { source: "session" },
      "operator"
    );
    expect(createSnapshot?.("run")).toMatchObject({
      runId: "run",
      bindings: {
        source: {
          sessionId: "session",
          capabilityDigest: digest,
          origin: "https://example.com",
          authentication: "authenticated"
        }
      }
    });
    expect(service.resolveBrowserSession("session")).toEqual({
      sessionId: "session",
      capabilityDigest: digest,
      capabilities: ["browser.dom.read"],
      origin: "https://example.com",
      authentication: "authenticated",
      state: "available"
    });
    persistence.updateBrowserSession({
      id: "session",
      disconnectedAt: "2026-07-30T01:00:00.000Z"
    });
    expect(service.resolveBrowserSession("session")?.state).toBe("revoked");
    persistence.close();
  });

  it("refuses ambiguous Origins and missing reported capabilities", () => {
    const persistence = database();
    const service = new RuntimeResourceBindingService(persistence);
    expect(() =>
      service.prepare(
        plan(["https://example.com", "https://other.example"]),
        { source: "session" },
        "operator"
      )
    ).toThrow("requires an explicit Origin observation");
    persistence.replaceBrowserCapabilities("session", []);
    expect(() =>
      service.prepare(plan(), { source: "session" }, "operator")
    ).toThrow("lacks capabilities");
    persistence.close();
  });
});
