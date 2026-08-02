import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { probeObservedPage } from "./page-observer-registry.js";

describe("page observer registry", () => {
  it("authenticates a Doudian product page from shop and shell evidence", async () => {
    const doc = new JSDOM(`
      <body>
        <div class="account-entry"><span>榆园儿食品专营店</span></div>
        <a href="/ffa/w/login/account">账号管理</a>
      </body>
    `).window.document;
    await expect(
      probeObservedPage(doc, "https://fxg.jinritemai.com/ffa/g/list")
    ).resolves.toMatchObject({
      observerCapabilityId: "doudian.page",
      authentication: {
        state: "authenticated",
        contextRef: expect.stringMatching(/^auth-context-[a-f0-9]{64}$/u)
      },
      observationState: "ready"
    });
  });

  it("does not authenticate from the Doudian URL without shop evidence", async () => {
    const doc = new JSDOM("<body><div>商品管理</div></body>").window.document;
    await expect(
      probeObservedPage(doc, "https://fxg.jinritemai.com/ffa/g/list")
    ).resolves.toMatchObject({
      authentication: { state: "unknown" },
      observationState: "loading",
      reasonCode: "PAGE_LOADING"
    });
  });
});
