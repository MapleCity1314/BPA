import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AttentionDeliveryRecord,
  AttentionRecord,
  BrowserPageObservationRecord,
  BrowserSessionRecord,
  ExecutionEventRecord,
  RunRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { RecoverySessionService } from "./recovery-session.js";

const issuedAt = "2026-08-09T08:00:00.000Z";
const attentionId = "run-terminal:run-recovery";

function browserSession(): BrowserSessionRecord {
  return {
    id: "browser-session-recovery",
    browserInstanceId: "managed-doudian-profile",
    extensionId: "extension-recovery",
    extensionVersion: "0.6.0",
    protocolVersion: "1.0.0",
    incomingSeq: 0,
    outgoingSeq: 0,
    lastAckedCommandSeq: 0,
    capabilityDigest: `sha256:${"a".repeat(64)}`,
    resumeTokenDigest: `sha256:${"b".repeat(64)}`,
    resumeTokenExpiresAt: "2026-08-10T00:00:00.000Z",
    connectedAt: issuedAt
  };
}

function page(
  overrides: Partial<BrowserPageObservationRecord> = {}
): BrowserPageObservationRecord {
  return {
    sessionId: "browser-session-recovery",
    browserInstanceId: "managed-doudian-profile",
    tabId: 42,
    origin: "https://fxg.jinritemai.com",
    pathname: "/ffa/morder/logistics",
    contentScriptReady: true,
    authentication: "anonymous",
    observationState: "auth_required",
    pageEpoch: "page-epoch-before-login",
    observerCapabilityId: "doudian.inventory.page",
    revision: 1,
    observedAt: issuedAt,
    reasonCode: "SESSION_EXPIRED",
    ...overrides
  };
}

function terminalAttention(): AttentionRecord {
  return {
    item: {
      id: attentionId,
      runId: "run-recovery",
      stageKey: "collect",
      groupKey: "authentication",
      kind: "blocking",
      source: "browser",
      title: "浏览器登录或验证需要处理",
      reason: "浏览器返回了登录阻断。",
      requestedAction: "人工恢复后显式创建新 Run。",
      blocking: true,
      batchable: false,
      attemptedActions: [],
      resumesAutomatically: false,
      createdAt: issuedAt
    },
    state: "open",
    revision: 0
  };
}

