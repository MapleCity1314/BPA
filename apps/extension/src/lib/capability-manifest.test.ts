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

describe("extension capability manifest", () => {
  it("reports all pinned read-only capabilities without changing protocol v1", () => {
    expect(BROWSER_PROTOCOL).toBe("bpa.browser/1");
    expect(capabilityReport()).toEqual({
      capabilities: [
        {
          node_id: "doudian.shop.context.read",
          versions: ["1.0.0", "1.1.0", "1.2.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.1.0"
        },
        {
          node_id: "doudian.product.scope.collect",
          versions: ["1.0.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.1.0"
        },
        {
          node_id: "doudian.product.editor.open",
          versions: ["1.0.0"],
          risk_level: "R0",
          permissions: [
            "browser.dom.read",
            "browser.tabs.read",
            "browser.tabs.navigate"
          ],
          adapter_id: "doudian",
          adapter_version: "1.1.0"
        },
        {
          node_id: "doudian.editor.priority-items.inspect",
          versions: ["1.0.0"],
          risk_level: "R0",
          permissions,
          adapter_id: "doudian",
          adapter_version: "1.1.0"
        }
      ],
      manifest_digest: CAPABILITY_MANIFEST_DIGEST
    });
    expect(CAPABILITY_MANIFEST_DIGEST).toBe(
      "sha256:46b9dd94f854528a4c28b5709c68e614d959c65057120a48cc35c6bd3e9519b3"
    );
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
      nodeVersion: "1.2.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0"
    },
    {
      nodeId: "doudian.product.scope.collect",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list"
    },
    {
      nodeId: "doudian.product.editor.open",
      nodeVersion: "1.0.0",
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
      nodeVersion: "1.0.0",
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
