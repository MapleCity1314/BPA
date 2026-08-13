import { describe, expect, it, vi } from "vitest";
import {
  ContentActionOutcomeError,
  routeContentAction,
  type ContentActionHandlers,
  type ContentActionRequest
} from "./content-action-router.js";

const deadline = "2026-07-29T00:00:00.000Z";
const pageEpoch = "tab-7:1722000000000:nonce-1";
const permissions = ["browser.dom.read", "browser.tabs.read"];

function request(
  nodeId: string,
  input: Record<string, unknown> = {}
): ContentActionRequest {
  return {
    type: "bpa.execute",
    node: { id: nodeId, version: "1.0.0" },
    input,
    pageEpoch,
    grantedPermissions: permissions,
    deadline
  };
}

function handlers(): ContentActionHandlers {
  return {
    "binance.copy-trading.management.snapshot.read": vi.fn(async () => ({
      output: { schemaVersion: "binance-copy-trading/v0.1", projects: [] }
    })),
    "binance.copy-trading.project.detail.collect": vi.fn(async () => ({
      output: { schemaVersion: "binance-copy-trading/v0.1", tabs: [] }
    })),
    "ecommerce.marketplace.search-results.read": vi.fn(async () => ({
      output: { schemaVersion: "marketplace-probe/v0.1", items: [] }
    })),
    "browser.design.snapshot.capture": vi.fn(async () => ({
      output: {
        apiVersion: "bpa.authoring/v1alpha1",
        kind: "SemanticSnapshotCapture"
      }
    })),
    "doudian.shop.context.read": vi.fn(async () => ({
      output: { supported: true }
    })),
    "doudian.product.scope.collect": vi.fn(async () => ({
      output: { status: "complete", inspectionQueue: [] }
    })),
    "doudian.product.scope.restore": vi.fn(async () => ({
      output: { status: "restored", formMutations: 0 }
    })),
    "doudian.inventory.product.snapshot.read": vi.fn(async () => ({
      output: { status: "complete", formMutations: 0 }
    })),
    "doudian.product.editor.open": vi.fn(async () => ({
      output: { status: "ready", domMutations: 0 }
    })),
    "doudian.editor.priority-items.inspect": vi.fn(async () => ({
      output: { status: "complete", domMutations: 0 }
    }))
  };
}

