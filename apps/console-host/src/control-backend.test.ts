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
    return queue.shift() as TResult;
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
  }
) {
  return new UdsControlBackend(client, {
    actorId: "operator:test",
    operationId: operationIds(),
    now: () => new Date("2026-07-30T04:00:00.000Z"),
    leaseDurationMs: 60_000,
    ...(stagingUploader ? { stagingUploader } : {})
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
      .respond(CONSOLE_CONTROL_METHODS.attentionList, [
        {
          id: "run-terminal:run-login",
          runId: "run-login",
          kind: "blocking",
          title: "浏览器登录或验证需要处理",
          reason: "浏览器返回了登录阻断。",
          requestedAction: "在受管 Chrome Profile 中完成人工登录。",
          createdAt: "2026-07-30T03:58:00.000Z",
          revision: 0
        }
      ])
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
      ]);
    const result = await backend(client).getDashboard();
    expect(result).toMatchObject({
      attention: "action",
      headline: "发现 1 项运行问题",
      pendingTaskCount: 1,
      alerts: [
        {
          id: "run-terminal:run-login",
          kind: "blocking"
        }
      ],
      components: [
        { id: "core", status: "healthy" },
        { id: "persistence", status: "healthy" },
        { id: "browser", status: "healthy" }
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
        params: { limit: 100 }
      }
    ]);
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

  it("locks future metadata methods while refusing file bytes on control", async () => {
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
          createdAt: "2026-07-30T03:00:00.000Z"
        }
      ])
      .respond(CONSOLE_CONTROL_METHODS.downloadGet, {
        capability: "pending"
      });
    const adapter = backend(client);
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
    await expect(adapter.getDownload("download-1")).rejects.toThrow(
      "文件内容不会通过控制协议发送"
    );
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
