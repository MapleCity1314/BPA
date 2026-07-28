import { describe, expect, it } from "vitest";
import {
  readDoudianEditorDom,
  readDoudianScopeDom
} from "./dom-readers.js";

interface FakeElementOptions {
  text?: string;
  value?: string;
  disabled?: boolean;
  attributes?: Readonly<Record<string, string>>;
  queries?: Readonly<Record<string, readonly Element[]>>;
  closest?: Readonly<Record<string, Element>>;
}

function fakeElement(options: FakeElementOptions = {}): Element {
  const attributes = options.attributes ?? {};
  const queries = options.queries ?? {};
  const closest = options.closest ?? {};
  return {
    textContent: options.text ?? "",
    value: options.value,
    disabled: options.disabled ?? false,
    hasAttribute(name: string) {
      return name in attributes;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: 120, height: 24 };
    },
    querySelectorAll(selector: string) {
      return queries[selector] ?? [];
    },
    querySelector(selector: string) {
      return queries[selector]?.[0] ?? null;
    },
    closest(selector: string) {
      return closest[selector] ?? null;
    }
  } as unknown as Element;
}

function fakeDocument(
  queries: Readonly<Record<string, readonly Element[]>>,
  options: { url: string; bodyText?: string; scrollTop?: number }
): Document {
  return {
    defaultView: { location: { href: options.url } },
    body: { innerText: options.bodyText ?? "" },
    scrollingElement: { scrollTop: options.scrollTop ?? 0 },
    querySelectorAll(selector: string) {
      return queries[selector] ?? [];
    },
    querySelector(selector: string) {
      return queries[selector]?.[0] ?? null;
    }
  } as unknown as Document;
}

const listSelectors = {
  rows: "tr[data-row-key]",
  active:
    "[role='tab'][aria-selected='true'],[role='tab'][class*='active']",
  filters:
    "input:not([type='hidden']),[role='combobox'],[role='searchbox']",
  totals:
    ".ecom-g-pagination-total-text,[class*='pagination'] [class*='total']",
  current:
    ".ecom-g-pagination-item-active,[class*='pagination'] [aria-current='page']",
  pages: "[class*='pagination'] [title],[class*='pagination'] [data-page]"
} as const;

