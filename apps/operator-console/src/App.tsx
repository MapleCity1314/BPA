import { useEffect, useState } from "react";
import type {
  ConsoleSession,
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
  DiagnosticsView,
  EvidenceView,
  OverviewView,
  ReportsView,
  RunTimelineView,
  TaskCenter,
  WorkflowWizard,
  type ViewId
} from "./views.js";

const navigation: Array<{ id: ViewId; label: string; marker: string }> = [
  { id: "overview", label: "首页", marker: "01" },
  { id: "tasks", label: "任务", marker: "02" },
  { id: "reports", label: "结果", marker: "03" },
  { id: "start", label: "自动化", marker: "04" }
];

const advancedNavigation: Array<{
  id: ViewId;
  label: string;
  marker: string;
}> = [
  { id: "diagnostics", label: "系统诊断", marker: "A1" },
  { id: "authoring", label: "创作模式", marker: "A2" },
  { id: "runs", label: "运行诊断", marker: "A3" },
  { id: "datasets", label: "数据导入", marker: "A4" },
  { id: "evidence", label: "证据血缘", marker: "A5" }
];

export function App({ api }: { api: OperatorConsoleApi }) {
  const [view, setView] = useState<ViewId>("overview");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardSnapshot>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [run, setRun] = useState<RunView>();
  const [lastRunId, setLastRunId] = useState("");
  const [lineage, setLineage] = useState<EvidenceLineageView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [accessMode, setAccessMode] = useState<ConsoleSession["accessMode"]>(
    "operator"
  );
  const [darkTheme, setDarkTheme] = useState(() => {
    const saved = window.localStorage.getItem("bpa-operator-theme");
    return saved
      ? saved === "dark"
      : window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  });

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
    window.localStorage.setItem(
      "bpa-operator-theme",
      darkTheme ? "dark" : "light"
    );
  }, [darkTheme]);

  async function reloadTasks() {
    setTasks(await api.listTasks());
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api.initializeSession();
        const [nextDashboard, nextDownloads] = await Promise.all([
          api.getDashboard(),
          api.listDownloads()
        ]);
        const [nextWorkflows, nextTasks] =
          session.accessMode === "viewer"
            ? [[], []]
            : await Promise.all([api.listWorkflows(), api.listTasks()]);
        if (!active) return;
        setAccessMode(session.accessMode);
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

  const visibleNavigation =
    accessMode === "viewer"
      ? navigation.filter((item) => item.id === "overview" || item.id === "reports")
      : navigation;
  const visibleAdvancedNavigation =
    accessMode === "viewer"
      ? advancedNavigation.filter((item) => item.id === "runs")
      : advancedNavigation;

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
          {visibleNavigation.map((item) => (
            <button
              aria-current={view === item.id ? "page" : undefined}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <span>{item.marker}</span>
              {item.label}
              {item.id === "tasks" &&
              tasks.length + dashboard.alerts.length > 0 ? (
                <em>{tasks.length + dashboard.alerts.length}</em>
              ) : null}
            </button>
          ))}
        </nav>
        <button
          className="advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
          type="button"
        >
          <span>•••</span>
          高级设置
        </button>
        {advancedOpen ? (
          <nav aria-label="高级功能" className="advanced-navigation">
            {visibleAdvancedNavigation.map((item) => (
              <button
                aria-current={view === item.id ? "page" : undefined}
                key={item.id}
                onClick={() => setView(item.id)}
                type="button"
              >
                <span>{item.marker}</span>
                {item.label}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="sidebar-foot">
          <span className="health-dot health-healthy" />
          <div>
            <strong>{accessMode === "viewer" ? "只读查看" : "本机操作"}</strong>
            <small>
              {accessMode === "viewer"
                ? "运行与浏览器操作只在 Mac 执行"
                : "安全会话将在闲置后结束"}
            </small>
          </div>
          <button
            aria-label={darkTheme ? "切换到浅色主题" : "切换到深色主题"}
            className="theme-toggle"
            onClick={() => setDarkTheme((current) => !current)}
            type="button"
          >
            {darkTheme ? "☀" : "◐"}
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {visibleAdvancedNavigation.some((item) => item.id === view)
                ? "高级视图"
                : "BPA 工作台"}
            </p>
            <h1>
              {[...visibleNavigation, ...visibleAdvancedNavigation].find(
                (item) => item.id === view
              )?.label}
            </h1>
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
        {view === "overview" ? (
          <OverviewView
            readOnly={accessMode === "viewer"}
            dashboard={dashboard}
            downloads={downloads}
            tasks={tasks}
            workflows={workflows}
            onNavigate={setView}
          />
        ) : null}
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
          <TaskCenter
            api={api}
            alerts={dashboard.alerts}
            browserSessions={dashboard.browserSessions}
            recoverySessions={dashboard.recoverySessions}
            tasks={tasks}
            onCompleted={reloadTasks}
            onAttentionAcknowledged={async () => {
              setDashboard(await api.getDashboard());
            }}
            onRecoveryChanged={async () => {
              setDashboard(await api.getDashboard());
            }}
          />
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
        {view === "diagnostics" ? (
          <DiagnosticsView dashboard={dashboard} />
        ) : null}
      </main>
    </div>
  );
}
