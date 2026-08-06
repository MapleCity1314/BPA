import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";

const digest = `sha256:${"a".repeat(64)}`;

function scenario(): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../docs/protocols/examples/authoring-scenario-spec-v1alpha1.example.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as unknown;
}

describe("Local Core Design Mode authorization", () => {
  it("binds an active Authoring Session to an exact available page resource", () => {
    const issuedAt = new Date().toISOString();
    const activatedAt = new Date(Date.parse(issuedAt) + 1_000).toISOString();
    const expiresAt = new Date(
      Date.parse(issuedAt) + 15 * 60_000
    ).toISOString();
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    expect(
      service.handle({
        id: "authoring-create",
        method: "authoring.session.create",
        params: {
          sessionId: "authoring.session-1",
          scenario: scenario(),
          actor: { type: "ai", id: "codex:local" },
          occurredAt: "2026-07-30T04:00:00.000Z"
        }
      }).ok
    ).toBe(true);
    persistence.openBrowserSession({
      session: {
        id: "browser-session-1",
        browserInstanceId: "browser-1",
        extensionId: "extension-1",
        extensionVersion: "0.5.0",
        protocolVersion: "1.0.0",
        incomingSeq: 0,
        outgoingSeq: 0,
        lastAckedCommandSeq: 0,
        capabilityDigest: digest,
        resumeTokenDigest: `sha256:${"b".repeat(64)}`,
        resumeTokenExpiresAt: "2026-07-31T00:00:00.000Z",
        connectedAt: "2026-07-30T04:00:00.000Z"
      },
      now: "2026-07-30T04:00:00.000Z"
    });
    persistence.upsertBrowserPageObservation({
      sessionId: "browser-session-1",
      browserInstanceId: "browser-1",
      tabId: 7,
      windowId: 3,
      origin: "https://www.chanmama.com",
      pathname: "/product/1001",
      contentScriptReady: true,
      authentication: "unknown",
      observationState: "ready",
      pageEpoch: "tab-7:1999999999999:design-1",
      observerCapabilityId: "chanmama.page",
      revision: 1,
      observedAt: issuedAt
    });
    const requested = service.handle({
      id: "design-request",
      method: "authoring.design-mode.request",
      params: {
        grantId: "design.grant-1",
        authoringSessionId: "authoring.session-1",
        approvedBy: "operator:test",
        browserSessionId: "browser-session-1",
        profileId: "chanmama.product-metrics",
        tabId: 7,
        origin: "https://www.chanmama.com",
        pageEpoch: "tab-7:1999999999999:design-1",
        screenshotApproved: false,
        issuedAt,
        expiresAt
      }
    });
    expect(requested).toMatchObject({
      ok: true,
      result: {
        state: "requested",
        revision: 0,
        allowedOperations: ["semantic_snapshot"]
      }
    });
    expect(
      persistence.getBrowserPageObservation("browser-session-1", 7)
    ).toMatchObject({
      origin: "https://www.chanmama.com",
      authentication: "unknown",
      observationState: "ready",
      revision: 1
    });
    expect(
      service.handle({
        id: "design-activate",
        method: "authoring.design-mode.activate",
        params: {
          grantId: "design.grant-1",
          expectedRevision: 0,
          actor: "operator:test",
          occurredAt: activatedAt
        }
      })
    ).toMatchObject({
      ok: true,
      result: { state: "active", revision: 1 }
    });

    expect(
      service.handle({
        id: "design-wrong-origin",
        method: "authoring.design-mode.request",
        params: {
          grantId: "design.grant-2",
          authoringSessionId: "authoring.session-1",
          approvedBy: "operator:test",
          browserSessionId: "browser-session-1",
          profileId: "chanmama.product-metrics",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          pageEpoch: "tab-7:1999999999999:design-2",
          screenshotApproved: false,
          issuedAt,
          expiresAt
        }
      })
    ).toMatchObject({ ok: false });
    persistence.close();
  });
});
