import {
  formatValidationErrors,
  validateBrowserProtocolMessage,
  type BrowserProtocolMessage
} from "@bpa/schemas";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject
} from "node:crypto";

export const BROWSER_PROTOCOL = "bpa.browser/2" as const;
export const BROWSER_PROTOCOL_VERSION = "2.0.0" as const;
export const BROWSER_PROTOCOL_MAX_MESSAGE_BYTES = 512 * 1024;
export const BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT = 4096;
export const EVIDENCE_CHUNK_BYTES = 256 * 1024;
export const RESUME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface PermissionGrantBody {
  grant_id: string;
  permissions: string[];
  domains: string[];
  risk_level: "R0" | "R1" | "R2" | "R3" | "R4";
  expires_at: string;
  run_id: string;
  node_execution_id: string;
  node_id: string;
  node_version: string;
  fencing_token: number;
  approval_ref?: string;
}

export interface SignedPermissionGrant extends PermissionGrantBody {
  key_id: string;
  grant_digest: string;
  authorization_tag: string;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function permissionGrantDigest(body: PermissionGrantBody): string {
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

export function signPermissionGrant(
  body: PermissionGrantBody,
  keyId: string,
  privateKey: KeyObject | string | Buffer
): SignedPermissionGrant {
  const grantDigest = permissionGrantDigest(body);
  const authorizationTag = sign(
    null,
    Buffer.from(grantDigest, "utf8"),
    typeof privateKey === "string" || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey
  ).toString("base64");
  return {
    ...body,
    key_id: keyId,
    grant_digest: grantDigest,
    authorization_tag: authorizationTag
  };
}

export function verifyPermissionGrant(
  grant: SignedPermissionGrant,
  publicKey: KeyObject | string | Buffer,
  at = new Date()
): boolean {
  if (Date.parse(grant.expires_at) <= at.getTime()) return false;
  const {
    key_id: _keyId,
    grant_digest: suppliedDigest,
    authorization_tag: authorizationTag,
    ...body
  } = grant;
  const expectedDigest = permissionGrantDigest(body);
  const supplied = Buffer.from(suppliedDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return false;
  }
  return verify(
    null,
    Buffer.from(expectedDigest, "utf8"),
    typeof publicKey === "string" || Buffer.isBuffer(publicKey)
      ? createPublicKey(publicKey)
      : publicKey,
    Buffer.from(authorizationTag, "base64")
  );
}

export function exportPublicKeySpkiBase64(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64");
}

export class ProtocolViolationError extends Error {
  constructor(
    readonly code:
      | "MESSAGE_TOO_LARGE"
      | "SCHEMA_INVALID"
      | "PROTOCOL_UPGRADE_REQUIRED"
      | "SESSION_MISMATCH"
      | "SEQUENCE_REPLAY"
      | "MESSAGE_REPLAY",
    message: string
  ) {
    super(message);
  }
}

export type ProtocolAcceptance =
  | { status: "accepted"; message: BrowserProtocolMessage }
  | { status: "duplicate"; message: BrowserProtocolMessage };

export class ProtocolSessionGuard {
  #sessionId: string | undefined;
  #lastSequence = -1;
  readonly #recentMessageIds = new Set<string>();

  establish(sessionId: string, lastSequence = 0): void {
    if (!sessionId || sessionId === "new") {
      throw new Error("Established session id must not be new");
    }
    this.#sessionId = sessionId;
    this.#lastSequence = lastSequence;
    this.#recentMessageIds.clear();
  }

  accept(value: unknown): ProtocolAcceptance {
    const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (encoded > BROWSER_PROTOCOL_MAX_MESSAGE_BYTES) {
      throw new ProtocolViolationError(
        "MESSAGE_TOO_LARGE",
        `Message is ${encoded} bytes; maximum is ${BROWSER_PROTOCOL_MAX_MESSAGE_BYTES}`
      );
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "protocol" in value &&
      (value as { protocol?: unknown }).protocol !== BROWSER_PROTOCOL
    ) {
      throw new ProtocolViolationError(
        "PROTOCOL_UPGRADE_REQUIRED",
        `Browser Bridge must use ${BROWSER_PROTOCOL}@${BROWSER_PROTOCOL_VERSION}`
      );
    }
    if (!validateBrowserProtocolMessage(value)) {
      throw new ProtocolViolationError(
        "SCHEMA_INVALID",
        formatValidationErrors(validateBrowserProtocolMessage.errors).join("; ")
      );
    }
    const message = value;
    if (this.#recentMessageIds.has(message.message_id)) {
      return { status: "duplicate", message };
    }
    const isHello = message.type === "session.hello";
    if (
      this.#sessionId &&
      !isHello &&
      message.session_id !== this.#sessionId
    ) {
      throw new ProtocolViolationError(
        "SESSION_MISMATCH",
        `Expected session ${this.#sessionId}; received ${message.session_id}`
      );
    }
    if (!isHello && message.seq <= this.#lastSequence) {
      throw new ProtocolViolationError(
        "SEQUENCE_REPLAY",
        `Sequence ${message.seq} is not greater than ${this.#lastSequence}`
      );
    }
    this.#recentMessageIds.add(message.message_id);
    if (
      this.#recentMessageIds.size >
      BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT
    ) {
      const oldest = this.#recentMessageIds.values().next().value;
      if (oldest !== undefined) this.#recentMessageIds.delete(oldest);
    }
    if (!isHello) this.#lastSequence = message.seq;
    return { status: "accepted", message };
  }
}

export {
  DEFAULT_BPA_EXTENSION_ID,
  assertNativeHostOrigin
} from "@bpa/native-host-contract";
export * from "./signing-key.js";
