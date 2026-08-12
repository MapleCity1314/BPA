import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_PROTOCOL_MAX_MESSAGE_BYTES,
  BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT,
  ProtocolSessionGuard,
  ProtocolViolationError,
  assertNativeHostOrigin,
  signPermissionGrant,
  verifyPermissionGrant
} from "./index.js";

const examples = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/protocols/examples/browser-protocol-v2.messages.json",
      import.meta.url
    ),
    "utf8"
  )
) as Array<Record<string, unknown>>;

describe("browser protocol v1", () => {
  it("accepts every normative example", () => {
    const bridgeToGateway = new ProtocolSessionGuard();
    const gatewayToBridge = new ProtocolSessionGuard();
    const hello = bridgeToGateway.accept(examples[0]);
    expect(hello.status).toBe("accepted");
    bridgeToGateway.establish("session-01", 0);
    gatewayToBridge.establish("session-01", 0);
    const gatewayTypes = new Set([
      "session.welcome",
      "session.resume",
      "page.probe.request",
      "command.dispatch",
      "result.ack",
      "cancel.request",
      "heartbeat.ping",
      "session.error",
      "evidence.ack"
    ]);
    for (const example of examples.slice(1)) {
      const guard = gatewayTypes.has(String(example.type))
        ? gatewayToBridge
        : bridgeToGateway;
      expect(guard.accept(example).status).toBe("accepted");
    }
    expect(new Set(examples.map((example) => example.type))).toEqual(
      new Set([
        "session.hello",
        "session.welcome",
        "session.resume",
        "capability.report",
        "page.observation",
        "page.probe.request",
        "page.probe.result",
        "command.dispatch",
        "command.ack",
        "command.result",
        "result.ack",
        "cancel.request",
        "cancel.ack",
        "cancel.effective",
        "heartbeat.ping",
        "heartbeat.pong",
        "session.error",
        "evidence.begin",
        "evidence.chunk",
        "evidence.complete",
        "evidence.ack"
      ])
    );
  });

  it("rejects unknown fields", () => {
    const guard = new ProtocolSessionGuard();
    expect(() =>
      guard.accept({ ...examples[0], unexpected: true })
    ).toThrow(ProtocolViolationError);
  });

  it("deduplicates message ids but rejects stale sequences", () => {
    const guard = new ProtocolSessionGuard();
    guard.establish("session-01", 0);
    const message = examples[1]!;
    expect(guard.accept(message).status).toBe("accepted");
    expect(guard.accept(message).status).toBe("duplicate");
    expect(() =>
      guard.accept({
        ...examples[2],
        message_id: "different-message",
        seq: 1
      })
    ).toThrow(/not greater/);
  });

  it("bounds duplicate tracking for a long-lived browser session", () => {
    const guard = new ProtocolSessionGuard();
    guard.establish("session-01", 0);
    const template = examples[1]!;
    for (
      let sequence = 1;
      sequence <= BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT + 1;
      sequence += 1
    ) {
      expect(
        guard.accept({
          ...template,
          message_id: `message-${sequence}`,
          seq: sequence
        }).status
      ).toBe("accepted");
    }
    expect(
      guard.accept({
        ...template,
        message_id: `message-${BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT + 1}`,
        seq: BROWSER_PROTOCOL_RECENT_MESSAGE_ID_LIMIT + 1
      }).status
    ).toBe("duplicate");
    expect(() =>
      guard.accept({
        ...template,
        message_id: "message-1",
        seq: 1
      })
    ).toThrow(/not greater/);
  });

  it("rejects application messages larger than 512 KiB", () => {
    const guard = new ProtocolSessionGuard();
    expect(() =>
      guard.accept({
        ...examples[0],
        padding: "x".repeat(BROWSER_PROTOCOL_MAX_MESSAGE_BYTES)
      })
    ).toThrow(/maximum/);
  });

  it("binds the native host to one exact extension origin", () => {
    expect(() =>
      assertNativeHostOrigin(
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      )
    ).toThrow(/rejected/);
    expect(() =>
      assertNativeHostOrigin(
        "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      )
    ).not.toThrow();
  });

  it("detects expired or modified permission grants", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = {
      grant_id: "grant-01",
      permissions: ["browser.dom.read"],
      domains: ["https://fxg.jinritemai.com"],
      risk_level: "R0" as const,
      expires_at: "2026-07-28T06:00:00.000Z",
      run_id: "run-01",
      node_execution_id: "node-execution-01",
      node_id: "doudian.shop.context.read",
      node_version: "1.0.0",
      fencing_token: 1
    };
    const signed = signPermissionGrant(body, "core-key-01", privateKey);
    expect(
      verifyPermissionGrant(signed, publicKey, new Date("2026-07-27T06:00:00Z"))
    ).toBe(true);
    expect(
      verifyPermissionGrant(
        { ...signed, permissions: ["browser.dom.write"] },
        publicKey,
        new Date("2026-07-27T06:00:00Z")
      )
    ).toBe(false);
    expect(
      verifyPermissionGrant(signed, publicKey, new Date("2026-07-29T06:00:00Z"))
    ).toBe(false);
  });
});
