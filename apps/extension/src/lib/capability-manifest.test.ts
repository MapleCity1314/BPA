import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import validateMessage from "@bpa/schemas/browser-protocol-v1.validator";
import {
  BROWSER_PROTOCOL,
  CAPABILITY_MANIFEST_DIGEST,
  capabilityReport,
  validPageEpoch,
  validateCapabilityRoute
} from "./capability-manifest.js";

const permissions = ["browser.dom.read", "browser.tabs.read"];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalJson(entry)}`
    )
    .join(",")}}`;
}

describe("extension capability manifest", () => {
  it("reports all pinned read-only capabilities without changing protocol v1", () => {
    expect(BROWSER_PROTOCOL).toBe("bpa.browser/1");
    expect(capabilityReport()).toEqual({
      capabilities: [
        {
          node_id: "doudian.shop.context.read",
          versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.2.0"
        },
        {
          node_id: "doudian.product.scope.collect",
          versions: ["1.0.0", "1.1.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.2.0"
        },
        {
          node_id: "doudian.product.scope.restore",
          versions: ["1.0.0"],
          risk_level: "R0",
          permissions: [
            "browser.dom.read",
            "browser.tabs.read",
            "browser.tabs.navigate"
          ],
          adapter_id: "doudian",
          adapter_version: "1.2.0"
        },
        {
          node_id: "doudian.product.editor.open",
          versions: ["1.0.0", "1.1.0"],
          risk_level: "R0",
          permissions: [
            "browser.dom.read",
            "browser.tabs.read",
            "browser.tabs.navigate"
          ],
          adapter_id: "doudian",
          adapter_version: "1.2.0"
        },
        {
          node_id: "doudian.editor.priority-items.inspect",
          versions: ["1.0.0", "1.1.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.2.0"
        }
      ],
      manifest_digest: CAPABILITY_MANIFEST_DIGEST
    });
    expect(CAPABILITY_MANIFEST_DIGEST).toBe(
      "sha256:70cb2ad0d566aa2e52de57a59388d58614fc98933fab01571a0bf48bda9c791c"
    );
    expect(
      `sha256:${createHash("sha256")
        .update(canonicalJson(capabilityReport().capabilities))
        .digest("hex")}`
    ).toBe(CAPABILITY_MANIFEST_DIGEST);
    expect(
      validateMessage({
        protocol: BROWSER_PROTOCOL,
        version: "1.0.0",
        message_id: "message-1",
        session_id: "session-1",
        seq: 1,
        sent_at: "2026-07-28T00:00:00.000Z",
        type: "capability.report",
        trace_id: "trace-1",
        payload: capabilityReport()
      })
    ).toBe(true);
  });

  it.each([
    {
      nodeId: "doudian.shop.context.read",
      nodeVersion: "1.3.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0"
    },
    {
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list"
    },
    {
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "1.1.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list"
    },
    {
      nodeId: "doudian.product.scope.restore",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: [
        "browser.dom.read",
        "browser.tabs.read",
        "browser.tabs.navigate"
      ]
    },
    {
      nodeId: "doudian.product.editor.open",
      nodeVersion: "1.1.0",
      currentUrl:
        "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit",
      grantedPermissions: [
        "browser.dom.read",
        "browser.tabs.read",
        "browser.tabs.navigate"
      ]
    },
    {
      nodeId: "doudian.editor.priority-items.inspect",
      nodeVersion: "1.1.0",
      currentUrl:
        "https://fxg.jinritemai.com/ffa/g/create?product_id=400001"
    }
  ])("accepts the exact route for $nodeId", (route) => {
    expect(
      validateCapabilityRoute({
        ...route,
        grantedPermissions: route.grantedPermissions ?? permissions
      })
    ).toMatchObject({ valid: true });
  });

  it.each([
    {
      expected: "UNKNOWN_ACTION",
      nodeId: "doudian.unknown",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: permissions
    },
    {
      expected: "UNSUPPORTED_NODE_VERSION",
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "2.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: permissions
    },
    {
      expected: "PAGE_ORIGIN_MISMATCH",
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "1.0.0",
      currentUrl: "https://example.com/ffa/g/list",
      grantedPermissions: permissions
    },
    {
      expected: "PAGE_PATH_MISMATCH",
      nodeId: "doudian.editor.priority-items.inspect",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: permissions
    },
    {
      expected: "PERMISSION_MISMATCH",
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: ["browser.dom.read"]
    }
  ])("rejects unsafe route: $expected", ({ expected, ...route }) => {
    expect(validateCapabilityRoute(route)).toEqual({
      valid: false,
      reason: expected
    });
  });

  it("binds page epochs to the expected tab", () => {
    const epoch = "tab-42:1722000000000:nonce-1";
    expect(validPageEpoch(epoch, 42)).toBe(true);
    expect(validPageEpoch(epoch, 41)).toBe(false);
    expect(validPageEpoch("42:https://example.com:1", 42)).toBe(false);
  });
});
