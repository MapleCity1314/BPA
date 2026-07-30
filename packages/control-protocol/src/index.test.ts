import { describe, expect, it } from "vitest";
import {
  CONTROL_HELLO_PROTOCOL_VERSION,
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_MIN_NEGOTIATED_FRAME_BYTES,
  CONTROL_PROTOCOL_VERSION,
  decodeControlEnvelope,
  encodeControlEnvelope,
  negotiateControlHello,
  parseControlHelloRequest,
  parseControlHelloResponse,
  parseControlRequest,
  parseControlResponse
} from "./index.js";

const request = {
  version: CONTROL_PROTOCOL_VERSION,
  kind: "request" as const,
  requestId: "request-1",
  method: "task.list",
  deadline: "2026-07-28T00:00:10.000Z",
  params: {}
};

const hello = {
  version: CONTROL_HELLO_PROTOCOL_VERSION,
  kind: "hello" as const,
  requestId: "hello-1",
  supportedApplicationProtocols: [
    CONTROL_PROTOCOL_VERSION,
    "bpa.control/2"
  ],
  runtime: { name: "bpa-cli", version: "0.4.0" },
  maxFrameBytes: CONTROL_MAX_MESSAGE_BYTES,
  features: ["task-center", "evidence-links"]
};

describe("control protocol envelopes", () => {
  it("round-trips a versioned request", () => {
    expect(
      parseControlRequest(decodeControlEnvelope(encodeControlEnvelope(request)))
    ).toEqual(request);
  });

  it("rejects unknown fields, malformed ids and invalid deadlines", () => {
    expect(() =>
      parseControlRequest({ ...request, unexpected: true })
    ).toThrow(/Malformed/);
    expect(() =>
      parseControlRequest({ ...request, requestId: "bad id" })
    ).toThrow(/Malformed/);
    expect(() =>
      parseControlRequest({ ...request, deadline: "tomorrow" })
    ).toThrow(/Malformed/);
  });

  it("accepts result/error responses and rejects unknown error codes", () => {
    expect(
      parseControlResponse({
        version: CONTROL_PROTOCOL_VERSION,
        kind: "result",
        requestId: "request-1",
        result: { ok: true }
      })
    ).toMatchObject({ kind: "result" });
    expect(
      parseControlResponse({
        version: CONTROL_PROTOCOL_VERSION,
        kind: "error",
        requestId: "request-1",
        error: { code: "CONFLICT", message: "stale revision" }
      })
    ).toMatchObject({ kind: "error" });
    expect(() =>
      parseControlResponse({
        version: CONTROL_PROTOCOL_VERSION,
        kind: "error",
        requestId: "request-1",
        error: { code: "MADE_UP", message: "bad" }
      })
    ).toThrow(/Malformed/);
  });

  it("rejects malformed framing and oversize payloads", () => {
    expect(() =>
      decodeControlEnvelope(new TextEncoder().encode("{}"))
    ).toThrow(/newline/);
    expect(() =>
      decodeControlEnvelope(new TextEncoder().encode("{}\n{}\n"))
    ).toThrow(/one newline/);
    expect(() =>
      encodeControlEnvelope({ value: "x".repeat(CONTROL_MAX_MESSAGE_BYTES) })
    ).toThrow(/maximum/);
    expect(() =>
      decodeControlEnvelope(new Uint8Array(CONTROL_MAX_MESSAGE_BYTES + 1))
    ).toThrow(/maximum/);
    expect(() =>
      decodeControlEnvelope(new TextEncoder().encode("{broken}\n"))
    ).toThrow(/valid JSON/);
  });

  it("accepts a valid frame at exactly 512 KiB", () => {
    const payload = `${JSON.stringify({
      value: "x".repeat(CONTROL_MAX_MESSAGE_BYTES - 13)
    })}\n`;
    const bytes = new TextEncoder().encode(payload);
    expect(bytes.byteLength).toBe(CONTROL_MAX_MESSAGE_BYTES);
    expect(decodeControlEnvelope(bytes)).toMatchObject({
      value: expect.any(String)
    });
    expect(CONTROL_MAX_MESSAGE_BYTES).toBe(512 * 1024);
  });
});

describe("control hello negotiation", () => {
  const server = {
    supportedApplicationProtocols: [CONTROL_PROTOCOL_VERSION],
    runtime: { name: "bpa-core", version: "0.4.0" },
    maxFrameBytes: 256 * 1024,
    features: ["evidence-links", "resource-bindings"]
  };

  it("strictly parses the small hello advertisement", () => {
    expect(parseControlHelloRequest(hello)).toEqual(hello);
    expect(() =>
      parseControlHelloRequest({ ...hello, selector: "#core" })
    ).toThrow(/Malformed/);
    expect(() =>
      parseControlHelloRequest({
        ...hello,
        supportedApplicationProtocols: []
      })
    ).toThrow(/Malformed/);
    expect(() =>
      parseControlHelloRequest({
        ...hello,
        features: ["task-center", "task-center"]
      })
    ).toThrow(/Malformed/);
    expect(() =>
      parseControlHelloRequest({
        ...hello,
        maxFrameBytes: CONTROL_MAX_MESSAGE_BYTES + 1
      })
    ).toThrow(/Malformed/);
  });

  it("chooses server preference, the smaller frame limit and common features", () => {
    const response = negotiateControlHello(hello, server);
    expect(response).toEqual({
      version: CONTROL_HELLO_PROTOCOL_VERSION,
      kind: "welcome",
      requestId: "hello-1",
      applicationProtocol: CONTROL_PROTOCOL_VERSION,
      runtime: server.runtime,
      maxFrameBytes: 256 * 1024,
      features: ["evidence-links"]
    });
    expect(parseControlHelloResponse(response)).toEqual(response);
  });

  it("returns a structured close response when no application protocol matches", () => {
    const response = negotiateControlHello(
      {
        ...hello,
        supportedApplicationProtocols: ["bpa.control/9"]
      },
      server
    );
    expect(response).toMatchObject({
      kind: "error",
      requestId: "hello-1",
      error: { code: "NO_COMMON_APPLICATION_PROTOCOL" },
      connection: "close"
    });
    expect(parseControlHelloResponse(response)).toEqual(response);
  });

  it("defines malformed hello errors as unbound and connection-closing", () => {
    const malformed = {
      version: CONTROL_HELLO_PROTOCOL_VERSION,
      kind: "error",
      requestId: null,
      error: {
        code: "MALFORMED_HELLO",
        message: "Malformed initial control frame"
      },
      connection: "close"
    } as const;
    expect(parseControlHelloResponse(malformed)).toEqual(malformed);
    expect(() =>
      parseControlHelloResponse({ ...malformed, connection: "continue" })
    ).toThrow(/Malformed/);
  });

  it("closes with a structured error when the common frame limit is unusable", () => {
    expect(
      negotiateControlHello(hello, {
        ...server,
        maxFrameBytes: CONTROL_MIN_NEGOTIATED_FRAME_BYTES - 1
      })
    ).toMatchObject({
      kind: "error",
      error: { code: "FRAME_LIMIT_TOO_SMALL" },
      connection: "close"
    });
    expect(() =>
      negotiateControlHello(hello, { ...server, maxFrameBytes: 0 })
    ).toThrow(/server/);
  });
});
