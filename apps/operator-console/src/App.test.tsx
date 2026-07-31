// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DashboardSnapshot,
  EvidenceLineageView,
  RunView,
  TaskView,
  WorkflowSummary
} from "@bpa/operator-console-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { OperatorConsoleApi } from "./api.js";

afterEach(cleanup);

const dashboard: DashboardSnapshot = {
  attention: "action",
  headline: "有 1 项需要确认",
  runtimeVersion: "0.4.0",
  activeRunCount: 1,
  pendingTaskCount: 1,
  components: [
    {
      id: "core",
      label: "本地服务",
      status: "healthy",
      summary: "运行正常",
      technicalDetails: "socket=/private/example/core.sock"
    }
  ],
  browserSessions: [
    {
      id: "session-1",
      label: "抖店商品管理",
      status: "ready",
      origin: "https://fxg.jinritemai.com",
      authenticated: true,
      lastSeenAt: "2026-07-30T01:00:00.000Z",
      binding: {
        sessionId: "session-1",
        browserInstanceId: "chrome-profile-1",
        tabId: 7,
        observationRevision: 3
      }
    }
  ]
};

const workflows: WorkflowSummary[] = [
  {
    id: "doudian.priority-check",
    version: "1.0.0",
    title: "重点项检查",
    description: "只读检查商品缺项",
    riskLevel: "R1",
    inputFields: [
      {
        key: "scope",
        label: "检查范围",
        kind: "text",
        required: true
      }
    ],
    resourceSlots: [
      {
        key: "shop",
        label: "抖店会话",
        requiredOrigin: "https://fxg.jinritemai.com"
      }
    ]
  }
];

const tasks: TaskView[] = [
  {
    id: "task-1",
    runId: "run-1",
    kind: "human_confirm",
    title: "确认可比商品",
    guidance: "请批量复核 AI 建议。",
    attention: "action",
    choices: [{ value: "accept", label: "确认选择" }]
  }
];

const run: RunView = {
  id: "run-1",
  workflowTitle: "重点项检查",
  status: "running",
  businessSummary: "已检查 35 / 100 件商品",
  startedAt: "2026-07-30T00:00:00.000Z",
  timeline: [
    {
      id: "event-1",
      at: "2026-07-30T00:00:01.000Z",
      title: "已确认店铺",
      summary: "店铺与筛选范围一致",
      state: "completed",
      technicalDetails: "scopeDigest=sha256:scope"
    }
  ]
};

const lineage: EvidenceLineageView = {
  runId: "run-1",
  sources: [
    {
      id: "source-1",
      label: "抖店商品页",
      origin: "https://fxg.jinritemai.com",
      observedAt: "2026-07-30T00:00:00.000Z"
    }
  ],
  evidence: [
    {
      id: "evidence-1",
      label: "商品字段观察",
      classification: "restricted",
      digest: "sha256:evidence",
      sourceIds: ["source-1"]
    }
  ],
  assets: [
    {
      id: "asset-1",
      label: "重点项报告",
      digest: "sha256:asset",
      evidenceIds: ["evidence-1"]
    }
  ]
};

function mockApi(): OperatorConsoleApi {
  return {
    initializeSession: vi.fn(async () => {}),
    getDashboard: vi.fn(async () => dashboard),
    listWorkflows: vi.fn(async () => workflows),
    createRun: vi.fn(async () => ({ runId: "run-1" })),
    getRun: vi.fn(async () => run),
    listTasks: vi.fn(async () => tasks),
    submitTask: vi.fn(async () => {}),
    importDataset: vi.fn(async () => ({
      status: "published" as const,
      stagingId: "staging-1",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      id: "packaging-master",
      version: "1.0.0",
      recordCount: 12,
      warnings: [],
      errors: []
    })),
    getEvidenceLineage: vi.fn(async () => lineage),
    listDownloads: vi.fn(async () => [
      {
        id: "download-1",
        runId: "run-1",
        kind: "report" as const,
        title: "重点项检查报告",
        fileName: "report.json",
        sizeBytes: 1024,
        createdAt: "2026-07-30T00:00:00.000Z"
      }
    ]),
    downloadUrl: (id) => `/api/downloads/${id}`,
    startDesignMode: vi.fn(async (input) => ({
      id: "design.grant-1",
      authoringSessionId: input.authoringSessionId,
      browserSessionId: input.browserSessionId,
      profileId: input.profileId,
      state: "active" as const,
      origin: input.pageBinding.origin,
      tabId: input.pageBinding.tabId,
      pageEpoch: input.pageBinding.pageEpoch,
      expiresAt: "2030-01-01T00:15:00.000Z",
      screenshotApproved: input.screenshotApproved,
      revision: 1
    })),
    stopDesignMode: vi.fn(async (id, revision) => ({
      id,
      authoringSessionId: "authoring.session-1",
      browserSessionId: "browser-session-1",
      profileId: "chanmama.product-metrics",
      state: "stopped" as const,
      origin: "https://www.chanmama.com",
      tabId: 7,
      pageEpoch: "tab-7:1999999999999:design-1",
      expiresAt: "2030-01-01T00:15:00.000Z",
      screenshotApproved: false,
      revision: revision + 1
    }))
  };
}

async function renderReady(api = mockApi()) {
  render(<App api={api} />);
  await screen.findByRole("heading", { name: "BPA 需要处理" });
  return api;
}

