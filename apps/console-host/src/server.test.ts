import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type {
  ControlBackend,
  CreateRunInput,
  DesignModeGrantInput,
  StagingLeaseRequest,
  StagedDatasetImportInput,
  SubmitTaskInput
} from "@bpa/operator-console-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startConsoleHost, type ConsoleHostHandle } from "./server.js";

class RecordingBackend implements ControlBackend {
  readonly createRun = vi.fn(async (_input: CreateRunInput) => ({ runId: "run-1" }));
  readonly submitTask = vi.fn(async (_taskId: string, _input: SubmitTaskInput) => {});
  readonly acknowledgeAttention = vi.fn(
    async (_id: string, _expectedRevision: number) => {}
  );
  readonly createStagingLease = vi.fn(async (_input: StagingLeaseRequest) => ({
    id: "lease-1",
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: 1024
  }));
  readonly uploadStagingLease = vi.fn(
    async (leaseId: string, body: Uint8Array, _expectedSha256?: string) => ({
      leaseId,
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: body.byteLength
    })
  );
  readonly importStagedDataset = vi.fn(
    async (input: StagedDatasetImportInput) => ({
      status: "published" as const,
      stagingId: "dataset-staging-1",
      sourceDigest: input.upload.digest,
      id: input.id,
      version: input.version,
      recordCount: 12,
      warnings: [],
      errors: []
    })
  );
  readonly startDesignMode = vi.fn(
    async (input: DesignModeGrantInput) => ({
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
    })
  );
  readonly stopDesignMode = vi.fn(
    async (grantId: string, expectedRevision: number) => ({
      id: grantId,
      authoringSessionId: "authoring.session-1",
      browserSessionId: "browser-session-1",
      profileId: "chanmama.product-metrics",
      state: "stopped" as const,
      origin: "https://www.chanmama.com",
      tabId: 7,
      pageEpoch: "tab-7:1999999999999:design-1",
      expiresAt: "2030-01-01T00:15:00.000Z",
      screenshotApproved: false,
      revision: expectedRevision + 1
    })
  );

  async getDashboard() {
    return {
      attention: "normal" as const,
      headline: "运行正常",
      runtimeVersion: "0.4.0",
      components: [],
      browserSessions: [],
      alerts: [],
      activeRunCount: 0,
      pendingTaskCount: 0
    };
  }

  async listWorkflows() {
    return [];
  }

  async getRun(runId: string) {
    return {
      id: runId,
      workflowTitle: "检查",
      status: "running" as const,
      businessSummary: "正在运行",
      startedAt: "2026-07-30T00:00:00.000Z",
      timeline: []
    };
  }

  async listTasks() {
    return [];
  }

  async getEvidenceLineage(runId: string) {
    return { runId, sources: [], evidence: [], assets: [] };
  }

  async listDownloads(_runId?: string) {
    return [];
  }

  async getDownload(_downloadId: string) {
    return {
      fileName: "report.json",
      mediaType: "application/json",
      body: new Uint8Array([123, 125])
    };
  }
}

const handles: ConsoleHostHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bpa-console-"));
  await writeFile(join(root, "index.html"), "<!doctype html><h1>BPA</h1>");
  return root;
}

async function requestWithHost(
  port: number,
  path: string,
  host: string
): Promise<number> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { Host: host }
      },
      (response) => {
        response.resume();
        response.once("end", () => resolveRequest(response.statusCode ?? 0));
      }
    );
    request.once("error", reject);
    request.end();
  });
}

function tokenSource(): () => Uint8Array {
  let value = 1;
  return () => new Uint8Array(32).fill(value++);
}

async function launch(
  options: {
    backend?: RecordingBackend;
    now?: () => number;
    idleTimeoutMs?: number;
  } = {}
) {
  const backend = options.backend ?? new RecordingBackend();
  const handle = await startConsoleHost({
    backend,
    staticRoot: await fixtureRoot(),
    tokenBytes: tokenSource(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {})
  });
  handles.push(handle);
  const token = new URL(handle.launchUrl).hash.slice("#token=".length);
  const exchange = await fetch(`${handle.origin}/api/session/exchange`, {
    method: "POST",
    headers: {
      Origin: handle.origin,
      "X-BPA-Console-Token": decodeURIComponent(token)
    }
  });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = (await exchange.json()) as { csrfToken: string };
  return { backend, handle, exchange, cookie, csrf: session.csrfToken };
}

