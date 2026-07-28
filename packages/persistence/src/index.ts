import type {
  AssistanceTaskDefinition,
  DatasetVersionDefinition,
  DecisionRecordDefinition
} from "@bpa/schemas";
import type { ExecutionPlan, JsonValue } from "@bpa/workflow-ir";

export type ArtifactType =
  | "workflow"
  | "node"
  | "adapter"
  | "policy"
  | "assistance_profile"
  | "dataset_profile"
  | "page_model"
  | "element_contract";
export type ArtifactStatus = "candidate" | "published";

export interface ArtifactRecord {
  recordId: string;
  assetType: ArtifactType;
  assetId: string;
  version: string;
  digest: string;
  status: ArtifactStatus;
  content: unknown;
  createdAt: string;
  publishedAt?: string;
}

export interface PublishArtifactInput {
  assetType: ArtifactType;
  assetId: string;
  version: string;
  digest: string;
  content: unknown;
  actor: string;
}

export interface RegistryStore {
  saveCandidate(input: PublishArtifactInput): ArtifactRecord;
  publish(input: PublishArtifactInput): ArtifactRecord;
  getPublished(
    assetType: ArtifactType,
    assetId: string,
    version: string
  ): ArtifactRecord | undefined;
  listPublished(assetType?: ArtifactType): ArtifactRecord[];
}

export type RunStatus =
  | "created"
  | "validated"
  | "queued"
  | "running"
  | "waiting_browser"
  | "waiting_assistance"
  | "waiting_human"
  | "paused"
  | "compensating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain";

export type NodeExecutionStatus =
  | "scheduled"
  | "dispatched"
  | "accepted"
  | "executing"
  | "succeeded"
  | "rejected"
  | "failed"
  | "timed_out"
  | "cancel_requested"
  | "cancelled"
  | "uncertain";

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  status: RunStatus;
  revision: number;
  input: unknown;
  output?: unknown;
  currentNodeKey?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable recovery source written in the same transaction as the Run.
 * Recovery consumes planJson and never recompiles the current catalog.
 */
export interface RunPlanSnapshotRecord {
  runId: string;
  irVersion: ExecutionPlan["irVersion"];
  planDigest: string;
  workflowSourceDigest: string;
  artifactClosureDigest: string;
  planJson: ExecutionPlan;
  riskSnapshot: JsonValue;
  createdAt: string;
}