const editorSelectors = {
  main: "main",
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

const valueControls =
  "input:not([type='hidden']),textarea,[role='combobox'],[contenteditable='true']";
const selectedValue =
  "[aria-selected='true'],[class*='selection-item'],[class*='selectionItem'],img[src],[data-file-id]";

describe("doudian read-only DOM observation layer", () => {
  it("reads scope fingerprint, both totals, pagination and product candidates", () => {
    const title = fakeElement({ text: "脱敏商品 500g" });
    const id = fakeElement({ text: "ID：400001" });
    const row = fakeElement({
      attributes: { "data-row-key": "400001" },
      queries: { "a,div,span,p": [title, id] }
    });
    const doc = fakeDocument(
      {
        [listSelectors.active]: [
          fakeElement({
            text: "在售商品",
            attributes: { "data-tab-key": "selling" }
          })
        ],
        [listSelectors.filters]: [
          fakeElement({
            value: "零食",
            attributes: { placeholder: "商品名称" }
          })
        ],
        [listSelectors.totals]: [
          fakeElement({ text: "共 106 件商品" }),
          fakeElement({ text: "共 106 件商品" })
        ],
        [listSelectors.current]: [
          fakeElement({ text: "2", attributes: { title: "2" } })
        ],
        [listSelectors.pages]: [
          fakeElement({ text: "1", attributes: { title: "1" } }),
          fakeElement({ text: "2", attributes: { title: "2" } }),
          fakeElement({ text: "3", attributes: { title: "3" } })
        ],
        [listSelectors.rows]: [row]
      },
      {
        url: "https://fxg.jinritemai.com/ffa/g/list",
        scrollTop: 320
      }
    );

    expect(
      readDoudianScopeDom(doc, {
        shopId: "shop-redacted",
        shopName: "脱敏测试旗舰店"
      })
    ).toMatchObject({
      fingerprint: {
        shopId: "shop-redacted",
        filters: { 商品名称: "零食" },
        statusTab: { id: "selling", label: "在售商品" }
      },
      topTotal: 106,
      bottomTotal: 106,
      page: 2,
      totalPages: 3,
      view: {
        scrollTop: 320,
        products: [{ id: "400001", title: "脱敏商品 500g" }]
      },
      riskSignals: []
    });
  });

  it("surfaces login and challenge text as blocking observations", () => {
    const doc = fakeDocument(
      {},
      {
        url: "https://fxg.jinritemai.com/login",
        bodyText: "请完成安全验证"
      }
    );
    expect(
      readDoudianScopeDom(doc, {
        shopId: "shop-redacted",
        shopName: "脱敏店铺",
        fallbackStatusTab: { id: "unknown", label: "未识别" }
      }).riskSignals
    ).toEqual([{ code: "SESSION_EXPIRED", severity: "blocking" }]);
  });

  it("reads editor readiness, required fields, SKU cells and platform warnings without mutation", () => {
    let mutationCalls = 0;
    const input = fakeElement({ value: "" });
    Object.assign(input, {
      click() {
        mutationCalls += 1;
      },
      dispatchEvent() {
        mutationCalls += 1;
        return true;
      }
    });
    const requiredMarker = fakeElement({ text: "*" });
    const section = fakeElement({
      attributes: { "data-section": "基础信息" }
    });
    const root = fakeElement({
      attributes: { "attr-field-id": "产地" },
      queries: {
        "[required],[aria-required='true'],span[class*='required']": [
          requiredMarker
        ],
        label: [fakeElement({ text: "产地" })],
        [valueControls]: [input],
        input: [input]
      },
      closest: { "[data-section]": section }
    });
    const selectedBrand = fakeElement({
      text: "脱敏品牌",
      attributes: { class: "selection-item" }
    });
    const brandInput = fakeElement({ value: "" });
    const brandRoot = fakeElement({
      attributes: { "attr-field-id": "品牌" },
      queries: {
        "[required],[aria-required='true'],span[class*='required']": [
          requiredMarker
        ],
        label: [fakeElement({ text: "品牌" })],
        [selectedValue]: [selectedBrand],
        [valueControls]: [brandInput],
        "[role='combobox']": [brandInput],
        input: [brandInput]
      },
      closest: { "[data-section]": section }
    });
    const priceInput = fakeElement({ value: "" });
    const skuCell = fakeElement({
      text: "",
      queries: { [valueControls]: [priceInput], input: [priceInput] }
    });
    const skuIdCell = fakeElement({ text: "sku-redacted" });
    const row = fakeElement({ queries: { td: [skuIdCell, skuCell] } });
    const table = fakeElement({
      queries: {
        "thead th": [
          fakeElement({ text: "SKUID" }),
          fakeElement({ text: "* 价格" })
        ],
        "tbody tr": [row]
      }
    });
    const doc = fakeDocument(
      {
        [editorSelectors.main]: [fakeElement()],
        [editorSelectors.controls]: [input, table],
        [editorSelectors.anchors]: [fakeElement({ text: "基础信息" })],
        [editorSelectors.markers]: [requiredMarker],
        [editorSelectors.roots]: [root, brandRoot],
        [editorSelectors.loading]: [],
        [editorSelectors.buttons]: [fakeElement({ text: "填写检查" })],
        [editorSelectors.warnings]: [fakeElement({ text: "价格不能为空" })],
        [editorSelectors.tables]: [table]
      },
      {
        url: "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit"
      }
    );

    const observation = readDoudianEditorDom(doc, {
      platformCheckRequested: true
    });
    expect(observation).toMatchObject({
      readiness: {
        hasMain: true,
        visibleControls: 2,
        knownAnchors: 1,
        requiredMarkers: 1,
        loading: false
      },
      requiredFields: [
        {
          key: "产地",
          label: "产地",
          section: "基础信息",
          required: true,
          valueState: "empty"
        },
        {
          key: "品牌",
          label: "品牌",
          section: "基础信息",
          required: true,
          valueState: "filled"
        }
      ],
      skuRequiredCells: [
        {
          skuId: "sku-redacted",
          row: 1,
          column: "价格",
          valueState: "empty"
        }
      ],
      platformFillCheck: {
        requested: true,
        available: true,
        completed: true,
        warnings: ["价格不能为空"]
      }
    });
    expect(mutationCalls).toBe(0);
  });
});
