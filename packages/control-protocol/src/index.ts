export const CONTROL_PROTOCOL_VERSION = "bpa.control/1" as const;
export const CONTROL_HELLO_PROTOCOL_VERSION = "bpa.control/hello/1" as const;
export const CONTROL_MAX_MESSAGE_BYTES = 512 * 1024;
export const CONTROL_MIN_NEGOTIATED_FRAME_BYTES = 4 * 1024;

export interface ControlRuntimeIdentity {
  name: string;
  version: string;
}

export interface ControlHelloRequestEnvelope {
  version: typeof CONTROL_HELLO_PROTOCOL_VERSION;
  kind: "hello";
  requestId: string;
  supportedApplicationProtocols: string[];
  runtime: ControlRuntimeIdentity;
  maxFrameBytes: number;
  features: string[];
}

export interface ControlHelloWelcomeEnvelope {
  version: typeof CONTROL_HELLO_PROTOCOL_VERSION;
  kind: "welcome";
  requestId: string;
  applicationProtocol: string;
  runtime: ControlRuntimeIdentity;
  maxFrameBytes: number;
  features: string[];
}

export type ControlHelloErrorCode =
  | "MALFORMED_HELLO"
  | "NO_COMMON_APPLICATION_PROTOCOL"
  | "FRAME_LIMIT_TOO_SMALL";

export interface ControlHelloErrorEnvelope {
  version: typeof CONTROL_HELLO_PROTOCOL_VERSION;
  kind: "error";
  requestId: string | null;
  error: {
    code: ControlHelloErrorCode;
    message: string;
  };
  connection: "close";
}

export type ControlHelloResponseEnvelope =
  | ControlHelloWelcomeEnvelope
  | ControlHelloErrorEnvelope;

export interface ControlHelloAdvertisement {
  supportedApplicationProtocols: string[];
  runtime: ControlRuntimeIdentity;
  maxFrameBytes: number;
  features: string[];
}

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
const PROTOCOL_PATTERN = /^[a-z][a-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;
const HELLO_ERROR_CODES = new Set<ControlHelloErrorCode>([
  "MALFORMED_HELLO",
  "NO_COMMON_APPLICATION_PROTOCOL",
  "FRAME_LIMIT_TOO_SMALL"
]);
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

function uniqueStrings(
  value: unknown,
  pattern: RegExp,
  minimumItems = 0
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimumItems &&
    value.every((item) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}

function validRuntime(value: unknown): value is ControlRuntimeIdentity {
  return (
    record(value) &&
    exactKeys(value, ["name", "version"]) &&
    typeof value.name === "string" &&
    RUNTIME_NAME_PATTERN.test(value.name) &&
    typeof value.version === "string" &&
    RUNTIME_VERSION_PATTERN.test(value.version)
  );
}

function validAdvertisedFrameLimit(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= CONTROL_MAX_MESSAGE_BYTES
  );
}

function validNegotiatedFrameLimit(value: unknown): value is number {
  return (
    validAdvertisedFrameLimit(value) &&
    value >= CONTROL_MIN_NEGOTIATED_FRAME_BYTES
  );
}

export function parseControlHelloRequest(
  value: unknown
): ControlHelloRequestEnvelope {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "kind",
      "requestId",
      "supportedApplicationProtocols",
      "runtime",
      "maxFrameBytes",
      "features"
    ]) ||
    value.version !== CONTROL_HELLO_PROTOCOL_VERSION ||
    value.kind !== "hello" ||
    typeof value.requestId !== "string" ||
    !ID_PATTERN.test(value.requestId) ||
    !uniqueStrings(value.supportedApplicationProtocols, PROTOCOL_PATTERN, 1) ||
    !validRuntime(value.runtime) ||
    !validAdvertisedFrameLimit(value.maxFrameBytes) ||
    !uniqueStrings(value.features, FEATURE_PATTERN)
  ) {
    throw new Error("Malformed control hello envelope");
  }
  return value as unknown as ControlHelloRequestEnvelope;
}

