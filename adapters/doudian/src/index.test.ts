import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  detectDoudianRiskSignals,
  readDoudianShopContext
} from "./index.js";

function documentFixture(): Document {
  const element = {
    textContent: "测试旗舰店",
    parentElement: undefined,
    getAttribute(name: string) {
      return name === "data-shop-id" ? "123456789" : null;
    }
  };
  return {
    defaultView: {
      location: {
        href: "https://fxg.jinritemai.com/ffa/g/list"
      }
    },
    querySelectorAll(selector: string) {
      return selector.includes("userName") ? [element] : [];
    }
  } as unknown as Document;
}

describe("doudian adapter", () => {
  it("reads a stable shop identity without mutating the page", () => {
    expect(readDoudianShopContext(documentFixture())).toEqual({
      supported: true,
      shop: {
        id: "123456789",
        name: "测试旗舰店",
        identity_confirmed: true
      },
      url: "https://fxg.jinritemai.com/ffa/g/list"
    });
  });

  it("rejects a different origin or path", () => {
    expect(() =>
      readDoudianShopContext(
        documentFixture(),
        "https://example.com/ffa/g/list"
      )
    ).toThrow("PAGE_MISMATCH");
  });

  it("uses a bounded visible header fallback when Doudian changes CSS classes", () => {
    const shopElement = {
      textContent: "榆园儿食品专营店",
      parentElement: undefined,
      getAttribute() {
        return null;
      },
      getBoundingClientRect() {
        return { top: 72, width: 150, height: 24 };
      }
    };
    const productElement = {
      ...shopElement,
      textContent: "页面下方测试专营店",
      getBoundingClientRect() {
        return { top: 600, width: 150, height: 24 };
      }
    };
    const doc = {
      defaultView: {
        location: {
          href: "https://fxg.jinritemai.com/ffa/g/list"
        }
      },
      querySelectorAll(selector: string) {
        return selector === "body *"
          ? [productElement, shopElement]
          : [];
      },
      querySelector() {
        return null;
      }
    } as unknown as Document;
    expect(readDoudianShopContext(doc).shop).toEqual({
      id: "name:59dcdd52",
      name: "榆园儿食品专营店",
      identity_confirmed: false
    });
  });

  it("confirms a unique visible shop from an authenticated product shell", () => {
    const doc = new JSDOM(`
      <body>
        <div class="top-navigation">
          <span>精选联盟</span>
          <div class="account-entry"><span>榆园儿食品专营店</span></div>
        </div>
        <input placeholder="请输入商品名称/商品ID/商家编码，多条可用逗号隔开" />
      </body>
    `).window.document;
    const shop = doc.querySelector<HTMLElement>(".account-entry span")!;
    shop.getBoundingClientRect = () =>
      ({ top: 72, bottom: 96, width: 150, height: 24 }) as DOMRect;
    expect(readDoudianShopContext(doc, "https://fxg.jinritemai.com/ffa/g/list"))
      .toMatchObject({
        shop: {
          id: "name:59dcdd52",
          name: "榆园儿食品专营店",
          identity_confirmed: true
        }
      });
  });

  it("falls back to the first complete shop-name line in transformed layouts", () => {
    const doc = {
      defaultView: {
        location: {
          href: "https://fxg.jinritemai.com/ffa/g/list"
        }
      },
      body: {
        innerText:
          "抖店\n智能搜索\n榆园儿食品专营店\n商品管理\n测试商品专营店"
      },
      querySelectorAll() {
        return [];
      }
    } as unknown as Document;
    expect(readDoudianShopContext(doc).shop.name).toBe("榆园儿食品专营店");
  });

  it("reports challenge, throttling and expired-session signals without bypassing them", () => {
    const challenge = {
      body: {
        innerText: "操作过于频繁，请稍后再试。请完成安全验证。"
      },
      defaultView: {
        location: {
          href: "https://fxg.jinritemai.com/ffa/g/list"
        }
      }
    } as unknown as Document;
    expect(
      detectDoudianRiskSignals(
        challenge,
        undefined,
        new Date("2026-07-27T00:00:00.000Z")
      )
    ).toMatchObject([
      { code: "CAPTCHA_REQUIRED", severity: "blocking" },
      {
        code: "RATE_LIMITED",
        severity: "blocking",
        retry_after_ms: 30000
      }
    ]);
    expect(
      detectDoudianRiskSignals(
        challenge,
        "https://fxg.jinritemai.com/login",
        new Date("2026-07-27T00:00:00.000Z")
      )
    ).toMatchObject([{ code: "SESSION_EXPIRED", severity: "blocking" }]);
  });
});
