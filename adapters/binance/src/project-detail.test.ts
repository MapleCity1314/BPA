import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  collectBinanceProjectDetail,
  readBinanceDetailPage,
  validateBinanceProjectTarget
} from "./project-detail.js";

const managementUrl =
  "https://www.binance.com/zh-CN/copy-trading/copy-management";

function page(body: string): Document {
  return new JSDOM(`<body><main>项目 ID：project_1001${body}</main></body>`, {
    url: managementUrl
  }).window.document;
}

function appPage(body: string): Document {
  return new JSDOM(`<body><div id="__APP">项目ID: project_1001${body}</div></body>`, {
    url: managementUrl
  }).window.document;
}

describe("Binance project detail collector", () => {
  it("accepts only a status-bound Binance management target", () => {
    expect(validateBinanceProjectTarget({
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    })).toEqual({ projectId: "project_1001", projectStatus: "ongoing", managementUrl });
    expect(() => validateBinanceProjectTarget({
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl: "https://evil.example/copy-management"
    })).toThrow("BINANCE_PROJECT_TARGET_INVALID");
  });

  it("finds the project in the current Binance __APP shell", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = appPage(`
      <button role="tab" aria-selected="true">进行中 (1)</button>
      <button role="tab" aria-selected="false">已结束 (0)</button>
      <section><div>项目ID: project_1001</div><button id="toggle">展开详情</button><div id="details" hidden></div></section>
    `);
    const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
    const details = document.querySelector<HTMLElement>("#details")!;
    toggle.addEventListener("click", () => {
      const opening = toggle.textContent === "展开详情";
      toggle.textContent = opening ? "收起详情" : "展开详情";
      details.hidden = !opening;
      details.innerHTML = opening
        ? `${labels.map((label, index) => `<button role="tab" aria-selected="${index === 0}">${label}</button>`).join("")}<div role="tabpanel">暂无记录</div>`
        : "";
      for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
        button.addEventListener("click", () => {
          for (const other of details.querySelectorAll("[role='tab']")) other.setAttribute("aria-selected", String(other === button));
        });
      }
    });
    const result = await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, { deadline: new Date(Date.now() + 5_000).toISOString() });
    expect(result.tabs).toHaveLength(8);
  });

  it("keeps legitimate duplicate trades using page and row ordinal", () => {
    const document = page(`
      <button role="tab" aria-selected="true">交易历史</button>
      <table><thead><tr><th>时间</th><th>合约</th><th>价格</th><th>数量</th><th>交易员显示名</th></tr></thead>
      <tbody>
        <tr><td>2026-08-12 12:00:00</td><td>BTCUSDT</td><td>120000</td><td>0.01</td><td>敏感姓名</td></tr>
        <tr><td>2026-08-12 12:00:00</td><td>BTCUSDT</td><td>120000</td><td>0.01</td><td>敏感姓名</td></tr>
      </tbody></table>
    `);
    const result = readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "交易历史"
    });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.recordKey).not.toBe(result.records[1]!.recordKey);
    expect(JSON.stringify(result)).not.toContain("敏感姓名");
  });

  it("ignores Binance measurement and full-width empty placeholder rows", () => {
    const document = page(`
      <button role="tab" aria-selected="true">仓位</button>
      <table><thead><tr><th>符号</th><th>大小</th></tr></thead><tbody>
        <tr class="bn-web-table-measure-row" aria-hidden="true"><td></td><td></td></tr>
        <tr class="bn-web-table-placeholder"><td colspan="2"></td></tr>
      </tbody></table>
    `);
    expect(readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "仓位"
    }).records).toEqual([]);
  });

  it("still fails closed for an unrecognized row shape", () => {
    const document = page(`
      <button role="tab" aria-selected="true">仓位</button>
      <table><thead><tr><th>符号</th><th>大小</th></tr></thead><tbody>
        <tr><td>BTCUSDT</td></tr>
      </tbody></table>
    `);
    expect(() => readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "仓位"
    })).toThrow("BINANCE_DETAIL_ROW_CHANGED");
  });

  it("parses Binance responsive history rows from explicit label-value pairs", () => {
    const document = page(`
      <button role="tab" aria-selected="true">仓位历史记录</button>
      <table><thead><tr><th>Symbol</th></tr></thead><tbody><tr><td>
        <div><div class="t-subtitle1 text-PrimaryText">BTCUSDT</div><div><span>做多</span></div></div>
        <div><div class="t-caption2 text-SecondaryText">开仓价格</div><div>100</div></div>
        <div><div class="t-caption2 text-TertiaryText">开仓时间</div><div>2026-08-13</div></div>
      </td></tr></tbody></table>
    `);
    expect(readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "仓位历史记录"
    }).records[0]!.fields).toEqual({
      Symbol: "BTCUSDT",
      方向: "做多",
      开仓价格: "100",
      开仓时间: "2026-08-13"
    });
  });

  it("retains a standard table column with an empty header by stable ordinal", () => {
    const document = page(`
      <button role="tab" aria-selected="true">历史委托</button>
      <table><thead><tr><th></th><th>时间</th></tr></thead><tbody>
        <tr><td>展开</td><td>2026-08-13</td></tr>
      </tbody></table>
    `);
    expect(readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "历史委托"
    }).records[0]!.fields).toEqual({
      _column_1: "展开",
      时间: "2026-08-13"
    });
  });

  it("walks all eight tabs and restores the initially active tab", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = page(`
      <button role="tab" aria-selected="true">进行中 (3)</button>
      <button role="tab" aria-selected="false">已结束 (4)</button>
      <section data-project-id="project_1001"><span>项目 ID：project_1001</span>
        <button id="toggle">展开详情</button><div id="details" hidden></div>
      </section>
    `);
    const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
    const details = document.querySelector<HTMLElement>("#details")!;
    toggle.addEventListener("click", () => {
      const opening = toggle.textContent === "展开详情";
      toggle.textContent = opening ? "收起详情" : "展开详情";
      details.hidden = !opening;
      details.innerHTML = opening ? `
        <div id="tabs">${labels.map((label, index) =>
          `<button role="tab" aria-selected="${index === 0 ? "true" : "false"}">${label}</button>`
        ).join("")}</div>
        <div><span>总交易手续费</span><span>-1.2 USDT</span></div>
        <table><thead><tr><th>时间</th><th>合约</th></tr></thead>
        <tbody><tr><td>2026-08-12</td><td>BTCUSDT</td></tr></tbody></table>` : "";
      for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
        button.addEventListener("click", () => {
          for (const other of details.querySelectorAll("[role='tab']")) {
            other.setAttribute("aria-selected", String(other === button));
          }
        });
      }
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("main > [role='tab']")) {
      button.addEventListener("click", () => {
        for (const other of document.querySelectorAll("main > [role='tab']")) {
          other.setAttribute("aria-selected", String(other === button));
        }
      });
    }
    const result = await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, { deadline: new Date(Date.now() + 5_000).toISOString() });
    expect(result.tabs).toHaveLength(8);
    expect(result.tabs.every((tab) => tab.pageCount === 1)).toBe(true);
    expect(result.tabs[0]!.summary).toEqual({ 总交易手续费: "-1.2 USDT" });
    expect(toggle.textContent).toBe("展开详情");
    expect(document.querySelector("main > [role='tab'][aria-selected='true']")?.textContent).toBe("进行中 (3)");
  });

  it("waits for a selected detail tab to render its table", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = page(`
      <button role="tab" aria-selected="true">进行中 (1)</button>
      <button role="tab" aria-selected="false">已结束 (0)</button>
      <section data-project-id="project_1001"><span>项目 ID：project_1001</span>
        <button id="toggle">展开详情</button><div id="details" hidden></div>
      </section>
    `);
    const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
    const details = document.querySelector<HTMLElement>("#details")!;
    toggle.addEventListener("click", () => {
      const opening = toggle.textContent === "展开详情";
      toggle.textContent = opening ? "收起详情" : "展开详情";
      details.hidden = !opening;
      details.innerHTML = opening ? labels.map((label, index) =>
        `<button role="tab" aria-selected="${index === 0}">${label}</button>`
      ).join("") : "";
      for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
        button.addEventListener("click", () => {
          for (const other of details.querySelectorAll("[role='tab']")) {
            other.setAttribute("aria-selected", String(other === button));
          }
          details.querySelector("table")?.remove();
        });
      }
    });
    let waits = 0;
    const result = await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, {
      deadline: new Date(Date.now() + 5_000).toISOString(),
      wait: async () => {
        waits += 1;
        if (!details.querySelector("table")) {
          details.insertAdjacentHTML("beforeend", "<table><thead><tr><th>时间</th></tr></thead><tbody><tr><td>2026-08-13</td></tr></tbody></table>");
        }
      }
    });
    expect(result.tabs).toHaveLength(8);
    expect(waits).toBeGreaterThanOrEqual(16);
  });

  it("waits while a selected detail table is replacing malformed rows", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = page(`
      <button role="tab" aria-selected="true">进行中 (1)</button>
      <button role="tab" aria-selected="false">已结束 (0)</button>
      <section data-project-id="project_1001"><span>项目 ID：project_1001</span>
        <button id="toggle">展开详情</button><div id="details" hidden></div>
      </section>
    `);
    const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
    const details = document.querySelector<HTMLElement>("#details")!;
    toggle.addEventListener("click", () => {
      const opening = toggle.textContent === "展开详情";
      toggle.textContent = opening ? "收起详情" : "展开详情";
      details.hidden = !opening;
      details.innerHTML = opening ? `
        ${labels.map((label, index) => `<button role="tab" aria-selected="${index === 0}">${label}</button>`).join("")}
        <table><thead><tr><th>时间</th><th>合约</th></tr></thead><tbody><tr><td>loading</td></tr></tbody></table>
      ` : "";
      for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
        button.addEventListener("click", () => {
          for (const other of details.querySelectorAll("[role='tab']")) {
            other.setAttribute("aria-selected", String(other === button));
          }
          details.querySelector("tbody")!.innerHTML = "<tr><td>loading</td></tr>";
        });
      }
    });
    let waits = 0;
    const result = await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, {
      deadline: new Date(Date.now() + 5_000).toISOString(),
      wait: async () => {
        waits += 1;
        details.querySelector("tbody")!.innerHTML = "<tr><td>2026-08-13</td><td>BTCUSDT</td></tr>";
      }
    });
    expect(result.tabs).toHaveLength(8);
    expect(waits).toBeGreaterThan(0);
  });

  it("preserves a project that was already expanded by the user", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = page(`
      <button role="tab" aria-selected="true">进行中</button>
      <button role="tab" aria-selected="false">已结束</button>
      <section data-project-id="project_1001"><span>项目 ID：project_1001</span>
        <button id="toggle">收起详情</button>
        <div id="details">
          ${labels.map((label, index) => `<button role="tab" aria-selected="${index === 0}">${label}</button>`).join("")}
          <table><thead><tr><th>时间</th><th>合约</th></tr></thead>
          <tbody><tr><td>2026-08-12</td><td>BTCUSDT</td></tr></tbody></table>
        </div>
      </section>
    `);
    const details = document.querySelector<HTMLElement>("#details")!;
    for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
      button.addEventListener("click", () => {
        for (const other of details.querySelectorAll("[role='tab']")) {
          other.setAttribute("aria-selected", String(other === button));
        }
      });
    }
    await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, { deadline: new Date(Date.now() + 5_000).toISOString() });
    expect(document.querySelector("#toggle")?.textContent).toBe("收起详情");
  });

  it("advances pagination until the last page", async () => {
    const document = page(`
      <button role="tab" aria-selected="true">交易历史</button>
      <table><thead><tr><th>时间</th><th>合约</th></tr></thead>
      <tbody><tr><td id="time">2026-08-11</td><td>BTCUSDT</td></tr></tbody></table>
      <span aria-current="page">1</span>
      <button aria-label="下一页">下一页</button>
    `);
    const current = document.querySelector<HTMLElement>("[aria-current='page']")!;
    const time = document.querySelector<HTMLElement>("#time")!;
    const next = document.querySelector<HTMLButtonElement>("[aria-label='下一页']")!;
    next.addEventListener("click", () => {
      current.textContent = "2";
      time.textContent = "2026-08-12";
      next.disabled = true;
    });
    const first = readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "交易历史"
    });
    expect(first).toMatchObject({ page: 1, hasNextPage: true });
    next.click();
    const second = readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "交易历史"
    });
    expect(second).toMatchObject({ page: 2, hasNextPage: false });
    expect(second.signature).not.toBe(first.signature);
  });

  it("fails closed when a selected tab has no table or explicit empty state", () => {
    const document = page('<button role="tab" aria-selected="true">资金费用</button>页面改版');
    expect(() => readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "资金费用"
    })).toThrow("BINANCE_DETAIL_STRUCTURE_UNCONFIRMED");
  });

  it("does not treat unrelated container text as the active tab empty state", () => {
    const document = page(`
      <button role="tab" aria-selected="true">历史委托</button>
      <section>账户提示：暂无记录，请查看其他页签。</section>
    `);
    expect(() => readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "历史委托"
    })).toThrow("BINANCE_DETAIL_STRUCTURE_UNCONFIRMED");
  });

  it("does not use an exact empty leaf outside the active tab panel", () => {
    const document = page(`
      <button id="orders-tab" role="tab" aria-selected="true" aria-controls="orders-panel">历史委托</button>
      <section id="orders-panel" role="tabpanel" aria-labelledby="orders-tab">页面加载中</section>
      <aside><span>暂无记录</span></aside>
    `);
    expect(() => readBinanceDetailPage(document, {
      projectId: "project_1001",
      sourceTab: "历史委托"
    })).toThrow("BINANCE_DETAIL_STRUCTURE_UNCONFIRMED");
  });

  it("requires three new stable observations after an intermediate parsing error", async () => {
    const labels = ["仓位", "仓位历史记录", "历史委托", "交易历史", "分润记录", "转账记录", "资金费用", "跟单失败订单"];
    const document = page(`
      <button role="tab" aria-selected="true">进行中 (1)</button>
      <button role="tab" aria-selected="false">已结束 (0)</button>
      <section data-project-id="project_1001"><span>项目 ID：project_1001</span>
        <button id="toggle">收起详情</button>
        <div id="details">
          ${labels.map((label, index) => `<button role="tab" aria-selected="${index === 0}">${label}</button>`).join("")}
          <table><thead><tr><th>时间</th><th>合约</th></tr></thead>
          <tbody><tr><td>2026-08-13</td><td>BTCUSDT</td></tr></tbody></table>
        </div>
      </section>
    `);
    const details = document.querySelector<HTMLElement>("#details")!;
    for (const button of details.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
      button.addEventListener("click", () => {
        for (const other of details.querySelectorAll("[role='tab']")) {
          other.setAttribute("aria-selected", String(other === button));
        }
      });
    }
    let waits = 0;
    await collectBinanceProjectDetail(document, {
      projectId: "project_1001",
      projectStatus: "ongoing",
      managementUrl
    }, {
      deadline: new Date(Date.now() + 5_000).toISOString(),
      wait: async () => {
        waits += 1;
        if (waits === 2) {
          details.querySelector("tbody")!.innerHTML = "<tr><td>malformed</td></tr>";
        } else if (waits === 3) {
          details.querySelector("tbody")!.innerHTML = "<tr><td>2026-08-13</td><td>BTCUSDT</td></tr>";
        }
      }
    });
    expect(waits).toBe(19);
  });
});
