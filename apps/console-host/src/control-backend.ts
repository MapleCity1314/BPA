import { randomUUID } from "node:crypto";
import type {
  BrowserSessionView,
  ControlBackend,
  CreateRunInput,
  DashboardSnapshot,
  DownloadPayload,
  DownloadView,
  EvidenceLineageView,
  RunTimelineEntry,
  RunView,
  StagingLease,
  StagingLeaseRequest,
  SubmitTaskInput,
  TaskView,
  UploadReceipt,
  WorkflowInputField,
  WorkflowSummary
} from "@bpa/operator-console-contracts";
import { ConsoleUserFacingError } from "./user-facing-error.js";

export const CONSOLE_CONTROL_METHODS = {
  doctor: "doctor",
  catalogList: "catalog.list",
  runCreate: "run.create",
  runInspect: "run.inspect",
  runEvents: "run.events",
  taskList: "assistance.task.list",
  taskClaim: "assistance.task.claim",
  taskSubmit: "assistance.task.submit",
  stagingLeaseCreate: "staging.lease.create",
  evidenceLineageGet: "evidence.lineage.get",
  downloadList: "download.list",
  downloadGet: "download.get"
} as const;

export interface ConsoleControlRequester {
  request<TResult>(
    method: string,
    params?: Record<string, unknown>,
    options?: { requestId?: string; timeoutMs?: number }
  ): Promise<TResult>;
}

export interface UdsControlBackendOptions {
  actorId?: string;
  now?: () => Date;
  operationId?: () => string;
  leaseDurationMs?: number;
}

interface CachedTask {
  raw: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return parsed ? [parsed] : [];
      })
    : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return value;
}

function failureMessage(action: string): ConsoleUserFacingError {
  return new ConsoleUserFacingError(
    `${action}暂时不可用，请确认 BPA 本地服务正在运行后重试。`
  );
}

function workflowFields(spec: Record<string, unknown>): WorkflowInputField[] {
  const schema = record(spec.inputSchema);
  const properties = record(schema?.properties);
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.map(String) : []
  );
  if (!properties) return [];
  return Object.entries(properties).flatMap(([key, definition]) => {
    const property = record(definition);
    const type = text(property?.type);
    const kind =
      type === "boolean"
        ? "boolean"
        : type === "number" || type === "integer"
          ? "number"
          : type === "object" && /dataset/i.test(key)
            ? "dataset"
            : type === "string"
              ? "text"
              : undefined;
    if (!kind) return [];
    return [
      {
        key,
        label: text(property?.title, key),
        kind,
        required: required.has(key),
        ...(typeof property?.description === "string"
          ? { help: property.description }
          : {})
      }
    ];
  });
}

function workflowResources(
  spec: Record<string, unknown>
): WorkflowSummary["resourceSlots"] {
  const slots = record(spec.resourceSlots);
  if (!slots) return [];
  return Object.entries(slots).flatMap(([key, value]) => {
    const slot = record(value);
    if (!slot || slot.kind !== "browser") return [];
    const origins = Array.isArray(slot.allowedOrigins)
      ? slot.allowedOrigins.filter(
          (origin): origin is string => typeof origin === "string"
        )
      : [];
    return [
      {
        key,
        label: text(slot.purpose, key),
        ...(origins[0] ? { requiredOrigin: origins[0] } : {})
      }
    ];
  });
}

function mapRunStatus(value: unknown): RunView["status"] {
  switch (value) {
    case "created":
    case "validated":
      return "queued";
    case "waiting_browser":
    case "waiting_assistance":
    case "waiting_human":
    case "paused":
      return "waiting";
    case "compensating":
      return "running";
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "uncertain":
    case "cancelled":
      return value;
    default:
      return "uncertain";
  }
}

const eventTitles: Record<string, string> = {
  RUN_CREATED: "任务已创建",
  RUN_STARTED: "任务开始执行",
  RUN_WAITING_BROWSER: "等待浏览器准备",
  RUN_WAITING_ASSISTANCE: "等待人工确认",
  NODE_DISPATCHED: "正在执行检查步骤",
  NODE_SUCCEEDED: "检查步骤已完成",
  NODE_FAILED: "检查步骤未完成",
  RUN_SUCCEEDED: "任务已完成",
  RUN_FAILED: "任务执行失败",
  RUN_UNCERTAIN: "任务需要复核",
  RUN_CANCELLED: "任务已取消"
};

