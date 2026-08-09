import { createHash, randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import type {
  AttentionView,
  BrowserSessionView,
  ControlBackend,
  DashboardQuery,
  CreateRunInput,
  DashboardSnapshot,
  DatasetImportResult,
  DesignModeGrantInput,
  DesignModeGrantView,
  DownloadPayload,
  DownloadView,
  EvidenceLineageView,
  RecoverySessionView,
  RunTimelineEntry,
  RunView,
  StagingLease,
  StagingLeaseRequest,
  StagedDatasetImportInput,
  StartRecoverySessionInput,
  SubmitTaskInput,
  TaskView,
  UploadReceipt,
  WorkflowInputField,
  WorkflowSummary
} from "@bpa/operator-console-contracts";
import { ConsoleUserFacingError } from "./user-facing-error.js";
import type { StagingUploader } from "./staging-uploader.js";

export const CONSOLE_CONTROL_METHODS = {
  doctor: "doctor",
  browserSessionList: "browser.session.list",
  browserPageObservationList: "browser.page-observation.list",
  catalogList: "catalog.list",
  runCreate: "run.create",
  runInspect: "run.inspect",
  runEvents: "run.events",
  taskList: "assistance.task.list",
  taskClaim: "assistance.task.claim",
  taskSubmit: "assistance.task.submit",
  attentionList: "attention.list",
  attentionAcknowledge: "attention.acknowledge",
  recoverySessionIssue: "recovery-session.issue",
  recoverySessionList: "recovery-session.list",
  recoverySessionActivate: "recovery-session.activate",
  recoverySessionComplete: "recovery-session.complete",
  recoverySessionRevoke: "recovery-session.revoke",
  stagingLeaseCreate: "staging.lease.create",
  datasetImportStaged: "dataset.import.staged",
  evidenceLineageGet: "evidence.lineage.get",
  downloadList: "download.list",
  downloadGet: "download.get",
  downloadAssetGet: "download.asset.get",
  authoringDesignModeRequest: "authoring.design-mode.request",
  authoringDesignModeActivate: "authoring.design-mode.activate",
  authoringDesignModeStop: "authoring.design-mode.stop"
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
  stagingUploader?: StagingUploader;
  assetReader?: { read(storageRef: string): Uint8Array };
}

interface CachedTask {
  raw: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  referenceCuration?: NonNullable<TaskView["referenceCuration"]>;
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

function attentionList(value: unknown): {
  items: Record<string, unknown>[];
  total: number;
  truncated: boolean;
} | undefined {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.items)) return undefined;
  const items = records(envelope.items);
  if (items.length !== envelope.items.length) return undefined;
  const total = integer(envelope.total, -1);
  if (
    total < items.length ||
    typeof envelope.truncated !== "boolean" ||
    (envelope.truncated ? total <= items.length : total !== items.length)
  ) {
    return undefined;
  }
  return { items, total, truncated: envelope.truncated };
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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function boundedStringArray(
  value: unknown,
  options: {
    minimum: number;
    maximum: number;
    itemMaximum: number;
    allowed?: readonly string[];
  }
): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < options.minimum ||
    value.length > options.maximum ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > options.itemMaximum ||
        (options.allowed && !options.allowed.includes(item))
    ) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return [...value] as string[];
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
    case "rejected":
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
  RUN_REJECTED: "任务已被安全阻断",
  RUN_FAILED: "任务执行失败",
  RUN_UNCERTAIN: "任务需要复核",
  RUN_CANCELLED: "任务已取消"
};