describe("content action router", () => {
  it("allows only the bounded optional Binance project target", async () => {
    const actions = handlers();
    const validRequest = {
      ...request("binance.copy-trading.management.snapshot.read", {
        projectId: "project_1001"
      }),
      node: {
        id: "binance.copy-trading.management.snapshot.read",
        version: "1.5.0"
      },
      grantedPermissions: [
        "browser.dom.read",
        "browser.dom.write",
        "browser.tabs.read"
      ]
    };
    await expect(routeContentAction({
      request: validRequest,
      currentUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
      handlers: actions,
      now: Date.parse("2026-07-28T00:00:00.000Z")
    })).resolves.toMatchObject({ response: { ok: true } });

    for (const invalidInput of [
      { projectId: "bad id" },
      { projectId: "project_1001", extra: true }
    ]) {
      await expect(routeContentAction({
        request: { ...validRequest, input: invalidInput },
        currentUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })).resolves.toMatchObject({
        response: {
          ok: false,
          error: { code: "BINANCE_PROJECT_TARGET_INVALID" }
        }
      });
    }
  });

  it("binds a marketplace probe to the declared platform origin", async () => {
    const actions = handlers();
    await expect(
      routeContentAction({
        request: request("ecommerce.marketplace.search-results.read", {
          platform: "JD",
          query: "预包装煎饼",
          maxItems: 20
        }),
        currentUrl: "https://search.jd.com/Search?keyword=%E9%A2%84%E5%8C%85%E8%A3%85%E7%85%8E%E9%A5%BC",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({ response: { ok: true } });
    await expect(
      routeContentAction({
        request: request("ecommerce.marketplace.search-results.read", {
          platform: "TAOBAO",
          query: "预包装煎饼",
          maxItems: 20
        }),
        currentUrl: "https://search.jd.com/Search?keyword=x",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: { ok: false, error: { code: "MARKETPLACE_INPUT_INVALID" } }
    });
  });
  it("routes a known capability and preserves the page epoch", async () => {
    const actions = handlers();
    await expect(
      routeContentAction({
        request: request("doudian.product.scope.collect"),
        currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toEqual({
      handled: true,
      response: {
        ok: true,
        output: { status: "complete", inspectionQueue: [] },
        pageEpoch
      }
    });
    expect(actions["doudian.product.scope.collect"]).toHaveBeenCalledOnce();
  });

  it("routes Design Mode capture only with the exact governed input", async () => {
    const actions = handlers();
    const designRequest = {
      ...request("browser.design.snapshot.capture", {
        authoringSessionId: "authoring.session-1",
        designGrantId: "design.grant-1",
        pageState: "product.detail",
        profileId: "chanmama.product-metrics",
        pageEpoch
      }),
      grantedPermissions: [...permissions, "page-model.design.read"]
    };
    await expect(
      routeContentAction({
        request: designRequest,
        currentUrl: "https://www.chanmama.com/product/1001",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: true,
        output: {
          apiVersion: "bpa.authoring/v1alpha1",
          kind: "SemanticSnapshotCapture"
        }
      }
    });

    await expect(
      routeContentAction({
        request: {
          ...designRequest,
          input: {
            authoringSessionId: "authoring.session-1",
            designGrantId: "design.grant-1",
            pageState: "product.detail",
            profileId: "chanmama.product-metrics",
            pageEpoch,
            script: "return document.cookie"
          }
        },
        currentUrl: "https://www.chanmama.com/product/1001",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: false,
        error: { code: "DESIGN_CAPTURE_INPUT_INVALID" }
      }
    });
  });

  it("rejects unknown actions instead of silently ignoring them", async () => {
    const actions = handlers();
    await expect(
      routeContentAction({
        request: request("doudian.product.write"),
        currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      handled: true,
      response: { ok: false, error: { code: "UNKNOWN_ACTION" } }
    });
    expect(
      Object.values(actions).every(
        (handler) => !vi.mocked(handler).mock.calls.length
      )
    ).toBe(true);
  });

  it("requires editor URL and product identity to match exactly", async () => {
    const actions = handlers();
    const input = {
      product: {
        id: "400001",
        title: "脱敏商品",
        editorUrl:
          "https://fxg.jinritemai.com/ffa/g/create?product_id=400001"
      }
    };
    await expect(
      routeContentAction({
        request: request(
          "doudian.editor.priority-items.inspect",
          input
        ),
        currentUrl:
          "https://fxg.jinritemai.com/ffa/g/create?product_id=400002",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: { ok: false, error: { code: "EDITOR_URL_MISMATCH" } }
    });
    expect(
      actions["doudian.editor.priority-items.inspect"]
    ).not.toHaveBeenCalled();
  });

  it("accepts only adapter-validated editor navigation destinations", async () => {
    const actions = handlers();
    const editUrl =
      "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit";
    await expect(
      routeContentAction({
        request: {
          ...request("doudian.product.editor.open", {
            productId: "400001",
            editUrl
          }),
          grantedPermissions: [...permissions, "browser.tabs.navigate"]
        },
        currentUrl: editUrl,
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: true,
        output: { status: "ready", domMutations: 0 }
      }
    });
    await expect(
      routeContentAction({
        request: {
          ...request("doudian.product.editor.open", {
            productId: "400001",
            editUrl:
              "https://evil.example/ffa/g/create?product_id=400001&entrance=edit"
          }),
          grantedPermissions: [...permissions, "browser.tabs.navigate"]
        },
        currentUrl: editUrl,
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: { ok: false, error: { code: "EDITOR_TARGET_INVALID" } }
    });
  });

  it("routes only an exact same-origin list restore target", async () => {
    const actions = handlers();
    const listUrl =
      "https://fxg.jinritemai.com/ffa/g/list?status=0&keyword=redacted";
    const restore = {
      listUrl,
      page: 3,
      scrollTop: 438,
      shopId: "shop-1",
      shopName: "脱敏店铺",
      scopeDigest: "abcdef12",
      required: true
    };
    await expect(
      routeContentAction({
        request: {
          ...request("doudian.product.scope.restore", restore),
          grantedPermissions: [...permissions, "browser.tabs.navigate"]
        },
        currentUrl: listUrl,
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: true,
        output: { status: "restored", formMutations: 0 }
      }
    });
    await expect(
      routeContentAction({
        request: {
          ...request("doudian.product.scope.restore", {
            ...restore,
            listUrl: "https://evil.example/ffa/g/list"
          }),
          grantedPermissions: [...permissions, "browser.tabs.navigate"]
        },
        currentUrl: listUrl,
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: false,
        error: { code: "SCOPE_RESTORE_TARGET_INVALID" }
      }
    });
  });

  it.each([
    {
      name: "missing permission",
      patch: { grantedPermissions: ["browser.dom.read"] },
      code: "PERMISSION_MISMATCH"
    },
    {
      name: "invalid page epoch",
      patch: { pageEpoch: "https://sensitive.example/evidence" },
      code: "PAGE_EPOCH_INVALID"
    },
    {
      name: "expired deadline",
      patch: { deadline: "2026-07-27T00:00:00.000Z" },
      code: "DEADLINE_EXCEEDED"
    }
  ])("rejects $name before dispatch", async ({ patch, code }) => {
    const actions = handlers();
    await expect(
      routeContentAction({
        request: {
          ...request("doudian.product.scope.collect"),
          ...patch
        },
        currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: { ok: false, error: { code } }
    });
    expect(
      actions["doudian.product.scope.collect"]
    ).not.toHaveBeenCalled();
  });

  it("rejects a page change observed after the handler", async () => {
    const actions = handlers();
    await expect(
      routeContentAction({
        request: request("doudian.product.scope.collect"),
        currentUrl: "https://fxg.jinritemai.com/ffa/g/list",
        readCurrentUrl: () =>
          "https://fxg.jinritemai.com/ffa/g/create?product_id=400001",
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: { ok: false, error: { code: "PAGE_CONTEXT_CHANGED" } }
    });
  });

  it("preserves retryable inspection diagnostics as a failed action", async () => {
    const actions: ContentActionHandlers = {
      ...handlers(),
      "doudian.editor.priority-items.inspect": vi.fn(async () => {
        throw new ContentActionOutcomeError(
          "PAGE_NOT_STABLE",
          "编辑页仍在加载。",
          {
            status: "retryable",
            baselineInspectionPerformed: false,
            anomalies: [{ code: "PAGE_NOT_STABLE", retryable: true }]
          },
          true
        );
      })
    };
    const editorUrl =
      "https://fxg.jinritemai.com/ffa/g/create?product_id=400001";
    await expect(
      routeContentAction({
        request: request("doudian.editor.priority-items.inspect", {
          product: {
            id: "400001",
            title: "脱敏商品",
            editorUrl
          }
        }),
        currentUrl: editorUrl,
        handlers: actions,
        now: Date.parse("2026-07-28T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      response: {
        ok: false,
        output: {
          status: "retryable",
          anomalies: [{ code: "PAGE_NOT_STABLE" }]
        },
        error: { code: "PAGE_NOT_STABLE", retryable: true }
      }
    });
  });
});