function timelineEntry(
  value: Record<string, unknown>,
  fallbackTime: string
): RunTimelineEntry {
  const type = text(value.type, "RUN_EVENT");
  const state: RunTimelineEntry["state"] =
    /FAILED|UNCERTAIN/.test(type)
      ? "failed"
      : /WAITING|PAUSED/.test(type)
        ? "waiting"
        : /STARTED|DISPATCHED|EXECUTING/.test(type)
          ? "active"
          : "completed";
  return {
    id: text(value.id, `event-${integer(value.sequence)}`),
    at: safeTimestamp(value.occurredAt, fallbackTime),
    title: eventTitles[type] ?? "任务状态已更新",
    summary:
      state === "failed"
        ? "此步骤未能确定完成，请按任务中心提示处理。"
        : state === "waiting"
          ? "流程已安全暂停，完成所需操作后会从原位置继续。"
          : "该步骤已经记录，可在技术细节中查看事件编号。",
    state,
    technicalDetails: `event=${type} · sequence=${integer(value.sequence)}`
  };
}

function taskOutput(
  task: CachedTask,
  input: SubmitTaskInput
): Record<string, unknown> {
  const properties = record(task.outputSchema.properties);
  const positive = !["reject", "rejected", "deny", "declined"].includes(
    input.decision
  );
  if (record(properties?.approved)?.type === "boolean") {
    return {
      approved: positive,
      ...(input.note && properties?.note ? { note: input.note } : {})
    };
  }
  if (properties?.decision) {
    return {
      decision: input.decision,
      ...(input.note && properties.note ? { note: input.note } : {})
    };
  }
  const stringKey = Object.entries(properties ?? {}).find(
    ([, definition]) => record(definition)?.type === "string"
  )?.[0];
  if (stringKey) return { [stringKey]: input.decision };
  return {
    decision: input.decision,
    ...(input.note ? { note: input.note } : {})
  };
}

export class UdsControlBackend implements ControlBackend {
  readonly #client: ConsoleControlRequester;
  readonly #actorId: string;
  readonly #now: () => Date;
  readonly #operationId: () => string;
  readonly #leaseDurationMs: number;
  readonly #tasks = new Map<string, CachedTask>();

  constructor(
    client: ConsoleControlRequester,
    options: UdsControlBackendOptions = {}
  ) {
    this.#client = client;
    this.#actorId = options.actorId ?? `operator-console:${process.pid}`;
    this.#now = options.now ?? (() => new Date());
    this.#operationId = options.operationId ?? randomUUID;
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1000;
  }