function delivery(): AttentionDeliveryRecord {
  const payload = { attentionId, runId: "run-recovery" };
  return {
    id: "delivery:run-recovery",
    attentionId,
    channel: "operator-notification",
    idempotencyKey: "attention:run-recovery:operator-notification",
    requestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`,
    payload,
    state: "pending",
    revision: 0,
    attempt: 0,
    createdAt: issuedAt,
    updatedAt: issuedAt
  };
}

function seed(path = ":memory:"): SqlitePersistence {
  const persistence = new SqlitePersistence({ path });
  const run: RunRecord = {
    id: "run-recovery",
    workflowId: "doudian.inventory.refresh",
    workflowVersion: "1.0.0",
    workflowDigest: `sha256:${"c".repeat(64)}`,
    status: "running",
    revision: 0,
    input: {},
    createdAt: issuedAt,
    updatedAt: issuedAt
  };
  const event = (sequence: number, type: string): ExecutionEventRecord => ({
    id: `event-recovery-${sequence}`,
    runId: run.id,
    sequence,
    type,
    payload: {},
    occurredAt: issuedAt
  });
  persistence.createRun({ run, event: event(1, "RUN_CREATED") });
  persistence.commitRunTransition({
    runId: run.id,
    expectedRevision: 0,
    nextStatus: "rejected",
    attention: terminalAttention(),
    attentionDelivery: delivery(),
    event: event(2, "RUN_REJECTED")
  });
  persistence.openBrowserSession({
    session: browserSession(),
    now: issuedAt
  });
  persistence.upsertBrowserPageObservation(page());
  return persistence;
}

function request() {
  return {
    attentionId,
    expectedAttentionRevision: 0,
    requestedBy: "operator:test",
    browserSessionId: "browser-session-recovery",
    browserInstanceId: "managed-doudian-profile",
    profileId: "managed-doudian-profile",
    tabId: 42,
    origin: "https://fxg.jinritemai.com",
    pageEpoch: "page-epoch-before-login",
    ttlSeconds: 300
  };
}

describe("RecoverySessionService", () => {
  it("issues one token, fences the browser resource and never exposes its digest", () => {
    const persistence = seed();
    const service = new RecoverySessionService(
      persistence,
      () => issuedAt,
      () => "recovery-1",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );

    const issued = service.issue(request());

    expect(issued).toMatchObject({
      token: "one-time-token-with-at-least-thirty-two-bytes",
      session: {
        id: "recovery-1",
        state: "issued",
        revision: 0,
        browserInstanceId: "managed-doudian-profile",
        tabId: 42
      }
    });
    expect(JSON.stringify(issued.session)).not.toContain("tokenDigest");
    expect(
      persistence.acquireBrowserControlLease({
        resourceId: "browser-instance:managed-doudian-profile",
        ownerId: "workflow:competing",
        now: "2026-08-09T08:00:01.000Z",
        ttlSeconds: 120
      })
    ).toBeUndefined();
    expect(() => service.issue(request())).toThrow(
      "Attention already has a Recovery Session"
    );
    expect(persistence.listAudit("recovery-session:recovery-1"))
      .toEqual([
        expect.objectContaining({ action: "recovery-session.issued" })
      ]);
    persistence.close();
  });

  it("consumes the token once and releases the lease only after fresh authenticated proof", () => {
    const persistence = seed();
    let now = issuedAt;
    const service = new RecoverySessionService(
      persistence,
      () => now,
      () => "recovery-2",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );
    service.issue(request());

    now = "2026-08-09T08:00:05.000Z";
    persistence.upsertBrowserPageObservation(
      page({ revision: 2, observedAt: now })
    );
    const active = service.activate({
      id: "recovery-2",
      expectedRevision: 0,
      token: "one-time-token-with-at-least-thirty-two-bytes",
      actor: "operator:test"
    });
    expect(active).toMatchObject({ state: "active", revision: 1 });
    expect(() =>
      service.activate({
        id: "recovery-2",
        expectedRevision: 1,
        token: "one-time-token-with-at-least-thirty-two-bytes",
        actor: "operator:test"
      })
    ).toThrow("RECOVERY_SESSION_STATE_INVALID");
    expect(() =>
      service.complete({
        id: "recovery-2",
        expectedRevision: 1,
        actor: "operator:test"
      })
    ).toThrow("RECOVERY_AUTHENTICATION_NOT_PROVEN");

    now = "2026-08-09T08:00:10.000Z";
    persistence.upsertBrowserPageObservation(
      page({
        revision: 3,
        observedAt: now,
        pageEpoch: "page-epoch-after-login",
        authentication: "authenticated",
        authenticationContextRef: "auth-context-shop-1",
        observationState: "ready"
      })
    );
    const completed = service.complete({
      id: "recovery-2",
      expectedRevision: 1,
      actor: "operator:test"
    });
    expect(completed).toMatchObject({
      state: "completed",
      revision: 2,
      completionPageEpoch: "page-epoch-after-login"
    });
    expect(persistence.getAttention(attentionId)).toMatchObject({
      state: "open",
      revision: 0
    });
    expect(
      persistence.acquireBrowserControlLease({
        resourceId: "browser-instance:managed-doudian-profile",
        ownerId: "workflow:new-run",
        now: "2026-08-09T08:00:11.000Z",
        ttlSeconds: 120
      })
    ).toMatchObject({ ownerId: "workflow:new-run", fencingToken: 2 });
    expect(
      persistence
        .listAudit("recovery-session:recovery-2")
        .map((record) => record.action)
    ).toEqual([
      "recovery-session.issued",
      "recovery-session.activated",
      "recovery-session.completed"
    ]);
    persistence.close();
  });

  it("does not issue while a workflow owns the browser and does not consume a wrong token", () => {
    const persistence = seed();
    const workflowLease = persistence.acquireBrowserControlLease({
      resourceId: "browser-instance:managed-doudian-profile",
      ownerId: "workflow:running",
      now: issuedAt,
      ttlSeconds: 120
    })!;
    const service = new RecoverySessionService(
      persistence,
      () => issuedAt,
      () => "recovery-busy",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );

    expect(() => service.issue(request())).toThrow(
      "Recovery Session browser resource is busy"
    );
    expect(persistence.getRecoverySession("recovery-busy")).toBeUndefined();
    expect(
      persistence.releaseBrowserControlLease({
        resourceId: workflowLease.resourceId,
        ownerId: workflowLease.ownerId,
        fencingToken: workflowLease.fencingToken,
        releasedAt: "2026-08-09T08:00:01.000Z"
      })
    ).toBe(true);
    const available = new RecoverySessionService(
      persistence,
      () => "2026-08-09T08:00:02.000Z",
      () => "recovery-available",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );
    persistence.upsertBrowserPageObservation(
      page({ revision: 2, observedAt: "2026-08-09T08:00:02.000Z" })
    );
    available.issue(request());
    expect(() =>
      available.activate({
        id: "recovery-available",
        expectedRevision: 0,
        token: "wrong-token",
        actor: "operator:test"
      })
    ).toThrow("Recovery Session cannot be activated");
    expect(persistence.getRecoverySession("recovery-available")).toMatchObject({
      state: "issued",
      revision: 0
    });
    persistence.close();
  });

  it("invalidates an issued session when the exact page epoch changes", () => {
    const persistence = seed();
    let now = issuedAt;
    const service = new RecoverySessionService(
      persistence,
      () => now,
      () => "recovery-3",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );
    service.issue(request());
    now = "2026-08-09T08:00:03.000Z";
    persistence.upsertBrowserPageObservation(
      page({
        revision: 2,
        observedAt: now,
        pageEpoch: "unexpected-page-epoch"
      })
    );

    expect(() =>
      service.activate({
        id: "recovery-3",
        expectedRevision: 0,
        token: "one-time-token-with-at-least-thirty-two-bytes",
        actor: "operator:test"
      })
    ).toThrow("RECOVERY_PAGE_BINDING_MISMATCH");
    expect(persistence.getRecoverySession("recovery-3")).toMatchObject({
      state: "invalidated",
      terminalReason: "RECOVERY_PAGE_EPOCH_CHANGED"
    });
    persistence.close();
  });

  it("expires without activation and lets a workflow acquire the resource", () => {
    const persistence = seed();
    let now = issuedAt;
    const service = new RecoverySessionService(
      persistence,
      () => now,
      () => "recovery-4",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );
    service.issue({ ...request(), ttlSeconds: 60 });
    now = "2026-08-09T08:01:00.000Z";

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: "recovery-4",
        state: "expired",
        terminalReason: "RECOVERY_SESSION_EXPIRED"
      })
    ]);
    expect(
      persistence.acquireBrowserControlLease({
        resourceId: "browser-instance:managed-doudian-profile",
        ownerId: "workflow:after-expiry",
        now,
        ttlSeconds: 120
      })
    ).toMatchObject({ ownerId: "workflow:after-expiry", fencingToken: 2 });
    persistence.close();
  });

  it("recovers the issued session and its browser fence after a Core restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-recovery-session-"));
    const databasePath = join(directory, "bpa.sqlite3");
    try {
      const first = seed(databasePath);
      const issuer = new RecoverySessionService(
        first,
        () => issuedAt,
        () => "recovery-restart",
        () => "one-time-token-with-at-least-thirty-two-bytes"
      );
      issuer.issue(request());
      first.close();

      const second = new SqlitePersistence({ path: databasePath });
      const recovered = new RecoverySessionService(
        second,
        () => "2026-08-09T08:00:02.000Z"
      );
      expect(recovered.list()).toEqual([
        expect.objectContaining({
          id: "recovery-restart",
          state: "issued",
          revision: 0
        })
      ]);
      expect(
        second.acquireBrowserControlLease({
          resourceId: "browser-instance:managed-doudian-profile",
          ownerId: "workflow:restart-race",
          now: "2026-08-09T08:00:02.000Z",
          ttlSeconds: 120
        })
      ).toBeUndefined();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("invalidates immediately and releases the fence when the browser disconnects", () => {
    const persistence = seed();
    const service = new RecoverySessionService(
      persistence,
      () => issuedAt,
      () => "recovery-disconnect",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );
    service.issue(request());

    persistence.updateBrowserSession({
      id: "browser-session-recovery",
      disconnectedAt: "2026-08-09T08:00:05.000Z"
    });

    expect(persistence.getRecoverySession("recovery-disconnect")).toMatchObject({
      state: "invalidated",
      revision: 1,
      terminalReason: "RECOVERY_BROWSER_DISCONNECTED"
    });
    expect(
      persistence.acquireBrowserControlLease({
        resourceId: "browser-instance:managed-doudian-profile",
        ownerId: "workflow:after-disconnect",
        now: "2026-08-09T08:00:06.000Z",
        ttlSeconds: 120
      })
    ).toMatchObject({ ownerId: "workflow:after-disconnect", fencingToken: 2 });
    expect(
      persistence
        .listAudit("recovery-session:recovery-disconnect")
        .map((record) => record.action)
    ).toEqual([
      "recovery-session.issued",
      "recovery-session.invalidated"
    ]);
    persistence.close();
  });

  it("rejects non-authentication Attention, profile aliases and non-HTTPS origins", () => {
    const persistence = seed();
    const service = new RecoverySessionService(
      persistence,
      () => issuedAt,
      () => "recovery-5",
      () => "one-time-token-with-at-least-thirty-two-bytes"
    );

    expect(() =>
      service.issue({ ...request(), expectedAttentionRevision: 1 })
    ).toThrow("RECOVERY_ATTENTION_NOT_ELIGIBLE");
    expect(() =>
      service.issue({ ...request(), profileId: "another-profile" })
    ).toThrow("RECOVERY_PROFILE_BINDING_INVALID");
    expect(() =>
      service.issue({ ...request(), origin: "http://fxg.jinritemai.com" })
    ).toThrow("RECOVERY_ORIGIN_INVALID");
    persistence.close();
  });
});
