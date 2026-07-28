import { describe, expect, it } from "vitest";
import {
  collectDoudianProductScope,
  legacyDoudianScopeCollectionResult,
  restoreDoudianProductScope,
  validateDoudianEditorTarget,
  validateDoudianScopeRestoreTarget,
  verifyDoudianEditorOpen
} from "./browser-actions.js";

interface FakeElementOptions {
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly queries?: Readonly<Record<string, readonly Element[]>>;
  readonly click?: () => void;
}

function element(options: FakeElementOptions = {}): Element {
  return {
    textContent: options.text ?? "",
    parentElement: undefined,
    hasAttribute(name: string) {
      return name in (options.attributes ?? {});
    },
    getAttribute(name: string) {
      return options.attributes?.[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
    querySelectorAll(selector: string) {
      return options.queries?.[selector] ?? [];
    },
    click: options.click
  } as unknown as Element;
}

describe("doudian read-only browser actions", () => {
  it("collects every page and restores the original page and scroll", async () => {
    let currentPage = 2;
    const navigation: number[] = [];
    const scroll = {
      scrollTop: 35,
      scrollHeight: 100,
      clientHeight: 100,
      scrollTo(options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
      }
    };
    const products = {
      1: { id: "400001", title: "脱敏商品一" },
      2: { id: "400002", title: "脱敏商品二" }
    } as const;
    const pageControls = [1, 2].map((page) =>
      element({
        text: String(page),
        attributes: { title: String(page) },
        click() {
          navigation.push(page);
          currentPage = page;
        }
      })
    );
    const currentProductRow = (): Element => {
      const product = products[currentPage as 1 | 2];
      return element({
        attributes: { "data-row-key": product.id },
        queries: {
          "a,div,span,p": [
            element({ text: product.title }),
            element({ text: `ID：${product.id}` })
          ]
        }
      });
    };
    const doc = {
      defaultView: {
        location: {
          href: "https://fxg.jinritemai.com/ffa/g/list?status=0"
        }
      },
      body: { innerText: "" },
      scrollingElement: scroll,
      querySelector(selector: string) {
        return selector === "tr[data-row-key]"
          ? currentProductRow()
          : null;
      },
      querySelectorAll(selector: string) {
        if (
          selector ===
          "[role='tab'][aria-selected='true'],[role='tab'][class*='active']"
        ) {
          return [
            element({
              text: "在售商品",
              attributes: { "data-tab-key": "selling" }
            })
          ];
        }
        if (
          selector ===
          "input:not([type='hidden']),[role='combobox'],[role='searchbox']"
        ) {
          return [];
        }
        if (
          selector ===
          ".ecom-g-pagination-total-text,[class*='pagination'] [class*='total']"
        ) {
          return [element({ text: "共 2 件" }), element({ text: "共 2 件" })];
        }
        if (
          selector ===
          ".ecom-g-pagination-item-active,[class*='pagination'] [aria-current='page']"
        ) {
          return [
            element({
              text: String(currentPage),
              attributes: { title: String(currentPage) }
            })
          ];
        }
        if (
          selector ===
          "[class*='pagination'] [title],[class*='pagination'] [data-page]"
        ) {
          return pageControls;
        }
        if (selector === "tr[data-row-key]") {
          return [currentProductRow()];
        }
        return [];
      }
    } as unknown as Document;

    const result = await collectDoudianProductScope(doc, {
      shop: { id: "shop-redacted", name: "脱敏旗舰店" },
      deadline: "2026-07-29T00:00:00.000Z",
      now: () => Date.parse("2026-07-28T00:00:00.000Z"),
      wait: async () => {}
    });

    expect(result).toMatchObject({
      status: "complete",
      collectorVersion: "1.1.0",
      expectedCount: 2,
      scanRounds: 2,
      products: [{ id: "400001" }, { id: "400002" }],
      inspectionQueue: [{ id: "400001" }, { id: "400002" }],
      restore: {
        listUrl: "https://fxg.jinritemai.com/ffa/g/list?status=0",
        page: 2,
        scrollTop: 35,
        shopId: "shop-redacted",
        shopName: "脱敏旗舰店",
        scopeDigest: expect.stringMatching(/^[a-f0-9]{8}$/u),
        required: true
      }
    });
    expect(currentPage).toBe(2);
    expect(scroll.scrollTop).toBe(35);
    expect(navigation).toEqual([1, 2, 1, 2]);
    expect(legacyDoudianScopeCollectionResult(result)).toMatchObject({
      collectorVersion: "1.0.0",
      restore: { page: 2, scrollTop: 35, required: true }
    });
    expect(
      legacyDoudianScopeCollectionResult(result).restore
    ).not.toHaveProperty("listUrl");

    currentPage = 1;
    scroll.scrollTop = 0;
    await expect(
      restoreDoudianProductScope(
        doc,
        result.restore as unknown as Readonly<Record<string, unknown>>,
        {
          deadline: "2026-07-29T00:00:00.000Z",
          now: () => Date.parse("2026-07-28T00:00:00.000Z"),
          wait: async () => {}
        }
      )
    ).resolves.toMatchObject({
      status: "restored",
      restoreVersion: "1.1.0",
      page: 2,
      scrollTop: 35,
      formMutations: 0
    });
    expect(currentPage).toBe(2);
    expect(scroll.scrollTop).toBe(35);
    expect(navigation).toEqual([1, 2, 1, 2, 2]);
    await expect(
      restoreDoudianProductScope(
        doc,
        {
          ...result.restore,
          scopeDigest: "deadbeef"
        },
        {
          deadline: "2026-07-29T00:00:00.000Z",
          now: () => Date.parse("2026-07-28T00:00:00.000Z"),
          wait: async () => {}
        }
      )
    ).rejects.toThrow("SCOPE_RESTORE_CONTEXT_MISMATCH");
    expect(navigation).toEqual([1, 2, 1, 2, 2]);
  });

  it("canonicalizes only the frozen Doudian editor target", () => {
    expect(
      validateDoudianEditorTarget({
        productId: "400001",
        editUrl:
          "https://fxg.jinritemai.com/ffa/g/create?entrance=edit&product_id=400001"
      })
    ).toEqual({
      productId: "400001",
      editUrl:
        "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit"
    });
    for (const editUrl of [
      "https://evil.example/ffa/g/create?product_id=400001&entrance=edit",
      "https://fxg.jinritemai.com/ffa/g/create?product_id=400002&entrance=edit",
      "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit&next=https://evil.example"
    ]) {
      expect(() =>
        validateDoudianEditorTarget({ productId: "400001", editUrl })
      ).toThrow("EDITOR_TARGET_INVALID");
    }
  });

  it("allows only a same-origin product-list restore target", () => {
    const valid = {
      listUrl:
        "https://fxg.jinritemai.com/ffa/g/list?status=0&keyword=redacted",
      page: 3,
      scrollTop: 438,
      shopId: "shop-1",
      shopName: "脱敏店铺",
      scopeDigest: "abcdef12",
      required: true
    };
    expect(
      validateDoudianScopeRestoreTarget(
        valid,
        "https://fxg.jinritemai.com/ffa/g/create?product_id=400001"
      )
    ).toEqual({
      listUrl: valid.listUrl,
      page: valid.page,
      scrollTop: valid.scrollTop,
      shopId: valid.shopId,
      shopName: valid.shopName,
      scopeDigest: valid.scopeDigest
    });
    for (const listUrl of [
      "https://evil.example/ffa/g/list",
      "https://fxg.jinritemai.com/ffa/g/create",
      "https://fxg.jinritemai.com/ffa/g/list#unsafe",
      "https://user:secret@fxg.jinritemai.com/ffa/g/list"
    ]) {
      expect(() =>
        validateDoudianScopeRestoreTarget(
          { ...valid, listUrl },
          "https://fxg.jinritemai.com/ffa/g/create?product_id=400001"
        )
      ).toThrow("SCOPE_RESTORE_TARGET_INVALID");
    }
  });

  it("requires three stable editor readiness samples after navigation", async () => {
    const editUrl =
      "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit";
    const visible = element({ text: "基础信息" });
    const editorSelectors = {
      controls:
        "main input:not([type='hidden']),main textarea,main [role='combobox'],main table,main [contenteditable='true']",
      anchors: "main div,main span,main h1,main h2,main h3",
      markers:
        "main span[class*='required'],main [aria-required='true'],main input[required],main textarea[required]",
      roots:
        "main [attr-field-id],main [data-field-id],main [class*='form-item']",
      loading:
        "main [aria-busy='true'],main [class*='spin-spinning'],main [class*='skeleton']",
      buttons: "main button",
      warnings:
        "[role='dialog'],main [role='alert'],main [class*='error-message'],main [class*='form-item-error']",
      tables: "main table"
    } as const;
    const doc = {
      defaultView: { location: { href: editUrl } },
      body: { innerText: "" },
      querySelector(selector: string) {
        return selector === "main" ? visible : null;
      },
      querySelectorAll(selector: string) {
        if (selector === editorSelectors.controls) return [visible];
        if (selector === editorSelectors.anchors) return [visible];
        if (
          selector === editorSelectors.markers ||
          selector === editorSelectors.roots ||
          selector === editorSelectors.loading ||
          selector === editorSelectors.buttons ||
          selector === editorSelectors.warnings ||
          selector === editorSelectors.tables
        ) {
          return [];
        }
        return [];
      }
    } as unknown as Document;
    const input = { productId: "400001", editUrl };
    await expect(
      verifyDoudianEditorOpen(doc, input, {
        deadline: "2026-07-29T00:00:00.000Z",
        now: () => Date.parse("2026-07-28T00:00:00.000Z"),
        wait: async () => {}
      })
    ).resolves.toMatchObject({
      status: "ready",
      productId: "400001",
      readiness: { stableSamples: 3, visibleControls: 1, knownAnchors: 1 },
      domMutations: 0
    });

    const loading = {
      ...doc,
      querySelectorAll(selector: string) {
        return selector === editorSelectors.loading
          ? [visible]
          : doc.querySelectorAll(selector);
      }
    } as unknown as Document;
    await expect(
      verifyDoudianEditorOpen(loading, input, {
        deadline: "2026-07-29T00:00:00.000Z",
        now: () => Date.parse("2026-07-28T00:00:00.000Z"),
        wait: async () => {}
      })
    ).rejects.toThrow("NAVIGATION_UNCERTAIN");
  });
});
