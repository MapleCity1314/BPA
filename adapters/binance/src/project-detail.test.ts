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
});
