export interface BridgeCapability {
  nodeId: string;
  nodeVersion: string;
  riskLevel: string;
  permissions: string[];
}

export interface SignedGrant {
  grant_id: string;
  permissions: string[];
  domains: string[];
  risk_level: string;
  expires_at: string;
  run_id: string;
  node_execution_id: string;
  node_id: string;
  node_version: string;
  fencing_token: number;
  approval_ref?: string;
  key_id: string;
  grant_digest: string;
  authorization_tag: string;
}

export interface BrowserCommandPayload {
  run_id: string;
  node_execution_id: string;
  fencing_token: number;
  node: { id: string; version: string };
  permission_grant: SignedGrant;
  deadline: string;
  timing_policy?: TimingPolicy;
}

export function createPageEpoch(
  tabId: number,
  at = Date.now(),
  nonce = globalThis.crypto.randomUUID()
): string {
  return `tab-${tabId}:${at}:${nonce}`;
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

function base64Bytes(value: string): ArrayBuffer {
  const binary = globalThis.atob(value);
  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0)
  ).buffer as ArrayBuffer;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyCommandAuthorization(input: {
  command: BrowserCommandPayload;
  publicKeySpkiBase64: string;
  keyId: string;
  capability: BridgeCapability;
  currentUrl: string;
  at?: Date;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  const { command, capability } = input;
  const grant = command.permission_grant;
  const at = input.at ?? new Date();
  if (grant.key_id !== input.keyId) {
    return { valid: false, reason: "SIGNING_KEY_MISMATCH" };
  }
  if (
    grant.run_id !== command.run_id ||
    grant.node_execution_id !== command.node_execution_id ||
    grant.node_id !== command.node.id ||
    grant.node_version !== command.node.version ||
    grant.fencing_token !== command.fencing_token
  ) {
    return { valid: false, reason: "GRANT_COMMAND_BINDING_MISMATCH" };
  }
  if (
    capability.nodeId !== command.node.id ||
    capability.nodeVersion !== command.node.version ||
    capability.riskLevel !== grant.risk_level ||
    grant.permissions.some(
      (permission) => !capability.permissions.includes(permission)
    )
  ) {
    return { valid: false, reason: "CAPABILITY_MISMATCH" };
  }
  if (
    Date.parse(grant.expires_at) <= at.getTime() ||
    Date.parse(command.deadline) <= at.getTime()
  ) {
    return { valid: false, reason: "COMMAND_EXPIRED" };
  }
  let currentOrigin: string;
  try {
    currentOrigin = new URL(input.currentUrl).origin;
  } catch {
    return { valid: false, reason: "PAGE_URL_INVALID" };
  }
  if (
    !grant.domains.some((domain) => {
      try {
        return new URL(domain).origin === currentOrigin;
      } catch {
        return false;
      }
    })
  ) {
    return { valid: false, reason: "PAGE_ORIGIN_NOT_GRANTED" };
  }
  const {
    key_id: _keyId,
    grant_digest: suppliedDigest,
    authorization_tag: authorizationTag,
    ...body
  } = grant;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(body))
  );
  const expectedDigest = `sha256:${hex(digest)}`;
  if (expectedDigest !== suppliedDigest) {
    return { valid: false, reason: "GRANT_DIGEST_MISMATCH" };
  }
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      base64Bytes(input.publicKeySpkiBase64),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const verified = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64Bytes(authorizationTag),
      new TextEncoder().encode(expectedDigest)
    );
    return verified
      ? { valid: true }
      : { valid: false, reason: "AUTHORIZATION_TAG_INVALID" };
  } catch {
    return { valid: false, reason: "AUTHORIZATION_TAG_INVALID" };
  }
}
import type { TimingPolicy } from "@bpa/schemas";
