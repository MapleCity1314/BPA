export const CONTROL_PROTOCOL_VERSION = "bpa.control/1" as const;
export const CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;

export type ControlErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_METHOD"
  | "DEADLINE_EXCEEDED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INTERNAL";

export interface ControlRequestEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION;
  kind: "request";
  requestId: string;
  method: string;
  deadline: string;
  params: Record<string, unknown>;
}

export type ControlResponseEnvelope<TResult = unknown> =
  | {
      version: typeof CONTROL_PROTOCOL_VERSION;
      kind: "result";
      requestId: string;
      result: TResult;
    }
  | {
      version: typeof CONTROL_PROTOCOL_VERSION;
      kind: "error";
      requestId: string;
      error: {
        code: ControlErrorCode;
        message: string;
        details?: unknown;
      };
    };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ERROR_CODES = new Set<ControlErrorCode>([
  "INVALID_REQUEST",
  "UNKNOWN_METHOD",
  "DEADLINE_EXCEEDED",
  "CONFLICT",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "INTERNAL"
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function parseControlRequest(value: unknown): ControlRequestEnvelope {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "kind",
      "requestId",
      "method",
      "deadline",
      "params"
    ]) ||
    value.version !== CONTROL_PROTOCOL_VERSION ||
    value.kind !== "request" ||
    typeof value.requestId !== "string" ||
    !ID_PATTERN.test(value.requestId) ||
    typeof value.method !== "string" ||
    !METHOD_PATTERN.test(value.method) ||
    typeof value.deadline !== "string" ||
    !Number.isFinite(Date.parse(value.deadline)) ||
    !record(value.params)
  ) {
    throw new Error("Malformed control request envelope");
  }
  return value as unknown as ControlRequestEnvelope;
}

export function parseControlResponse<TResult = unknown>(
  value: unknown
): ControlResponseEnvelope<TResult> {
  if (
    !record(value) ||
    value.version !== CONTROL_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    !ID_PATTERN.test(value.requestId)
  ) {
    throw new Error("Malformed control response envelope");
  }
  if (
    value.kind === "result" &&
    exactKeys(value, ["version", "kind", "requestId", "result"])
  ) {
    return value as unknown as ControlResponseEnvelope<TResult>;
  }
  if (
    value.kind === "error" &&
    exactKeys(value, ["version", "kind", "requestId", "error"]) &&
    record(value.error) &&
    exactKeys(value.error, ["code", "message"], ["details"]) &&
    typeof value.error.code === "string" &&
    ERROR_CODES.has(value.error.code as ControlErrorCode) &&
    typeof value.error.message === "string" &&
    value.error.message.length > 0
  ) {
    return value as unknown as ControlResponseEnvelope<TResult>;
  }
  throw new Error("Malformed control response envelope");
}

export function encodeControlEnvelope(value: unknown): Uint8Array {
  const text = `${JSON.stringify(value)}\n`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > CONTROL_MAX_MESSAGE_BYTES) {
    throw new Error("Control message exceeds maximum size");
  }
  return bytes;
}

export function decodeControlEnvelope(bytes: Uint8Array): unknown {
  if (bytes.byteLength > CONTROL_MAX_MESSAGE_BYTES) {
    throw new Error("Control message exceeds maximum size");
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Control transport requires one newline-delimited envelope");
  }
  try {
    return JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("Control message is not valid JSON");
  }
}