describe("Console Host security boundary", () => {
  it("exchanges a fragment-only token once and creates a hardened session", async () => {
    const { handle, exchange, cookie } = await launch();
    expect(handle.launchUrl).toContain("/#token=");
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");
    expect(exchange.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(exchange.headers.get("access-control-allow-origin")).toBeNull();
    expect(exchange.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );

    const token = new URL(handle.launchUrl).hash.slice("#token=".length);
    const replay = await fetch(`${handle.origin}/api/session/exchange`, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        "X-BPA-Console-Token": decodeURIComponent(token)
      }
    });
    expect(replay.status).toBe(401);

    const dashboard = await fetch(`${handle.origin}/api/dashboard`, {
      headers: { Cookie: cookie }
    });
    expect(dashboard.status).toBe(200);
  });

  it("acknowledges attention through an authenticated CAS mutation", async () => {
    const { handle, cookie, csrf, backend } = await launch();
    const response = await fetch(
      `${handle.origin}/api/attention/run-terminal%3Arun-1/acknowledge`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: handle.origin,
          "X-BPA-CSRF-Token": csrf,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expectedRevision: 0 })
      }
    );

    expect(response.status).toBe(200);
    expect(backend.acknowledgeAttention).toHaveBeenCalledWith(
      "run-terminal:run-1",
      0
    );
  });

  it("rejects foreign Host, foreign Origin, and missing CSRF", async () => {
    const { handle, cookie, csrf, backend } = await launch();
    const foreignOrigin = await fetch(`${handle.origin}/api/runs`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://evil.invalid",
        "X-BPA-CSRF-Token": csrf,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workflowId: "w",
        workflowVersion: "1.0.0",
        inputs: {},
        resourceBindings: {}
      })
    });
    expect(foreignOrigin.status).toBe(403);

    const missingCsrf = await fetch(`${handle.origin}/api/runs`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: handle.origin,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workflowId: "w",
        workflowVersion: "1.0.0",
        inputs: {},
        resourceBindings: {}
      })
    });
    expect(missingCsrf.status).toBe(403);
    expect(backend.createRun).not.toHaveBeenCalled();

    expect(
      await requestWithHost(handle.port, "/api/dashboard", "localhost:1234")
    ).toBe(403);
  });

  it("accepts valid mutations and never accepts a local path for uploads", async () => {
    const { handle, cookie, csrf, backend } = await launch();
    const run = await fetch(`${handle.origin}/api/runs`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: handle.origin,
        "X-BPA-CSRF-Token": csrf,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workflowId: "priority-check",
        workflowVersion: "1.0.0",
        inputs: { scope: "all" },
        resourceBindings: {
          shop: {
            sessionId: "session-1",
            browserInstanceId: "chrome-profile-1",
            tabId: 7,
            observationRevision: 3
          }
        }
      })
    });
    expect(run.status).toBe(201);
    expect(backend.createRun).toHaveBeenCalledOnce();

    const pathAttempt = await fetch(`${handle.origin}/api/uploads/leases`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: handle.origin,
        "X-BPA-CSRF-Token": csrf,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileName: "data.xlsx",
        mediaType: "application/octet-stream",
        sizeBytes: 12,
        purpose: "dataset",
        path: "/Users/example/secret.xlsx"
      })
    });
    expect(pathAttempt.status).toBe(400);
    expect(backend.createStagingLease).not.toHaveBeenCalled();
  });

  it("requires CSRF and a closed Design Mode page-binding shape", async () => {
    const { handle, cookie, csrf, backend } = await launch();
    const input = {
      authoringSessionId: "authoring.session-1",
      browserSessionId: "browser-session-1",
      profileId: "chanmama.product-metrics",
      screenshotApproved: false,
      pageBinding: {
        version: "bpa.design-page-binding/1",
        tabId: 7,
        origin: "https://www.chanmama.com",
        pageEpoch: "tab-7:1999999999999:design-1",
        issuedAt: new Date().toISOString()
      }
    };
    const started = await fetch(
      `${handle.origin}/api/authoring/design-mode/grants`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: handle.origin,
          "X-BPA-CSRF-Token": csrf,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input)
      }
    );
    expect(started.status).toBe(201);
    expect(backend.startDesignMode).toHaveBeenCalledWith(input);

    const injected = await fetch(
      `${handle.origin}/api/authoring/design-mode/grants`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: handle.origin,
          "X-BPA-CSRF-Token": csrf,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...input,
          pageBinding: {
            ...input.pageBinding,
            script: "return document.cookie"
          }
        })
      }
    );
    expect(injected.status).toBe(400);
    expect(backend.startDesignMode).toHaveBeenCalledTimes(1);

    const stopped = await fetch(
      `${handle.origin}/api/authoring/design-mode/grants/design.grant-1/stop`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: handle.origin,
          "X-BPA-CSRF-Token": csrf,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expectedRevision: 1 })
      }
    );
    expect(stopped.status).toBe(200);
    expect(backend.stopDesignMode).toHaveBeenCalledWith(
      "design.grant-1",
      1
    );
  });

  it("uses a lease before accepting bytes and consumes it after upload", async () => {
    const { handle, cookie, csrf, backend } = await launch();
    const headers = {
      Cookie: cookie,
      Origin: handle.origin,
      "X-BPA-CSRF-Token": csrf
    };
    const leaseResponse = await fetch(`${handle.origin}/api/uploads/leases`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "data.csv",
        mediaType: "text/csv",
        sizeBytes: 3,
        purpose: "dataset"
      })
    });
    expect(leaseResponse.status).toBe(201);
    const upload = await fetch(
      `${handle.origin}/api/uploads/leases/lease-1/content`,
      { method: "PUT", headers, body: new Uint8Array([1, 2, 3]) }
    );
    expect(upload.status).toBe(201);
    expect(backend.uploadStagingLease).toHaveBeenCalledOnce();
    const receipt = await upload.json();
    const imported = await fetch(`${handle.origin}/api/datasets/imports`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        upload: receipt,
        id: "packaging-master",
        version: "1.0.0",
        title: "包装主数据"
      })
    });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({
      status: "published",
      id: "packaging-master",
      recordCount: 12
    });
    expect(backend.importStagedDataset).toHaveBeenCalledWith({
      upload: receipt,
      id: "packaging-master",
      version: "1.0.0",
      title: "包装主数据"
    });

    const replay = await fetch(
      `${handle.origin}/api/uploads/leases/lease-1/content`,
      { method: "PUT", headers, body: new Uint8Array([1]) }
    );
    expect(replay.status).toBe(404);
  });

  it("expires sessions after thirty minutes of inactivity", async () => {
    let time = 10_000;
    const { handle, cookie } = await launch({
      now: () => time,
      idleTimeoutMs: 30 * 60 * 1000
    });
    time += 30 * 60 * 1000;
    const response = await fetch(`${handle.origin}/api/dashboard`, {
      headers: { Cookie: cookie }
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "SESSION_EXPIRED" }
    });
  });

  it("serves only files inside the configured static root with strict headers", async () => {
    const { handle } = await launch();
    const page = await fetch(handle.origin);
    expect(await page.text()).toContain("<h1>BPA</h1>");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");
    const traversal = await fetch(`${handle.origin}/..%2f..%2fetc%2fpasswd`);
    expect(traversal.status).toBe(404);
    const writeAttempt = await fetch(`${handle.origin}/unknown-route`, {
      method: "POST",
      headers: { Origin: handle.origin }
    });
    expect(writeAttempt.status).toBe(405);
  });

  it("survives oversized bodies and masks unexpected backend failures", async () => {
    const backend = new RecordingBackend();
    backend.createRun.mockRejectedValueOnce(
      new Error("private socket /Users/example/core.sock")
    );
    const logError = vi.fn();
    const root = await fixtureRoot();
    const handle = await startConsoleHost({
      backend,
      staticRoot: root,
      tokenBytes: tokenSource(),
      logError
    });
    handles.push(handle);
    const token = new URL(handle.launchUrl).hash.slice("#token=".length);
    const exchange = await fetch(`${handle.origin}/api/session/exchange`, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        "X-BPA-Console-Token": decodeURIComponent(token)
      }
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = (await exchange.json()) as { csrfToken: string };
    const mutationHeaders = {
      Cookie: cookie,
      Origin: handle.origin,
      "X-BPA-CSRF-Token": csrfToken,
      "Content-Type": "application/json"
    };

    const oversized = await fetch(`${handle.origin}/api/runs`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ content: "x".repeat(512 * 1024) })
    });
    expect(oversized.status).toBe(413);
    expect(
      await fetch(`${handle.origin}/api/dashboard`, {
        headers: { Cookie: cookie }
      })
    ).toHaveProperty("status", 200);

    const backendFailure = await fetch(`${handle.origin}/api/runs`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        workflowId: "w",
        workflowVersion: "1.0.0",
        inputs: {},
        resourceBindings: {}
      })
    });
    expect(backendFailure.status).toBe(500);
    const responseBody = JSON.stringify(await backendFailure.json());
    expect(responseBody).toContain("工作台服务暂时不可用");
    expect(responseBody).not.toContain("private socket");
    expect(logError).toHaveBeenCalledOnce();
    expect(
      await fetch(`${handle.origin}/api/dashboard`, {
        headers: { Cookie: cookie }
      })
    ).toHaveProperty("status", 200);
  });
});
