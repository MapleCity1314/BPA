import type {
  CreateRunInput,
  CreateRunResult,
  DashboardSnapshot,
  DatasetImportResult,
  DownloadView,
  EvidenceLineageView,
  RunView,
  StagingLease,
  StagingLeaseRequest,
  StagedDatasetImportInput,
  SubmitTaskInput,
  TaskView,
  UploadReceipt,
  WorkflowSummary
} from "@bpa/operator-console-contracts";

export interface OperatorConsoleApi {
  initializeSession(): Promise<void>;
  getDashboard(): Promise<DashboardSnapshot>;
  listWorkflows(): Promise<WorkflowSummary[]>;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunView>;
  listTasks(): Promise<TaskView[]>;
  submitTask(taskId: string, input: SubmitTaskInput): Promise<void>;
  importDataset(
    file: File,
    input: Omit<StagedDatasetImportInput, "upload">
  ): Promise<DatasetImportResult>;
  getEvidenceLineage(runId: string): Promise<EvidenceLineageView>;
  listDownloads(runId?: string): Promise<DownloadView[]>;
  downloadUrl(downloadId: string): string;
}

interface SessionResponse {
  csrfToken: string;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = "请求失败，请稍后重试。";
    try {
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Preserve the stable business-facing fallback.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export class HttpOperatorConsoleApi implements OperatorConsoleApi {
  #csrfToken = "";

  async #request<T>(
    path: string,
    init: RequestInit = {},
    mutation = false
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (mutation) {
      if (!this.#csrfToken) throw new Error("工作台安全会话尚未建立。");
      headers.set("X-BPA-CSRF-Token", this.#csrfToken);
    }
    if (init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }
    return parseResponse<T>(
      await fetch(path, {
        ...init,
        headers,
        credentials: "same-origin"
      })
    );
  }

  async initializeSession(): Promise<void> {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const launchToken = fragment.get("token");
    let session: SessionResponse;
    if (launchToken) {
      session = await this.#request<SessionResponse>(
        "/api/session/exchange",
        {
          method: "POST",
          headers: { "X-BPA-Console-Token": launchToken }
        }
      );
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    } else {
      session = await this.#request<SessionResponse>("/api/session");
    }
    this.#csrfToken = session.csrfToken;
  }

  getDashboard() {
    return this.#request<DashboardSnapshot>("/api/dashboard");
  }

  listWorkflows() {
    return this.#request<WorkflowSummary[]>("/api/workflows");
  }

  createRun(input: CreateRunInput) {
    return this.#request<CreateRunResult>(
      "/api/runs",
      { method: "POST", body: JSON.stringify(input) },
      true
    );
  }

  getRun(runId: string) {
    return this.#request<RunView>(`/api/runs/${encodeURIComponent(runId)}`);
  }

  listTasks() {
    return this.#request<TaskView[]>("/api/tasks");
  }

  async submitTask(taskId: string, input: SubmitTaskInput) {
    await this.#request(
      `/api/tasks/${encodeURIComponent(taskId)}/submit`,
      { method: "POST", body: JSON.stringify(input) },
      true
    );
  }

  async #uploadFile(
    file: File,
    purpose: "dataset" | "evidence"
  ): Promise<UploadReceipt> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const leaseRequest: StagingLeaseRequest = {
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256,
      purpose
    };
    const lease = await this.#request<StagingLease>(
      "/api/uploads/leases",
      { method: "POST", body: JSON.stringify(leaseRequest) },
      true
    );
    return this.#request<UploadReceipt>(
      `/api/uploads/leases/${encodeURIComponent(lease.id)}/content`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-BPA-Content-SHA256": sha256
        },
        body: bytes
      },
      true
    );
  }

  async importDataset(
    file: File,
    input: Omit<StagedDatasetImportInput, "upload">
  ): Promise<DatasetImportResult> {
    const upload = await this.#uploadFile(file, "dataset");
    return this.#request<DatasetImportResult>(
      "/api/datasets/imports",
      {
        method: "POST",
        body: JSON.stringify({ upload, ...input })
      },
      true
    );
  }

  getEvidenceLineage(runId: string) {
    return this.#request<EvidenceLineageView>(
      `/api/runs/${encodeURIComponent(runId)}/lineage`
    );
  }

  listDownloads(runId?: string) {
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    return this.#request<DownloadView[]>(`/api/downloads${query}`);
  }

  downloadUrl(downloadId: string) {
    return `/api/downloads/${encodeURIComponent(downloadId)}`;
  }
}