  async getDashboard(): Promise<DashboardSnapshot> {
    const observedAt = this.#now().toISOString();
    try {
      const [doctorValue, taskValue] = await Promise.all([
        this.#client.request<unknown>(CONSOLE_CONTROL_METHODS.doctor),
        this.#client
          .request<unknown>(CONSOLE_CONTROL_METHODS.taskList, {
            statuses: [
              "queued",
              "claimed",
              "processing",
              "awaiting_human"
            ],
            modes: ["human_confirm", "human_action"],
            limit: 100
          })
          .catch(() => [])
      ]);
      const doctor = record(doctorValue) ?? {};
      const persistence = record(doctor.persistence) ?? {};
      const browser = record(doctor.browser) ?? {};
      const browserReady = boolean(browser.ready);
      const browserConnected = boolean(browser.connected);
      const browserSessions: BrowserSessionView[] = browserConnected
        ? [
            {
              id: text(browser.sessionId, "browser-pending"),
              label: browserReady ? "已连接的 Chrome" : "Chrome 正在准备",
              status: browserReady ? "ready" : "attention",
              origin: `chrome-extension://${text(
                browser.extensionId,
                "bpa-extension"
              )}`,
              role: "浏览器自动化",
              authenticated: browserReady,
              lastSeenAt: observedAt
            }
          ]
        : [];
      const pendingTaskCount = records(taskValue).length;
      return {
        attention:
          !boolean(persistence.writable) || !browserReady
            ? "action"
            : pendingTaskCount > 0
              ? "attention"
              : "normal",
        headline:
          !boolean(persistence.writable)
            ? "业务数据暂时不可写"
            : !browserReady
              ? "请连接并准备 Chrome"
              : pendingTaskCount > 0
                ? `有 ${pendingTaskCount} 项等待处理`
                : "系统运行正常",
        runtimeVersion: "0.4.0",
        components: [
          {
            id: "core",
            label: "BPA 本地服务",
            status: doctor.status === "ok" ? "healthy" : "degraded",
            summary:
              doctor.status === "ok" ? "运行正常" : "服务需要检查",
            technicalDetails: `protocol=${text(doctor.protocol, "unknown")}`
          },
          {
            id: "persistence",
            label: "业务数据",
            status: boolean(persistence.writable) ? "healthy" : "unavailable",
            summary: boolean(persistence.writable)
              ? "数据读写正常"
              : "数据暂时不可写",
            technicalDetails: `adapter=${text(
              persistence.adapter,
              "unknown"
            )} · schema=${integer(persistence.schemaVersion)}`
          },
          {
            id: "browser",
            label: "Chrome 与扩展",
            status: browserReady
              ? "healthy"
              : browserConnected
                ? "degraded"
                : "unavailable",
            summary: browserReady
              ? "浏览器能力已就绪"
              : browserConnected
                ? "扩展已连接，正在等待页面能力"
                : "尚未连接浏览器"
          }
        ],
        browserSessions,
        activeRunCount: 0,
        pendingTaskCount
      };
    } catch {
      return {
        attention: "action",
        headline: "BPA 本地服务尚未连接",
        runtimeVersion: "0.4.0",
        components: [
          {
            id: "core",
            label: "BPA 本地服务",
            status: "unavailable",
            summary: "请启动本地服务后重新打开工作台"
          }
        ],
        browserSessions: [],
        activeRunCount: 0,
        pendingTaskCount: 0
      };
    }
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.catalogList,
        { assetType: "workflow" }
      );
      return records(value).flatMap((artifact) => {
        const content = record(artifact.content);
        const metadata = record(content?.metadata);
        const spec = record(content?.spec);
        const riskLevel = spec?.riskLevel;
        if (
          !content ||
          !metadata ||
          !spec ||
          (riskLevel !== "R0" && riskLevel !== "R1")
        ) {
          return [];
        }
        return [
          {
            id: text(artifact.assetId, text(metadata.id)),
            version: text(artifact.version, text(metadata.version)),
            title: text(metadata.title, text(artifact.assetId)),
            description: text(metadata.description, "已发布的只读业务流程"),
            riskLevel,
            inputFields: workflowFields(spec),
            resourceSlots: workflowResources(spec)
          }
        ];
      });
    } catch {
      return [];
    }
  }

  async createRun(input: CreateRunInput) {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.runCreate,
        {
          workflowId: input.workflowId,
          workflowVersion: input.workflowVersion,
          input: input.inputs,
          resourceBindings: input.resourceBindings
        }
      );
      const run = record(value);
      const runId = text(run?.id, text(run?.runId));
      if (!runId) throw new Error("missing run id");
      return { runId };
    } catch {
      throw failureMessage("启动流程");
    }
  }

  async getRun(runId: string): Promise<RunView> {
    try {
      const [runValue, eventValue] = await Promise.all([
        this.#client.request<unknown>(CONSOLE_CONTROL_METHODS.runInspect, {
          runId
        }),
        this.#client.request<unknown>(CONSOLE_CONTROL_METHODS.runEvents, {
          runId
        })
      ]);
      const run = record(runValue);
      if (!run) throw new Error("invalid run");
      const startedAt = safeTimestamp(
        run.createdAt,
        this.#now().toISOString()
      );
      const status = mapRunStatus(run.status);
      const currentNode = text(run.currentNodeKey);
      return {
        id: text(run.id, runId),
        workflowTitle: `${text(run.workflowId, "业务流程")} · ${text(
          run.workflowVersion,
          "unknown"
        )}`,
        status,
        businessSummary:
          status === "succeeded"
            ? "任务已完成，可在报告与资产中查看结果。"
            : status === "waiting"
              ? "任务已安全暂停，请查看任务中心。"
              : status === "failed" || status === "uncertain"
                ? "任务没有确定完成，请按提示复核。"
                : currentNode
                  ? `正在执行：${currentNode}`
                  : "任务正在准备执行。",
        startedAt,
        ...(typeof run.updatedAt === "string" &&
        ["succeeded", "failed", "uncertain", "cancelled"].includes(status)
          ? { completedAt: safeTimestamp(run.updatedAt, startedAt) }
          : {}),
        timeline: records(eventValue).map((event) =>
          timelineEntry(event, startedAt)
        )
      };
    } catch {
      throw failureMessage("查询任务");
    }
  }

  async listTasks(): Promise<TaskView[]> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.taskList,
        {
          statuses: [
            "queued",
            "claimed",
            "processing",
            "awaiting_human"
          ],
          modes: ["human_confirm", "human_action"],
          limit: 100
        }
      );
      this.#tasks.clear();
      return records(value).flatMap((task) => {
        const taskId = text(task.taskId);
        const mode = task.mode;
        const status = text(task.status);
        if (
          !taskId ||
          (mode !== "human_confirm" && mode !== "human_action") ||
          ![
            "queued",
            "claimed",
            "processing",
            "awaiting_human"
          ].includes(status)
        ) {
          return [];
        }
        const taskLease = record(task.lease);
        const leaseActive =
          typeof taskLease?.expiresAt === "string" &&
          Date.parse(taskLease.expiresAt) > this.#now().getTime();
        if (
          (status === "claimed" || status === "processing") &&
          leaseActive &&
          taskLease?.ownerId !== this.#actorId
        ) {
          return [];
        }
        const profile = record(task.profile);
        const outputSchema = record(task.outputSchema) ?? {};
        this.#tasks.set(taskId, { raw: task, outputSchema });
        const properties = record(outputSchema.properties);
        const approved = record(properties?.approved)?.type === "boolean";
        return [
          {
            id: taskId,
            runId: text(task.runId),
            kind: mode,
            title:
              mode === "human_action"
                ? "需要你完成页面操作"
                : `请确认：${text(profile?.id, "业务判断")}`,
            guidance:
              mode === "human_action"
                ? "按页面提示完成登录或验证后，再回来确认完成。"
                : "请核对业务信息；不确定时选择暂不确认。",
            attention: mode === "human_action" ? "action" : "attention",
            dueAt: safeTimestamp(task.deadline, this.#now().toISOString()),
            choices: approved
              ? [
                  { value: "confirmed", label: "确认" },
                  { value: "rejected", label: "暂不确认" }
                ]
              : [{ value: "completed", label: "确认完成" }]
          }
        ];
      });
    } catch {
      return [];
    }
  }

  async submitTask(taskId: string, input: SubmitTaskInput): Promise<void> {
    const cached = this.#tasks.get(taskId);
    if (!cached) throw failureMessage("提交处理结果");
    try {
      const existingLease = record(cached.raw.lease);
      const canReuseLease =
        (cached.raw.status === "claimed" ||
          cached.raw.status === "processing") &&
        existingLease?.ownerId === this.#actorId &&
        typeof existingLease.expiresAt === "string" &&
        Date.parse(existingLease.expiresAt) > this.#now().getTime();
      let leaseId = text(existingLease?.leaseId);
      let fencingToken = integer(existingLease?.fencingToken);
      if (!canReuseLease || !leaseId || fencingToken < 1) {
        leaseId = `console-lease:${this.#operationId()}`;
        const claimedValue = await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.taskClaim,
          {
            operationId: this.#operationId(),
            taskId,
            leaseId,
            actorId: this.#actorId,
            actorType: "human",
            leaseDurationMs: this.#leaseDurationMs
          }
        );
        const claimed = record(claimedValue);
        const claimedTask = record(claimed?.task);
        if (!boolean(claimed?.ok) || !claimedTask) {
          throw new Error("claim rejected");
        }
        const lease = record(claimedTask.lease);
        fencingToken = integer(
          lease?.fencingToken,
          integer(claimedTask.fencingCounter)
        );
      }
      if (fencingToken < 1) throw new Error("missing fencing token");
      const submittedValue = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.taskSubmit,
        {
          operationId: this.#operationId(),
          taskId,
          leaseId,
          actorId: this.#actorId,
          resolverType: "human",
          fencingToken,
          output: taskOutput(cached, input)
        }
      );
      if (!boolean(record(submittedValue)?.ok)) {
        throw new Error("submit rejected");
      }
      this.#tasks.delete(taskId);
    } catch {
      throw failureMessage("提交处理结果");
    }
  }

  async createStagingLease(
    input: StagingLeaseRequest
  ): Promise<StagingLease> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.stagingLeaseCreate,
        input as unknown as Record<string, unknown>
      );
      const lease = record(value);
      const id = text(lease?.id, text(lease?.leaseId));
      if (!lease || !id) throw new Error("invalid lease");
      return {
        id,
        expiresAt: safeTimestamp(
          lease.expiresAt,
          this.#now().toISOString()
        ),
        maxBytes: integer(lease.maxBytes)
      };
    } catch {
      throw failureMessage("创建安全上传凭证");
    }
  }

  async uploadStagingLease(
    _leaseId: string,
    _body: Uint8Array,
    _expectedSha256?: string
  ): Promise<UploadReceipt> {
    throw new ConsoleUserFacingError(
      "安全文件上传通道尚未启用；文件内容不会通过控制协议发送。"
    );
  }

  async getEvidenceLineage(runId: string): Promise<EvidenceLineageView> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.evidenceLineageGet,
        { runId }
      );
      const lineage = record(value);
      if (!lineage) throw new Error("invalid lineage");
      return {
        runId: text(lineage.runId, runId),
        sources: records(lineage.sources).map((source) => ({
          id: text(source.id),
          label: text(source.label, "业务来源"),
          origin: text(source.origin, "来源已脱敏"),
          observedAt: safeTimestamp(
            source.observedAt,
            this.#now().toISOString()
          )
        })),
        evidence: records(lineage.evidence).map((evidence) => ({
          id: text(evidence.id),
          label: text(evidence.label, "业务证据"),
          classification:
            evidence.classification === "confidential"
              ? "confidential"
              : evidence.classification === "restricted"
                ? "restricted"
                : "public",
          digest: text(evidence.digest),
          sourceIds: Array.isArray(evidence.sourceIds)
            ? evidence.sourceIds.map(String)
            : []
        })),
        assets: records(lineage.assets).map((asset) => ({
          id: text(asset.id),
          label: text(asset.label, "业务资产"),
          digest: text(asset.digest),
          evidenceIds: Array.isArray(asset.evidenceIds)
            ? asset.evidenceIds.map(String)
            : []
        }))
      };
    } catch {
      throw failureMessage("查询证据血缘");
    }
  }

  async listDownloads(runId?: string): Promise<DownloadView[]> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.downloadList,
        runId ? { runId } : {}
      );
      return records(value).flatMap((download) => {
        const id = text(download.id);
        const kind = download.kind;
        if (
          !id ||
          (kind !== "report" && kind !== "reference_pack")
        ) {
          return [];
        }
        return [
          {
            id,
            runId: text(download.runId),
            kind,
            title: text(download.title, "业务输出"),
            fileName: text(download.fileName, "bpa-output"),
            sizeBytes: integer(download.sizeBytes),
            createdAt: safeTimestamp(
              download.createdAt,
              this.#now().toISOString()
            )
          }
        ];
      });
    } catch {
      return [];
    }
  }

  async getDownload(downloadId: string): Promise<DownloadPayload> {
    try {
      await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.downloadGet,
        { downloadId }
      );
    } catch {
      throw failureMessage("准备下载");
    }
    throw new ConsoleUserFacingError(
      "安全下载通道尚未启用；文件内容不会通过控制协议发送。"
    );
  }
}
