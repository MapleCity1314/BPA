import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  collectBinanceManagementSnapshot,
  detectBinanceRiskSignals,
  readBinanceManagementSnapshot
} from "./index.js";

function page(body: string, url = "https://www.binance.com/zh-CN/copy-trading/copy-management"): Document {
  return new JSDOM(`<body><main>${body}</main></body>`, { url }).window.document;
}

describe("Binance copy-trading adapter", () => {
  it("pins the exact read-only browser implementation", () => {
    const adapter = parseWorkflowYaml(readFileSync(
      new URL("../binance-copy-trading.adapter.yaml", import.meta.url),
      "utf8"
    )) as {
      metadata: { version: string };
      extension: { minimumVersion: string };
      capabilities: Array<{ implementationDigest: string; permissions: string[] }>;
    };
    const implementationDigest = `sha256:${createHash("sha256")
      .update([
        "apps/extension/src/entrypoints/binance-content.ts",
        "apps/extension/src/lib/capability-manifest.ts",
        "apps/extension/src/lib/content-action-router.ts",
        "apps/extension/src/lib/page-observer-registry.ts",
        "apps/extension/src/lib/binance-node-registry.ts",
        "apps/extension/src/lib/binance-detail-background.ts",
        "apps/extension/src/lib/binance-detail-content.ts",
        "adapters/binance/src/index.ts",
        "adapters/binance/src/project-detail.ts"
      ].map((path) => readFileSync(new URL(`../../../${path}`, import.meta.url))).join("\n"))
      .digest("hex")}`;
    expect(adapter).toMatchObject({
      metadata: { version: "1.2.0" },
      extension: { minimumVersion: "0.6.2" },
      capabilities: [
        {
          implementationDigest,
          permissions: ["browser.dom.read", "browser.dom.write", "browser.tabs.read"]
        },
        {
          implementationDigest,
          permissions: ["browser.dom.read", "browser.dom.write", "browser.tabs.read"]
        }
      ]
    });
  });
  it("reads account summary and a project without collecting trader names", () => {
    const document = page(`
      <div><span>保证金余额</span><span>1,000 USDT</span></div>
      <div data-project-id="project_1001">
        <span>项目 ID：project_1001</span><span>跟单时间</span><span>2026-08-01</span>
        <span>净利润</span><span>25 USDT</span><span>交易员显示名</span><span>不得落库的姓名</span>
        <button>展开详情</button>
      </div>
    `);
    const result = readBinanceManagementSnapshot(document, document.defaultView!.location.href, new Date("2026-08-12T04:00:00.000Z"));
    expect(result).toMatchObject({ status: "complete", accountSummary: { 保证金余额: "1,000 USDT" }, projects: [{ projectId: "project_1001", status: "ongoing", summary: { 跟单时间: "2026-08-01", 净利润: "25 USDT" } }], formMutations: 0 });
    expect(JSON.stringify(result)).not.toContain("不得落库的姓名");
  });

  it("reads the current Binance __APP shell without a main landmark", () => {
    const document = new JSDOM(`
      <body><div id="__APP">
        <div><span>保证金余额</span><span>1,000 USDT</span></div>
        <section>
          <div>项目ID: project_1001</div><span>净利润</span><span>25 USDT</span>
          <div class="cursor-pointer"><div>展开详情</div></div>
        </section>
      </div></body>
    `, { url: "https://www.binance.com/zh-CN/copy-trading/copy-management" }).window.document;
    expect(readBinanceManagementSnapshot(document)).toMatchObject({
      accountSummary: { 保证金余额: "1,000 USDT" },
      projects: [{ projectId: "project_1001", summary: { 净利润: "25 USDT" } }]
    });
  });

  it("accepts an explicit empty state", () => {
    expect(readBinanceManagementSnapshot(page("<div>暂无进行中跟单项目</div>"))).toMatchObject({ status: "empty_confirmed", projects: [] });
  });

  it("finds a project that was already expanded before collection", () => {
    const document = page(`
      <section data-project-id="project_1001">
        <span>项目 ID：project_1001</span><span>净利润</span><span>25 USDT</span>
        <button>收起详情</button><div><button role="tab" aria-selected="true">仓位</button></div>
      </section>
    `);
    expect(readBinanceManagementSnapshot(document).projects).toMatchObject([
      { projectId: "project_1001", summary: { 净利润: "25 USDT" } }
    ]);
  });

  it("collects ongoing and ended projects and restores the original tab", async () => {
    const document = page(`
      <button role="tab" aria-selected="true">进行中</button>
      <button role="tab" aria-selected="false">已结束</button>
      <div id="projects" data-project-id="ongoing_1001">
        <span>项目 ID：ongoing_1001</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>
      </div>
    `);
    const [ongoing, ended] = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[role='tab']")
    );
    const projects = document.querySelector<HTMLElement>("#projects")!;
    const activate = (button: HTMLButtonElement, id: string): void => {
      ongoing!.setAttribute("aria-selected", String(button === ongoing));
      ended!.setAttribute("aria-selected", String(button === ended));
      projects.setAttribute("data-project-id", id);
      projects.innerHTML = `<span>项目 ID：${id}</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>`;
    };
    ongoing!.addEventListener("click", () => activate(ongoing!, "ongoing_1001"));
    ended!.addEventListener("click", () => activate(ended!, "ended_1001"));
    const result = await collectBinanceManagementSnapshot(
      document,
      document.defaultView!.location.href,
      { deadline: new Date(Date.now() + 5_000).toISOString() }
    );
    expect(result.projects.map((project) => project.projectId)).toEqual([
      "ongoing_1001",
      "ended_1001"
    ]);
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("进行中");
  });

  it("waits for project rows after the status tab becomes active", async () => {
    const document = page(`
      <button role="tab" aria-selected="true">进行中</button>
      <button role="tab" aria-selected="false">已结束</button>
      <div id="projects" data-project-id="ongoing_1001">
        <span>项目 ID：ongoing_1001</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>
      </div>
    `);
    const [ongoing, ended] = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[role='tab']")
    );
    const projects = document.querySelector<HTMLElement>("#projects")!;
    ended!.addEventListener("click", () => {
      ongoing!.setAttribute("aria-selected", "false");
      ended!.setAttribute("aria-selected", "true");
    });
    ongoing!.addEventListener("click", () => {
      ongoing!.setAttribute("aria-selected", "true");
      ended!.setAttribute("aria-selected", "false");
      projects.setAttribute("data-project-id", "ongoing_1001");
      projects.innerHTML = '<span>项目 ID：ongoing_1001</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>';
    });
    let waits = 0;
    const result = await collectBinanceManagementSnapshot(
      document,
      document.defaultView!.location.href,
      {
        deadline: new Date(Date.now() + 5_000).toISOString(),
        wait: async () => {
          waits += 1;
          if (ended!.getAttribute("aria-selected") === "true") {
            projects.setAttribute("data-project-id", "ended_1001");
            projects.innerHTML = '<span>项目 ID：ended_1001</span><span>净利润</span><span>2 USDT</span><button>展开详情</button>';
          }
        }
      }
    );
    expect(waits).toBeGreaterThan(0);
    expect(result.projects.map((project) => project.projectId)).toEqual([
      "ongoing_1001",
      "ended_1001"
    ]);
  });

  it("limits an A1 collection to one project without opening the other status tab", async () => {
    const document = page(`
      <button role="tab" aria-selected="true">进行中</button>
      <button role="tab" aria-selected="false">已结束</button>
      <div data-project-id="ongoing_1001">
        <span>项目 ID：ongoing_1001</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>
      </div>
      <div data-project-id="ongoing_1002">
        <span>项目 ID：ongoing_1002</span><span>净利润</span><span>2 USDT</span><button>展开详情</button>
      </div>
    `);
    const ended = document.querySelectorAll<HTMLButtonElement>("[role='tab']")[1]!;
    let endedClicks = 0;
    ended.addEventListener("click", () => {
      endedClicks += 1;
    });
    const result = await collectBinanceManagementSnapshot(
      document,
      document.defaultView!.location.href,
      {
        deadline: new Date(Date.now() + 5_000).toISOString(),
        projectId: "ongoing_1002"
      }
    );
    expect(result.projects.map((project) => project.projectId)).toEqual([
      "ongoing_1002"
    ]);
    expect(endedClicks).toBe(0);
  });

  it("fails closed when the requested A1 project is absent", async () => {
    const document = page(`
      <button role="tab" aria-selected="true">进行中</button>
      <button role="tab" aria-selected="false">已结束</button>
      <div id="projects" data-project-id="ongoing_1001">
        <span>项目 ID：ongoing_1001</span><span>净利润</span><span>1 USDT</span><button>展开详情</button>
      </div>
    `);
    const [ongoing, ended] = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[role='tab']")
    );
    const projects = document.querySelector<HTMLElement>("#projects")!;
    ended!.addEventListener("click", () => {
      ongoing!.setAttribute("aria-selected", "false");
      ended!.setAttribute("aria-selected", "true");
      projects.remove();
      document.querySelector("main")!.insertAdjacentHTML(
        "beforeend",
        "<div>暂无已结束跟单项目</div>"
      );
    });
    ongoing!.addEventListener("click", () => {
      ongoing!.setAttribute("aria-selected", "true");
      ended!.setAttribute("aria-selected", "false");
    });
    await expect(collectBinanceManagementSnapshot(
      document,
      document.defaultView!.location.href,
      {
        deadline: new Date(Date.now() + 5_000).toISOString(),
        projectId: "ended_9999"
      }
    )).rejects.toThrow("BINANCE_PROJECT_TARGET_MISSING");
  });

  it("fails closed on structure drift", () => {
    expect(() => readBinanceManagementSnapshot(page("<div>页面已改版</div>"))).toThrow("BINANCE_STRUCTURE_UNCONFIRMED");
  });

  it("blocks login, captcha and risk control", () => {
    expect(detectBinanceRiskSignals(page("请输入验证码"))[0]).toMatchObject({ code: "CAPTCHA_REQUIRED", severity: "blocking" });
    expect(detectBinanceRiskSignals(page("", "https://www.binance.com/zh-CN/login"))[0]).toMatchObject({ code: "SESSION_EXPIRED" });
  });
});