export function parseControlHelloResponse(
  value: unknown
): ControlHelloResponseEnvelope {
  if (
    !record(value) ||
    value.version !== CONTROL_HELLO_PROTOCOL_VERSION
  ) {
    throw new Error("Malformed control hello response envelope");
  }
  if (
    value.kind === "welcome" &&
    exactKeys(value, [
      "version",
      "kind",
      "requestId",
      "applicationProtocol",
      "runtime",
      "maxFrameBytes",
      "features"
    ]) &&
    typeof value.requestId === "string" &&
    ID_PATTERN.test(value.requestId) &&
    typeof value.applicationProtocol === "string" &&
    PROTOCOL_PATTERN.test(value.applicationProtocol) &&
    validRuntime(value.runtime) &&
    validNegotiatedFrameLimit(value.maxFrameBytes) &&
    uniqueStrings(value.features, FEATURE_PATTERN)
  ) {
    return value as unknown as ControlHelloWelcomeEnvelope;
  }
  if (
    value.kind === "error" &&
    exactKeys(value, [
      "version",
      "kind",
      "requestId",
      "error",
      "connection"
    ]) &&
    (value.requestId === null ||
      (typeof value.requestId === "string" &&
        ID_PATTERN.test(value.requestId))) &&
    record(value.error) &&
    exactKeys(value.error, ["code", "message"]) &&
    typeof value.error.code === "string" &&
    HELLO_ERROR_CODES.has(value.error.code as ControlHelloErrorCode) &&
    typeof value.error.message === "string" &&
    value.error.message.length > 0 &&
    value.connection === "close"
  ) {
    return value as unknown as ControlHelloErrorEnvelope;
  }
  throw new Error("Malformed control hello response envelope");
}

/**
 * Pure negotiation helper. A transport may use it after parsing the first
 * frame; it does not open, close, or otherwise mutate a connection.
 */
export function negotiateControlHello(
  request: ControlHelloRequestEnvelope,
  server: ControlHelloAdvertisement
): ControlHelloResponseEnvelope {
  const parsedRequest = parseControlHelloRequest(request);
  if (
    !uniqueStrings(server.supportedApplicationProtocols, PROTOCOL_PATTERN, 1) ||
    !validRuntime(server.runtime) ||
    !validAdvertisedFrameLimit(server.maxFrameBytes) ||
    !uniqueStrings(server.features, FEATURE_PATTERN)
  ) {
    throw new Error("Malformed server control hello advertisement");
  }
  const applicationProtocol = server.supportedApplicationProtocols.find(
    (protocol) =>
      parsedRequest.supportedApplicationProtocols.includes(protocol)
  );
  if (!applicationProtocol) {
    return {
      version: CONTROL_HELLO_PROTOCOL_VERSION,
      kind: "error",
      requestId: parsedRequest.requestId,
      error: {
        code: "NO_COMMON_APPLICATION_PROTOCOL",
        message: "No common control application protocol"
      },
      connection: "close"
    };
  }
  const maxFrameBytes = Math.min(
    parsedRequest.maxFrameBytes,
    server.maxFrameBytes,
    CONTROL_MAX_MESSAGE_BYTES
  );
  if (maxFrameBytes < CONTROL_MIN_NEGOTIATED_FRAME_BYTES) {
    return {
      version: CONTROL_HELLO_PROTOCOL_VERSION,
      kind: "error",
      requestId: parsedRequest.requestId,
      error: {
        code: "FRAME_LIMIT_TOO_SMALL",
        message: "Negotiated control frame limit is too small"
      },
      connection: "close"
    };
  }
  const clientFeatures = new Set(parsedRequest.features);
  return {
    version: CONTROL_HELLO_PROTOCOL_VERSION,
    kind: "welcome",
    requestId: parsedRequest.requestId,
    applicationProtocol,
    runtime: server.runtime,
    maxFrameBytes,
    features: server.features.filter((feature) => clientFeatures.has(feature))
  };
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
