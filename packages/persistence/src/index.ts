import type {
  AssetRecordDefinition,
  AssistanceTaskDefinition,
  AuthoringSessionDefinition,
  CandidateBundleDefinition,
  DatasetVersionDefinition,
  DecisionRecordDefinition,
  EvidenceLinkDefinition,
  PageSnapshotDefinition,
  ScenarioSpecDefinition,
  SourceRecordDefinition
} from "@bpa/schemas";
import type { TriggerSpecDefinition } from "@bpa/schemas";
import type {
  BlobRecord,
  StagingLeaseRecord
} from "@bpa/asset-core";
import type {
  EvidenceChunkRecord,
  EvidenceTransferRecord
} from "@bpa/evidence-core";
import type {
  ExecutionPlan,
  JsonValue,
  ResourceAuthentication,
  ResourceBindingSnapshot,
  ScopePath
} from "@bpa/workflow-ir";

export type {
  AssetRecordDefinition,
  AssistanceTaskDefinition,
  AuthoringSessionDefinition,
  CandidateBundleDefinition,
  DatasetVersionDefinition,
  DecisionRecordDefinition,
  EvidenceLinkDefinition,
  PageSnapshotDefinition,
  ScenarioSpecDefinition,
  SourceRecordDefinition
} from "@bpa/schemas";
export type { TriggerSpecDefinition } from "@bpa/schemas";
export type { BlobRecord, StagingLeaseRecord } from "@bpa/asset-core";
export type {
  EvidenceChunkRecord,
  EvidenceTransferRecord
} from "@bpa/evidence-core";
export type {
  ExecutionPlan,
  JsonValue,
  ResourceAuthentication,
  ResourceBindingSnapshot,
  ScopePath
} from "@bpa/workflow-ir";

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
  getCandidate(
    assetType: ArtifactType,
    assetId: string,
    version: string
  ): ArtifactRecord | undefined;
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
  | "rejected"
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

export interface EngineCheckpointRecord {
  runId: string;
  stateVersion: string;
  stateRevision: number;
  state: JsonValue;
  updatedAt: string;
}

export interface ExecutionScopeRecord {
  scopeId: string;
  runId: string;
  scopePath: ScopePath;
  parentScopeId?: string;
  scopeKind: "root" | "call" | "foreach";
  createdAt: string;
}

