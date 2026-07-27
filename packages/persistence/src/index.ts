export type ArtifactType = "workflow" | "node" | "adapter" | "policy";
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
  close(): void;
}

export class RevisionConflictError extends Error {}
export class ArtifactConflictError extends Error {}
export class StaleFencingTokenError extends Error {}
