export type AttentionLevel = "normal" | "attention" | "action";
export type HealthStatus = "healthy" | "degraded" | "unavailable";

export interface HealthComponent {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  technicalDetails?: string;
}

export interface BrowserSessionView {
  id: string;
  label: string;
  status: "ready" | "attention" | "offline";
  origin: string;
  role?: string;
  authenticated: boolean;
  lastSeenAt: string;
}

export interface DashboardSnapshot {
  attention: AttentionLevel;
  headline: string;
  runtimeVersion: string;
  components: HealthComponent[];
  browserSessions: BrowserSessionView[];
  activeRunCount: number;
  pendingTaskCount: number;
}

export interface WorkflowInputField {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "dataset";
  required: boolean;
  help?: string;
}

export interface WorkflowSummary {
  id: string;
  version: string;
  title: string;
  description: string;
  riskLevel: "R0" | "R1";
  inputFields: WorkflowInputField[];
  resourceSlots: Array<{
    key: string;
    label: string;
    requiredOrigin?: string;
  }>;
}

export interface CreateRunInput {
  workflowId: string;
  workflowVersion: string;
  inputs: Record<string, string | number | boolean>;
  resourceBindings: Record<string, string>;
}

export interface CreateRunResult {
  runId: string;
}

export interface RunTimelineEntry {
  id: string;
  at: string;
  title: string;
  summary: string;
  state: "completed" | "active" | "waiting" | "failed";
  technicalDetails?: string;
}

export interface RunView {
  id: string;
  workflowTitle: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  businessSummary: string;
  startedAt: string;
  completedAt?: string;
  timeline: RunTimelineEntry[];
}

export interface TaskView {
  id: string;
  runId: string;
  kind: "ai_review" | "human_confirm" | "human_action";
  title: string;
  guidance: string;
  attention: "attention" | "action";
  dueAt?: string;
  choices?: Array<{ value: string; label: string }>;
}

export interface SubmitTaskInput {
  decision: string;
  note?: string;
}

export interface StagingLeaseRequest {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
  purpose: "dataset" | "evidence";
}

export interface StagingLease {
  id: string;
  expiresAt: string;
  maxBytes: number;
}

export interface UploadReceipt {
  leaseId: string;
  digest: string;
  sizeBytes: number;
}

export interface StagedDatasetImportInput {
  upload: UploadReceipt;
  id: string;
  version: string;
  title?: string;
}

export interface DatasetImportResult {
  status: "published" | "rejected";
  stagingId: string;
  sourceDigest: string;
  id?: string;
  version?: string;
  recordCount?: number;
  warnings: string[];
  errors: string[];
}

export interface EvidenceLineageView {
  runId: string;
  sources: Array<{
    id: string;
    label: string;
    origin: string;
    observedAt: string;
  }>;
  evidence: Array<{
    id: string;
    label: string;
    classification: "public" | "restricted" | "confidential";
    digest: string;
    sourceIds: string[];
  }>;
  assets: Array<{
    id: string;
    label: string;
    digest: string;
    evidenceIds: string[];
  }>;
}

export interface DownloadView {
  id: string;
  runId: string;
  kind: "report" | "reference_pack";
  title: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DownloadPayload {
  fileName: string;
  mediaType: string;
  body: Uint8Array;
}

export interface ControlBackend {
  getDashboard(): Promise<DashboardSnapshot>;
  listWorkflows(): Promise<WorkflowSummary[]>;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunView>;
  listTasks(): Promise<TaskView[]>;
  submitTask(taskId: string, input: SubmitTaskInput): Promise<void>;
  createStagingLease(input: StagingLeaseRequest): Promise<StagingLease>;
  uploadStagingLease(
    leaseId: string,
    body: Uint8Array,
    expectedSha256?: string
  ): Promise<UploadReceipt>;
  importStagedDataset(
    input: StagedDatasetImportInput
  ): Promise<DatasetImportResult>;
  getEvidenceLineage(runId: string): Promise<EvidenceLineageView>;
  listDownloads(runId?: string): Promise<DownloadView[]>;
  getDownload(downloadId: string): Promise<DownloadPayload>;
}
