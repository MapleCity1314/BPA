import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  discoverDoudianAllianceShops,
  DOUDIAN_ALLIANCE_RUNTIME_VERSION,
  dismissBuyinPromotionDialogs,
  openBuyinRetiredProducts,
  openDoudianAlliancePromotion,
  openDoudianShopSwitcher,
  readBuyinRetiredProducts,
  readDoudianHeaderShopIdentity,
  readDoudianHeaderShopName,
  scrollDoudianShopSwitcher,
  selectDoudianAllianceShop
} from "./alliance-retired.js";

function documentOf(body: string): Document {
  const dom = new JSDOM(`<body>${body}</body>`, {
    url: "https://fxg.jinritemai.com/ffa/g/list"
  });
  dom.window.Element.prototype.getBoundingClientRect = () =>
    ({ top: 20, bottom: 44, width: 160, height: 24 }) as DOMRect;
  return dom.window.document;
}

describe("Doudian alliance retired-products runtime", () => {
  it("publishes only the exact v2 browser capabilities and implementation", () => {
    const adapter = parseWorkflowYaml(
      readFileSync(
        new URL("../doudian-alliance.adapter.yaml", import.meta.url),
        "utf8"
      )
    ) as {
      metadata: { version: string };
      extension: { minimumVersion: string };
      capabilities: Array<{
        nodeId: string;
        nodeVersions: string[];
        handlerVersion: string;
        implementationDigest: string;
      }>;
    };
    const implementationDigest = `sha256:${createHash("sha256")
      .update(
        [
          "apps/extension/src/entrypoints/background.ts",
          "apps/extension/src/entrypoints/content.ts",
          "apps/extension/src/lib/adapter-node-registry.ts",
          "apps/extension/src/lib/alliance-retired-background.ts",
          "apps/extension/src/lib/alliance-retired-content.ts",
          "apps/extension/src/lib/extension-runtime-resources.ts",
          "apps/extension/src/lib/managed-tab-lifecycle.ts",
          "apps/extension/src/lib/native-connection-supervisor.ts",
          "adapters/doudian/src/alliance-retired.ts",
          "adapters/doudian/src/shop-context.ts"
        ]
          .map((path) =>
            readFileSync(new URL(`../../../${path}`, import.meta.url))
          )
          .join("\n")
      )
      .digest("hex")}`;

    expect(DOUDIAN_ALLIANCE_RUNTIME_VERSION).toBe("2.0.20");
    expect(adapter.metadata.version).toBe("2.0.20");
    expect(adapter.extension.minimumVersion).toBe("0.6.10");
    expect(adapter.capabilities).toHaveLength(2);
    expect(adapter.capabilities.map((capability) => capability.nodeId)).toEqual([
      "doudian.alliance.shops.discover",
      "doudian.alliance.shop.retired-products.scan"
    ]);
    for (const capability of adapter.capabilities) {
      expect(capability).toMatchObject({
        nodeVersions: ["2.0.20"],
        handlerVersion: "2.0.20",
        implementationDigest
      });
    }
  });

  it("discovers active shops and blocks inactive targets", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName">乙食品专营店</span>店铺ID 10002 停业整顿</div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      {
        id: "10001",
        name: "甲食品旗舰店",
        status: "active",
        statusText: "正常营业"
      },
      {
        id: "10002",
        name: "乙食品专营店",
        status: "blocked",
        statusText: "停业整顿"
      }
    ]);
    expect(() =>
      selectDoudianAllianceShop(doc, {
        id: "10002",
        name: "乙食品专营店",
        status: "blocked",
        statusText: "停业整顿"
      })
    ).toThrow("SHOP_NOT_ACTIVE");
  });

  it("discovers and selects shops from the current Auxo drawer", () => {
    const doc = documentOf(`
      <div class="auxo-drawer auxo-drawer-open">
        <div class="auxo-drawer-content-wrapper">
          <div class="index_descriptions__current">切换组织/店铺</div>
          <div class="index_shopOption__one">
            <span class="index_introName__new">甲食品旗舰店</span>
            <span>店铺ID 10001 正常营业</span>
          </div>
          <div class="index_shopOption__two">
            <span class="index_introName__new">乙食品专营店</span>
            <span>店铺ID 10002 正常营业</span>
          </div>
        </div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      {
        id: "10001",
        name: "甲食品旗舰店",
        status: "active",
        statusText: "正常营业"
      },
      {
        id: "10002",
        name: "乙食品专营店",
        status: "active",
        statusText: "正常营业"
      }
    ]);
    const target = doc.querySelector<HTMLElement>(
      ".index_shopOption__two"
    )!;
    const click = vi.fn();
    target.addEventListener("click", click);
    selectDoudianAllianceShop(doc, {
      id: "10002",
      name: "乙食品专营店",
      status: "active",
      statusText: "正常营业"
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("discovers shops from the current Auxo modal switcher", () => {
    const doc = documentOf(`
      <div class="auxo-modal-wrap auxo-modal-centered">
        <div class="auxo-modal">
          <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
        </div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      {
        id: "10001",
        name: "甲食品旗舰店",
        status: "active",
        statusText: "正常营业"
      }
    ]);
  });

  it("treats a nested semantic dialog as part of one Auxo modal switcher", () => {
    const doc = documentOf(`
      <div class="auxo-modal-wrap auxo-modal-centered">
        <div class="auxo-modal">
          <div role="dialog">
            <div>切换组织/店铺</div>
            <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
          </div>
        </div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      {
        id: "10001",
        name: "甲食品旗舰店",
        status: "active",
        statusText: "正常营业"
      }
    ]);
  });

  it("still rejects two independent visible shop switchers", () => {
    const switcher = (shopName: string, shopId: string) => `
      <div class="auxo-modal-wrap auxo-modal-centered">
        <div role="dialog">
          <div>切换组织/店铺</div>
          <div class="roleItem"><span class="introName">${shopName}</span>店铺ID ${shopId} 正常营业</div>
        </div>
      </div>`;
    const doc = documentOf(
      switcher("甲食品旗舰店", "10001") +
        switcher("乙食品专营店", "10002")
    );
    expect(() => discoverDoudianAllianceShops(doc)).toThrow(
      "SHOP_SWITCH_DIALOG_AMBIGUOUS"
    );
  });

  it("fails closed when a shop list mixes valid and malformed cards", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName"></span>店铺ID 10002 正常营业</div>
      </div>
    `);

    expect(() => discoverDoudianAllianceShops(doc)).toThrow(
      "SHOP_LIST_INCOMPLETE"
    );
  });

  it("keeps same-name shops distinct when both stable IDs are visible", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10001 正常营业</div>
        <div class="roleItem"><span class="introName">同名食品店</span>店铺ID 10002 正常营业</div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toHaveLength(2);
    const cards = Array.from(doc.querySelectorAll<HTMLElement>(".roleItem"));
    const clicks = cards.map(() => vi.fn());
    cards.forEach((card, index) =>
      card.addEventListener("click", clicks[index]!)
    );
    selectDoudianAllianceShop(doc, {
      id: "10002",
      name: "同名食品店",
      status: "active",
      statusText: "正常营业"
    });
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it("assigns stable switcher ordinals to same-name cards without visible IDs", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">同名食品店</span>正常营业</div>
        <div class="roleItem"><span class="introName">同名食品店</span>正常营业</div>
      </div>
    `);
    expect(discoverDoudianAllianceShops(doc)).toEqual([
      expect.objectContaining({ name: "同名食品店", switcherOrdinal: 0 }),
      expect.objectContaining({ name: "同名食品店", switcherOrdinal: 1 })
    ]);
    const cards = Array.from(doc.querySelectorAll<HTMLElement>(".roleItem"));
    const clicks = cards.map(() => vi.fn());
    cards.forEach((card, index) =>
      card.addEventListener("click", clicks[index]!)
    );
    selectDoudianAllianceShop(doc, {
      name: "同名食品店",
      switcherOrdinal: 1,
      status: "active",
      statusText: "正常营业"
    });
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it("does not activate a virtualized card outside the visible switcher viewport", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem"><span class="introName">甲食品旗舰店</span>正常营业</div>
        <div class="roleItem target"><span class="introName">乙食品专营店</span>正常营业</div>
      </div>
    `);
    const dialog = doc.querySelector<HTMLElement>("[role=dialog]")!;
    const target = doc.querySelector<HTMLElement>(".target")!;
    dialog.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 300, width: 400, height: 300 }) as DOMRect;
    target.getBoundingClientRect = () =>
      ({ left: 20, right: 380, top: 500, bottom: 540, width: 360, height: 40 }) as DOMRect;
    const click = vi.fn();
    target.addEventListener("click", click);

    expect(() =>
      selectDoudianAllianceShop(doc, {
        name: "乙食品专营店",
        status: "active",
        statusText: "正常营业"
      })
    ).toThrow("SHOP_TARGET_AMBIGUOUS");
    expect(click).not.toHaveBeenCalled();
  });

  it("does not activate a virtualized card touching only the viewport boundary", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem target"><span class="introName">乙食品专营店</span>正常营业</div>
      </div>
    `);
    const dialog = doc.querySelector<HTMLElement>("[role=dialog]")!;
    const target = doc.querySelector<HTMLElement>(".target")!;
    dialog.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 300, width: 400, height: 300 }) as DOMRect;
    target.getBoundingClientRect = () =>
      ({ left: 20, right: 380, top: 300, bottom: 340, width: 360, height: 40 }) as DOMRect;
    const click = vi.fn();
    target.addEventListener("click", click);

    expect(() =>
      selectDoudianAllianceShop(doc, {
        name: "乙食品专营店",
        status: "active",
        statusText: "正常营业"
      })
    ).toThrow("SHOP_TARGET_AMBIGUOUS");
    expect(click).not.toHaveBeenCalled();
  });

  it("scrolls by half a viewport before activating a partially visible shop card", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="roleItem target"><span class="introName">乙食品专营店</span>正常营业</div>
      </div>
    `);
    const dialog = doc.querySelector<HTMLElement>("[role=dialog]")!;
    const target = doc.querySelector<HTMLElement>(".target")!;
    Object.defineProperties(dialog, {
      clientHeight: { configurable: true, value: 382 },
      scrollHeight: { configurable: true, value: 1_430 }
    });
    dialog.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 262, bottom: 644, width: 400, height: 382 }) as DOMRect;
    target.getBoundingClientRect = () =>
      ({
        left: 20,
        right: 380,
        top: 592 - dialog.scrollTop,
        bottom: 678 - dialog.scrollTop,
        width: 360,
        height: 86
      }) as DOMRect;
    const click = vi.fn();
    target.addEventListener("click", click);
    const shop = {
      name: "乙食品专营店",
      status: "active" as const,
      statusText: "正常营业"
    };

    expect(() => selectDoudianAllianceShop(doc, shop)).toThrow(
      "SHOP_TARGET_AMBIGUOUS"
    );
    expect(scrollDoudianShopSwitcher(doc)).toBe(true);
    expect(dialog.scrollTop).toBe(191);
    expect(() => selectDoudianAllianceShop(doc, shop)).not.toThrow();
    expect(click).toHaveBeenCalledOnce();
  });

  it("uses the nested virtual scroller viewport instead of the outer dialog", () => {
    const doc = documentOf(`
      <div role="dialog">切换组织/店铺
        <div class="virtual-scroller">
          <div class="roleItem target"><span class="introName">乙食品专营店</span>正常营业</div>
        </div>
      </div>
    `);
    const dialog = doc.querySelector<HTMLElement>("[role=dialog]")!;
    const scroller = doc.querySelector<HTMLElement>(".virtual-scroller")!;
    const target = doc.querySelector<HTMLElement>(".target")!;
    dialog.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 }) as DOMRect;
    scroller.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 100, bottom: 300, width: 400, height: 200 }) as DOMRect;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 }
    });
    target.getBoundingClientRect = () =>
      ({ left: 20, right: 380, top: 340, bottom: 380, width: 360, height: 40 }) as DOMRect;
    const click = vi.fn();
    target.addEventListener("click", click);

    expect(() =>
      selectDoudianAllianceShop(doc, {
        name: "乙食品专营店",
        status: "active",
        statusText: "正常营业"
      })
    ).toThrow("SHOP_TARGET_AMBIGUOUS");
    expect(click).not.toHaveBeenCalled();
  });

  it("uses exact semantic entries for the Doudian-to-Buyin path", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div class="menuTitle">精选联盟</div>
      <div class="layerTitle">去推广</div>
    `);
    const alliance = doc.querySelector<HTMLElement>(".menuTitle")!;
    const promote = doc.querySelector<HTMLElement>(".layerTitle")!;
    const allianceClick = vi.spyOn(alliance, "click");
    const promoteClick = vi.spyOn(promote, "click");
    expect(readDoudianHeaderShopName(doc)).toBe("甲食品旗舰店");
    openDoudianAlliancePromotion(doc);
    expect(allianceClick).toHaveBeenCalledOnce();
    expect(promoteClick).toHaveBeenCalledOnce();
  });

  it("reads the current shop after Doudian changes header class names", () => {
    const doc = documentOf(`
      <div class="account-entry"><span>榆园儿食品专营店</span></div>
      <a href="/ffa/w/login/account">账号管理</a>
    `);
    expect(readDoudianHeaderShopName(doc)).toBe("榆园儿食品专营店");
  });

  it("binds a header shop name to the unique numeric ID in its account popover", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div class="auxo-popover">
        <div>甲食品旗舰店</div>
        <div>店铺ID 10001</div>
        <div>切换组织/店铺</div>
      </div>
    `);
    expect(readDoudianHeaderShopIdentity(doc)).toEqual({
      id: "10001",
      name: "甲食品旗舰店"
    });
  });

  it("ignores stale aggregate ancestor text and binds the visible account popover ID", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="header-shell">
          <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
          <div class="cached-account">店铺ID 10002</div>
        </div>
      </div>
      <div class="auxo-popover">
        <div>甲食品旗舰店</div>
        <div>店铺ID 10001</div>
        <div>切换组织/店铺</div>
      </div>
    `);
    expect(readDoudianHeaderShopIdentity(doc)).toEqual({
      id: "10001",
      name: "甲食品旗舰店"
    });
  });

  it("accepts an explicit shop ID attribute without opening account text", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName" data-shop-id="10001">
          <span class="userName">甲食品旗舰店</span>
        </div>
      </div>
    `);
    expect(readDoudianHeaderShopIdentity(doc)).toEqual({
      id: "10001",
      name: "甲食品旗舰店"
    });
  });

  it("binds the header to two agreeing authenticated session identities", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    doc.defaultView!.sessionStorage.setItem(
      "initialUserInfo",
      JSON.stringify({ data: { id: "10001", shop_name: "甲食品旗舰店" } })
    );
    doc.defaultView!.sessionStorage.setItem(
      "storeGetters",
      JSON.stringify({ user: { id: "10001", shop_name: "甲食品旗舰店" } })
    );

    expect(readDoudianHeaderShopIdentity(doc)).toEqual({
      id: "10001",
      name: "甲食品旗舰店"
    });
  });

  it.each([
    {
      initial: { id: "10001", shop_name: "甲食品旗舰店" },
      getters: undefined
    },
    {
      initial: { id: "10001", shop_name: "甲食品旗舰店" },
      getters: { id: "10002", shop_name: "甲食品旗舰店" }
    },
    {
      initial: { id: "10001", shop_name: "乙食品专营店" },
      getters: { id: "10001", shop_name: "乙食品专营店" }
    }
  ])("rejects incomplete or disagreeing authenticated session identity", ({ initial, getters }) => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    doc.defaultView!.sessionStorage.setItem(
      "initialUserInfo",
      JSON.stringify({ data: initial })
    );
    if (getters) {
      doc.defaultView!.sessionStorage.setItem(
        "storeGetters",
        JSON.stringify({ user: getters })
      );
    }

    expect(() => readDoudianHeaderShopIdentity(doc)).toThrow(
      "SHOP_IDENTITY_UNCERTAIN"
    );
  });

  it("dispatches the pointer and mouse sequence on semantic account and switch-row containers", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    const account = doc.querySelector<HTMLElement>(".headerShopName")!;
    const accountEvents: string[] = [];
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      account.addEventListener(type, () => accountEvents.push(type));
    }
    openDoudianShopSwitcher(doc);
    expect(accountEvents).toEqual([
      "mouseover",
      "mousedown",
      "mouseup",
      "click"
    ]);

    const popover = documentOf(`
      <div class="auxo-popover">
        <div class="descriptions"><div><span>切换组织/店铺</span></div></div>
      </div>
    `);
    const switchRow = popover.querySelector<HTMLElement>(".descriptions")!;
    const switchEvents: string[] = [];
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      switchRow.addEventListener(type, () => switchEvents.push(type));
    }
    openDoudianShopSwitcher(popover);
    expect(switchEvents).toEqual([
      "mouseover",
      "mousedown",
      "mouseup",
      "click"
    ]);
  });

  it("uses the topmost interactive header when a transition leaves a duplicate", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName stale"><span class="userName">甲食品旗舰店</span></div>
        <div class="headerShopName active"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    const stale = doc.querySelector<HTMLElement>(".stale")!;
    const active = doc.querySelector<HTMLElement>(".active")!;
    Object.defineProperty(doc, "elementFromPoint", {
      configurable: true,
      value: () => active.querySelector(".userName")
    });
    const staleClick = vi.fn();
    const activeClick = vi.fn();
    stale.addEventListener("click", staleClick);
    active.addEventListener("click", activeClick);

    openDoudianShopSwitcher(doc);

    expect(staleClick).not.toHaveBeenCalled();
    expect(activeClick).toHaveBeenCalledOnce();
  });

  it("still rejects independently interactive duplicate shop triggers", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName first"><span class="userName">甲食品旗舰店</span></div>
        <div class="headerShopName second"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    const first = doc.querySelector<HTMLElement>(".first")!;
    const second = doc.querySelector<HTMLElement>(".second")!;
    first.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 20 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ left: 0, top: 30, width: 100, height: 20 }) as DOMRect;
    Object.defineProperty(doc, "elementFromPoint", {
      configurable: true,
      value: (_x: number, y: number) => (y < 30 ? first : second)
    });

    expect(() => openDoudianShopSwitcher(doc)).toThrow(
      "SHOP_SWITCH_TRIGGER_AMBIGUOUS"
    );
  });

  it("uses the rightmost independently interactive account trigger in the top header", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName secondary"><span class="userName">甲食品旗舰店</span></div>
        <div class="headerShopName account"><span class="userName">甲食品旗舰店</span></div>
      </div>
    `);
    const secondary = doc.querySelector<HTMLElement>(".secondary")!;
    const account = doc.querySelector<HTMLElement>(".account")!;
    secondary.getBoundingClientRect = () =>
      ({ left: 900, right: 1000, top: 0, width: 100, height: 20 }) as DOMRect;
    account.getBoundingClientRect = () =>
      ({ left: 1300, right: 1400, top: 0, width: 100, height: 20 }) as DOMRect;
    Object.defineProperty(doc, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x < 1200 ? secondary : account)
    });
    const secondaryClick = vi.fn();
    const accountClick = vi.fn();
    secondary.addEventListener("click", secondaryClick);
    account.addEventListener("click", accountClick);

    openDoudianShopSwitcher(doc);

    expect(secondaryClick).not.toHaveBeenCalled();
    expect(accountClick).toHaveBeenCalledOnce();
  });

  it("rejects a numeric ID from an account popover for another shop", () => {
    const doc = documentOf(`
      <div id="fxg-pc-header">
        <div class="headerShopName"><span class="userName">甲食品旗舰店</span></div>
      </div>
      <div class="auxo-popover">
        <div>乙食品专营店</div>
        <div>店铺ID 10002</div>
        <div>切换组织/店铺</div>
      </div>
    `);
    expect(() => readDoudianHeaderShopIdentity(doc)).toThrow(
      "SHOP_IDENTITY_UNCERTAIN"
    );
  });

  it("closes stacked promotion dialogs from the top and opens clear-out", () => {
    const doc = documentOf(`
      <div role="dialog">如何迁移旧版数据？<button aria-label="Close"></button></div>
      <div role="dialog">推广策略支持分层设佣<button aria-label="Close"></button></div>
      <div class="back_old_version"><div><span>已清退商品</span></div></div>
    `);
    const dialogs = Array.from(
      doc.querySelectorAll<HTMLElement>("[role=dialog]")
    );
    for (const dialog of dialogs) {
      vi.spyOn(
        dialog.querySelector<HTMLElement>("button")!,
        "click"
      ).mockImplementation(() => dialog.remove());
    }
    expect(dismissBuyinPromotionDialogs(doc)).toBe(2);
    const entry = doc.querySelector<HTMLElement>(".back_old_version")!;
    const click = vi.spyOn(entry, "click");
    openBuyinRetiredProducts(doc);
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not close an unrecognized promotion dialog", () => {
    const doc = documentOf(`
      <div role="dialog">请确认新的结算协议<button aria-label="Close"></button></div>
    `);
    expect(() => dismissBuyinPromotionDialogs(doc)).toThrow(
      "PROMOTION_DIALOG_UNRECOGNIZED"
    );
  });

  it("reads an empty page without converting it to an alert", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <div>当前记录更新时间：2026/07/30</div>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody><tr><td colspan="5">无搜索结果</td></tr></tbody>
      </table>
    `);
    expect(readBuyinRetiredProducts(doc)).toEqual({
      shop: { name: "甲食品旗舰店" },
      updatedAt: "2026/07/30",
      empty: true,
      products: []
    });
  });

  it("extracts bounded product evidence by table column contract", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody>
          <tr>
            <td>T-1</td>
            <td>测试商品 商品ID：3566148304733665467</td>
            <td>已清退</td>
            <td>2026/07/31 09:00:00</td>
            <td>体验分不达标</td>
          </tr>
        </tbody>
      </table>
    `);
    expect(readBuyinRetiredProducts(doc).products).toEqual([
      {
        treatmentId: "T-1",
        productId: "3566148304733665467",
        title: "测试商品",
        status: "已清退",
        processedAt: "2026/07/31 09:00:00",
        reason: "体验分不达标"
      }
    ]);
  });

  it("rejects an overlong Chinese DOM field instead of serializing it", () => {
    const doc = documentOf(`
      <header><span class="btn-item-role-exchange-name__title">甲食品旗舰店</span></header>
      <table>
        <thead><tr><th>处理ID</th><th>商品信息</th><th>处理状态</th><th>处理时间</th><th>处理原因</th></tr></thead>
        <tbody>
          <tr><td>T-1</td><td>${"商".repeat(501)}</td><td>已清退</td><td>2026/07/31</td><td>原因</td></tr>
        </tbody>
      </table>
    `);

    expect(() => readBuyinRetiredProducts(doc)).toThrow(
      "RETIRED_PRODUCT_ROW_CHANGED"
    );
  });
});
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
