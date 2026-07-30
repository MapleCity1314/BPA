import { useEffect, useState } from "react";
import type {
  DashboardSnapshot,
  DownloadView,
  EvidenceLineageView,
  RunView,
  TaskView,
  WorkflowSummary
} from "@bpa/operator-console-contracts";
import type { OperatorConsoleApi } from "./api.js";
import {
  DatasetImport,
  DesignModeView,
  EvidenceView,
  OverviewView,
  ReportsView,
  RunTimelineView,
  TaskCenter,
  WorkflowWizard,
  type ViewId
} from "./views.js";

const navigation: Array<{ id: ViewId; label: string; marker: string }> = [
  { id: "overview", label: "运行总览", marker: "01" },
  { id: "start", label: "启动流程", marker: "02" },
  { id: "runs", label: "运行记录", marker: "03" },
  { id: "tasks", label: "任务中心", marker: "04" },
  { id: "datasets", label: "数据导入", marker: "05" },
  { id: "evidence", label: "证据血缘", marker: "06" },
  { id: "reports", label: "报告与资产", marker: "07" },
  { id: "authoring", label: "创作授权", marker: "08" }
];

export function App({ api }: { api: OperatorConsoleApi }) {
  const [view, setView] = useState<ViewId>("overview");
  const [dashboard, setDashboard] = useState<DashboardSnapshot>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [run, setRun] = useState<RunView>();
  const [lastRunId, setLastRunId] = useState("");
  const [lineage, setLineage] = useState<EvidenceLineageView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function reloadTasks() {
    setTasks(await api.listTasks());
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await api.initializeSession();
        const [nextDashboard, nextWorkflows, nextTasks, nextDownloads] =
          await Promise.all([
            api.getDashboard(),
            api.listWorkflows(),
            api.listTasks(),
            api.listDownloads()
          ]);
        if (!active) return;
        setDashboard(nextDashboard);
        setWorkflows(nextWorkflows);
        setTasks(nextTasks);
        setDownloads(nextDownloads);
      } catch (failure) {
        if (active) {
          setError(
            failure instanceof Error
              ? failure.message
              : "工作台暂时无法连接本地服务。"
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  async function loadRun(runId: string) {
    try {
      setRun(await api.getRun(runId));
      setLastRunId(runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务查询失败。");
    }
  }

  async function loadLineage(runId: string) {
    try {
      setLineage(await api.getEvidenceLineage(runId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "证据查询失败。");
    }
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark">B</div>
        <p>正在建立安全的本地工作台会话…</p>
      </main>
    );
  }

  if (error && !dashboard) {
    return (
      <main className="boot-screen error-screen">
        <div className="brand-mark">B</div>
        <h1>工作台暂时不可用</h1>
        <p role="alert">{error}</p>
        <button onClick={() => window.location.reload()} type="button">
          重新连接
        </button>
      </main>
    );
  }

  if (!dashboard) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>BPA</strong>
            <span>业务运行中心</span>
          </div>
        </div>
        <nav aria-label="主要功能">
          {navigation.map((item) => (
            <button
              aria-current={view === item.id ? "page" : undefined}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <span>{item.marker}</span>
              {item.label}
              {item.id === "tasks" && tasks.length > 0 ? (
                <em>{tasks.length}</em>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="health-dot health-healthy" />
          <div>
            <strong>仅本机可访问</strong>
            <small>安全会话将在闲置后结束</small>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL OPERATIONS</p>
            <h1>{navigation.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="attention-summary">
            <span className={`attention-orb attention-${dashboard.attention}`} />
            <div>
              <strong>
                {dashboard.attention === "normal"
                  ? "无需监管"
                  : dashboard.attention === "attention"
                    ? "请关注"
                    : "需要操作"}
              </strong>
              <small>{dashboard.headline}</small>
            </div>
          </div>
        </header>
        {error ? (
          <div className="notice" role="alert">
            {error}
            <button onClick={() => setError("")} type="button" aria-label="关闭提示">
              ×
            </button>
          </div>
        ) : null}
        {view === "overview" ? <OverviewView dashboard={dashboard} /> : null}
        {view === "start" ? (
          <WorkflowWizard
            api={api}
            workflows={workflows}
            sessions={dashboard.browserSessions}
            onRunCreated={(runId) => {
              setLastRunId(runId);
              setView("runs");
              void loadRun(runId);
            }}
          />
        ) : null}
        {view === "runs" ? (
          <RunTimelineView
            run={run}
            initialRunId={lastRunId}
            onLoad={loadRun}
          />
        ) : null}
        {view === "tasks" ? (
          <TaskCenter api={api} tasks={tasks} onCompleted={reloadTasks} />
        ) : null}
        {view === "datasets" ? <DatasetImport api={api} /> : null}
        {view === "evidence" ? (
          <EvidenceView lineage={lineage} onLoad={loadLineage} />
        ) : null}
        {view === "reports" ? (
          <ReportsView api={api} downloads={downloads} />
        ) : null}
        {view === "authoring" ? (
          <DesignModeView
            api={api}
            sessions={dashboard.browserSessions}
          />
        ) : null}
      </main>
    </div>
  );
}
