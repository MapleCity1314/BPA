import { describe, expect, it } from "vitest";
import { resolveNavigationTarget } from "./navigation-target.js";

describe("reviewed Doudian navigation target", () => {
  const currentUrl =
    "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit";
  const restore = {
    listUrl:
      "https://fxg.jinritemai.com/ffa/g/list?status=0&keyword=redacted",
    page: 3,
    scrollTop: 438,
    shopId: "shop-1",
    shopName: "脱敏店铺",
    scopeDigest: "abcdef12",
    required: true
  };

  it("allows the exact same-origin product-list restore", () => {
    expect(
      resolveNavigationTarget({
        nodeId: "doudian.product.scope.restore",
        payloadInput: restore,
        currentUrl
      })
    ).toEqual({
      valid: true,
      executionUrl: restore.listUrl,
      navigate: true
    });
  });

  it.each([
    "https://evil.example/ffa/g/list",
    "https://fxg.jinritemai.com/ffa/g/create",
    "https://fxg.jinritemai.com/ffa/g/list#unsafe",
    "https://user:secret@fxg.jinritemai.com/ffa/g/list"
  ])("rejects restore navigation to %s", (listUrl) => {
    expect(
      resolveNavigationTarget({
        nodeId: "doudian.product.scope.restore",
        payloadInput: { ...restore, listUrl },
        currentUrl
      })
    ).toEqual({
      valid: false,
      reason: "SCOPE_RESTORE_TARGET_INVALID"
    });
  });

  it("keeps non-navigation actions on the current URL", () => {
    expect(
      resolveNavigationTarget({
        nodeId: "doudian.editor.priority-items.inspect",
        payloadInput: {},
        currentUrl
      })
    ).toEqual({
      valid: true,
      executionUrl: currentUrl,
      navigate: false
    });
  });
});