describe("Operator Console", () => {
  it("shows business work first and keeps diagnostics in advanced mode", async () => {
    const user = userEvent.setup();
    await renderReady();
    expect(screen.getAllByText("需要操作").length).toBeGreaterThan(0);
    expect(screen.queryByText("抖店商品管理")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /高级设置/ }));
    await user.click(screen.getByRole("button", { name: /系统诊断/ }));
    expect(screen.getByText("抖店商品管理")).toBeInTheDocument();
    const details = screen.getByText("查看技术细节").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("socket=/private/example/core.sock")).not.toBeVisible();
  });

  it("starts a workflow with an exact browser session binding", async () => {
    const user = userEvent.setup();
    const api = await renderReady();
    await user.click(screen.getByRole("button", { name: /自动化/ }));
    await user.type(screen.getByLabelText("检查范围"), "全部在售商品");
    await user.selectOptions(screen.getByLabelText("抖店会话"), "session-1");
    await user.click(screen.getByRole("button", { name: "确认并启动" }));
    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith({
        workflowId: "doudian.priority-check",
        workflowVersion: "1.0.0",
        inputs: { scope: "全部在售商品" },
        resourceBindings: {
          shop: {
            sessionId: "session-1",
            browserInstanceId: "chrome-profile-1",
            tabId: 7,
            observationRevision: 3
          }
        }
      })
    );
    expect(await screen.findByText("已检查 35 / 100 件商品")).toBeInTheDocument();
  });

  it("handles a task and refreshes the task center", async () => {
    const user = userEvent.setup();
    const api = await renderReady();
    await user.click(screen.getByRole("button", { name: /^02任务1$/ }));
    expect(screen.getByText("确认可比商品")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认选择" }));
    await waitFor(() =>
      expect(api.submitTask).toHaveBeenCalledWith("task-1", {
        decision: "accept"
      })
    );
    expect(screen.getByText(/已记录处理结果/)).toBeInTheDocument();
  });

  it("opens and stops an exact 15-minute Design Mode grant", async () => {
    const user = userEvent.setup();
    const api = mockApi();
    vi.mocked(api.getDashboard).mockResolvedValue({
      ...dashboard,
      browserSessions: [
        {
          ...dashboard.browserSessions[0]!,
          status: "attention",
          origin: "等待选择业务来源",
          authenticated: false
        }
      ]
    });
    await renderReady(api);
    await user.click(screen.getByRole("button", { name: /高级设置/ }));
    await user.click(screen.getByRole("button", { name: /创作模式/ }));
    await user.type(
      screen.getByLabelText(/创作会话编号/),
      "authoring.session-1"
    );
    await user.type(
      screen.getByLabelText(/页面能力 Profile/),
      "doudian.shop-context"
    );
    await user.selectOptions(
      screen.getByLabelText(/浏览器会话/),
      "session-1"
    );
    const pageBinding = {
      version: "bpa.design-page-binding/1",
      tabId: 7,
      origin: "https://fxg.jinritemai.com",
      pageEpoch: "tab-7:1999999999999:design-1",
      issuedAt: "2026-07-30T01:00:00.000Z"
    } as const;
    fireEvent.change(
      screen.getByLabelText(/一次性页面绑定码/),
      { target: { value: JSON.stringify(pageBinding) } }
    );
    await user.click(
      screen.getByRole("button", {
        name: "确认并开启 15 分钟授权"
      })
    );
    await waitFor(() =>
      expect(api.startDesignMode).toHaveBeenCalledWith({
        authoringSessionId: "authoring.session-1",
        browserSessionId: "session-1",
        profileId: "doudian.shop-context",
        pageBinding,
        screenshotApproved: false
      })
    );
    expect(await screen.findByText("授权中")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "立即停止授权" })
    );
    await waitFor(() =>
      expect(api.stopDesignMode).toHaveBeenCalledWith(
        "design.grant-1",
        1
      )
    );
  });

  it("imports a browser File through the staging lease abstraction", async () => {
    const user = userEvent.setup();
    const api = await renderReady();
    await user.click(screen.getByRole("button", { name: /高级设置/ }));
    await user.click(screen.getByRole("button", { name: /数据导入/ }));
    const file = new File(["xlsx"], "master.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    await user.upload(screen.getByLabelText("选择数据文件"), file);
    await user.click(screen.getByRole("button", { name: "开始导入" }));
    await waitFor(() =>
      expect(api.importDataset).toHaveBeenCalledWith(file, {
        id: "packaging-master",
        version: "1.0.0",
        title: "包装主数据"
      })
    );
    expect(screen.getByText(/已发布 packaging-master@1.0.0/)).toBeInTheDocument();
  });

  it("renders evidence lineage and authenticated report downloads", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole("button", { name: /高级设置/ }));
    await user.click(screen.getByRole("button", { name: /证据血缘/ }));
    await user.type(screen.getByLabelText("任务编号"), "run-1");
    await user.click(screen.getByRole("button", { name: "查看血缘" }));
    expect(await screen.findByText("商品字段观察")).toBeInTheDocument();
    expect(screen.getByText("重点项报告")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /结果/ }));
    const download = screen.getByRole("link", { name: "下载" });
    expect(download).toHaveAttribute("href", "/api/downloads/download-1");
  });
});