export interface IterationInstanceRecord {
  iterationId: string;
  runId: string;
  scopeId: string;
  iterationKey: string;
  ordinal: number;
  status: string;
  input: JsonValue;
  output?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface StepInstanceRecord {
  stepInstanceId: string;
  runId: string;
  scopeId: string;
  iterationId?: string;
  stepKey: string;
  attempt: number;
  executionIdentity: string;
  status: string;
  revision: number;
  input: JsonValue;
  output?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryStateStore {
  getRunPlanSnapshot(runId: string): RunPlanSnapshotRecord | undefined;
  getRunResourceBindingSnapshot(
    runId: string
  ): ResourceBindingSnapshot | undefined;
  getEngineCheckpoint(runId: string): EngineCheckpointRecord | undefined;
  putExecutionScope(scope: ExecutionScopeRecord): ExecutionScopeRecord;
  putIterationInstance(
    iteration: IterationInstanceRecord
  ): IterationInstanceRecord;
  putStepInstance(step: StepInstanceRecord): StepInstanceRecord;
  getExecutionScope(scopeId: string): ExecutionScopeRecord | undefined;
  getIterationInstance(
    iterationId: string
  ): IterationInstanceRecord | undefined;
  getStepInstance(stepInstanceId: string): StepInstanceRecord | undefined;
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
  /**
   * Optional only for Runtime 0.3 compatibility. New resumable callers use
   * createRecoverableRun, which requires the snapshot.
   */
  planSnapshot?: RunPlanSnapshotRecord;
  resourceBindingSnapshot?: ResourceBindingSnapshot;
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
  createRecoverableRun(
    input: CreateRunInput & {
      planSnapshot: RunPlanSnapshotRecord;
      checkpoint: EngineCheckpointRecord;
      outbox?: readonly OutboxMessage[];
      assistanceTasks?: readonly AssistanceTaskRecord[];
    }
  ): RunRecord;
  commitRecoverableTransition(
    input: RunTransitionInput & {
      checkpoint: EngineCheckpointRecord;
      expectedCheckpointRevision: number;
      outbox?: readonly OutboxMessage[];
      assistanceTasks?: readonly AssistanceTaskRecord[];
      inbox?: readonly InboxMessageRecord[];
      acknowledgeOutboxIds?: readonly string[];
    }
  ): RunRecord;
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

export interface AssistanceTaskPrivateStateRecord {
  leaseId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  ownerType?: "ai" | "human";
  fencingCounter: number;
  blocking?: boolean;
  terminalReason?: string;
}

export interface AssistanceTaskRecord {
  task: AssistanceTaskDefinition;
  /** Compatibility mirror used in SQL CAS predicates. */
  fencingCounter: number;
  privateState: AssistanceTaskPrivateStateRecord;
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
  expectedFencingToken: number;
  expectedRunRevision: number;
  inbox: InboxMessageRecord;
  wakeEvent: ExecutionEventRecord;
  outbox?: OutboxMessage;
  checkpoint?: EngineCheckpointRecord;
  expectedCheckpointRevision?: number;
  nextRunStatus?: RunStatus;
  currentNodeKey?: string;
  output?: unknown;
  assistanceTasks?: readonly AssistanceTaskRecord[];
  additionalOutbox?: readonly OutboxMessage[];
  acknowledgeOutboxIds?: readonly string[];
}

export interface AssistanceTaskListFilter {
  statuses?: ReadonlyArray<AssistanceTaskDefinition["status"]>;
  modes?: ReadonlyArray<AssistanceTaskDefinition["mode"]>;
  ownerType?: "ai" | "human";
  limit?: number;
}

export interface CommitAssistanceTaskRequestInput {
  requestId: string;
  task: AssistanceTaskRecord;
  expectedRevision: number;
  expectedFencingCounter: number;
  recordedAt: string;
}

export interface CompleteDetachedAssistanceInput {
  requestId: string;
  task: AssistanceTaskRecord;
  expectedRevision: number;
  expectedFencingCounter: number;
  inbox: InboxMessageRecord;
  event: Omit<ExecutionEventRecord, "sequence">;
  acknowledgeOutboxIds?: readonly string[];
}

export type CommitAssistanceTaskRequestResult =
  | {
      status: "accepted" | "duplicate";
      task: AssistanceTaskRecord;
    }
  | { status: "stale" };

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
  commitAssistanceTask(input: {
    task: AssistanceTaskRecord;
    expectedRevision: number;
    expectedFencingCounter: number;
  }): { status: "accepted"; task: AssistanceTaskRecord } | { status: "stale" };
  commitAssistanceTaskRequest(
    input: CommitAssistanceTaskRequestInput
  ): CommitAssistanceTaskRequestResult;
  completeDetachedAssistanceTask(
    input: CompleteDetachedAssistanceInput
  ): CommitAssistanceTaskRequestResult;
  getAssistanceTask(taskId: string): AssistanceTaskRecord | undefined;
  listAssistanceTasks(
    filter: AssistanceTaskListFilter
  ): AssistanceTaskRecord[];
  getAssistanceRequestResult(
    requestId: string
  ): AssistanceTaskRecord | undefined;
  getInboxMessage(messageId: string): InboxMessageRecord | undefined;
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
  stageDataset(record: DatasetStagingRecord): DatasetStagingRecord;
  transitionDatasetStaging(input: {
    stagingId: string;
    expectedState: DatasetStagingRecord["state"];
    nextState: DatasetStagingRecord["state"];
    validationReport: JsonValue;
    updatedAt: string;
  }): DatasetStagingRecord;
  getDatasetStaging(stagingId: string): DatasetStagingRecord | undefined;
  publishDataset(input: {
    stagingId: string;
    expectedState: "validated";
    dataset: DatasetVersionDefinition;
    normalizedRecords: readonly JsonValue[];
    audit: AuditRecord;
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
  supersedeDecision(input: {
    decisionId: string;
    expectedStatus: "active";
    replacement: DecisionRecordDefinition;
  }): {
    superseded: DecisionRecordDefinition;
    replacement: DecisionRecordDefinition;
  };
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
  acceptResultWithEvidence(input: {
    commandId: string;
    runId: string;
    nodeExecutionId: string;
    fencingToken: number;
    result: unknown;
    evidenceIds: readonly string[];
    evidenceLinks: readonly EvidenceLinkDefinition[];
    inboxMessageId: string;
    receivedAt: string;
  }):
    | "accepted"
    | "duplicate"
    | "stale"
    | "evidence_not_ready"
    | "evidence_invalid";
}

export interface GatewayCommandStore extends GatewayDeliveryUnitOfWork {
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
}

export type BrowserSessionRole =
  | "general"
  | "metrics_source"
  | "public_asset_source"
  | "design_mode";

export type BrowserSessionObservationState =
  | "unknown"
  | "available"
  | "auth_required"
  | "revoked";

export type BrowserPageAuthentication =
  | "unknown"
  | "anonymous"
  | "authenticated"
  | "membership";

export type BrowserPageObservationState =
  | "content_script_missing"
  | "loading"
  | "probing"
  | "auth_required"
  | "challenge"
  | "ready"
  | "departed"
  | "stale";

export interface BrowserPageObservationRecord {
  sessionId: string;
  browserInstanceId: string;
  tabId: number;
  windowId?: number;
  origin: string;
  pathname: string;
  contentScriptReady: boolean;
  authentication: BrowserPageAuthentication;
  authenticationContextRef?: string;
  observationState: BrowserPageObservationState;
  pageEpoch: string;
  observerCapabilityId: string;
  revision: number;
  observedAt: string;
  reasonCode?: string;
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
  observationRevision?: number;
  role?: BrowserSessionRole;
  observedOrigin?: string;
  observedAuthentication?: ResourceAuthentication;
  observationState?: BrowserSessionObservationState;
  observedAt?: string;
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
  routes?: Array<{
    origin: string;
    pathnamePrefixes: string[];
    observerCapabilityId: string;
  }>;
  adapterId?: string;
  adapterVersion?: string;
}

/**
 * Narrow, platform-neutral browser resource port. Consumers receive only
 * observed browser facts and capability projections; SQLite details and
 * ecommerce identities are intentionally absent.
 */
export interface BrowserObservationStore {
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
  getBrowserSession(id: string): BrowserSessionRecord | undefined;
  listBrowserSessions(input: {
    limit: number;
    role?: BrowserSessionRole;
    observationState?: BrowserSessionObservationState;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<BrowserSessionRecord>;
  upsertBrowserPageObservation(
    input: BrowserPageObservationRecord
  ): BrowserPageObservationRecord;
  getBrowserPageObservation(
    sessionId: string,
    tabId: number
  ): BrowserPageObservationRecord | undefined;
  listBrowserPageObservations(input: {
    limit: number;
    sessionId?: string;
    browserInstanceId?: string;
  }): BrowserPageObservationRecord[];
  invalidateBrowserPageObservations(input: {
    sessionId: string;
    observedAt: string;
    reasonCode: string;
  }): number;
  resetBrowserPageObservations(sessionId: string): number;
  pruneBrowserPageObservations(input: {
    observedBefore: string;
  }): number;
  replaceBrowserCapabilities(
    sessionId: string,
    capabilities: BrowserCapabilityRecord[]
  ): void;
  listBrowserCapabilities(sessionId: string): BrowserCapabilityRecord[];
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

export type TriggerRunStatus =
  | "due"
  | "lease_acquired"
  | "run_created"
  | "running"
  | "complete"
  | "partial"
  | "blocked"
  | "degraded"
  | "rejected"
  | "uncertain"
  | "cancelled"
  | "failed"
  | "skipped";

export interface TriggerSpecRecord {
  spec: TriggerSpecDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface TriggerRunRecord {
  triggerRunId: string;
  triggerId: string;
  triggerVersion: string;
  occurrenceKey: string;
  status: TriggerRunStatus;
  workflowRunId?: string;
  fencingToken?: number;
  datasetId?: string;
  datasetVersion?: string;
  diagnostic?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserControlLeaseRecord {
  resourceId: string;
  ownerId: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface TriggerStore {
  putTriggerSpec(input: {
    spec: TriggerSpecDefinition;
    actor: string;
    occurredAt: string;
  }): TriggerSpecRecord;
  setTriggerEnabled(input: {
    id: string;
    expectedRevision: number;
    enabled: boolean;
    actor: string;
    occurredAt: string;
  }): TriggerSpecRecord;
  getTriggerSpec(id: string): TriggerSpecRecord | undefined;
  getTriggerSpecVersion(
    id: string,
    version: string
  ): TriggerSpecDefinition | undefined;
  listTriggerSpecs(): TriggerSpecRecord[];
  claimTriggerOccurrence(input: TriggerRunRecord):
    | { status: "accepted"; record: TriggerRunRecord }
    | { status: "duplicate"; record: TriggerRunRecord };
  updateTriggerRun(input: {
    triggerRunId: string;
    status: TriggerRunStatus;
    updatedAt: string;
    workflowRunId?: string;
    fencingToken?: number;
    diagnostic?: string;
  }): TriggerRunRecord;
  listTriggerRuns(triggerId?: string): TriggerRunRecord[];
  latestDatasetVersion(datasetId: string): {
    id: string;
    version: string;
    createdAt: string;
  } | undefined;
  acquireTriggerLease(input: {
    concurrencyKey: string;
    ownerId: string;
    now: string;
    ttlSeconds: number;
  }): BrowserControlLeaseRecord | undefined;
  renewTriggerLease(input: {
    concurrencyKey: string;
    ownerId: string;
    fencingToken: number;
    now: string;
    ttlSeconds: number;
  }): BrowserControlLeaseRecord | undefined;
  releaseTriggerLease(input: {
    concurrencyKey: string;
    ownerId: string;
    fencingToken: number;
    releasedAt: string;
  }): boolean;
  acquireBrowserControlLease(input: {
    resourceId: string;
    ownerId: string;
    now: string;
    ttlSeconds: number;
  }): BrowserControlLeaseRecord | undefined;
  renewBrowserControlLease(input: {
    resourceId: string;
    ownerId: string;
    fencingToken: number;
    now: string;
    ttlSeconds: number;
  }): BrowserControlLeaseRecord | undefined;
  releaseBrowserControlLease(input: {
    resourceId: string;
    ownerId: string;
    fencingToken: number;
    releasedAt: string;
  }): boolean;
  listBrowserControlLeases(now: string): BrowserControlLeaseRecord[];
}

export interface WorkflowDraftRecord {
  draftId: string;
  revision: number;
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDraftRevisionRecord {
  draftId: string;
  revision: number;
  operationId?: string;
  content: unknown;
  createdAt: string;
}

export interface ApplyWorkflowDraftRevisionInput {
  draftId: string;
  expectedRevision: number;
  operationId: string;
  content: unknown;
  updatedAt: string;
}

export type ApplyWorkflowDraftRevisionResult =
  | {
      status: "accepted" | "duplicate";
      current: WorkflowDraftRecord;
      revision: WorkflowDraftRevisionRecord;
    }
  | {
      status: "stale";
      actualRevision: number;
    };

export interface WorkflowCandidateRecord {
  candidateId: string;
  draftId: string;
  sourceRevision: number;
  content: unknown;
  createdAt: string;
}

/**
 * Generic persistence boundary for incremental authoring. Content deliberately
 * remains unknown so Persistence never depends on authoring-core.
 */
export interface WorkflowAuthoringStore {
  createWorkflowDraft(record: WorkflowDraftRecord): WorkflowDraftRecord;
  getWorkflowDraft(draftId: string): WorkflowDraftRecord | undefined;
  getWorkflowDraftRevision(
    draftId: string,
    revision: number
  ): WorkflowDraftRevisionRecord | undefined;
  applyWorkflowDraftRevision(
    input: ApplyWorkflowDraftRevisionInput
  ): ApplyWorkflowDraftRevisionResult;
  saveWorkflowCandidate(
    candidate: WorkflowCandidateRecord
  ): WorkflowCandidateRecord;
  getWorkflowCandidate(
    candidateId: string
  ): WorkflowCandidateRecord | undefined;
}

export interface AuthoringScenarioRecord {
  scenario: ScenarioSpecDefinition;
  digest: string;
  createdAt: string;
}

export interface AuthoringSessionRevisionRecord {
  sessionId: string;
  revision: number;
  operationId?: string;
  operationDigest?: string;
  session: AuthoringSessionDefinition;
  createdAt: string;
}

export interface ApplyAuthoringSessionInput {
  sessionId: string;
  expectedRevision: number;
  operationId: string;
  next: AuthoringSessionDefinition;
  actor: string;
}

export type ApplyAuthoringSessionResult =
  | {
      status: "accepted" | "duplicate";
      current: AuthoringSessionDefinition;
      revision: AuthoringSessionRevisionRecord;
    }
  | {
      status: "stale";
      actualRevision: number;
    };

export type DesignModeGrantState =
  | "requested"
  | "active"
  | "stopped"
  | "expired"
  | "revoked"
  | "invalidated";

export type DesignModeCaptureOperation =
  | "semantic_snapshot"
  | "screenshot_once";

export interface DesignModeGrantRecord {
  grantId: string;
  authoringSessionId: string;
  revision: number;
  state: DesignModeGrantState;
  approvedBy: string;
  browserSessionId: string;
  profileId: string;
  tabId: number;
  origin: string;
  pageEpoch: string;
  allowedOperations: readonly DesignModeCaptureOperation[];
  issuedAt: string;
  expiresAt: string;
  updatedAt: string;
  terminalReason?: string;
}

export interface TransitionDesignModeGrantInput {
  grantId: string;
  expectedRevision: number;
  nextState: Exclude<DesignModeGrantState, "requested">;
  actor: string;
  occurredAt: string;
  reason?: string;
}

export interface AttachPageSnapshotInput
  extends ApplyAuthoringSessionInput {
  snapshot: PageSnapshotDefinition;
}

export interface CandidateBundleValidationRecord {
  bundleId: string;
  checkType:
    | "schema"
    | "contracts"
    | "replay"
    | "permissions"
    | "risk";
  valid: boolean;
  issueCount: number;
  reportAssetId?: string;
  createdAt: string;
}

export interface SaveCandidateBundleInput
  extends ApplyAuthoringSessionInput {
  bundle: CandidateBundleDefinition;
  validationResults: readonly CandidateBundleValidationRecord[];
}

export interface CandidateBundleRecord {
  bundle: CandidateBundleDefinition;
  digest: string;
  createdAt: string;
}

export interface CandidateExportRecord {
  exportId: string;
  bundleId: string;
  bundleDigest: string;
  archiveDigest: string;
  manifestDigest: string;
  destinationRef: string;
  actor: string;
  createdAt: string;
}

/**
 * Durable boundary for BPA 0.5 authoring. Scenario, snapshot and bundle
 * bodies are Schema-owned values; session mutation remains CAS and
 * operation-idempotent.
 */
export interface AuthoringStore {
  putAuthoringScenario(
    record: AuthoringScenarioRecord
  ): { status: "accepted" | "duplicate"; record: AuthoringScenarioRecord };
  getAuthoringScenario(
    scenarioId: string,
    version: string
  ): AuthoringScenarioRecord | undefined;
  createAuthoringSession(
    session: AuthoringSessionDefinition
  ): AuthoringSessionDefinition;
  getAuthoringSession(
    sessionId: string
  ): AuthoringSessionDefinition | undefined;
  getAuthoringSessionRevision(
    sessionId: string,
    revision: number
  ): AuthoringSessionRevisionRecord | undefined;
  applyAuthoringSession(
    input: ApplyAuthoringSessionInput
  ): ApplyAuthoringSessionResult;
  putDesignModeGrant(grant: DesignModeGrantRecord): DesignModeGrantRecord;
  getDesignModeGrant(grantId: string): DesignModeGrantRecord | undefined;
  transitionDesignModeGrant(
    input: TransitionDesignModeGrantInput
  ): DesignModeGrantRecord;
  attachPageSnapshot(
    input: AttachPageSnapshotInput
  ): ApplyAuthoringSessionResult;
  getPageSnapshot(
    snapshotId: string
  ): PageSnapshotDefinition | undefined;
  saveCandidateBundle(
    input: SaveCandidateBundleInput
  ): {
    status: "accepted" | "duplicate" | "stale";
    record?: CandidateBundleRecord;
    actualRevision?: number;
  };
  getCandidateBundle(bundleId: string): CandidateBundleRecord | undefined;
  listCandidateBundleValidation(
    bundleId: string
  ): CandidateBundleValidationRecord[];
  putCandidateExport(
    record: CandidateExportRecord
  ): { status: "accepted" | "duplicate"; record: CandidateExportRecord };
  getCandidateExport(exportId: string): CandidateExportRecord | undefined;
}

export interface RetentionJobRecord {
  jobId: string;
  targetType: "evidence" | "asset" | "blob";
  targetId: string;
  expectedPolicy: string;
  state: "scheduled" | "running" | "completed" | "skipped" | "failed";
  notBefore: string;
  attempt: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceListCursor {
  createdAt: string;
  id: string;
}

export interface EvidenceListPage<T> {
  records: readonly T[];
  nextCursor?: EvidenceListCursor;
}

export interface ExportRecord {
  exportId: string;
  runId: string;
  exportType:
    | "reference_asset_pack"
    | "issue_report"
    | "evidence_bundle"
    | "dataset";
  status: "ready" | "failed" | "archived";
  assetIds: readonly string[];
  metadata: JsonValue;
  createdAt: string;
}

export interface TrustedLineageStore {
  listEvidenceTransfersForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<EvidenceTransferRecord>;
  listEvidenceLinksForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<EvidenceLinkDefinition>;
  listSourceRecordsForRun(input: {
    runId: string;
    limit: number;
    afterSourceId?: string;
  }): {
    records: readonly SourceRecordDefinition[];
    nextSourceId?: string;
  };
  listAssetRecordsForRun(input: {
    runId: string;
    limit: number;
    afterAssetId?: string;
  }): {
    records: readonly AssetRecordDefinition[];
    nextAssetId?: string;
  };
  getSourceRecords(sourceIds: readonly string[]): SourceRecordDefinition[];
  getAssetRecords(assetIds: readonly string[]): AssetRecordDefinition[];
}

export interface ExportStore {
  putExportRecord(
    record: ExportRecord
  ): { status: "accepted" | "duplicate"; record: ExportRecord };
  getExportRecord(exportId: string): ExportRecord | undefined;
  listExportRecordsForRun(input: {
    runId: string;
    limit: number;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<ExportRecord>;
}

export interface SourceAssetStore {
  putSourceRecord(
    record: SourceRecordDefinition
  ): { status: "accepted" | "duplicate"; record: SourceRecordDefinition };
  getSourceRecord(sourceId: string): SourceRecordDefinition | undefined;
  registerBlob(
    record: BlobRecord
  ): {
    status: "accepted" | "duplicate";
    record: BlobRecord;
    storageWarning: boolean;
  };
  getBlob(digest: string): BlobRecord | undefined;
  putAssetRecord(
    record: AssetRecordDefinition
  ): { status: "accepted" | "duplicate"; record: AssetRecordDefinition };
  getAssetRecord(assetId: string): AssetRecordDefinition | undefined;
  deleteAssetRecord(input: {
    assetId: string;
    actor: string;
    deletedAt: string;
  }):
    | { status: "deleted" }
    | { status: "missing" | "referenced" | "retained" };
}

export interface EvidenceTransferUnitOfWork {
  putStagingLease(
    lease: StagingLeaseRecord
  ): { status: "accepted" | "duplicate"; lease: StagingLeaseRecord };
  getStagingLease(leaseId: string): StagingLeaseRecord | undefined;
  transitionStagingLease(input: {
    leaseId: string;
    expectedState: StagingLeaseRecord["state"];
    nextState: StagingLeaseRecord["state"];
  }): StagingLeaseRecord;
  declareEvidence(
    transfer: EvidenceTransferRecord
  ):
    | {
        status: "accepted" | "duplicate";
        transfer: EvidenceTransferRecord;
        runBytes: number;
      }
    | { status: "over_run_quota"; runBytes: number };
  commitEvidenceChunk(input: {
    evidenceId: string;
    chunk: EvidenceChunkRecord;
  }):
    | { status: "accepted" | "duplicate"; transfer: EvidenceTransferRecord }
    | { status: "out_of_order"; nextChunkIndex: number }
    | { status: "conflict" };
  completeEvidence(input: {
    evidenceId: string;
    blob: BlobRecord;
  }): EvidenceTransferRecord;
  acknowledgeEvidence(
    evidenceId: string,
    acknowledgedAt: string
  ): EvidenceTransferRecord;
  terminateEvidence(input: {
    evidenceId: string;
    terminalState: "rejected" | "expired";
    updatedAt: string;
  }): EvidenceTransferRecord;
  getEvidenceTransfer(
    evidenceId: string
  ): EvidenceTransferRecord | undefined;
  listEvidenceChunks(evidenceId: string): EvidenceChunkRecord[];
  linkEvidence(
    link: EvidenceLinkDefinition
  ): { status: "accepted" | "duplicate"; link: EvidenceLinkDefinition };
  getEvidenceLink(linkId: string): EvidenceLinkDefinition | undefined;
  scheduleRetention(
    job: RetentionJobRecord
  ): { status: "accepted" | "duplicate"; job: RetentionJobRecord };
  listDueRetentionJobs(now: string, limit: number): RetentionJobRecord[];
  completeRetentionJob(input: {
    jobId: string;
    expectedState: "scheduled" | "running";
    nextState: "completed" | "skipped" | "failed";
    updatedAt: string;
    lastError?: string;
  }): RetentionJobRecord;
}

export interface Persistence
  extends RegistryStore,
    ExecutionUnitOfWork,
    RecoveryStateStore,
    AssistanceUnitOfWork,
    DatasetPublicationUnitOfWork,
    DecisionRecordStore,
    GatewayDeliveryUnitOfWork,
    ExecutionStore,
    WorkflowAuthoringStore,
    AuthoringStore,
    SourceAssetStore,
    EvidenceTransferUnitOfWork,
    TrustedLineageStore,
    ExportStore,
    BrowserObservationStore,
    GatewayCommandStore,
    TriggerStore {
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
  getBrowserSession(id: string): BrowserSessionRecord | undefined;
  listBrowserSessions(input: {
    limit: number;
    role?: BrowserSessionRole;
    observationState?: BrowserSessionObservationState;
    cursor?: EvidenceListCursor;
  }): EvidenceListPage<BrowserSessionRecord>;
  updateBrowserSessionObservation(input: {
    id: string;
    expectedRevision: number;
    role: BrowserSessionRole;
    observedOrigin?: string;
    observedAuthentication?: ResourceAuthentication;
    observationState: BrowserSessionObservationState;
    observedAt: string;
  }): BrowserSessionRecord;
  upsertBrowserPageObservation(
    input: BrowserPageObservationRecord
  ): BrowserPageObservationRecord;
  getBrowserPageObservation(
    sessionId: string,
    tabId: number
  ): BrowserPageObservationRecord | undefined;
  listBrowserPageObservations(input: {
    limit: number;
    sessionId?: string;
    browserInstanceId?: string;
  }): BrowserPageObservationRecord[];
  invalidateBrowserPageObservations(input: {
    sessionId: string;
    observedAt: string;
    reasonCode: string;
  }): number;
  pruneBrowserPageObservations(input: {
    observedBefore: string;
  }): number;
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
export class WorkflowDraftConflictError extends Error {}
export class WorkflowOperationConflictError extends Error {}
export class WorkflowCandidateConflictError extends Error {}
export class AuthoringConflictError extends Error {}
export class AuthoringOperationConflictError extends Error {}
export class DesignModeGrantConflictError extends Error {}
export class CandidateBundleConflictError extends Error {}
export class EvidenceConflictError extends Error {}
export class EvidenceOwnershipError extends Error {}
export class AssetReferenceConflictError extends Error {}
