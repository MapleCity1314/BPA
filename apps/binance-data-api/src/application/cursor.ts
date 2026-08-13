import { createHash } from "node:crypto";

interface CursorPayload {
  v: 1;
  endpoint: string;
  fingerprint: string;
  seek: Record<string, string>;
}

function fingerprint(filters: Readonly<Record<string, string | undefined>>): string {
  const canonical = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function encodeCursor(
  endpoint: string,
  filters: Readonly<Record<string, string | undefined>>,
  seek: Record<string, string>
): string {
  const payload: CursorPayload = {
    v: 1,
    endpoint,
    fingerprint: fingerprint(filters),
    seek
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
  endpoint: string,
  filters: Readonly<Record<string, string | undefined>>,
  seekKeys: readonly string[]
): Record<string, string> | undefined {
  if (!cursor) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<CursorPayload>;
    if (
      payload.v !== 1 ||
      payload.endpoint !== endpoint ||
      payload.fingerprint !== fingerprint(filters) ||
      payload.seek === null ||
      typeof payload.seek !== "object" ||
      Array.isArray(payload.seek) ||
      Object.values(payload.seek).some((value) => typeof value !== "string") ||
      Object.keys(payload.seek).sort().join("\u0000") !==
        [...seekKeys].sort().join("\u0000")
    ) {
      throw new Error("cursor mismatch");
    }
    return payload.seek as Record<string, string>;
  } catch {
    throw new InvalidCursorError();
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Cursor is invalid for this endpoint or filter set");
    this.name = "InvalidCursorError";
  }
}
