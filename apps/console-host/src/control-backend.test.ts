import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  CONSOLE_CONTROL_METHODS,
  UdsControlBackend,
  type ConsoleControlRequester
} from "./control-backend.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

class FakeRequester implements ConsoleControlRequester {
  readonly calls: Call[] = [];
  readonly responses = new Map<string, unknown[]>();
  error?: Error;

  respond(method: string, ...values: unknown[]): this {
    this.responses.set(method, values);
    return this;
  }

  async request<TResult>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<TResult> {
    this.calls.push({ method, params });
    if (this.error) throw this.error;
    const queue = this.responses.get(method) ?? [];
    if (queue.length === 0) {
      throw new Error(`No fake response for ${method}`);
    }
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value as TResult;
  }
}

function operationIds(): () => string {
  let sequence = 0;
  return () => `operation-${++sequence}`;
}

function backend(
  client: FakeRequester,
  stagingUploader?: {
    upload(input: {
      leaseId: string;
      token: string;
      body: Uint8Array;
      expectedSha256?: string;
    }): Promise<{
      leaseId: string;
      digest: string;
      sizeBytes: number;
    }>;
  },
  assetReader?: { read(storageRef: string): Uint8Array }
) {
  return new UdsControlBackend(client, {
    actorId: "operator:test",
    operationId: operationIds(),
    now: () => new Date("2026-07-30T04:00:00.000Z"),
    leaseDurationMs: 60_000,
    ...(stagingUploader ? { stagingUploader } : {}),
    ...(assetReader ? { assetReader } : {})
  });
}

