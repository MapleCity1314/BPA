import { useMemo, useState, type FormEvent } from "react";
import type {
  AttentionView,
  BrowserPageBindingSelection,
  BrowserSessionView,
  DashboardSnapshot,
  DesignModeGrantInput,
  DesignModeGrantView,
  DownloadView,
  EvidenceLineageView,
  RecoverySessionView,
  RunView,
  SubmitTaskInput,
  TaskView,
  WorkflowSummary
} from "@bpa/operator-console-contracts";
import type { OperatorConsoleApi } from "./api.js";

export type ViewId =
  | "overview"
  | "start"
  | "runs"
  | "tasks"
  | "datasets"
  | "evidence"
  | "reports"
  | "authoring"
  | "diagnostics";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

export function StatusPill({
  tone,
  children
}: {
  tone: string;
  children: React.ReactNode;
}) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

export function OverviewView({
  readOnly = false,
  dashboard,
  workflows,
  tasks,
  downloads,
  onNavigate
}: {
  readOnly?: boolean;
  dashboard: DashboardSnapshot;
  workflows: WorkflowSummary[];
  tasks: TaskView[];
  downloads: DownloadView[];
  onNavigate(view: ViewId): void;
}) {
  const ready = dashboard.attention === "normal";
  const attentionCount = tasks.length + dashboard.alerts.length;
  return (
    <div className="view-stack">
      <section className={`hero-card operator-hero ${ready ? "quiet" : "needs-action"}`}>
        <div>
          <p className="eyebrow">{ready ? "准备就绪" : "需要处理"}</p>
          <h2>
            {readOnly
              ? "BPA 运行概览"
              : ready
                ? "今天想让 BPA 做什么？"
                : "BPA 需要处理"}
          </h2>
          <p className="muted">
            {readOnly
              ? dashboard.headline
              : ready
                ? `已有 ${workflows.length} 个自动化可以直接开始。`
                : dashboard.headline}
          </p>
        </div>
        <button
          className="hero-action"
          onClick={() =>
            onNavigate(readOnly ? "runs" : ready ? "start" : "tasks")
          }
          type="button"
        >
          {readOnly ? "查看运行记录" : ready ? "开始新任务" : "查看处理项"}
        </button>
      </section>
      <section className="operator-home-grid" aria-label="业务概览">
        {!readOnly ? (
          <>
            <button onClick={() => onNavigate("start")} type="button">
              <span>开始</span>
              <strong>新任务</strong>
              <small>{workflows[0]?.title ?? "查看可用自动化"}</small>
            </button>
            <button onClick={() => onNavigate("tasks")} type="button">
              <span>需要处理</span>
              <strong>{attentionCount}</strong>
              <small>
                {attentionCount === 0
                  ? "当前无需介入"
                  : "查看阻断、失败与待确认项"}
              </small>
            </button>
          </>
        ) : null}
        <button onClick={() => onNavigate("runs")} type="button">
          <span>正在运行</span>
          <strong>{dashboard.activeRunCount}</strong>
          <small>可随时查看业务进度</small>
        </button>
        <button onClick={() => onNavigate("reports")} type="button">
          <span>最近结果</span>
          <strong>{downloads.length}</strong>
          <small>{downloads[0]?.title ?? "暂无可下载结果"}</small>
        </button>
      </section>
      {dashboard.alerts.length > 0 ? (
        <section className="panel attention-preview">
          <div className="section-heading">
            <div>
              <p className="eyebrow">运行问题</p>
              <h3>{dashboard.alerts[0]?.title}</h3>
              <p className="muted">{dashboard.alerts[0]?.requestedAction}</p>
            </div>
            {!readOnly ? (
              <button onClick={() => onNavigate("tasks")} type="button">
                查看 {dashboard.alerts.length} 项问题
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {tasks.length > 0 ? (
        <section className="panel attention-preview">
          <div className="section-heading">
            <div>
              <p className="eyebrow">需要你处理</p>
              <h3>{tasks[0]?.title}</h3>
              <p className="muted">{tasks[0]?.guidance}</p>
            </div>
            <button onClick={() => onNavigate("tasks")} type="button">
              集中处理 {tasks.length} 项
            </button>
          </div>
        </section>
      ) : null}
      {downloads.length > 0 ? (
        <section className="panel recent-result-preview">
          <div className="section-heading">
            <div>
              <p className="eyebrow">最近得到的结果</p>
              <h3>{downloads[0]?.title}</h3>
              <p className="muted">
                {formatTime(downloads[0]!.createdAt)} · 可安全下载
              </p>
            </div>
            <button onClick={() => onNavigate("reports")} type="button">
              查看全部结果
            </button>
          </div>
        </section>
      ) : null}
      {!ready ? (
        <section className="panel compact-health">
        <div className="section-heading">
          <div>
              <p className="eyebrow">无法自动解决</p>
              <h3>按提示处理后，由系统重新验证状态</h3>
              <p className="muted">终态任务不会自动重试，需要时请显式发起新任务。</p>
          </div>
        </div>
        <div className="health-list">
            {dashboard.components
              .filter((component) => component.status !== "healthy")
              .map((component) => (
            <article className="health-row" key={component.id}>
              <span className={`health-dot health-${component.status}`} />
              <div>
                <strong>{component.label}</strong>
                <p>{component.summary}</p>
                {component.technicalDetails ? (
                  <details>
                    <summary>查看技术细节</summary>
                    <code>{component.technicalDetails}</code>
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      ) : null}
    </div>
  );
}

export function SessionList({ sessions }: { sessions: BrowserSessionView[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">BROWSER RESOURCES</p>
          <h3>浏览器会话</h3>
        </div>
        <span className="muted">{sessions.length} 个</span>
      </div>
      {sessions.length === 0 ? (
        <div className="empty-state">尚未发现浏览器会话，请先打开 BPA Extension。</div>
      ) : (
        <div className="session-grid">
          {sessions.map((session) => (
            <article className="session-card" key={session.id}>
              <div className="session-title">
                <strong>{session.label}</strong>
                <StatusPill tone={session.status}>{session.status === "ready" ? "可用" : "请关注"}</StatusPill>
              </div>
              <p>{session.origin}</p>
              <dl>
                <div>
                  <dt>用途</dt>
                  <dd>{session.role ?? "未分配"}</dd>
                </div>
                <div>
                  <dt>登录</dt>
                  <dd>{session.authenticated ? "已确认" : "需要登录"}</dd>
                </div>
                <div>
                  <dt>最后在线</dt>
                  <dd>{formatTime(session.lastSeenAt)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function DiagnosticsView({
  dashboard
}: {
  dashboard: DashboardSnapshot;
}) {
  return (
    <div className="view-stack">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">开发者模式</p>
            <h2>系统诊断</h2>
            <p className="muted">
              普通任务不需要查看这些信息。这里保留完整的运行与连接追溯入口。
            </p>
          </div>
          <StatusPill tone={dashboard.attention}>
            Runtime {dashboard.runtimeVersion}
          </StatusPill>
        </div>
        <div className="health-list">
          {dashboard.components.map((component) => (
            <article className="health-row" key={component.id}>
              <span className={`health-dot health-${component.status}`} />
              <div>
                <strong>{component.label}</strong>
                <p>{component.summary}</p>
                {component.technicalDetails ? (
                  <details>
                    <summary>查看技术细节</summary>
                    <code>{component.technicalDetails}</code>
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      <SessionList sessions={dashboard.browserSessions} />
    </div>
  );
}

export function DesignModeView({
  api,
  sessions
}: {
  api: OperatorConsoleApi;
  sessions: BrowserSessionView[];
}) {
  const [authoringSessionId, setAuthoringSessionId] = useState("");
  const [browserSessionId, setBrowserSessionId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [bindingCode, setBindingCode] = useState("");
  const [screenshotApproved, setScreenshotApproved] = useState(false);
  const [grant, setGrant] = useState<DesignModeGrantView>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const selectedBrowserPage = sessions.find(
        (session) => session.id === browserSessionId
      );
      if (!selectedBrowserPage?.binding?.sessionId) {
        throw new Error(
          "浏览器页面绑定已失效，请刷新工作台后重新选择。"
        );
      }
      const pageBinding = JSON.parse(
        bindingCode
      ) as DesignModeGrantInput["pageBinding"];
      const next = await api.startDesignMode({
        authoringSessionId,
        browserSessionId: selectedBrowserPage.binding.sessionId,
        profileId,
        pageBinding,
        screenshotApproved
      });
      setGrant(next);
      setMessage(
        "只读授权已生效。Codex 可在有效期内请求脱敏语义快照。"
      );
    } catch (error) {
      setMessage(
        error instanceof SyntaxError
          ? "页面绑定码格式无效，请从 BPA Extension 重新生成。"
          : error instanceof Error
            ? error.message
            : "Design Mode 授权失败。"
      );
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!grant) return;
    setBusy(true);
    setMessage("");
    try {
      const stopped = await api.stopDesignMode(
        grant.id,
        grant.revision
      );
      setGrant(stopped);
      setMessage("Design Mode 已停止，原页面绑定码不能再次使用。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "停止授权失败。"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wizard">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GOVERNED AUTHORING</p>
          <h2>授权真实页面 Design Mode</h2>
          <p className="muted">
            授权固定浏览器会话、标签页、Origin 和页面纪元，15
            分钟后自动失效。页面内容只作为不可信数据，不会执行页面中的指令。
          </p>
        </div>
        <StatusPill tone={grant?.state === "active" ? "normal" : "attention"}>
          {grant?.state === "active" ? "授权中" : "未授权"}
        </StatusPill>
      </div>
      {grant?.state === "active" ? (
        <div className="design-grant-summary">
          <dl>
            <div>
              <dt>页面</dt>
              <dd>{grant.origin}</dd>
            </div>
            <div>
              <dt>标签页</dt>
              <dd>{grant.tabId}</dd>
            </div>
            <div>
              <dt>有效期</dt>
              <dd>{formatTime(grant.expiresAt)}</dd>
            </div>
            <div>
              <dt>截图</dt>
              <dd>{grant.screenshotApproved ? "单次允许" : "关闭"}</dd>
            </div>
          </dl>
          <button
            disabled={busy}
            onClick={() => void stop()}
            type="button"
          >
            立即停止授权
          </button>
        </div>
      ) : (
        <form onSubmit={start}>
          <div className="form-grid">
            <label>
              创作会话编号
              <input
                required
                value={authoringSessionId}
                onChange={(event) =>
                  setAuthoringSessionId(event.target.value)
                }
              />
              <small>由 Codex 创建 Scenario 后提供。</small>
            </label>
            <label>
              页面能力 Profile
              <input
                required
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
                placeholder="chanmama.product-metrics"
              />
            </label>
            <label>
              浏览器会话
              <select
                required
                value={browserSessionId}
                onChange={(event) =>
                  setBrowserSessionId(event.target.value)
                }
              >
                <option value="">请选择当前 Chrome 会话</option>
                {sessions
                  .filter((session) => session.status !== "offline")
                  .map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.label} · {session.origin}
                    </option>
                  ))}
              </select>
            </label>
            <label className="wide-field">
              一次性页面绑定码
              <textarea
                required
                value={bindingCode}
                onChange={(event) => setBindingCode(event.target.value)}
                placeholder="在目标页面打开 BPA Extension，点击“生成只读页面绑定码”后粘贴到这里。"
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={screenshotApproved}
                onChange={(event) =>
                  setScreenshotApproved(event.target.checked)
                }
              />
              本次额外允许一张 restricted 截图
              <small>默认关闭；语义快照不需要截图。</small>
            </label>
          </div>
          <div className="form-actions">
            <button
              className="primary-button"
              disabled={busy}
              type="submit"
            >
              {busy ? "正在核验…" : "确认并开启 15 分钟授权"}
            </button>
          </div>
        </form>
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

export function WorkflowWizard({
  api,
  workflows,
  sessions,
  onRunCreated
}: {
  api: OperatorConsoleApi;
  workflows: WorkflowSummary[];
  sessions: BrowserSessionView[];
  onRunCreated(runId: string): void;
}) {
  const [workflowKey, setWorkflowKey] = useState(
    workflows[0] ? `${workflows[0].id}@${workflows[0].version}` : ""
  );
  const [inputs, setInputs] = useState<Record<string, string | number | boolean>>({});
  const [bindings, setBindings] = useState<
    Record<string, BrowserPageBindingSelection>
  >({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const workflow = workflows.find(
    (item) => `${item.id}@${item.version}` === workflowKey
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workflow) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api.createRun({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        inputs,
        resourceBindings: bindings
      });
      setMessage(`任务已启动：${result.runId}`);
      onRunCreated(result.runId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务启动失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wizard">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GUIDED START</p>
          <h2>启动业务流程</h2>
          <p className="muted">按业务语言填写，技术配置已由已发布资产固定。</p>
        </div>
      </div>
      {workflows.length === 0 ? (
        <div className="empty-state">当前没有可运行的已发布流程。</div>
      ) : (
        <form onSubmit={submit}>
          <label>
            选择流程
            <select
              value={workflowKey}
              onChange={(event) => {
                setWorkflowKey(event.target.value);
                setInputs({});
                setBindings({});
              }}
            >
              {workflows.map((item) => (
                <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {workflow ? (
            <>
              <div className="workflow-description">
                <StatusPill tone={workflow.riskLevel}>{workflow.riskLevel} 只读</StatusPill>
                <p>{workflow.description}</p>
              </div>
              <div className="form-grid">
                {workflow.inputFields.map((field) => (
                  <label key={field.key}>
                    {field.label}
                    {field.kind === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={Boolean(inputs[field.key])}
                        onChange={(event) =>
                          setInputs((current) => ({
                            ...current,
                            [field.key]: event.target.checked
                          }))
                        }
                      />
                    ) : (
                      <input
                        type={field.kind === "number" ? "number" : "text"}
                        required={field.required}
                        value={String(inputs[field.key] ?? "")}
                        onChange={(event) =>
                          setInputs((current) => ({
                            ...current,
                            [field.key]:
                              field.kind === "number"
                                ? Number(event.target.value)
                                : event.target.value
                          }))
                        }
                      />
                    )}
                    {field.help ? <small>{field.help}</small> : null}
                  </label>
                ))}
                {workflow.resourceSlots.map((slot) => (
                  <label key={slot.key}>
                    {slot.label}
                    <select
                      required
                      value={
                        sessions.find(
                          (session) =>
                            session.binding === bindings[slot.key]
                        )?.id ?? ""
                      }
                      onChange={(event) => {
                        const selected = sessions.find(
                          (session) => session.id === event.target.value
                        );
                        setBindings((current) => {
                          const next = { ...current };
                          if (selected?.binding) {
                            next[slot.key] = selected.binding;
                          } else {
                            delete next[slot.key];
                          }
                          return next;
                        });
                      }}
                    >
                      <option value="">请选择浏览器会话</option>
                      {sessions
                        .filter(
                          (session) =>
                            session.status === "ready" &&
                            session.binding !== undefined &&
                            (!slot.requiredOrigin ||
                              session.origin.startsWith(slot.requiredOrigin))
                        )
                        .map((session) => (
                          <option key={session.id} value={session.id}>
                            {session.label} · {session.origin}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          ) : null}
          <div className="form-actions">
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "正在启动…" : "确认并启动"}
            </button>
            {message ? <p role="status">{message}</p> : null}
          </div>
        </form>
      )}
    </section>
  );
}

export function RunTimelineView({
  run,
  onLoad,
  initialRunId = ""
}: {
  run: RunView | undefined;
  onLoad(runId: string): Promise<void>;
  initialRunId?: string;
}) {
  const [runId, setRunId] = useState(initialRunId);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RUN TIMELINE</p>
          <h2>运行时间线</h2>
        </div>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (runId) void onLoad(runId);
        }}
      >
        <label>
          任务编号
          <input value={runId} onChange={(event) => setRunId(event.target.value)} />
        </label>
        <button type="submit">查询</button>
      </form>
      {!run ? (
        <div className="empty-state">输入任务编号，可查看每一步业务进度。</div>
      ) : (
        <>
          <div className="run-summary">
            <div>
              <h3>{run.workflowTitle}</h3>
              <p>{run.businessSummary}</p>
            </div>
            <StatusPill tone={run.status}>{run.status}</StatusPill>
          </div>
          <ol className="timeline">
            {run.timeline.map((entry) => (
              <li className={`timeline-${entry.state}`} key={entry.id}>
                <time>{formatTime(entry.at)}</time>
                <strong>{entry.title}</strong>
                <p>{entry.summary}</p>
                {entry.technicalDetails ? (
                  <details>
                    <summary>查看技术细节</summary>
                    <code>{entry.technicalDetails}</code>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

type ReferenceRole = NonNullable<
  NonNullable<SubmitTaskInput["referenceCuration"]>["selectedAssets"][number]
>["role"];

function ReferenceCurationEditor({
  busy,
  curation,
  onSubmit
}: {
  busy: boolean;
  curation: NonNullable<TaskView["referenceCuration"]>;
  onSubmit(input: SubmitTaskInput): Promise<void>;
}) {
  const roles: Array<{ value: ReferenceRole; label: string }> = [
    { value: "COMPOSITION_TEMPLATE", label: "构图模板" },
    { value: "PACKAGING_FACT", label: "包装观察" },
    { value: "PRODUCT_FACT", label: "产品观察" },
    { value: "TEXTURE_MATERIAL", label: "质感素材" }
  ];
  const [drafts, setDrafts] = useState(() =>
    Object.fromEntries(
      curation.assets.map((asset) => [
        asset.assetId,
        {
          selected: false,
          role: "COMPOSITION_TEMPLATE" as ReferenceRole,
          reason: "",
          prohibited: "不得据此推断版权、销量或产品真实性"
        }
      ])
    )
  );
  const selectedAssets = curation.assets.flatMap((asset) => {
    const draft = drafts[asset.assetId];
    if (!draft?.selected) return [];
    const prohibitedInferences = draft.prohibited
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    return [{
      assetId: asset.assetId,
      role: draft.role,
      reason: draft.reason.trim(),
      prohibitedInferences
    }];
  });
  const ready =
    selectedAssets.length > 0 &&
    selectedAssets.every(
      (asset) =>
        asset.reason.length > 0 && asset.prohibitedInferences.length > 0
    );
  return (
    <div className="reference-curation">
      <p className="reference-boundary">
        权利未评估 · 仅限内部参考 · 未选择的候选将明确记为不采用
      </p>
      <div className="reference-curation-grid">
        {curation.assets.map((asset) => {
          const draft = drafts[asset.assetId]!;
          return (
            <fieldset key={asset.assetId}>
              <img
                alt={`${asset.platform} 候选参考图`}
                loading="lazy"
                referrerPolicy="no-referrer"
                src={asset.previewUrl}
              />
              <label className="reference-select">
                <input
                  checked={draft.selected}
                  disabled={busy}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [asset.assetId]: {
                        ...current[asset.assetId]!,
                        selected: event.target.checked
                      }
                    }))
                  }
                  type="checkbox"
                />
                采用这张图
              </label>
              <small>{asset.platform} · {asset.discoveryId}</small>
              {draft.selected ? (
                <>
                  <label>
                    参考角色
                    <select
                      disabled={busy}
                      value={draft.role}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [asset.assetId]: {
                            ...current[asset.assetId]!,
                            role: event.target.value as ReferenceRole
                          }
                        }))
                      }
                    >
                      {roles.map((role) => (
                        <option key={role.value} value={role.value}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    采用理由
                    <input
                      disabled={busy}
                      maxLength={500}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [asset.assetId]: {
                            ...current[asset.assetId]!,
                            reason: event.target.value
                          }
                        }))
                      }
                      placeholder="只描述允许参考的视觉关系"
                      value={draft.reason}
                    />
                  </label>
                  <label>
                    禁止推断（每行一条）
                    <textarea
                      disabled={busy}
                      maxLength={3000}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [asset.assetId]: {
                            ...current[asset.assetId]!,
                            prohibited: event.target.value
                          }
                        }))
                      }
                      rows={3}
                      value={draft.prohibited}
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
          );
        })}
      </div>
      <button
        disabled={busy || !ready}
        onClick={() =>
          void onSubmit({
            decision: "publish_selection",
            referenceCuration: { selectedAssets }
          })
        }
        type="button"
      >
        发布内部参考包
      </button>
    </div>
  );
}

export function TaskCenter({
  api,
  alerts,
  browserSessions,
  recoverySessions,
  tasks,
  onCompleted,
  onAttentionAcknowledged,
  onRecoveryChanged
}: {
  api: OperatorConsoleApi;
  alerts: AttentionView[];
  browserSessions: BrowserSessionView[];
  recoverySessions: RecoverySessionView[];
  tasks: TaskView[];
  onCompleted(): Promise<void>;
  onAttentionAcknowledged(): Promise<void>;
  onRecoveryChanged(): Promise<void>;
}) {
  const deliveryLabel: Record<AttentionView["deliveryState"], string> = {
    pending: "通知待投递",
    delivering: "通知投递中",
    delivered: "通知渠道已受理",
    failed: "通知投递失败",
    uncertain: "通知结果不确定",
    "not-requested": "仅在工作台显示",
    missing: "通知任务缺失"
  };
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const recoveryPages = browserSessions.filter(
    (session) => session.recoveryBinding
  );
  const [selectedRecoveryPageId, setSelectedRecoveryPageId] = useState(
    recoveryPages[0]?.id ?? ""
  );
  async function submit(task: TaskView, input: SubmitTaskInput) {
    setBusyId(task.id);
    setMessage("");
    try {
      await api.submitTask(task.id, input);
      setMessage("已记录处理结果，流程将从原位置继续。");
      await onCompleted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败。");
    } finally {
      setBusyId("");
    }
  }
  async function acknowledge(alert: AttentionView) {
    setBusyId(alert.id);
    setMessage("");
    try {
      await api.acknowledgeAttention(alert.id, alert.revision);
      setMessage("已确认该运行问题；旧 Run 保持终态，不会自动重试。");
      await onAttentionAcknowledged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认失败。");
    } finally {
      setBusyId("");
    }
  }
  async function startRecovery(alert: AttentionView) {
    const selected = recoveryPages.find(
      (session) => session.id === selectedRecoveryPageId
    ) ?? recoveryPages[0];
    if (!selected?.recoveryBinding) {
      setMessage("没有可恢复的登录页面，请先在受管 Chrome 中打开登录页。");
      return;
    }
    setBusyId(alert.id);
    setMessage("");
    try {
      await api.startRecoverySession({
        attentionId: alert.id,
        expectedAttentionRevision: alert.revision,
        pageBinding: selected.recoveryBinding
      });
      setMessage(
        "恢复会话已开启。请只在绑定的 Chrome 标签页完成登录，然后点击“验证登录结果”。"
      );
      await onRecoveryChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "开启恢复失败。");
    } finally {
      setBusyId("");
    }
  }
  async function finishRecovery(
    recovery: RecoverySessionView,
    action: "complete" | "revoke"
  ) {
    setBusyId(recovery.attentionId);
    setMessage("");
    try {
      if (action === "complete") {
        await api.completeRecoverySession(recovery.id, recovery.revision);
        setMessage("登录状态已由同一标签页重新证明；旧 Run 不会自动重试。");
      } else {
        await api.revokeRecoverySession(recovery.id, recovery.revision);
        setMessage("恢复会话已结束，浏览器资源已释放。");
      }
      await onRecoveryChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复操作失败。");
    } finally {
      setBusyId("");
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ASSISTANCE</p>
          <h2>任务中心</h2>
          <p className="muted">只有需要判断或登录时才会在这里打扰你。</p>
        </div>
        <StatusPill tone={tasks.length + alerts.length ? "action" : "normal"}>
          {tasks.length + alerts.length ? "需要操作" : "无需监管"}
        </StatusPill>
      </div>
      {tasks.length === 0 && alerts.length === 0 ? (
        <div className="empty-state">目前没有需要人工处理的事项。</div>
      ) : (
        <div className="task-list">
          {alerts.map((alert) => (
            <article className="task-card" key={alert.id}>
              <div>
                <StatusPill tone="action">
                  {alert.kind === "blocking" ? "已阻断" : "需要复核"}
                </StatusPill>
                <h3>{alert.title}</h3>
                <p>{alert.reason}</p>
                <p>{alert.requestedAction}</p>
                <small>
                  {formatTime(alert.createdAt)}
                  {alert.runId ? ` · Run ${alert.runId}` : ""}
                  {` · ${deliveryLabel[alert.deliveryState]}`}
                  {alert.deliveryAttempt > 0
                    ? ` · 尝试 ${alert.deliveryAttempt}`
                    : ""}
                </small>
                {alert.deliveryErrorCode ? (
                  <small>通知诊断码：{alert.deliveryErrorCode}</small>
                ) : null}
              </div>
              <div className="choice-row">
                {alert.recoverable ? (() => {
                  const recovery = recoverySessions.find(
                    (session) =>
                      session.attentionId === alert.id &&
                      ["issued", "active"].includes(session.state)
                  );
                  return recovery ? (
                    <>
                      <button
                        disabled={busyId === alert.id}
                        onClick={() => void finishRecovery(recovery, "complete")}
                        type="button"
                      >
                        验证登录结果
                      </button>
                      <button
                        disabled={busyId === alert.id}
                        onClick={() => void finishRecovery(recovery, "revoke")}
                        type="button"
                      >
                        结束恢复
                      </button>
                    </>
                  ) : (
                    <>
                      {recoveryPages.length > 1 ? (
                        <select
                          aria-label="选择登录页面"
                          value={selectedRecoveryPageId}
                          onChange={(event) =>
                            setSelectedRecoveryPageId(event.target.value)
                          }
                        >
                          {recoveryPages.map((session) => (
                            <option key={session.id} value={session.id}>
                              {session.label} · {session.origin}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <button
                        disabled={
                          busyId === alert.id || recoveryPages.length === 0
                        }
                        onClick={() => void startRecovery(alert)}
                        type="button"
                      >
                        开始恢复登录
                      </button>
                    </>
                  );
                })() : null}
                <button
                  disabled={busyId === alert.id}
                  onClick={() => void acknowledge(alert)}
                  type="button"
                >
                  已知晓
                </button>
              </div>
            </article>
          ))}
          {tasks.map((task) => (
            <article className="task-card" key={task.id}>
              <div>
                <StatusPill tone={task.attention}>
                  {task.attention === "action" ? "需要操作" : "请关注"}
                </StatusPill>
                <h3>{task.title}</h3>
                <p>{task.guidance}</p>
                {task.dueAt ? <small>建议在 {formatTime(task.dueAt)} 前完成</small> : null}
              </div>
              {task.referenceCuration ? (
                <ReferenceCurationEditor
                  busy={busyId === task.id}
                  curation={task.referenceCuration}
                  onSubmit={(input) => submit(task, input)}
                />
              ) : (
                <div className="choice-row">
                  {(task.choices ?? [{ value: "confirmed", label: "确认完成" }]).map(
                    (choice) => (
                      <button
                        disabled={busyId === task.id}
                        key={choice.value}
                        onClick={() => void submit(task, { decision: choice.value })}
                        type="button"
                      >
                        {choice.label}
                      </button>
                    )
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

export function DatasetImport({ api }: { api: OperatorConsoleApi }) {
  const [file, setFile] = useState<File>();
  const [datasetId, setDatasetId] = useState("packaging-master");
  const [version, setVersion] = useState("1.0.0");
  const [title, setTitle] = useState("包装主数据");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await api.importDataset(file, {
        id: datasetId,
        version,
        title
      });
      setStatus(
        result.status === "published"
          ? `已发布 ${result.id}@${result.version}，共 ${result.recordCount ?? 0} 条记录。`
          : `文件未通过校验：${result.errors.join("；") || "请检查工作簿格式。"}`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导入失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DATASET</p>
          <h2>导入业务主数据</h2>
          <p className="muted">文件先进入临时上传凭证，经摘要和格式验证后才会发布为 Dataset。</p>
        </div>
      </div>
      <div className="upload-zone">
        <div className="inline-form">
          <label>
            Dataset ID
            <input
              aria-label="Dataset ID"
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
            />
          </label>
          <label>
            版本
            <input
              aria-label="Dataset 版本"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
          </label>
          <label>
            标题
            <input
              aria-label="Dataset 标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </div>
        <input
          aria-label="选择数据文件"
          type="file"
          accept=".xlsx"
          onChange={(event) => setFile(event.target.files?.[0])}
        />
        <p>{file ? `${file.name} · ${Math.ceil(file.size / 1024)} KiB` : "当前支持 packaging-master-v1 的 .xlsx 文件"}</p>
        <button
          className="primary-button"
          disabled={!file || !datasetId || !version || !title || busy}
          onClick={() => void upload()}
          type="button"
        >
          {busy ? "正在安全导入…" : "开始导入"}
        </button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

export function EvidenceView({
  lineage,
  onLoad
}: {
  lineage: EvidenceLineageView | undefined;
  onLoad(runId: string): Promise<void>;
}) {
  const [runId, setRunId] = useState("");
  const linkedSourceCount = useMemo(
    () => lineage?.evidence.reduce((sum, item) => sum + item.sourceIds.length, 0) ?? 0,
    [lineage]
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">TRUSTED LINEAGE</p>
          <h2>证据血缘</h2>
          <p className="muted">从业务结论反查原始来源、观察时间和不可变摘要。</p>
        </div>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (runId) void onLoad(runId);
        }}
      >
        <label>
          任务编号
          <input value={runId} onChange={(event) => setRunId(event.target.value)} />
        </label>
        <button type="submit">查看血缘</button>
      </form>
      {lineage ? (
        <div className="lineage-grid">
          <article>
            <span>01</span>
            <h3>来源 · {lineage.sources.length}</h3>
            {lineage.sources.map((source) => (
              <p key={source.id}>{source.label}<small>{source.origin}</small></p>
            ))}
          </article>
          <article>
            <span>02</span>
            <h3>证据 · {lineage.evidence.length}</h3>
            {lineage.evidence.map((evidence) => (
              <p key={evidence.id}>{evidence.label}<small>{evidence.classification} · {evidence.digest.slice(0, 16)}…</small></p>
            ))}
            <small>{linkedSourceCount} 条来源关联</small>
          </article>
          <article>
            <span>03</span>
            <h3>业务资产 · {lineage.assets.length}</h3>
            {lineage.assets.map((asset) => (
              <p key={asset.id}>{asset.label}<small>{asset.digest.slice(0, 16)}…</small></p>
            ))}
          </article>
        </div>
      ) : (
        <div className="empty-state">输入任务编号后查看可信证据链。</div>
      )}
    </section>
  );
}

export function ReportsView({
  api,
  downloads
}: {
  api: OperatorConsoleApi;
  downloads: DownloadView[];
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">OUTPUTS</p>
          <h2>报告与参考资产包</h2>
          <p className="muted">下载内容均保留来源、摘要和审计记录。</p>
        </div>
      </div>
      {downloads.length === 0 ? (
        <div className="empty-state">任务完成后，报告和 ReferenceAssetPack 会出现在这里。</div>
      ) : (
        <div className="download-list">
          {downloads.map((download) => (
            <article key={download.id}>
              <div>
                <StatusPill tone={download.kind}>{download.kind === "report" ? "检查报告" : "参考资产包"}</StatusPill>
                <h3>{download.title}</h3>
                <p>{download.fileName} · {Math.ceil(download.sizeBytes / 1024)} KiB</p>
                {download.kind === "reference_pack" ? (
                  <>
                    <p className="reference-boundary">
                      权利未评估 · 仅限内部参考 · 禁止外发
                    </p>
                    <div className="reference-preview-grid">
                      {download.assetIds.map((assetId) => (
                        <img
                          alt="受限参考图预览"
                          key={assetId}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          src={api.previewUrl(download.id, assetId)}
                        />
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
              <a className="download-button" href={api.downloadUrl(download.id)}>
                下载
              </a>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
