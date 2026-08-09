import {
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import type {
  BrowserPageObservationRecord,
  Persistence,
  RecoverySessionRecord
} from "@bpa/persistence";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 15 * 60;
const MAX_OBSERVATION_AGE_MS = 30_000;

export interface PublicRecoverySession {
  id: string;
  attentionId: string;
  revision: number;
  state: RecoverySessionRecord["state"];
  requestedBy: string;
  browserSessionId: string;
  browserInstanceId: string;
  profileId: string;
  tabId: number;
  origin: string;
  initialPageEpoch: string;
  issuedAt: string;
  expiresAt: string;
  updatedAt: string;
  activatedAt?: string;
  completedAt?: string;
  completionPageEpoch?: string;
  terminalReason?: string;
}

export interface IssueRecoverySessionRequest {
  attentionId: string;
  requestedBy: string;
  browserSessionId: string;
  browserInstanceId: string;
  profileId: string;
  tabId: number;
  origin: string;
  pageEpoch: string;
  ttlSeconds: number;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function assertCanonicalHttpsOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("RECOVERY_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("RECOVERY_ORIGIN_INVALID");
  }
}

function assertFresh(page: BrowserPageObservationRecord, now: string): void {
  const age = Date.parse(now) - Date.parse(page.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_OBSERVATION_AGE_MS) {
    throw new Error("RECOVERY_PAGE_OBSERVATION_STALE");
  }
}

function isAuthenticationBlocked(page: BrowserPageObservationRecord): boolean {
  return (
    page.observationState === "auth_required" ||
    page.observationState === "challenge" ||
    !["authenticated", "membership"].includes(page.authentication)
  );
}

function publicRecord(record: RecoverySessionRecord): PublicRecoverySession {
  return {
    id: record.id,
    attentionId: record.attentionId,
    revision: record.revision,
    state: record.state,
    requestedBy: record.requestedBy,
    browserSessionId: record.browserSessionId,
    browserInstanceId: record.browserInstanceId,
    profileId: record.profileId,
    tabId: record.tabId,
    origin: record.origin,
    initialPageEpoch: record.initialPageEpoch,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
    ...(record.activatedAt === undefined
      ? {}
      : { activatedAt: record.activatedAt }),
    ...(record.completedAt === undefined
      ? {}
      : { completedAt: record.completedAt }),
    ...(record.completionPageEpoch === undefined
      ? {}
      : { completionPageEpoch: record.completionPageEpoch }),
    ...(record.terminalReason === undefined
      ? {}
      : { terminalReason: record.terminalReason })
  };
}

export class RecoverySessionService {
  constructor(
    private readonly persistence: Persistence,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly idFactory: () => string = randomUUID,
    private readonly tokenFactory: () => string = () =>
      randomBytes(32).toString("base64url")
  ) {}

  issue(input: IssueRecoverySessionRequest): {
    session: PublicRecoverySession;
    token: string;
  } {
    const now = this.#expire();
    const attention = this.persistence.getAttention(input.attentionId);
    if (
      !attention ||
      attention.state !== "open" ||
      !attention.item.blocking ||
      attention.item.groupKey !== "authentication"
    ) {
      throw new Error("RECOVERY_ATTENTION_NOT_ELIGIBLE");
    }
    if (
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < MIN_TTL_SECONDS ||
      input.ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error("RECOVERY_TTL_INVALID");
    }
    if (input.profileId !== input.browserInstanceId) {
      throw new Error("RECOVERY_PROFILE_BINDING_INVALID");
    }
    assertCanonicalHttpsOrigin(input.origin);
    const browser = this.persistence.getBrowserSession(input.browserSessionId);
    const page = this.persistence.getBrowserPageObservation(
      input.browserSessionId,
      input.tabId
    );
    if (
      !browser ||
      browser.disconnectedAt ||
      browser.browserInstanceId !== input.browserInstanceId ||
      !page ||
      page.browserInstanceId !== input.browserInstanceId ||
      page.origin !== input.origin ||
      page.pageEpoch !== input.pageEpoch
    ) {
      throw new Error("RECOVERY_PAGE_BINDING_MISMATCH");
    }
    assertFresh(page, now);
    if (!isAuthenticationBlocked(page)) {
      throw new Error("RECOVERY_AUTHENTICATION_NOT_BLOCKED");
    }
    const token = this.tokenFactory();
    if (token.length < 32) throw new Error("RECOVERY_TOKEN_INVALID");
    const record = this.persistence.issueRecoverySession({
      id: this.idFactory(),
      attentionId: input.attentionId,
      requestedBy: input.requestedBy,
      browserSessionId: input.browserSessionId,
      browserInstanceId: input.browserInstanceId,
      profileId: input.profileId,
      tabId: input.tabId,
      origin: input.origin,
      initialPageEpoch: input.pageEpoch,
      tokenDigest: tokenDigest(token),
      issuedAt: now,
      expiresAt: new Date(
        Date.parse(now) + input.ttlSeconds * 1_000
      ).toISOString()
    });
    return { session: publicRecord(record), token };
  }

  list(limit = 100): PublicRecoverySession[] {
    this.#expire();
    return this.persistence
      .listRecoverySessions({ limit })
      .map(publicRecord);
  }

  activate(input: {
    id: string;
    expectedRevision: number;
    token: string;
    actor: string;
  }): PublicRecoverySession {
    const now = this.#expire();
    const current = this.#activeBinding(input.id, "issued", now);
    const page = this.persistence.getBrowserPageObservation(
      current.browserSessionId,
      current.tabId
    )!;
    if (page.pageEpoch !== current.initialPageEpoch) {
      this.#invalidate(current, input.actor, now, "RECOVERY_PAGE_EPOCH_CHANGED");
      throw new Error("RECOVERY_PAGE_BINDING_MISMATCH");
    }
    if (!isAuthenticationBlocked(page)) {
      throw new Error("RECOVERY_AUTHENTICATION_NOT_BLOCKED");
    }
    return publicRecord(
      this.persistence.activateRecoverySession({
        id: input.id,
        expectedRevision: input.expectedRevision,
        tokenDigest: tokenDigest(input.token),
        actor: input.actor,
        activatedAt: now
      })
    );
  }

  complete(input: {
    id: string;
    expectedRevision: number;
    actor: string;
  }): PublicRecoverySession {
    const now = this.#expire();
    const current = this.#activeBinding(input.id, "active", now);
    const page = this.persistence.getBrowserPageObservation(
      current.browserSessionId,
      current.tabId
    )!;
    if (
      page.observationState !== "ready" ||
      !page.contentScriptReady ||
      !["authenticated", "membership"].includes(page.authentication) ||
      !page.authenticationContextRef
    ) {
      throw new Error("RECOVERY_AUTHENTICATION_NOT_PROVEN");
    }
    return publicRecord(
      this.persistence.completeRecoverySession({
        id: input.id,
        expectedRevision: input.expectedRevision,
        actor: input.actor,
        completedAt: now,
        completionPageEpoch: page.pageEpoch
      })
    );
  }

  revoke(input: {
    id: string;
    expectedRevision: number;
    actor: string;
  }): PublicRecoverySession {
    const now = this.#expire();
    return publicRecord(
      this.persistence.terminateRecoverySession({
        id: input.id,
        expectedRevision: input.expectedRevision,
        nextState: "revoked",
        actor: input.actor,
        occurredAt: now,
        reason: "RECOVERY_SESSION_REVOKED"
      })
    );
  }

  #expire(): string {
    const now = this.now();
    this.persistence.expireRecoverySessions({
      now,
      actor: "system:recovery-expiry"
    });
    return now;
  }

  #activeBinding(
    id: string,
    state: "issued" | "active",
    now: string
  ): RecoverySessionRecord {
    const current = this.persistence.getRecoverySession(id);
    if (!current || current.state !== state) {
      throw new Error("RECOVERY_SESSION_STATE_INVALID");
    }
    const browser = this.persistence.getBrowserSession(
      current.browserSessionId
    );
    const page = this.persistence.getBrowserPageObservation(
      current.browserSessionId,
      current.tabId
    );
    if (
      !browser ||
      browser.disconnectedAt ||
      browser.browserInstanceId !== current.browserInstanceId ||
      !page ||
      page.browserInstanceId !== current.browserInstanceId ||
      page.origin !== current.origin
    ) {
      this.#invalidate(
        current,
        "system:recovery-binding",
        now,
        "RECOVERY_PAGE_BINDING_LOST"
      );
      throw new Error("RECOVERY_PAGE_BINDING_MISMATCH");
    }
    assertFresh(page, now);
    return current;
  }

  #invalidate(
    current: RecoverySessionRecord,
    actor: string,
    occurredAt: string,
    reason: string
  ): void {
    this.persistence.terminateRecoverySession({
      id: current.id,
      expectedRevision: current.revision,
      nextState: "invalidated",
      actor,
      occurredAt,
      reason
    });
  }
}
