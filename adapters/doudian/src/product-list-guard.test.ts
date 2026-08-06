import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { prepareDoudianProductList } from "./product-list-guard.js";

function makeVisible(element: HTMLElement): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 880,
    height: 500,
    top: 0,
    right: 880,
    bottom: 500,
    left: 0,
    toJSON: () => ({})
  });
}

describe("prepareDoudianProductList", () => {
  it("closes the known attribute optimization promotion without enabling it", async () => {
    const document = new JSDOM(`<!doctype html><body><div role="dialog">
      开启属性自动优化，增加商品曝光，促进下单转化
      若属性未填/填错，平台将精准优化
      优化前通知商家，支持一键撤销
      <button aria-label="Close">关闭</button><button>立即开启</button>
    </div></body>`).window.document;
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    makeVisible(dialog);
    const enable = dialog.querySelectorAll("button")[1]!;
    const enableClick = vi.spyOn(enable, "click");
    dialog.querySelector<HTMLElement>("button[aria-label='Close']")!
      .addEventListener("click", () => dialog.remove());

    await expect(
      prepareDoudianProductList(document, async () => undefined, 1)
    ).resolves.toBe(1);
    expect(enableClick).not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("blocks an unknown visible dialog", async () => {
    const document = new JSDOM(`<!doctype html><body><div role="dialog">
      请确认新的商品授权协议<button aria-label="Close">关闭</button>
    </div></body>`).window.document;
    makeVisible(document.querySelector<HTMLElement>("[role='dialog']")!);
    await expect(
      prepareDoudianProductList(document, async () => undefined, 1)
    ).rejects.toThrow("UNKNOWN_PRODUCT_LIST_DIALOG");
  });
});