function timelineEntry(
  value: Record<string, unknown>,
  fallbackTime: string
): RunTimelineEntry {
  const type = text(value.type, "RUN_EVENT");
  const payload = record(value.payload);
  const rejected =
    type === "RUN_REJECTED" ||
    payload?.status === "rejected" ||
    payload?.outcomeStatus === "rejected";
  const state: RunTimelineEntry["state"] =
    rejected || /FAILED|UNCERTAIN/.test(type)
      ? "failed"
      : /WAITING|PAUSED/.test(type)
        ? "waiting"
        : /STARTED|DISPATCHED|EXECUTING/.test(type)
          ? "active"
          : "completed";
  return {
    id: text(value.id, `event-${integer(value.sequence)}`),
    at: safeTimestamp(value.occurredAt, fallbackTime),
    title: rejected
      ? eventTitles.RUN_REJECTED!
      : eventTitles[type] ?? "任务状态已更新",
    summary:
      rejected
        ? "任务已作为不可恢复终态安全阻断；处理拒绝原因后请重新发起。"
        : state === "failed"
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
  if (task.referenceCuration) {
    const submitted = input.referenceCuration;
    const roleDimensions: Record<string, string> = {
      COMPOSITION_TEMPLATE: "composition",
      PACKAGING_FACT: "packaging_observation",
      PRODUCT_FACT: "product_observation",
      TEXTURE_MATERIAL: "texture_reference"
    };
    if (
      input.decision !== "publish_selection" ||
      input.note !== undefined ||
      !submitted ||
      submitted.selectedAssets.length < 1 ||
      submitted.selectedAssets.length > task.referenceCuration.assets.length
    ) {
      throw new Error("invalid reference curation");
    }
    const available = new Set(
      task.referenceCuration.assets.map((asset) => asset.assetId)
    );
    const selectedIds = new Set<string>();
    const selectedAssets = submitted.selectedAssets.map((item) => {
      const dimension = roleDimensions[item.role];
      if (
        !available.has(item.assetId) ||
        selectedIds.has(item.assetId) ||
        !dimension ||
        item.reason.length < 1 ||
        item.reason.length > 500 ||
        item.prohibitedInferences.length < 1 ||
        item.prohibitedInferences.length > 10 ||
        new Set(item.prohibitedInferences).size !==
          item.prohibitedInferences.length ||
        item.prohibitedInferences.some(
          (value) => value.length < 1 || value.length > 300
        )
      ) {
        throw new Error("invalid reference curation");
      }
      selectedIds.add(item.assetId);
      return {
        assetId: item.assetId,
        role: item.role,
        reason: item.reason,
        allowedTransferDimensions: [dimension],
        prohibitedInferences: [...item.prohibitedInferences]
      };
    });
    return {
      packId: task.referenceCuration.packId,
      selectedAssets,
      rejectedAssetIds: task.referenceCuration.assets
        .map((asset) => asset.assetId)
        .filter((assetId) => !selectedIds.has(assetId))
    };
  }
  if (input.referenceCuration) {
    throw new Error("unexpected reference curation");
  }
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

function referenceCurationView(
  task: Record<string, unknown>
): NonNullable<TaskView["referenceCuration"]> | undefined {
  const profile = record(task.profile);
  if (
    profile?.id !== "reference_asset_curation" ||
    profile.version !== "1.0.0"
  ) {
    return undefined;
  }
  const input = record(task.input);
  const materialization = record(input?.materialization);
  if (
    !input ||
    !hasExactKeys(input, ["packId", "materialization"]) ||
    !materialization ||
    !hasExactKeys(materialization, [
      "schemaVersion", "materializationExportId", "packId", "sourceRunId",
      "status", "rightsStatus", "allowedUse", "sourceEvidenceDigest",
      "assetCount", "assets", "blockers"
    ]) ||
    materialization.schemaVersion !== "reference-asset-materialization/v1" ||
    materialization.packId !== input.packId ||
    materialization.sourceRunId !== task.runId ||
    materialization.status !== "materialized_internal_reference" ||
    materialization.rightsStatus !== "not_assessed" ||
    materialization.allowedUse !== "internal_reference_only" ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(materialization.sourceEvidenceDigest)) ||
    JSON.stringify(materialization.blockers) !== JSON.stringify([
      "SOURCE_RIGHTS_NOT_ASSESSED",
      "HUMAN_ROLE_CURATION_REQUIRED"
    ]) ||
    !boundedText(input.packId, 120) ||
    !boundedText(materialization.materializationExportId, 300) ||
    !Array.isArray(materialization.assets) ||
    materialization.assets.length < 1 ||
    materialization.assets.length > 20 ||
    materialization.assetCount !== materialization.assets.length
  ) {
    throw new Error("invalid reference curation task");
  }
  const materializationExportId = materialization.materializationExportId as string;
  const assets = materialization.assets.map((value) => {
    const item = record(value);
    if (
      !item ||
      !hasExactKeys(item, [
        "discoveryId", "platform", "sourceEvidenceId", "assetId", "digest",
        "sizeBytes", "mediaType", "observedRemoteUrl", "sourceUrl",
        "sourcePageUrl", "role", "rightsStatus", "allowedUse"
      ]) ||
      !["DOUYIN", "TAOBAO", "JD"].includes(String(item.platform)) ||
      !boundedText(item.discoveryId, 300) ||
      !boundedText(item.sourceEvidenceId, 200) ||
      !boundedText(item.assetId, 300) ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(item.digest)) ||
      !Number.isSafeInteger(item.sizeBytes) ||
      (item.sizeBytes as number) < 1 ||
      (item.sizeBytes as number) > 5 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(
        String(item.mediaType)
      ) ||
      item.role !== "UNASSIGNED_REFERENCE_CANDIDATE" ||
      item.rightsStatus !== "not_assessed" ||
      item.allowedUse !== "internal_reference_only"
    ) {
      throw new Error("invalid reference curation task");
    }
    return {
      assetId: item.assetId as string,
      platform: item.platform as "DOUYIN" | "TAOBAO" | "JD",
      discoveryId: item.discoveryId as string,
      mediaType: item.mediaType as "image/jpeg" | "image/png" | "image/webp",
      sizeBytes: item.sizeBytes as number,
      previewUrl:
        `/api/downloads/${encodeURIComponent(materializationExportId)}` +
        `/assets/${encodeURIComponent(item.assetId as string)}`
    };
  });
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new Error("invalid reference curation task");
  }
  return {
    packId: input.packId as string,
    materializationExportId,
    rightsStatus: "not_assessed",
    allowedUse: "internal_reference_only",
    assets
  };
}

function designGrantView(value: unknown): DesignModeGrantView {
  const grant = record(value);
  if (
    !grant ||
    (grant.state !== "active" && grant.state !== "stopped")
  ) {
    throw new Error("invalid Design Mode Grant");
  }
  const allowedOperations = stringList(grant.allowedOperations);
  return {
    id: text(grant.grantId),
    authoringSessionId: text(grant.authoringSessionId),
    browserSessionId: text(grant.browserSessionId),
    profileId: text(grant.profileId),
    state: grant.state,
    origin: text(grant.origin),
    tabId: integer(grant.tabId, -1),
    pageEpoch: text(grant.pageEpoch),
    expiresAt: safeTimestamp(grant.expiresAt, new Date(0).toISOString()),
    screenshotApproved: allowedOperations.includes("screenshot_once"),
    revision: integer(grant.revision)
  };
}

function recoverySessionView(value: unknown): RecoverySessionView {
  const session = record(value);
  const state = text(session?.state);
  if (
    !session ||
    ![
      "issued",
      "active",
      "completed",
      "expired",
      "revoked",
      "invalidated"
    ].includes(state)
  ) {
    throw new Error("invalid Recovery Session");
  }
  return {
    id: text(session.id),
    attentionId: text(session.attentionId),
    revision: integer(session.revision),
    state: state as RecoverySessionView["state"],
    browserInstanceId: text(session.browserInstanceId),
    profileId: text(session.profileId),
    tabId: integer(session.tabId, -1),
    origin: text(session.origin),
    issuedAt: safeTimestamp(session.issuedAt, new Date(0).toISOString()),
    expiresAt: safeTimestamp(session.expiresAt, new Date(0).toISOString()),
    updatedAt: safeTimestamp(session.updatedAt, new Date(0).toISOString()),
    ...(text(session.terminalReason)
      ? { terminalReason: text(session.terminalReason) }
      : {})
  };
}

