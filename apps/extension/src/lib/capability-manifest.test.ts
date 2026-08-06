import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import validateMessage from "@bpa/schemas/browser-protocol-v2.validator";
import {
  BROWSER_PROTOCOL,
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
  it("derives the complete protocol v2 report and digest from one registry", async () => {
    expect(BROWSER_PROTOCOL).toBe("bpa.browser/2");
    const report = await capabilityReport();
    expect(report.features).toEqual([
      "page_observation_v2",
      "exact_tab_binding_v2",
      "active_page_probe_v1"
    ]);
    expect(report.capabilities).toHaveLength(12);
    expect(report.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node_id: "ecommerce.marketplace.search-results.read",
          risk_level: "R1",
          adapter_id: "marketplace-search"
        }),
        expect.objectContaining({
          node_id: "doudian.alliance.shop.retired-products.scan",
          adapter_id: "doudian-alliance",
          routes: expect.arrayContaining([
            {
              origin: "https://fxg.jinritemai.com",
              pathname_prefixes: ["/ffa/g/list"],
              observer_capability_id: "doudian.page"
            },
            {
              origin: "https://buyin.jinritemai.com",
              pathname_prefixes: ["/dashboard"],
              observer_capability_id: "buyin.page"
            }
          ])
        })
      ])
    );
    const { manifest_digest: manifestDigest, ...projection } = report;
    expect(
      `sha256:${createHash("sha256")
        .update(canonicalJson(projection))
        .digest("hex")}`
    ).toBe(manifestDigest);
    expect(
      validateMessage({
        protocol: BROWSER_PROTOCOL,
        version: "2.0.0",
        message_id: "message-1",
        session_id: "session-1",
        seq: 1,
        sent_at: "2026-07-28T00:00:00.000Z",
        type: "capability.report",
        trace_id: "trace-1",
        payload: report
      })
    ).toBe(true);
  });

  it.each([
    {
      nodeId: "browser.design.snapshot.capture",
      nodeVersion: "1.0.0",
      currentUrl: "https://www.chanmama.com/product/1001",
      grantedPermissions: [
        "browser.dom.read",
        "browser.tabs.read",
        "page-model.design.read"
      ]
    },
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
      nodeId: "doudian.inventory.product.snapshot.read",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: [
        "browser.dom.read",
        "browser.dom.write",
        "browser.tabs.read"
      ]
    },
    {
      nodeId: "doudian.orders.recent.read",
      nodeVersion: "1.2.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/morder/order/list",
      grantedPermissions: [
        "browser.dom.read",
        "browser.dom.write",
        "browser.tabs.read"
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
    },
    {
      nodeId: "doudian.alliance.shop.retired-products.scan",
      nodeVersion: "1.0.0",
      currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
      grantedPermissions: [
        "browser.dom.read",
        "browser.dom.write",
        "browser.tabs.read",
        "browser.tabs.navigate"
      ]
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
