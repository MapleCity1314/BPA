import { describe, expect, it } from "vitest";
import { readDoudianShopContext } from "./index.js";

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
});