export class UdsControlBackend implements ControlBackend {
  readonly #client: ConsoleControlRequester;
  readonly #actorId: string;
  readonly #now: () => Date;
  readonly #operationId: () => string;
  readonly #leaseDurationMs: number;
  readonly #stagingUploader: StagingUploader | undefined;
  readonly #assetReader:
    | { read(storageRef: string): Uint8Array }
    | undefined;
  readonly #tasks = new Map<string, CachedTask>();
  readonly #stagingAuthorizations = new Map<
    string,
    { token: string; expectedSha256?: string }
  >();

  constructor(
    client: ConsoleControlRequester,
    options: UdsControlBackendOptions = {}
  ) {
    this.#client = client;
    this.#actorId = options.actorId ?? `operator-console:${process.pid}`;
    this.#now = options.now ?? (() => new Date());
    this.#operationId = options.operationId ?? randomUUID;
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1000;
    this.#stagingUploader = options.stagingUploader;
    this.#assetReader = options.assetReader;
  }

  async getDashboard(query: DashboardQuery = {}): Promise<DashboardSnapshot> {
    const observedAt = this.#now().toISOString();
    try {
      const [
        doctorValue,
        taskValue,
        pageValue,
        attentionValue,
        recoveryValue
      ] =
        await Promise.all([
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
            .catch(() => []),
          this.#client
            .request<unknown>(
              CONSOLE_CONTROL_METHODS.browserPageObservationList,
              { limit: 200 }
            )
            .catch(() => []),
          this.#client
            .request<unknown>(CONSOLE_CONTROL_METHODS.attentionList, {
              states: ["open"],
              limit: 100
            })
            .then(
              (value) => ({ available: true as const, value }),
              () => ({ available: false as const, value: undefined })
            ),
          query.includeRecoverySessions === false
            ? Promise.resolve([])
            : this.#client
                .request<unknown>(CONSOLE_CONTROL_METHODS.recoverySessionList, {
                  limit: 100
                })
                .catch(() => [])
        ]);
      const doctor = record(doctorValue) ?? {};
      const persistence = record(doctor.persistence) ?? {};
      const browser = record(doctor.browser) ?? {};
      const browserReady = boolean(browser.ready);
      const browserConnected = boolean(browser.connected);
      const observedPages = records(pageValue);
      const browserSessions: BrowserSessionView[] =
        observedPages.length > 0
          ? observedPages.slice(0, 20).map((page) => {
              const observationState = text(
                page.observationState,
                "unknown"
              );
              const contentReady = boolean(page.contentScriptReady);
              const authentication = text(page.authentication);
              const sessionId = text(page.sessionId);
              const browserInstanceId = text(page.browserInstanceId);
              const tabId = integer(page.tabId, -1);
              const observationRevision = integer(page.revision, -1);
              const pageEpoch = text(page.pageEpoch);
              const origin = text(page.origin);
              const validBinding =
                sessionId.length > 0 &&
                browserInstanceId.length > 0 &&
                tabId >= 0 &&
                observationRevision >= 1;
              return {
                id: `${browserInstanceId}:${tabId}:${observationRevision}`,
                label: `Chrome 标签页 ${tabId}`,
                status:
                  ["departed", "stale"].includes(observationState)
                    ? "offline"
                    : observationState === "ready" && contentReady
                      ? "ready"
                      : "attention",
                origin: origin || "等待选择业务来源",
                role: text(page.observerCapabilityId, "浏览器页面"),
                authenticated: ["authenticated", "membership"].includes(
                  authentication
                ),
                lastSeenAt: safeTimestamp(page.observedAt, observedAt),
                ...(validBinding
                  ? {
                      binding: {
                        sessionId,
                        browserInstanceId,
                        tabId,
                        observationRevision
                      }
                    }
                  : {}),
                ...(
                  validBinding &&
                  pageEpoch.length > 0 &&
                  origin.startsWith("https://") &&
                  ["auth_required", "challenge"].includes(
                    observationState
                  ) &&
                  !["authenticated", "membership"].includes(authentication)
                    ? {
                        recoveryBinding: {
                          sessionId,
                          browserInstanceId,
                          profileId: browserInstanceId,
                          tabId,
                          observationRevision,
                          origin,
                          pageEpoch
                        }
                      }
                    : {})
              };
            })
          : browserConnected
            ? [
                {
                  id: "browser-pending",
                  label: browserReady
                    ? "Chrome 已连接，等待页面"
                    : "Chrome 正在准备",
                  status: "attention",
                  origin: "等待 Content Script 页面观察",
                  role: "浏览器自动化",
                  authenticated: false,
                  lastSeenAt: observedAt
                }
              ]
            : [];
      const pendingTaskCount = records(taskValue).length;
      const parsedAttention = attentionValue.available
        ? attentionList(attentionValue.value)
        : undefined;
      const attentionTotal = parsedAttention?.total ?? 0;
      const attentionTruncated = parsedAttention?.truncated ?? false;
      const alerts: AttentionView[] = (parsedAttention?.items ?? []).flatMap(
        (item) => {
          const id = text(item.id);
          const kind = text(item.kind);
          const deliveryState = text(item.deliveryState, "missing");
          const deliveryPolicy = text(item.deliveryPolicy);
          const sourceRef = record(item.sourceRef);
          const sourceKind = text(sourceRef?.kind);
          const sourceRunId = text(sourceRef?.runId);
          const sourceOccurrenceId = text(sourceRef?.occurrenceId);
          const sourceRefIsValid =
            (sourceKind === "workflow-run" && sourceRunId.length > 0) ||
            (sourceKind === "trigger-occurrence" &&
              sourceOccurrenceId.length > 0);
          const runStatus = text(item.runStatus);
          const terminalRunIsSafe = [
            "rejected",
            "failed",
            "uncertain"
          ].includes(runStatus);
          if (
            !id ||
            !sourceRefIsValid ||
            !["operator-notification", "dashboard-only"].includes(
              deliveryPolicy
            ) ||
            ![
              "information",
              "review",
              "action",
              "approval",
              "blocking"
            ].includes(kind) ||
            ![
              "pending",
              "delivering",
              "delivered",
              "failed",
              "uncertain",
              "not-requested",
              "missing"
            ].includes(deliveryState) ||
            (deliveryPolicy === "dashboard-only") !==
              (deliveryState === "not-requested") ||
            (deliveryState === "not-requested" &&
              (integer(item.deliveryAttempt) !== 0 ||
                text(item.deliveryErrorCode).length > 0))
          ) {
            return [];
          }
          return [
            {
              id,
              ...(sourceRunId ? { runId: sourceRunId } : {}),
              kind: kind as AttentionView["kind"],
              title: text(item.title, "任务需要处理"),
              reason: text(item.reason, "任务没有确定完成。"),
              requestedAction: text(
                item.requestedAction,
                "查看运行记录后再决定是否重新发起。"
              ),
              createdAt: safeTimestamp(item.createdAt, observedAt),
              revision: integer(item.revision),
              deliveryState: deliveryState as AttentionView["deliveryState"],
              deliveryAttempt: integer(item.deliveryAttempt),
              recoverable:
                sourceKind === "workflow-run" &&
                sourceRunId.length > 0 &&
                item.source === "browser" &&
                deliveryPolicy === "operator-notification" &&
                item.groupKey === "authentication" &&
                kind === "blocking" &&
                item.blocking === true &&
                terminalRunIsSafe &&
                browserSessions.some((session) => session.recoveryBinding),
              ...(text(item.deliveryErrorCode)
                ? { deliveryErrorCode: text(item.deliveryErrorCode) }
                : {})
            }
          ];
        }
      );
      const attentionAvailable =
        parsedAttention !== undefined &&
        alerts.length === parsedAttention.items.length;
      const recoverySessions = records(recoveryValue).flatMap((value) => {
        try {
          return [recoverySessionView(value)];
        } catch {
          return [];
        }
      });
      return {
        attention:
          !boolean(persistence.writable) || !browserReady || !attentionAvailable
            ? "action"
            : alerts.some((item) =>
                ["action", "approval", "blocking"].includes(item.kind)
              )
              ? "action"
            : alerts.length > 0 ||
                pendingTaskCount > 0 ||
                attentionTruncated
              ? "attention"
              : "normal",
        headline:
          !boolean(persistence.writable)
            ? "业务数据暂时不可写"
            : !browserReady
              ? "请连接并准备 Chrome"
              : !attentionAvailable
                ? "运行问题状态暂时不可读"
                : alerts.length > 0
                  ? `发现 ${alerts.length} 项运行问题`
                  : attentionTruncated
                    ? `运行问题超过显示上限，共 ${attentionTotal} 项`
                    : pendingTaskCount > 0
                      ? `有 ${pendingTaskCount} 项等待处理`
                      : "系统运行正常",
        runtimeVersion: "0.6.1",
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
          },
          {
            id: "attention",
            label: "运行问题",
            status: attentionAvailable ? "healthy" : "unavailable",
            summary: attentionAvailable
              ? attentionTruncated
                ? `当前显示 ${alerts.length} 项，共 ${attentionTotal} 项`
                : `已读取 ${attentionTotal} 项待处理状态`
              : "运行问题状态暂时不可读，请稍后复核"
          }
        ],
        browserSessions,
        alerts,
        recoverySessions,
        activeRunCount: 0,
        pendingTaskCount,
        ...(attentionAvailable
          ? {
              attentionTotal,
              attentionTruncated
            }
          : {})
      };
    } catch {
      return {
        attention: "action",
        headline: "BPA 本地服务尚未连接",
        runtimeVersion: "0.6.1",
        components: [
          {
            id: "core",
            label: "BPA 本地服务",
            status: "unavailable",
            summary: "请启动本地服务后重新打开工作台"
          }
        ],
        browserSessions: [],
        alerts: [],
        recoverySessions: [],
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
              : status === "rejected" ||
                  status === "failed" ||
                  status === "uncertain"
                ? "任务没有确定完成，请按提示复核。"
                : currentNode
                  ? `正在执行：${currentNode}`
                  : "任务正在准备执行。",
        startedAt,
        ...(typeof run.updatedAt === "string" &&
        ["succeeded", "rejected", "failed", "uncertain", "cancelled"].includes(
          status
        )
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
        const referenceCuration = referenceCurationView(task);
        this.#tasks.set(taskId, {
          raw: task,
          outputSchema,
          ...(referenceCuration ? { referenceCuration } : {})
        });
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
                : referenceCuration
                  ? "确认参考图片角色与使用边界"
                : `请确认：${text(profile?.id, "业务判断")}`,
            guidance:
              mode === "human_action"
                ? "按页面提示完成登录或验证后，再回来确认完成。"
                : referenceCuration
                  ? "逐张预览候选图片；至少选择一张，填写参考角色、采用理由和禁止推断。未选择的图片会明确记为不采用。"
                : "请核对业务信息；不确定时选择暂不确认。",
            attention: mode === "human_action" ? "action" : "attention",
            dueAt: safeTimestamp(task.deadline, this.#now().toISOString()),
            ...(referenceCuration
              ? { referenceCuration }
              : { choices: approved
              ? [
                  { value: "confirmed", label: "确认" },
                  { value: "rejected", label: "暂不确认" }
                ]
              : [{ value: "completed", label: "确认完成" }] })
          }
        ];
      });
    } catch {
      return [];
    }
  }

  async acknowledgeAttention(
    id: string,
    expectedRevision: number
  ): Promise<void> {
    try {
      await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.attentionAcknowledge,
        {
          id,
          expectedRevision,
          actor: this.#actorId
        },
        { requestId: this.#operationId() }
      );
    } catch {
      throw failureMessage("确认运行问题");
    }
  }

  async startRecoverySession(
    input: StartRecoverySessionInput
  ): Promise<RecoverySessionView> {
    const binding = input.pageBinding;
    if (
      !input.attentionId ||
      !Number.isSafeInteger(input.expectedAttentionRevision) ||
      input.expectedAttentionRevision < 0 ||
      !binding.sessionId ||
      !binding.browserInstanceId ||
      binding.profileId !== binding.browserInstanceId ||
      !Number.isSafeInteger(binding.tabId) ||
      binding.tabId < 0 ||
      !binding.origin ||
      !binding.pageEpoch
    ) {
      throw new ConsoleUserFacingError("恢复登录的页面绑定无效，请刷新后重试。");
    }
    try {
      const issuedValue = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.recoverySessionIssue,
        {
          attentionId: input.attentionId,
          expectedAttentionRevision: input.expectedAttentionRevision,
          browserSessionId: binding.sessionId,
          browserInstanceId: binding.browserInstanceId,
          profileId: binding.profileId,
          tabId: binding.tabId,
          origin: binding.origin,
          pageEpoch: binding.pageEpoch,
          ttlSeconds: 300,
          actor: this.#actorId
        },
        { requestId: this.#operationId() }
      );
      const issued = record(issuedValue);
      const session = record(issued?.session);
      const token = text(issued?.token);
      if (!session || !token || session.state !== "issued") {
        throw new Error("Recovery Session issue result is invalid");
      }
      const id = text(session.id);
      const revision = integer(session.revision, -1);
      try {
        return recoverySessionView(
          await this.#client.request<unknown>(
            CONSOLE_CONTROL_METHODS.recoverySessionActivate,
            {
              id,
              expectedRevision: revision,
              token,
              actor: this.#actorId
            },
            { requestId: this.#operationId() }
          )
        );
      } catch (error) {
        await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.recoverySessionRevoke,
          {
            id,
            expectedRevision: revision,
            actor: this.#actorId
          },
          { requestId: this.#operationId() }
        ).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof ConsoleUserFacingError) throw error;
      throw failureMessage("开启登录恢复");
    }
  }

  async completeRecoverySession(
    id: string,
    expectedRevision: number
  ): Promise<RecoverySessionView> {
    try {
      return recoverySessionView(
        await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.recoverySessionComplete,
          { id, expectedRevision, actor: this.#actorId },
          { requestId: this.#operationId() }
        )
      );
    } catch {
      throw failureMessage("验证登录恢复结果");
    }
  }

  async revokeRecoverySession(
    id: string,
    expectedRevision: number
  ): Promise<RecoverySessionView> {
    try {
      return recoverySessionView(
        await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.recoverySessionRevoke,
          { id, expectedRevision, actor: this.#actorId },
          { requestId: this.#operationId() }
        )
      );
    } catch {
      throw failureMessage("结束登录恢复");
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
      const transferToken = text(lease.transferToken);
      if (this.#stagingUploader && !transferToken) {
        throw new Error("missing staging transfer authorization");
      }
      if (transferToken) {
        this.#stagingAuthorizations.set(id, {
          token: transferToken,
          ...(input.sha256 ? { expectedSha256: input.sha256 } : {})
        });
      }
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
    leaseId: string,
    body: Uint8Array,
    expectedSha256?: string
  ): Promise<UploadReceipt> {
    const authorization = this.#stagingAuthorizations.get(leaseId);
    if (!this.#stagingUploader || !authorization) {
      throw new ConsoleUserFacingError(
        "安全文件上传通道尚未启用；文件内容不会通过控制协议发送。"
      );
    }
    if (
      authorization.expectedSha256 &&
      expectedSha256 &&
      authorization.expectedSha256.toLowerCase() !==
        expectedSha256.toLowerCase()
    ) {
      throw new ConsoleUserFacingError("上传文件摘要与凭证不一致。");
    }
    try {
      const authorizedDigest =
        expectedSha256 ?? authorization.expectedSha256;
      const receipt = await this.#stagingUploader.upload({
        leaseId,
        token: authorization.token,
        body,
        ...(authorizedDigest === undefined
          ? {}
          : { expectedSha256: authorizedDigest })
      });
      this.#stagingAuthorizations.delete(leaseId);
      return receipt;
    } catch {
      throw failureMessage("安全上传文件");
    }
  }

  async importStagedDataset(
    input: StagedDatasetImportInput
  ): Promise<DatasetImportResult> {
    try {
      const value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.datasetImportStaged,
        {
          leaseId: input.upload.leaseId,
          digest: input.upload.digest,
          id: input.id,
          version: input.version,
          actor: this.#actorId,
          ...(input.title === undefined ? {} : { title: input.title })
        }
      );
      const result = record(value);
      const status = result?.status;
      if (!result || (status !== "published" && status !== "rejected")) {
        throw new Error("invalid dataset import result");
      }
      const dataset = record(result.dataset);
      const metadata = record(dataset?.metadata);
      const source = record(dataset?.source);
      return {
        status,
        stagingId: text(result.stagingId),
        sourceDigest: text(
          result.sourceDigest,
          text(source?.digest, input.upload.digest)
        ),
        ...(status === "published"
          ? {
              id: text(metadata?.id, input.id),
              version: text(metadata?.version, input.version),
              recordCount: integer(dataset?.recordCount)
            }
          : {}),
        warnings: stringList(result.warnings),
        errors: stringList(result.errors)
      };
    } catch {
      throw failureMessage("校验并发布业务主数据");
    }
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
            assetIds: stringList(download.assetIds),
            ...(download.rightsStatus === "not_assessed"
              ? { rightsStatus: "not_assessed" as const }
              : {}),
            ...(download.allowedUse === "internal_reference_only"
              ? { allowedUse: "internal_reference_only" as const }
              : {}),
            ...(Array.isArray(download.blockers)
              ? { blockers: stringList(download.blockers) }
              : {}),
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

  async startDesignMode(
    input: DesignModeGrantInput
  ): Promise<DesignModeGrantView> {
    const now = this.#now();
    const binding = input.pageBinding;
    if (
      binding.version !== "bpa.design-page-binding/1" ||
      !Number.isSafeInteger(binding.tabId) ||
      binding.tabId < 0 ||
      !binding.pageEpoch.startsWith(`tab-${binding.tabId}:`) ||
      !Number.isFinite(Date.parse(binding.issuedAt)) ||
      now.getTime() - Date.parse(binding.issuedAt) > 5 * 60 * 1000 ||
      Date.parse(binding.issuedAt) - now.getTime() > 30_000
    ) {
      throw new ConsoleUserFacingError(
        "页面绑定码已失效，请在目标页面重新生成。"
      );
    }
    let origin: URL;
    try {
      origin = new URL(binding.origin);
    } catch {
      throw new ConsoleUserFacingError("页面绑定码中的 Origin 无效。");
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== binding.origin ||
      ![
        "https://fxg.jinritemai.com",
        "https://www.chanmama.com"
      ].includes(binding.origin)
    ) {
      throw new ConsoleUserFacingError(
        "当前页面不在 Design Mode 只读允许范围内。"
      );
    }
    try {
      const grantId = `design.grant-${this.#operationId()}`;
      const requested = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.authoringDesignModeRequest,
        {
          grantId,
          authoringSessionId: input.authoringSessionId,
          approvedBy: this.#actorId,
          browserSessionId: input.browserSessionId,
          profileId: input.profileId,
          tabId: binding.tabId,
          origin: binding.origin,
          pageEpoch: binding.pageEpoch,
          screenshotApproved: input.screenshotApproved,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString()
        }
      );
      const requestedRecord = record(requested);
      if (!requestedRecord || requestedRecord.state !== "requested") {
        throw new Error("Design Mode request rejected");
      }
      return designGrantView(
        await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.authoringDesignModeActivate,
          {
            grantId,
            expectedRevision: integer(requestedRecord.revision),
            actor: this.#actorId,
            occurredAt: this.#now().toISOString()
          }
        )
      );
    } catch (error) {
      if (error instanceof ConsoleUserFacingError) throw error;
      throw failureMessage("开启 Design Mode");
    }
  }

  async stopDesignMode(
    grantId: string,
    expectedRevision: number
  ): Promise<DesignModeGrantView> {
    try {
      return designGrantView(
        await this.#client.request<unknown>(
          CONSOLE_CONTROL_METHODS.authoringDesignModeStop,
          {
            grantId,
            expectedRevision,
            actor: this.#actorId,
            occurredAt: this.#now().toISOString(),
            reason: "operator_stopped"
          }
        )
      );
    } catch {
      throw failureMessage("停止 Design Mode");
    }
  }

  async getDownload(downloadId: string): Promise<DownloadPayload> {
    const manifest = await this.#downloadManifest(downloadId);
    const contents = manifest.assets.map((asset) => ({
      ...asset,
      body: this.#readAsset(asset)
    }));
    if (manifest.kind === "report" && contents.length === 1) {
      return {
        fileName: manifest.fileName,
        mediaType: contents[0]!.mediaType,
        body: contents[0]!.body
      };
    }
    const files: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(
        `${JSON.stringify(manifest.referencePack ?? {
          manifestVersion: manifest.manifestVersion,
          id: manifest.id,
          runId: manifest.runId,
          kind: manifest.kind,
          assets: manifest.assets.map(({ storageRef: _storageRef, ...asset }) => asset)
        }, null, 2)}\n`
      )
    };
    contents.forEach((asset, index) => {
      const extension = asset.mediaType === "image/jpeg"
        ? "jpg"
        : asset.mediaType === "image/png"
          ? "png"
          : asset.mediaType === "image/webp"
            ? "webp"
            : "bin";
      files[`assets/${String(index + 1).padStart(2, "0")}-${asset.assetId.replace(/[^A-Za-z0-9._-]/gu, "_")}.${extension}`] =
        asset.body;
    });
    return {
      fileName: manifest.fileName.endsWith(".zip")
        ? manifest.fileName
        : `${manifest.fileName}.zip`,
      mediaType: "application/zip",
      body: zipSync(files, { level: 0 })
    };
  }

  async getDownloadAsset(
    downloadId: string,
    assetId: string
  ): Promise<DownloadPayload> {
    const manifest = await this.#downloadManifest(downloadId);
    if (
      manifest.kind !== "reference_pack" &&
      manifest.kind !== "reference_candidates"
    ) {
      throw new ConsoleUserFacingError("该业务输出不支持图片预览。");
    }
    const asset = manifest.assets.find((candidate) =>
      candidate.assetId === assetId
    );
    if (!asset || !["image/jpeg", "image/png", "image/webp"].includes(asset.mediaType)) {
      throw new ConsoleUserFacingError("参考图片不存在或不可预览。");
    }
    return {
      fileName: `${asset.assetId}`,
      mediaType: asset.mediaType,
      body: this.#readAsset(asset)
    };
  }

  async #downloadManifest(downloadId: string): Promise<{
    manifestVersion: "bpa.download-manifest/1";
    id: string;
    runId: string;
    kind: "report" | "reference_pack" | "reference_candidates";
    fileName: string;
    assets: Array<{
      assetId: string;
      digest: string;
      sizeBytes: number;
      mediaType: string;
      storageRef: string;
    }>;
    referencePack?: Record<string, unknown>;
  }> {
    if (!this.#assetReader) {
      throw new ConsoleUserFacingError("本机 CAS 下载读取器尚未配置。");
    }
    let value: unknown;
    try {
      value = await this.#client.request<unknown>(
        CONSOLE_CONTROL_METHODS.downloadGet,
        { downloadId }
      );
    } catch {
      throw failureMessage("准备下载");
    }
    const candidate = record(value);
    const kind = candidate?.kind;
    const baseKeys = [
      "manifestVersion", "id", "runId", "kind", "title", "fileName",
      "sizeBytes", "createdAt", "assetIds", "assets"
    ];
    const expectedKeys = kind === "reference_pack"
      ? [
          ...baseKeys,
          "rightsStatus", "allowedUse", "blockers", "referencePack"
        ]
      : kind === "reference_candidates"
        ? [...baseKeys, "rightsStatus", "allowedUse", "blockers"]
      : baseKeys;
    if (
      !candidate ||
      !hasExactKeys(candidate, expectedKeys) ||
      candidate.manifestVersion !== "bpa.download-manifest/1" ||
      candidate.id !== downloadId ||
      (kind !== "report" &&
        kind !== "reference_pack" &&
        kind !== "reference_candidates") ||
      !boundedText(candidate.runId, 200) ||
      !boundedText(candidate.title, 300) ||
      !boundedText(candidate.fileName, 240) ||
      /[\\/\u0000-\u001f]/u.test(String(candidate.fileName)) ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      !Array.isArray(candidate.assets)
    ) {
      throw failureMessage("校验下载清单");
    }
    const parsedAssets = records(candidate.assets);
    const assets = parsedAssets.map((asset) => {
      if (
        !hasExactKeys(asset, [
          "assetId", "digest", "sizeBytes", "mediaType", "storageRef"
        ])
      ) {
        throw failureMessage("校验下载清单");
      }
      return {
        assetId: boundedText(asset.assetId, 300) ?? "",
        digest: boundedText(asset.digest, 71) ?? "",
        sizeBytes: integer(asset.sizeBytes, -1),
        mediaType: boundedText(asset.mediaType, 100) ?? "",
        storageRef: boundedText(asset.storageRef, 100) ?? ""
      };
    });
    const assetIds = boundedStringArray(candidate.assetIds, {
      minimum: 1,
      maximum: 20,
      itemMaximum: 300
    });
    const totalSize = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    if (
      assets.length !== candidate.assets.length ||
      assets.length < 1 ||
      assets.length > 20 ||
      !assetIds ||
      new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
      assets.some((asset) =>
        !asset.assetId ||
        !/^sha256:[a-f0-9]{64}$/u.test(asset.digest) ||
        asset.sizeBytes < 1 ||
        asset.sizeBytes >
          (kind === "report" ? 25 * 1024 * 1024 : 5 * 1024 * 1024) ||
        asset.storageRef !== `asset-store:${asset.digest}`
      ) ||
      totalSize < 1 ||
      totalSize > 100 * 1024 * 1024 ||
      candidate.sizeBytes !== totalSize ||
      JSON.stringify(assets.map((asset) => asset.assetId)) !==
        JSON.stringify(assetIds)
    ) {
      throw failureMessage("校验下载清单");
    }
    if (
      kind === "reference_candidates" &&
      (candidate.rightsStatus !== "not_assessed" ||
        candidate.allowedUse !== "internal_reference_only" ||
        JSON.stringify(candidate.blockers) !==
          JSON.stringify(["SOURCE_RIGHTS_NOT_ASSESSED"]))
    ) {
      throw failureMessage("校验参考资产包边界");
    }
    let referencePack: Record<string, unknown> | undefined;
    if (kind === "reference_pack") {
      const rawPack = record(candidate.referencePack);
      if (
        candidate.rightsStatus !== "not_assessed" ||
        candidate.allowedUse !== "internal_reference_only" ||
        JSON.stringify(candidate.blockers) !==
          JSON.stringify(["SOURCE_RIGHTS_NOT_ASSESSED"]) ||
        !rawPack ||
        !hasExactKeys(rawPack, [
          "schemaVersion", "exportId", "packId", "sourceRunId", "status",
          "rightsStatus", "allowedUse", "assetCount", "assets", "blockers"
        ]) ||
        rawPack.schemaVersion !== "reference-asset-pack/v1" ||
        rawPack.exportId !== downloadId ||
        rawPack.sourceRunId !== candidate.runId ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(String(rawPack.packId)) ||
        rawPack.status !== "ready_internal_reference" ||
        rawPack.rightsStatus !== "not_assessed" ||
        rawPack.allowedUse !== "internal_reference_only" ||
        rawPack.assetCount !== assets.length ||
        JSON.stringify(rawPack.blockers) !==
          JSON.stringify(["SOURCE_RIGHTS_NOT_ASSESSED"]) ||
        !Array.isArray(rawPack.assets) ||
        rawPack.assets.length !== assets.length
      ) {
        throw failureMessage("校验参考资产包边界");
      }
      const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
      const roleDimensions: Record<string, string> = {
        COMPOSITION_TEMPLATE: "composition",
        PACKAGING_FACT: "packaging_observation",
        PRODUCT_FACT: "product_observation",
        TEXTURE_MATERIAL: "texture_reference"
      };
      const safeAssets = rawPack.assets.map((value) => {
        const item = record(value);
        if (
          !item ||
          !hasExactKeys(item, [
            "assetId", "digest", "sizeBytes", "mediaType", "platform",
            "discoveryId", "sourceUrl", "sourcePageUrl", "sourceEvidenceId",
            "role", "reason", "allowedTransferDimensions",
            "prohibitedInferences", "rightsStatus", "allowedUse"
          ])
        ) {
          throw failureMessage("校验参考资产包边界");
        }
        const asset = byId.get(String(item.assetId));
        const role = boundedText(item.role, 40);
        const dimensions = boundedStringArray(item.allowedTransferDimensions, {
          minimum: 1,
          maximum: 4,
          itemMaximum: 50,
          allowed: [
            "composition", "packaging_observation", "product_observation",
            "texture_reference"
          ]
        });
        const prohibited = boundedStringArray(item.prohibitedInferences, {
          minimum: 1,
          maximum: 10,
          itemMaximum: 300
        });
        let sourceUrl: URL;
        let sourcePageUrl: URL;
        try {
          sourceUrl = new URL(String(item.sourceUrl));
          sourcePageUrl = new URL(String(item.sourcePageUrl));
        } catch {
          throw failureMessage("校验参考资产包边界");
        }
        const platform = String(item.platform) as "DOUYIN" | "TAOBAO" | "JD";
        const cdnSuffixes = {
          DOUYIN: ["ecombdimg.com", "byteimg.com"],
          TAOBAO: ["alicdn.com"],
          JD: ["360buyimg.com"]
        }[platform] ?? [];
        const pageHosts: Record<string, string> = {
          DOUYIN: "www.douyin.com",
          TAOBAO: "s.taobao.com",
          JD: "search.jd.com"
        };
        const pageQueryKeys: Record<string, readonly string[]> = {
          DOUYIN: ["type"],
          TAOBAO: ["q"],
          JD: ["keyword"]
        };
        const sourceHost = sourceUrl.hostname.toLowerCase();
        const sourceApproved = cdnSuffixes.some(
          (suffix) =>
            sourceHost === suffix || sourceHost.endsWith(`.${suffix}`)
        );
        const pageApproved =
          sourcePageUrl.hostname.toLowerCase() === pageHosts[platform] &&
          [...sourcePageUrl.searchParams.keys()].every((key) =>
            (pageQueryKeys[platform] ?? []).includes(key)
          );
        if (
          !asset ||
          item.digest !== asset.digest ||
          item.sizeBytes !== asset.sizeBytes ||
          item.mediaType !== asset.mediaType ||
          !["image/jpeg", "image/png", "image/webp"].includes(asset.mediaType) ||
          !["DOUYIN", "TAOBAO", "JD"].includes(platform) ||
          !boundedText(item.discoveryId, 300) ||
          sourceUrl.protocol !== "https:" ||
          sourcePageUrl.protocol !== "https:" ||
          Boolean(sourceUrl.username || sourceUrl.password) ||
          Boolean(sourcePageUrl.username || sourcePageUrl.password) ||
          Boolean(sourceUrl.port && sourceUrl.port !== "443") ||
          Boolean(sourcePageUrl.port && sourcePageUrl.port !== "443") ||
          !sourceApproved ||
          !pageApproved ||
          !boundedText(item.sourceEvidenceId, 200) ||
          !role ||
          !roleDimensions[role] ||
          !boundedText(item.reason, 500) ||
          !dimensions ||
          !dimensions.includes(roleDimensions[role]!) ||
          !prohibited ||
          item.rightsStatus !== "not_assessed" ||
          item.allowedUse !== "internal_reference_only"
        ) {
          throw failureMessage("校验参考资产包边界");
        }
        return {
          assetId: asset.assetId,
          digest: asset.digest,
          sizeBytes: asset.sizeBytes,
          mediaType: asset.mediaType,
          platform: item.platform,
          discoveryId: item.discoveryId,
          sourceUrl: sourceUrl.toString(),
          sourcePageUrl: sourcePageUrl.toString(),
          sourceEvidenceId: item.sourceEvidenceId,
          role,
          reason: item.reason,
          allowedTransferDimensions: dimensions,
          prohibitedInferences: prohibited,
          rightsStatus: "not_assessed",
          allowedUse: "internal_reference_only"
        };
      });
      if (
        JSON.stringify(safeAssets.map((asset) => asset.assetId)) !==
        JSON.stringify(assetIds)
      ) {
        throw failureMessage("校验参考资产包边界");
      }
      referencePack = {
        schemaVersion: "reference-asset-pack/v1",
        exportId: downloadId,
        packId: rawPack.packId,
        sourceRunId: candidate.runId,
        status: "ready_internal_reference",
        rightsStatus: "not_assessed",
        allowedUse: "internal_reference_only",
        assetCount: safeAssets.length,
        assets: safeAssets,
        blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
      };
    }
    return {
      manifestVersion: "bpa.download-manifest/1",
      id: downloadId,
      runId: candidate.runId as string,
      kind,
      fileName: candidate.fileName as string,
      assets,
      ...(referencePack ? { referencePack } : {})
    };
  }

  #readAsset(asset: {
    digest: string;
    sizeBytes: number;
    storageRef: string;
  }): Uint8Array {
    let body: Uint8Array;
    try {
      body = this.#assetReader!.read(asset.storageRef);
    } catch {
      throw new ConsoleUserFacingError("CAS 业务资产不可读取。");
    }
    const actual = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if (body.byteLength !== asset.sizeBytes || actual !== asset.digest) {
      throw new ConsoleUserFacingError("CAS 业务资产摘要校验失败。");
    }
    return body;
  }
}
