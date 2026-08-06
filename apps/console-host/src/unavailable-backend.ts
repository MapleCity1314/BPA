import type {
  ControlBackend,
  CreateRunInput,
  DesignModeGrantInput,
  StagingLeaseRequest,
  StagedDatasetImportInput,
  SubmitTaskInput
} from "@bpa/operator-console-contracts";

const unavailable = (): never => {
  throw new Error("BPA Core 暂不可用，请检查本地服务后重试。");
};

export class UnavailableControlBackend implements ControlBackend {
  async getDashboard() {
    return {
      attention: "action" as const,
      headline: "BPA Core 尚未连接",
      runtimeVersion: "0.6.0",
      components: [
        {
          id: "core",
          label: "本地服务",
          status: "unavailable" as const,
          summary: "请先启动 BPA Core",
          technicalDetails: "Console Host is waiting for a ControlBackend adapter."
        }
      ],
      browserSessions: [],
      activeRunCount: 0,
      pendingTaskCount: 0
    };
  }

  async listWorkflows() {
    return [];
  }

  async createRun(_input: CreateRunInput) {
    return unavailable();
  }

  async getRun(_runId: string) {
    return unavailable();
  }

  async listTasks() {
    return [];
  }

  async submitTask(_taskId: string, _input: SubmitTaskInput) {
    return unavailable();
  }

  async createStagingLease(_input: StagingLeaseRequest) {
    return unavailable();
  }

  async uploadStagingLease(
    _leaseId: string,
    _body: Uint8Array,
    _expectedSha256?: string
  ) {
    return unavailable();
  }

  async importStagedDataset(_input: StagedDatasetImportInput) {
    return unavailable();
  }

  async getEvidenceLineage(_runId: string) {
    return unavailable();
  }

  async listDownloads(_runId?: string) {
    return [];
  }

  async getDownload(_downloadId: string) {
    return unavailable();
  }

  async startDesignMode(_input: DesignModeGrantInput) {
    return unavailable();
  }

  async stopDesignMode(
    _grantId: string,
    _expectedRevision: number
  ) {
    return unavailable();
  }
}
