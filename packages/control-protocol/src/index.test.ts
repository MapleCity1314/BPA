import { describe, expect, it } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  decodeControlEnvelope,
  encodeControlEnvelope,
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
      encodeControlEnvelope({ value: "x".repeat(1024 * 1024) })
    ).toThrow(/maximum/);
    expect(() =>
      decodeControlEnvelope(new Uint8Array(1024 * 1024 + 1))
    ).toThrow(/maximum/);
    expect(() =>
      decodeControlEnvelope(new TextEncoder().encode("{broken}\n"))
    ).toThrow(/valid JSON/);
  });
});