export interface NodeExecutionRecord {
  id: string;
  runId: string;
  nodeKey: string;
  nodeId: string;
  nodeVersion: string;
  status: NodeExecutionStatus;
  revision: number;
  attempt: number;
  idempotencyKey: string;
  fencingToken: number;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEventRecord {
  id: string;
  runId: string;
  nodeExecutionId?: string;
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  run: RunRecord;
  event: ExecutionEventRecord;
  planSnapshot?: RunPlanSnapshotRecord;
}

export interface NodeTransitionInput {
  nodeExecutionId: string;
  expectedRevision: number;
  nextStatus: NodeExecutionStatus;
  output?: unknown;
  error?: NodeExecutionRecord["error"];
  event: ExecutionEventRecord;
  idempotencyResult?: {
    key: string;
    status: NodeExecutionStatus;
    result: unknown;
  };
  outbox?: OutboxMessage;
}

export interface RunTransitionInput {
  runId: string;
  expectedRevision: number;
  nextStatus: RunStatus;
  currentNodeKey?: string;
  output?: unknown;
  event: ExecutionEventRecord;
}

export interface ExecutionUnitOfWork {
  createRun(input: CreateRunInput): RunRecord;
  commitRunTransition(input: RunTransitionInput): RunRecord;
  createNodeExecution(
    node: NodeExecutionRecord,
    event: ExecutionEventRecord
  ): NodeExecutionRecord;
  commitNodeTransition(input: NodeTransitionInput): NodeExecutionRecord;
}

export interface InboxMessageRecord {
  id: string;
  topic: string;
  aggregateId: string;
  payload: unknown;
  receivedAt: string;
  appliedAt?: string;
}

export interface AssistanceTaskRecord {
  task: AssistanceTaskDefinition;
  fencingCounter: number;
}

export interface CreateBlockingAssistanceInput {
  task: AssistanceTaskRecord;
  runId: string;
  expectedRunRevision: number;
  waitingEvent: ExecutionEventRecord;
  outbox: OutboxMessage;
}

export interface SubmitAssistanceAndWakeInput {
  task: AssistanceTaskRecord;
  expectedTaskRevision: number;
  expectedRunRevision: number;
  inbox: InboxMessageRecord;
  wakeEvent: ExecutionEventRecord;
  outbox?: OutboxMessage;
}

/**
 * The two methods below are transactional boundaries, not convenience
 * sequences. Implementations must apply task/run/event/inbox/outbox changes
 * atomically and use both CAS revision and fencing checks.
 */
export interface AssistanceUnitOfWork {
  createBlockingTaskAndPauseRun(
    input: CreateBlockingAssistanceInput
  ): {
    task: AssistanceTaskRecord;
    run: RunRecord;
  };
  submitTaskAndWakeRun(
    input: SubmitAssistanceAndWakeInput
  ):
    | { status: "accepted"; task: AssistanceTaskRecord; run: RunRecord }
    | { status: "duplicate" | "stale" };
}

export interface DatasetStagingRecord {
  stagingId: string;
  profileId: string;
  profileVersion: string;
  sourceDigest: string;
  state: "staged" | "validated" | "rejected" | "published";
  validationReport: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetPublicationUnitOfWork {
  publishDataset(input: {
    stagingId: string;
    expectedState: "validated";
    dataset: DatasetVersionDefinition;
    normalizedRecords: readonly JsonValue[];
    event: ExecutionEventRecord;
  }): DatasetVersionDefinition;
  getDataset(id: string, version: string): DatasetVersionDefinition | undefined;
  readDatasetRecords(input: {
    id: string;
    version: string;
    afterRecordKey?: string;
    limit: number;
  }): {
    records: readonly JsonValue[];
    nextRecordKey?: string;
  };
}

export interface DecisionRecordStore {
  putDecision(record: DecisionRecordDefinition): DecisionRecordDefinition;
  getActiveDecision(
    decisionType: string,
    scope: Readonly<Record<string, string>>,
    preconditions: Readonly<Record<string, string>>
  ): DecisionRecordDefinition | undefined;
  revokeDecision(input: {
    decisionId: string;
    expectedStatus: "active";
    revokedBy: string;
    revokedAt: string;
  }): DecisionRecordDefinition;
}

export interface GatewayCommandRecord {
  id: string;
  nodeExecutionId: string;
  commandSeq: number;
  idempotencyKey: string;
  fencingToken: number;
  state: "queued" | "delivered" | "accepted" | "terminal";
  payload: unknown;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayDeliveryUnitOfWork {
  enqueueCommand(command: GatewayCommandRecord, outbox: OutboxMessage): void;
  promoteEngineOutbox(
    engineOutboxId: string,
    command: GatewayCommandRecord,
    outbox: OutboxMessage,
    acknowledgedAt: string
  ): GatewayCommandRecord;
  acceptResult(input: {
    commandId: string;
    fencingToken: number;
    result: unknown;
    inboxMessageId: string;
    receivedAt: string;
  }): "accepted" | "duplicate" | "stale";
}

export interface BrowserSessionRecord {
  id: string;
  browserInstanceId: string;
  extensionId: string;
  extensionVersion: string;
  protocolVersion: string;
  incomingSeq: number;
  outgoingSeq: number;
  lastAckedCommandSeq: number;
  capabilityDigest?: string;
  resumeTokenDigest: string;
  resumeTokenExpiresAt: string;
  connectedAt: string;
  disconnectedAt?: string;
}

export interface OpenBrowserSessionInput {
  session: BrowserSessionRecord;
  presentedResumeTokenDigest?: string;
  now: string;
}

export interface BrowserCapabilityRecord {
  nodeId: string;
  nodeVersion: string;
  riskLevel: string;
  permissions: string[];
}

export interface ExecutionStore {
  getRun(id: string): RunRecord | undefined;
  getNodeExecution(id: string): NodeExecutionRecord | undefined;
  listEvents(runId: string): ExecutionEventRecord[];
  requestCancel(runId: string, actor: string): RunRecord;
}

export interface AuditRecord {
  id: string;
  action: string;
  actor: string;
  target: string;
  detail: unknown;
  occurredAt: string;
}

export interface Persistence
  extends RegistryStore,
    ExecutionUnitOfWork,
    GatewayDeliveryUnitOfWork,
    ExecutionStore {
  health(): {
    adapter: string;
    schemaVersion: number;
    writable: boolean;
  };
  listPendingEngineOutbox(): OutboxMessage[];
  listPendingGatewayCommands(
    afterCommandSeq?: number
  ): GatewayCommandRecord[];
  listGatewayCommandsForRun(runId: string): GatewayCommandRecord[];
  listGatewayCommandsNeedingApplication(): GatewayCommandRecord[];
  getGatewayCommand(id: string): GatewayCommandRecord | undefined;
  markGatewayCommandState(
    id: string,
    state: GatewayCommandRecord["state"],
    updatedAt: string
  ): GatewayCommandRecord;
  nextGatewayCommandSequence(): number;
  openBrowserSession(input: OpenBrowserSessionInput): {
    session: BrowserSessionRecord;
    resumedFrom?: BrowserSessionRecord;
  };
  updateBrowserSession(input: {
    id: string;
    incomingSeq?: number;
    outgoingSeq?: number;
    lastAckedCommandSeq?: number;
    capabilityDigest?: string;
    disconnectedAt?: string;
  }): BrowserSessionRecord;
  replaceBrowserCapabilities(
    sessionId: string,
    capabilities: BrowserCapabilityRecord[]
  ): void;
  listBrowserCapabilities(sessionId: string): BrowserCapabilityRecord[];
  listAudit(target?: string): AuditRecord[];
  close(): void;
}

export class RevisionConflictError extends Error {}
export class ArtifactConflictError extends Error {}
export class StaleFencingTokenError extends Error {}