describe("UdsControlBackend", () => {
  it("maps doctor and pending assistance into a business dashboard", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.doctor, {
        status: "ok",
        protocol: "bpa.browser/2",
        persistence: {
          adapter: "sqlite",
          schemaVersion: 8,
          writable: true
        },
        browser: {
          connected: true,
          ready: true,
          sessionId: "session-1",
          extensionId: "extension-id"
        }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskList, [
        { taskId: "task-1" }
      ])
      .respond(CONSOLE_CONTROL_METHODS.attentionList, {
        items: [{
          id: "run-terminal:run-login",
          sourceRef: { kind: "workflow-run", runId: "run-login" },
          source: "browser",
          groupKey: "authentication",
          kind: "blocking",
          blocking: true,
          deliveryPolicy: "operator-notification",
          title: "浏览器登录或验证需要处理",
          reason: "浏览器返回了登录阻断。",
          requestedAction: "在受管 Chrome Profile 中完成人工登录。",
          createdAt: "2026-07-30T03:58:00.000Z",
          revision: 0,
          deliveryState: "pending",
          deliveryAttempt: 0
        }],
        total: 1,
        truncated: false
      })
      .respond(CONSOLE_CONTROL_METHODS.browserPageObservationList, [
        {
          sessionId: "session-1",
          browserInstanceId: "chrome-profile-1",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          pathname: "/ffa/g/list",
          contentScriptReady: true,
          authentication: "authenticated",
          observationState: "ready",
          pageEpoch: "tab-7:1",
          revision: 3,
          observedAt: "2026-07-30T03:59:30.000Z"
        }
      ])
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionList, []);
    const result = await backend(client).getDashboard();
    expect(result).toMatchObject({
      attention: "action",
      headline: "发现 1 项运行问题",
      pendingTaskCount: 1,
      alerts: [
        {
          id: "run-terminal:run-login",
          kind: "blocking",
          deliveryState: "pending",
          recoverable: false
        }
      ],
      components: [
        { id: "core", status: "healthy" },
        { id: "persistence", status: "healthy" },
        { id: "browser", status: "healthy" },
        { id: "attention", status: "healthy" }
      ],
      browserSessions: [
        { id: "chrome-profile-1:7:3", status: "ready" }
      ]
    });
    expect(client.calls).toEqual([
      { method: "doctor", params: {} },
      {
        method: "assistance.task.list",
        params: {
          statuses: [
            "queued",
            "claimed",
            "processing",
            "awaiting_human"
          ],
          modes: ["human_confirm", "human_action"],
          limit: 100
        }
      },
      {
        method: "browser.page-observation.list",
        params: { limit: 200 }
      },
      {
        method: "attention.list",
        params: { states: ["open"], limit: 100 }
      },
      {
        method: "recovery-session.list",
        params: { limit: 100 }
      }
    ]);
  });

  it("activates a recovery session without returning its one-time token", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionIssue, {
        session: {
          id: "recovery-1",
          attentionId: "attention-1",
          revision: 0,
          state: "issued",
          browserInstanceId: "chrome-profile-1",
          profileId: "chrome-profile-1",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          issuedAt: "2026-07-30T04:00:00.000Z",
          expiresAt: "2026-07-30T04:05:00.000Z",
          updatedAt: "2026-07-30T04:00:00.000Z"
        },
        token: "one-time-recovery-token"
      })
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionActivate, {
        id: "recovery-1",
        attentionId: "attention-1",
        revision: 1,
        state: "active",
        browserInstanceId: "chrome-profile-1",
        profileId: "chrome-profile-1",
        tabId: 7,
        origin: "https://fxg.jinritemai.com",
        issuedAt: "2026-07-30T04:00:00.000Z",
        expiresAt: "2026-07-30T04:05:00.000Z",
        updatedAt: "2026-07-30T04:00:01.000Z"
      });

    const result = await backend(client).startRecoverySession({
      attentionId: "attention-1",
      expectedAttentionRevision: 0,
      pageBinding: {
        sessionId: "browser-session-1",
        browserInstanceId: "chrome-profile-1",
        profileId: "chrome-profile-1",
        tabId: 7,
        observationRevision: 3,
        origin: "https://fxg.jinritemai.com",
        pageEpoch: "tab-7:1"
      }
    });

    expect(result).toMatchObject({
      id: "recovery-1",
      state: "active",
      revision: 1
    });
    expect(JSON.stringify(result)).not.toContain("one-time-recovery-token");
    expect(client.calls).toEqual([
      {
        method: "recovery-session.issue",
        params: {
          attentionId: "attention-1",
          expectedAttentionRevision: 0,
          browserSessionId: "browser-session-1",
          browserInstanceId: "chrome-profile-1",
          profileId: "chrome-profile-1",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          pageEpoch: "tab-7:1",
          ttlSeconds: 300,
          actor: "operator:test"
        }
      },
      {
        method: "recovery-session.activate",
        params: {
          id: "recovery-1",
          expectedRevision: 0,
          token: "one-time-recovery-token",
          actor: "operator:test"
        }
      }
    ]);
  });

  it("maps only an exact authentication-blocked page as recoverable", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.doctor, {
        status: "ok",
        persistence: { adapter: "sqlite", schemaVersion: 18, writable: true },
        browser: { connected: true, ready: true }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskList, [])
      .respond(CONSOLE_CONTROL_METHODS.attentionList, {
        items: [{
          id: "attention-1",
          sourceRef: { kind: "workflow-run", runId: "run-1" },
          source: "browser",
          groupKey: "authentication",
          kind: "blocking",
          blocking: true,
          runStatus: "rejected",
          deliveryPolicy: "operator-notification",
          title: "需要登录",
          reason: "登录态失效",
          requestedAction: "恢复登录",
          createdAt: "2026-07-30T03:59:00.000Z",
          revision: 0,
          deliveryState: "delivered",
          deliveryAttempt: 1
        }],
        total: 1,
        truncated: false
      })
      .respond(CONSOLE_CONTROL_METHODS.browserPageObservationList, [
        {
          sessionId: "browser-session-1",
          browserInstanceId: "chrome-profile-1",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          contentScriptReady: true,
          authentication: "anonymous",
          observationState: "auth_required",
          pageEpoch: "tab-7:login",
          revision: 4,
          observedAt: "2026-07-30T03:59:50.000Z"
        }
      ])
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionList, [
        {
          id: "recovery-1",
          attentionId: "attention-1",
          revision: 1,
          state: "active",
          browserInstanceId: "chrome-profile-1",
          profileId: "chrome-profile-1",
          tabId: 7,
          origin: "https://fxg.jinritemai.com",
          issuedAt: "2026-07-30T03:59:55.000Z",
          expiresAt: "2026-07-30T04:04:55.000Z",
          updatedAt: "2026-07-30T03:59:56.000Z"
        }
      ]);

    const result = await backend(client).getDashboard();

    expect(result.alerts).toEqual([
      expect.objectContaining({ id: "attention-1", recoverable: true })
    ]);
    expect(result.browserSessions).toEqual([
      expect.objectContaining({
        status: "attention",
        recoveryBinding: {
          sessionId: "browser-session-1",
          browserInstanceId: "chrome-profile-1",
          profileId: "chrome-profile-1",
          tabId: 7,
          observationRevision: 4,
          origin: "https://fxg.jinritemai.com",
          pageEpoch: "tab-7:login"
        }
      })
    ]);
    expect(result.recoverySessions).toEqual([
      expect.objectContaining({ id: "recovery-1", state: "active" })
    ]);
  });

  it("raises informational dashboard-only Attention and exposes truncation", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.doctor, {
        status: "ok",
        persistence: { adapter: "sqlite", schemaVersion: 21, writable: true },
        browser: { connected: true, ready: true }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskList, [])
      .respond(CONSOLE_CONTROL_METHODS.browserPageObservationList, [])
      .respond(CONSOLE_CONTROL_METHODS.attentionList, {
        items: [{
          id: "trigger-occurrence-terminal:occurrence-1",
          sourceRef: {
            kind: "trigger-occurrence",
            occurrenceId: "occurrence-1"
          },
          source: "runtime",
          groupKey: "trigger-missed",
          kind: "information",
          blocking: false,
          deliveryPolicy: "dashboard-only",
          title: "计划执行已错过",
          reason: "计划时间已过。",
          requestedAction: "在工作台复核。",
          createdAt: "2026-07-30T03:59:00.000Z",
          revision: 0,
          deliveryState: "not-requested",
          deliveryAttempt: 0
        }],
        total: 7,
        truncated: true
      })
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionList, []);

    const result = await backend(client).getDashboard();

    expect(result).toMatchObject({
      attention: "attention",
      headline: "发现 1 项运行问题",
      attentionTotal: 7,
      attentionTruncated: true,
      alerts: [{
        id: "trigger-occurrence-terminal:occurrence-1",
        deliveryState: "not-requested",
        recoverable: false
      }]
    });
    expect(result.components).toContainEqual(expect.objectContaining({
      id: "attention",
      status: "healthy",
      summary: "当前显示 1 项，共 7 项"
    }));
  });

  it("fails closed when open Attention cannot be read", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.doctor, {
        status: "ok",
        persistence: { adapter: "sqlite", schemaVersion: 21, writable: true },
        browser: { connected: true, ready: true }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskList, [])
      .respond(CONSOLE_CONTROL_METHODS.browserPageObservationList, [])
      .respond(
        CONSOLE_CONTROL_METHODS.attentionList,
        new Error("internal socket=/private/core.sock")
      )
      .respond(CONSOLE_CONTROL_METHODS.recoverySessionList, []);

    const result = await backend(client).getDashboard();

    expect(result).toMatchObject({
      attention: "action",
      headline: "运行问题状态暂时不可读",
      alerts: []
    });
    expect(result.components).toContainEqual(expect.objectContaining({
      id: "attention",
      status: "unavailable"
    }));
    expect(JSON.stringify(result)).not.toContain("/private/core.sock");
  });

  it("turns transport failures into an unavailable view without leaking details", async () => {
    const client = new FakeRequester();
    client.error = new Error(
      "connect ENOENT /Users/private/Library/Application Support/BPA/run/core.sock"
    );
    const result = await backend(client).getDashboard();
    expect(JSON.stringify(result)).toContain("本地服务尚未连接");
    expect(JSON.stringify(result)).not.toContain("/Users/private");
    expect(await backend(client).listWorkflows()).toEqual([]);
    expect(await backend(client).listTasks()).toEqual([]);
    expect(await backend(client).listDownloads()).toEqual([]);
  });

  it("maps only R0/R1 published workflows and freezes resource bindings", async () => {
    const client = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.catalogList,
      [
        {
          assetId: "research.readonly",
          version: "1.2.0",
          content: {
            metadata: {
              id: "research.readonly",
              version: "1.2.0",
              title: "商品研究",
              description: "只读采集"
            },
            spec: {
              riskLevel: "R1",
              inputSchema: {
                type: "object",
                required: ["keyword"],
                properties: {
                  keyword: {
                    type: "string",
                    title: "商品关键词",
                    description: "填写商品名"
                  },
                  dataset: { type: "object", title: "主数据" },
                  ignored: { type: "array" }
                }
              },
              resourceSlots: {
                metrics: {
                  kind: "browser",
                  purpose: "蝉妈妈指标来源",
                  allowedOrigins: ["https://www.chanmama.com"]
                }
              }
            }
          }
        },
        {
          assetId: "write.workflow",
          version: "1.0.0",
          content: {
            metadata: { id: "write.workflow", version: "1.0.0" },
            spec: { riskLevel: "R2", inputSchema: {} }
          }
        }
      ]
    );
    const workflows = await backend(client).listWorkflows();
    expect(workflows).toEqual([
      {
        id: "research.readonly",
        version: "1.2.0",
        title: "商品研究",
        description: "只读采集",
        riskLevel: "R1",
        inputFields: [
          {
            key: "keyword",
            label: "商品关键词",
            kind: "text",
            required: true,
            help: "填写商品名"
          },
          {
            key: "dataset",
            label: "主数据",
            kind: "dataset",
            required: false
          }
        ],
        resourceSlots: [
          {
            key: "metrics",
            label: "蝉妈妈指标来源",
            requiredOrigin: "https://www.chanmama.com"
          }
        ]
      }
    ]);
    expect(client.calls).toEqual([
      { method: "catalog.list", params: { assetType: "workflow" } }
    ]);
  });

  it("maps run creation, inspection, and events without exposing payloads", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.runCreate, { id: "run-1" })
      .respond(CONSOLE_CONTROL_METHODS.runInspect, {
        id: "run-1",
        workflowId: "research",
        workflowVersion: "1.0.0",
        status: "running",
        currentNodeKey: "collect",
        createdAt: "2026-07-30T03:00:00.000Z",
        updatedAt: "2026-07-30T03:01:00.000Z"
      })
      .respond(CONSOLE_CONTROL_METHODS.runEvents, [
        {
          id: "event-1",
          sequence: 1,
          type: "NODE_DISPATCHED",
          occurredAt: "2026-07-30T03:00:05.000Z",
          payload: { privateDom: "<secret>" }
        }
      ]);
    const adapter = backend(client);
    await expect(
      adapter.createRun({
        workflowId: "research",
        workflowVersion: "1.0.0",
        inputs: { keyword: "煎饼" },
        resourceBindings: {
          metrics: {
            sessionId: "session-1",
            browserInstanceId: "chrome-profile-1",
            tabId: 7,
            observationRevision: 3
          }
        }
      })
    ).resolves.toEqual({ runId: "run-1" });
    const run = await adapter.getRun("run-1");
    expect(run).toMatchObject({
      id: "run-1",
      status: "running",
      timeline: [
        {
          title: "正在执行检查步骤",
          technicalDetails: "event=NODE_DISPATCHED · sequence=1"
        }
      ]
    });
    expect(JSON.stringify(run)).not.toContain("<secret>");
    expect(client.calls).toEqual([
      {
        method: "run.create",
        params: {
          workflowId: "research",
          workflowVersion: "1.0.0",
          input: { keyword: "煎饼" },
          resourceBindings: {
            metrics: {
              sessionId: "session-1",
              browserInstanceId: "chrome-profile-1",
              tabId: 7,
              observationRevision: 3
            }
          }
        }
      },
      { method: "run.inspect", params: { runId: "run-1" } },
      { method: "run.events", params: { runId: "run-1" } }
    ]);
  });

  it("maps compatibility and IR2 rejected events to a safe blocked terminal", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.runInspect, {
        id: "run-rejected",
        workflowId: "research",
        workflowVersion: "1.0.0",
        status: "rejected",
        createdAt: "2026-07-30T03:00:00.000Z",
        updatedAt: "2026-07-30T03:01:00.000Z"
      })
      .respond(CONSOLE_CONTROL_METHODS.runEvents, [
        {
          id: "event-compatibility",
          sequence: 1,
          type: "RUN_REJECTED",
          occurredAt: "2026-07-30T03:00:30.000Z",
          payload: { error: { code: "SESSION_EXPIRED" } }
        },
        {
          id: "event-ir2",
          sequence: 2,
          type: "RUNTIME_RESULT_APPLIED",
          occurredAt: "2026-07-30T03:01:00.000Z",
          payload: {
            status: "rejected",
            outcomeStatus: "rejected",
            errorCode: "CAPTCHA_REQUIRED"
          }
        }
      ]);

    const run = await backend(client).getRun("run-rejected");

    expect(run).toMatchObject({
      status: "rejected",
      completedAt: "2026-07-30T03:01:00.000Z",
      timeline: [
        {
          title: "任务已被安全阻断",
          state: "failed",
          summary:
            "任务已作为不可恢复终态安全阻断；处理拒绝原因后请重新发起。"
        },
        {
          title: "任务已被安全阻断",
          state: "failed",
          summary:
            "任务已作为不可恢复终态安全阻断；处理拒绝原因后请重新发起。"
        }
      ]
    });
    expect(JSON.stringify(run)).not.toContain("SESSION_EXPIRED");
    expect(JSON.stringify(run)).not.toContain("CAPTCHA_REQUIRED");
  });

  it("creates a 15-minute exact Design Mode grant and can stop it", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.authoringDesignModeRequest, {
        grantId: "design.grant-operation-1",
        revision: 0,
        state: "requested"
      })
      .respond(CONSOLE_CONTROL_METHODS.authoringDesignModeActivate, {
        grantId: "design.grant-operation-1",
        authoringSessionId: "authoring.session-1",
        browserSessionId: "browser-session-1",
        profileId: "chanmama.product-metrics",
        revision: 1,
        state: "active",
        origin: "https://www.chanmama.com",
        tabId: 7,
        pageEpoch: "tab-7:1999999999999:design-1",
        allowedOperations: ["semantic_snapshot"],
        expiresAt: "2026-07-30T04:15:00.000Z"
      })
      .respond(CONSOLE_CONTROL_METHODS.authoringDesignModeStop, {
        grantId: "design.grant-operation-1",
        authoringSessionId: "authoring.session-1",
        browserSessionId: "browser-session-1",
        profileId: "chanmama.product-metrics",
        revision: 2,
        state: "stopped",
        origin: "https://www.chanmama.com",
        tabId: 7,
        pageEpoch: "tab-7:1999999999999:design-1",
        allowedOperations: ["semantic_snapshot"],
        expiresAt: "2026-07-30T04:15:00.000Z"
      });
    const adapter = backend(client);
    const active = await adapter.startDesignMode({
      authoringSessionId: "authoring.session-1",
      browserSessionId: "browser-session-1",
      profileId: "chanmama.product-metrics",
      screenshotApproved: false,
      pageBinding: {
        version: "bpa.design-page-binding/1",
        tabId: 7,
        origin: "https://www.chanmama.com",
        pageEpoch: "tab-7:1999999999999:design-1",
        issuedAt: "2026-07-30T03:59:00.000Z"
      }
    });
    expect(active).toMatchObject({
      id: "design.grant-operation-1",
      state: "active",
      screenshotApproved: false
    });
    await expect(
      adapter.stopDesignMode(active.id, active.revision)
    ).resolves.toMatchObject({ state: "stopped", revision: 2 });
    expect(client.calls).toEqual([
      {
        method: "authoring.design-mode.request",
        params: expect.objectContaining({
          grantId: "design.grant-operation-1",
          tabId: 7,
          origin: "https://www.chanmama.com",
          expiresAt: "2026-07-30T04:15:00.000Z"
        })
      },
      {
        method: "authoring.design-mode.activate",
        params: {
          grantId: "design.grant-operation-1",
          expectedRevision: 0,
          actor: "operator:test",
          occurredAt: "2026-07-30T04:00:00.000Z"
        }
      },
      {
        method: "authoring.design-mode.stop",
        params: {
          grantId: "design.grant-operation-1",
          expectedRevision: 1,
          actor: "operator:test",
          occurredAt: "2026-07-30T04:00:00.000Z",
          reason: "operator_stopped"
        }
      }
    ]);
  });

  it("claims and submits a human task with a short fenced lease", async () => {
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.taskList, [
        {
          taskId: "task-1",
          runId: "run-1",
          mode: "human_confirm",
          status: "queued",
          profile: { id: "binding_confirm" },
          deadline: "2026-07-30T05:00:00.000Z",
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { approved: { type: "boolean" } }
          }
        }
      ])
      .respond(CONSOLE_CONTROL_METHODS.taskClaim, {
        ok: true,
        task: {
          taskId: "task-1",
          fencingCounter: 7,
          lease: { fencingToken: 7 }
        }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskSubmit, { ok: true });
    const adapter = backend(client);
    const tasks = await adapter.listTasks();
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      kind: "human_confirm",
      choices: [
        { value: "confirmed", label: "确认" },
        { value: "rejected", label: "暂不确认" }
      ]
    });
    await adapter.submitTask("task-1", { decision: "confirmed" });
    expect(client.calls.slice(1)).toEqual([
      {
        method: "assistance.task.claim",
        params: {
          operationId: "operation-2",
          taskId: "task-1",
          leaseId: "console-lease:operation-1",
          actorId: "operator:test",
          actorType: "human",
          leaseDurationMs: 60_000
        }
      },
      {
        method: "assistance.task.submit",
        params: {
          operationId: "operation-3",
          taskId: "task-1",
          leaseId: "console-lease:operation-1",
          actorId: "operator:test",
          resolverType: "human",
          fencingToken: 7,
          output: { approved: true }
        }
      }
    ]);
  });

  it("projects reference candidates and submits a complete human curation", async () => {
    const materializedAsset = (assetId: string, platform: "DOUYIN" | "TAOBAO") => ({
      discoveryId: `${platform}:product-${assetId}`,
      platform,
      sourceEvidenceId: `evidence:${platform.toLowerCase()}`,
      assetId,
      digest: `sha256:${(platform === "DOUYIN" ? "a" : "b").repeat(64)}`,
      sizeBytes: 4,
      mediaType: "image/jpeg",
      observedRemoteUrl: platform === "DOUYIN"
        ? "https://p3.ecombdimg.com/source.jpg"
        : "https://img.alicdn.com/source.jpg",
      sourceUrl: platform === "DOUYIN"
        ? "https://p3.ecombdimg.com/final.jpg"
        : "https://img.alicdn.com/final.jpg",
      sourcePageUrl: platform === "DOUYIN"
        ? "https://www.douyin.com/search/type?type=product"
        : "https://s.taobao.com/search?q=food",
      role: "UNASSIGNED_REFERENCE_CANDIDATE",
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only"
    });
    const assets = [
      materializedAsset("asset-1", "DOUYIN"),
      materializedAsset("asset-2", "TAOBAO")
    ];
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.taskList, [{
        taskId: "task-curation",
        runId: "run-curation",
        mode: "human_confirm",
        status: "queued",
        profile: { id: "reference_asset_curation", version: "1.0.0" },
        input: {
          packId: "pack-curation",
          materialization: {
            schemaVersion: "reference-asset-materialization/v1",
            materializationExportId: "export-materialization",
            packId: "pack-curation",
            sourceRunId: "run-curation",
            status: "materialized_internal_reference",
            rightsStatus: "not_assessed",
            allowedUse: "internal_reference_only",
            sourceEvidenceDigest: `sha256:${"c".repeat(64)}`,
            assetCount: 2,
            assets,
            blockers: [
              "SOURCE_RIGHTS_NOT_ASSESSED",
              "HUMAN_ROLE_CURATION_REQUIRED"
            ]
          }
        },
        deadline: "2026-07-30T05:00:00.000Z",
        outputSchema: { type: "object" }
      }])
      .respond(CONSOLE_CONTROL_METHODS.taskClaim, {
        ok: true,
        task: {
          taskId: "task-curation",
          lease: { fencingToken: 9 }
        }
      })
      .respond(CONSOLE_CONTROL_METHODS.taskSubmit, { ok: true });
    const adapter = backend(client);

    await expect(adapter.listTasks()).resolves.toMatchObject([{
      id: "task-curation",
      title: "确认参考图片角色与使用边界",
      referenceCuration: {
        packId: "pack-curation",
        materializationExportId: "export-materialization",
        rightsStatus: "not_assessed",
        allowedUse: "internal_reference_only",
        assets: [
          {
            assetId: "asset-1",
            platform: "DOUYIN",
            previewUrl: "/api/downloads/export-materialization/assets/asset-1"
          },
          { assetId: "asset-2", platform: "TAOBAO" }
        ]
      }
    }]);
    await adapter.submitTask("task-curation", {
      decision: "publish_selection",
      referenceCuration: {
        selectedAssets: [{
          assetId: "asset-1",
          role: "COMPOSITION_TEMPLATE",
          reason: "只参考主体与留白关系",
          prohibitedInferences: ["不得推断版权或销量"]
        }]
      }
    });
    expect(client.calls.at(-1)).toMatchObject({
      method: "assistance.task.submit",
      params: {
        output: {
          packId: "pack-curation",
          selectedAssets: [{
            assetId: "asset-1",
            role: "COMPOSITION_TEMPLATE",
            reason: "只参考主体与留白关系",
            allowedTransferDimensions: ["composition"],
            prohibitedInferences: ["不得推断版权或销量"]
          }],
          rejectedAssetIds: ["asset-2"]
        }
      }
    });
  });

  it("acknowledges terminal attention with its current revision", async () => {
    const client = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.attentionAcknowledge,
      { state: "acknowledged", revision: 1 }
    );

    await backend(client).acknowledgeAttention("run-terminal:run-1", 0);

    expect(client.calls).toEqual([
      {
        method: "attention.acknowledge",
        params: {
          id: "run-terminal:run-1",
          expectedRevision: 0,
          actor: "operator:test"
        }
      }
    ]);
  });

  it("keeps upload bytes off control while reading verified download bytes from local CAS", async () => {
    const downloadBody = new TextEncoder().encode("report");
    const downloadDigest = `sha256:${createHash("sha256")
      .update(downloadBody)
      .digest("hex")}`;
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.stagingLeaseCreate, {
        leaseId: "lease-1",
        expiresAt: "2026-07-30T04:10:00.000Z",
        maxBytes: 1024
      })
      .respond(CONSOLE_CONTROL_METHODS.evidenceLineageGet, {
        runId: "run-1",
        sources: [
          {
            id: "source-1",
            label: "公开商品页",
            origin: "https://example.com",
            observedAt: "2026-07-30T03:00:00.000Z"
          }
        ],
        evidence: [],
        assets: []
      })
      .respond(CONSOLE_CONTROL_METHODS.downloadList, [
        {
          id: "download-1",
          runId: "run-1",
          kind: "report",
          title: "研究报告",
          fileName: "report.json",
          sizeBytes: 123,
          createdAt: "2026-07-30T03:00:00.000Z",
          assetIds: ["asset-report"]
        }
      ])
      .respond(CONSOLE_CONTROL_METHODS.downloadGet, {
        manifestVersion: "bpa.download-manifest/1",
        id: "download-1",
        runId: "run-1",
        kind: "report",
        title: "研究报告",
        fileName: "report.json",
        sizeBytes: downloadBody.byteLength,
        createdAt: "2026-07-30T03:00:00.000Z",
        assetIds: ["asset-report"],
        assets: [{
          assetId: "asset-report",
          digest: downloadDigest,
          sizeBytes: downloadBody.byteLength,
          mediaType: "application/json",
          storageRef: `asset-store:${downloadDigest}`
        }]
      });
    const adapter = backend(client, undefined, {
      read: vi.fn(() => downloadBody)
    });
    await expect(
      adapter.createStagingLease({
        fileName: "master.xlsx",
        mediaType: "application/octet-stream",
        sizeBytes: 3,
        purpose: "dataset"
      })
    ).resolves.toMatchObject({ id: "lease-1", maxBytes: 1024 });
    const callCount = client.calls.length;
    await expect(
      adapter.uploadStagingLease("lease-1", new Uint8Array([1, 2, 3]))
    ).rejects.toThrow("文件内容不会通过控制协议发送");
    expect(client.calls).toHaveLength(callCount);
    await expect(adapter.getEvidenceLineage("run-1")).resolves.toMatchObject({
      runId: "run-1",
      sources: [{ id: "source-1" }]
    });
    await expect(adapter.listDownloads("run-1")).resolves.toMatchObject([
      { id: "download-1", kind: "report" }
    ]);
    await expect(adapter.getDownload("download-1")).resolves.toEqual({
      fileName: "report.json",
      mediaType: "application/json",
      body: downloadBody
    });
    expect(client.calls).toEqual([
      {
        method: "staging.lease.create",
        params: {
          fileName: "master.xlsx",
          mediaType: "application/octet-stream",
          sizeBytes: 3,
          purpose: "dataset"
        }
      },
      { method: "evidence.lineage.get", params: { runId: "run-1" } },
      { method: "download.list", params: { runId: "run-1" } },
      { method: "download.get", params: { downloadId: "download-1" } }
    ]);
  });

  it("builds a rights-bounded reference ZIP and serves a digest-verified preview", async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xee]);
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const manifest = {
        manifestVersion: "bpa.download-manifest/1",
        id: "reference-1",
        runId: "run-1",
        kind: "reference_pack",
        title: "参考资产包",
        fileName: "reference-1.zip",
        sizeBytes: body.byteLength,
        createdAt: "2026-07-30T03:00:00.000Z",
        assetIds: ["asset-1"],
        rightsStatus: "not_assessed",
        allowedUse: "internal_reference_only",
        blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"],
        assets: [{
          assetId: "asset-1",
          digest,
          sizeBytes: body.byteLength,
          mediaType: "image/jpeg",
          storageRef: `asset-store:${digest}`
        }],
        referencePack: {
          schemaVersion: "reference-asset-pack/v1",
          exportId: "reference-1",
          packId: "pack-1",
          sourceRunId: "run-1",
          status: "ready_internal_reference",
          rightsStatus: "not_assessed",
          allowedUse: "internal_reference_only",
          assetCount: 1,
          assets: [{
            assetId: "asset-1",
            digest,
            sizeBytes: body.byteLength,
            mediaType: "image/jpeg",
            platform: "DOUYIN",
            discoveryId: "DOUYIN:product-1",
            sourceUrl: "https://cdn.ecombdimg.com/image-1.jpg",
            sourcePageUrl: "https://www.douyin.com/search/type?type=product",
            sourceEvidenceId: "evidence:browser:1",
            role: "COMPOSITION_TEMPLATE",
            reason: "只参考构图层级",
            allowedTransferDimensions: ["composition"],
            prohibitedInferences: ["不得据此推断版权或销量"],
            rightsStatus: "not_assessed",
            allowedUse: "internal_reference_only"
          }],
          blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
        }
      };
    const client = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.downloadGet,
      manifest,
      manifest
    );
    const reader = { read: vi.fn(() => body) };
    const adapter = backend(client, undefined, reader);
    const download = await adapter.getDownload("reference-1");
    expect(download).toMatchObject({
      fileName: "reference-1.zip",
      mediaType: "application/zip"
    });
    const archive = unzipSync(download.body);
    expect(Object.keys(archive).sort()).toEqual([
      "assets/01-asset-1.jpg",
      "manifest.json"
    ]);
    expect(JSON.parse(new TextDecoder().decode(archive["manifest.json"]))).toMatchObject({
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only",
      blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
    });
    await expect(
      adapter.getDownloadAsset("reference-1", "asset-1")
    ).resolves.toEqual({
      fileName: "asset-1",
      mediaType: "image/jpeg",
      body
    });
    expect(reader.read).toHaveBeenCalledWith(`asset-store:${digest}`);

    const tamperedClient = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.downloadGet,
      manifest
    );
    await expect(
      backend(tamperedClient, undefined, {
        read: () => new Uint8Array([0xff, 0xd8, 0xff, 0x00])
      }).getDownload("reference-1")
    ).rejects.toThrow("摘要校验失败");

    const malformedClient = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.downloadGet,
      {
        ...manifest,
        referencePack: {
          ...manifest.referencePack,
          internalPath: "/private/cas/asset-1"
        }
      }
    );
    await expect(
      backend(malformedClient, undefined, reader).getDownload("reference-1")
    ).rejects.toThrow("校验参考资产包边界");

    const wrongSourceClient = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.downloadGet,
      {
        ...manifest,
        referencePack: {
          ...manifest.referencePack,
          assets: [{
            ...manifest.referencePack.assets[0],
            sourceUrl: "https://example.com/unbound.jpg"
          }]
        }
      }
    );
    await expect(
      backend(wrongSourceClient, undefined, reader).getDownload("reference-1")
    ).rejects.toThrow("校验参考资产包边界");

    const oversized = 5 * 1024 * 1024 + 1;
    const oversizedClient = new FakeRequester().respond(
      CONSOLE_CONTROL_METHODS.downloadGet,
      {
        ...manifest,
        sizeBytes: oversized,
        assets: [{ ...manifest.assets[0], sizeBytes: oversized }],
        referencePack: {
          ...manifest.referencePack,
          assets: [{ ...manifest.referencePack.assets[0], sizeBytes: oversized }]
        }
      }
    );
    await expect(
      backend(oversizedClient, undefined, reader).getDownload("reference-1")
    ).rejects.toThrow("校验下载清单");
  });

  it("sends upload bytes only through the dedicated staging channel", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const uploader = {
      upload: vi.fn(async () => ({
        leaseId: "lease-secure",
        digest: `sha256:${"a".repeat(64)}`,
        sizeBytes: body.byteLength
      }))
    };
    const client = new FakeRequester()
      .respond(CONSOLE_CONTROL_METHODS.stagingLeaseCreate, {
          leaseId: "lease-secure",
          expiresAt: "2026-07-30T04:10:00.000Z",
          maxBytes: body.byteLength,
          transferToken: "secret-token"
        })
      .respond(CONSOLE_CONTROL_METHODS.datasetImportStaged, {
        status: "published",
        stagingId: "dataset-staging-1",
        dataset: {
          metadata: { id: "packaging-master", version: "1.0.0" },
          source: { digest: `sha256:${"a".repeat(64)}` },
          recordCount: 10
        },
        warnings: []
      });
    const adapter = backend(client, uploader);
    await adapter.createStagingLease({
      fileName: "packaging.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: body.byteLength,
      sha256: "a".repeat(64),
      purpose: "dataset"
    });
    await expect(
      adapter.uploadStagingLease(
        "lease-secure",
        body,
        "a".repeat(64)
      )
    ).resolves.toMatchObject({
      leaseId: "lease-secure",
      sizeBytes: body.byteLength
    });
    expect(uploader.upload).toHaveBeenCalledWith({
      leaseId: "lease-secure",
      token: "secret-token",
      body,
      expectedSha256: "a".repeat(64)
    });
    await expect(
      adapter.importStagedDataset({
        upload: {
          leaseId: "lease-secure",
          digest: `sha256:${"a".repeat(64)}`,
          sizeBytes: body.byteLength
        },
        id: "packaging-master",
        version: "1.0.0",
        title: "包装主数据"
      })
    ).resolves.toEqual({
      status: "published",
      stagingId: "dataset-staging-1",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      id: "packaging-master",
      version: "1.0.0",
      recordCount: 10,
      warnings: [],
      errors: []
    });
    expect(JSON.stringify(client.calls)).not.toContain("1,2,3");
    expect(client.calls.at(-1)).toEqual({
      method: "dataset.import.staged",
      params: {
        leaseId: "lease-secure",
        digest: `sha256:${"a".repeat(64)}`,
        id: "packaging-master",
        version: "1.0.0",
        actor: "operator:test",
        title: "包装主数据"
      }
    });
  });
});
