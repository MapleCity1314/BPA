import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import {
  AssistanceTaskService,
  PACKAGING_MATCH_REVIEW_VALIDATOR_REF,
  validatePackagingMatchReviewResult,
  type AssistanceResultValidator,
  type TaskQueueFilter
} from "@bpa/assistance-core";
import type { DraftOperation } from "@bpa/authoring-core";
import {
  compileCanonicalWorkflow,
  compileWorkflow,
  contentDigest,
  MemoryNodeCatalog,
  type CatalogResolver
} from "@bpa/compiler";
import {
  CONTROL_HELLO_PROTOCOL_VERSION,
  CONTROL_MAX_MESSAGE_BYTES as CONTROL_V1_MAX_MESSAGE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlEnvelope,
  negotiateControlHello,
  parseControlHelloRequest,
  parseControlRequest,
  type ControlErrorCode,
  type ControlHelloErrorEnvelope,
  type ControlRequestEnvelope,
  type ControlResponseEnvelope
} from "@bpa/control-protocol";
import { isWindowsNamedPipe } from "@bpa/platform-runtime";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import type {
  ArtifactType,
  Persistence,
  RunRecord,
  TriggerSpecDefinition
} from "@bpa/persistence";
import {
  BuiltinRuntimeProvider,
  RuntimeProviderRegistry
} from "@bpa/node-runtime";
import { registerTeamRuntimeProvider } from "@bpa/team-runtime";
import {
  compileDataValidator,
  formatValidationErrors,
  validateAdapterManifest,
  validateAssistanceProfile,
  validateElementContract,
  validateDeterministicResultValidatorPolicy,
  validateJsonSchemaDefinition,
  validateNode,
  validateNodeV1Alpha2,
  validatePageModel,
  validateTriggerSpec,
  validateWorkflow,
  validateWorkflowV1Alpha3,
  type NodeDefinition,
  type NodeDefinitionV1Alpha2,
  type AdapterManifestDefinition,
  type AssistanceProfileDefinition,
  type AuthoringSessionDefinition,
  type CandidateBundleDefinition,
  type ElementContractDefinition,
  type PageModelDefinition,
  type PageSnapshotDefinition,
  type ScenarioSpecDefinition,
  type DeterministicResultValidatorPolicyDefinition,
  type WorkflowDefinition,
  type WorkflowDefinitionV1Alpha2,
  type WorkflowDefinitionV1Alpha3
} from "@bpa/schemas";
import {
  validateElementContractDefinition,
  validatePageModel as validatePageModelDefinition,
  type PageAssetCandidate
} from "@bpa/page-model";
import type { LocalBrowserGateway } from "./browser-gateway.js";
import { Ir2WorkflowRuntime } from "./ir2-workflow-runtime.js";
import { PersistenceTaskQueue } from "./persistence-task-queue.js";
import {
  LocalAuthoringService,
  type AuthoringSessionOperation
} from "./authoring-service.js";
import { PackagingDatasetService } from "./dataset-service.js";
import { DatasetRuntimeProvider } from "./dataset-runtime-provider.js";
import { PACKAGING_DATASET_PROFILE } from "@bpa/packaging-dataset";
import {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS
} from "../../team-worker/src/manifest.js";
import type { JsonValue } from "@bpa/workflow-ir";
import { RuntimeResourceBindingService } from "./runtime-resource-bindings.js";
import { TrustedEvidenceQueryService } from "./trusted-evidence-queries.js";
import {
  StagingTransferService,
  type StagingLeaseRequest
} from "./staging-transfer.js";
import { LocalCandidateArchiveService } from "./candidate-archive-service.js";
import { TriggerRuntime } from "./trigger-runtime.js";

export const CONTROL_MAX_MESSAGE_BYTES = 512 * 1024;

type PublishedNodeDefinition = NodeDefinition | NodeDefinitionV1Alpha2;

export interface ControlRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ControlResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class LocalCoreService {
  readonly engine: LocalWorkflowEngine;
  readonly ir2Runtime: Ir2WorkflowRuntime;
  readonly assistance: AssistanceTaskService;
  readonly authoring: LocalAuthoringService;
  readonly candidateArchives: LocalCandidateArchiveService | undefined;
  readonly datasets: PackagingDatasetService;
  readonly triggers: TriggerRuntime;
  readonly #resourceBindings: RuntimeResourceBindingService;
  readonly #trustedEvidence: TrustedEvidenceQueryService;

  constructor(
    readonly persistence: Persistence,
    readonly browserGateway?: LocalBrowserGateway,
    runtimeProviders?: RuntimeProviderRegistry,
    readonly stagingTransfers?: StagingTransferService,
    candidateArchiveDataDirectory?: string,
    readonly runtimeMaintenancePath?: string
  ) {
    this.engine = new LocalWorkflowEngine(persistence);
    this.datasets = new PackagingDatasetService(persistence);
    this.triggers = new TriggerRuntime(
      persistence,
      (trigger,input) => {
        this.#assertRuntimeAvailable();
        const resolved = this.#resolveWorkflowResources(
          trigger.spec.workflow.id,
          trigger.spec.workflow.version,
          trigger.spec.browserInstanceId
        ) as { resourceBindings?: unknown };
        return this.#createRun(
          trigger.spec.workflow.id,
          trigger.spec.workflow.version,
          input,
          resolved.resourceBindings ?? {},
          `trigger:${trigger.spec.id}`
        ) as RunRecord;
      }
    );
    this.#resourceBindings = new RuntimeResourceBindingService(persistence);
    this.#trustedEvidence = new TrustedEvidenceQueryService(persistence);
    const providers = runtimeProviders ?? new RuntimeProviderRegistry();
    if (!providers.list().includes("builtin")) {
      providers.register(new BuiltinRuntimeProvider());
    }
    if (browserGateway && !providers.list().includes("browser")) {
      providers.register(browserGateway);
    }
    if (!providers.list().includes("dataset")) {
      providers.register(new DatasetRuntimeProvider(this.datasets));
    }
    if (!providers.list().includes("team")) {
      const packagedWorker = resolve(
        import.meta.dirname,
        "bpa-team-worker.js"
      );
      const workerArgs = existsSync(packagedWorker)
        ? [packagedWorker]
        : [
            "--import",
            "tsx",
            resolve(import.meta.dirname, "../../team-worker/src/main.ts")
          ];
      registerTeamRuntimeProvider(providers, {
        process: {
          command: process.execPath,
          args: workerArgs,
          cwd: existsSync(packagedWorker)
            ? resolve(import.meta.dirname, "..")
            : resolve(import.meta.dirname, "../../.."),
          env: {
            ...(process.env.BPA_INVENTORY_SOCKET
              ? { BPA_INVENTORY_SOCKET: process.env.BPA_INVENTORY_SOCKET }
              : {})
          }
        },
        expectedCodeDigest: TEAM_WORKER_CODE_DIGEST,
        expectedHandlerRefs: TEAM_WORKER_HANDLER_REFS
      });
    }
    this.ir2Runtime = new Ir2WorkflowRuntime(persistence, providers, {
      resolveResourceBindingSnapshot: (runId) =>
        persistence.getRunResourceBindingSnapshot(runId),
      browserSessions: {
        getBrowserSession: (binding) =>
          this.#resourceBindings.resolveBrowserBinding(binding)
      }
    });
    const assistanceValidator: AssistanceResultValidator = {
      validateOutput(schema, output) {
        try {
          const validate = compileDataValidator(schema);
          return validate(output)
            ? { valid: true, errors: [] }
            : {
                valid: false,
                errors: formatValidationErrors(validate.errors)
              };
        } catch (error) {
          return {
            valid: false,
            errors: [
              `Output Schema cannot be compiled: ${
                error instanceof Error ? error.message : String(error)
              }`
            ]
          };
        }
      },
      validateDeterministicResult(task, output) {
        const reference = task.policySnapshot.deterministicValidator;
        const key = reference
          ? `${reference.id}@${reference.version}#${reference.digest}`
          : "";
        const packagingKey =
          `${PACKAGING_MATCH_REVIEW_VALIDATOR_REF.id}` +
          `@${PACKAGING_MATCH_REVIEW_VALIDATOR_REF.version}` +
          `#${PACKAGING_MATCH_REVIEW_VALIDATOR_REF.digest}`;
        if (key === packagingKey) {
          return validatePackagingMatchReviewResult(task, output);
        }
        return {
          valid: false,
          errors: ["No exact audited deterministic validator is registered"]
        };
      }
    };
    this.assistance = new AssistanceTaskService({
      queue: new PersistenceTaskQueue(persistence, this.ir2Runtime),
      validator: assistanceValidator,
      profilePublished: (profile) => {
        const published =
          persistence.getPublished(
            "assistance_profile",
            profile.id,
            profile.version
          ) ??
          persistence.getPublished("policy", profile.id, profile.version);
        return published?.digest === profile.digest;
      }
    });
    const candidateArchives = candidateArchiveDataDirectory
      ? new LocalCandidateArchiveService(
          persistence,
          candidateArchiveDataDirectory
        )
      : undefined;
    this.candidateArchives = candidateArchives;
    this.authoring = new LocalAuthoringService(
      persistence,
      candidateArchives
        ? (storageRef) =>
            candidateArchives.readAsset(storageRef)
        : undefined,
      candidateArchives
        ? (input) =>
            candidateArchives.storeCandidateFile(input)
        : undefined
    );
  }

  handle(request: ControlRequest): ControlResponse {
    try {
      const result = this.#dispatch(request.method, request.params ?? {});
      return { id: request.id, ok: true, result };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          code:
            error instanceof Error && error.name
              ? error.name.toUpperCase()
              : "CORE_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async handleAsync(request: ControlRequest): Promise<ControlResponse> {
    if (
      !request.method.startsWith("assistance.task.") &&
      request.method !== "dataset.import" &&
      request.method !== "dataset.import.staged"
    ) {
      return this.handle(request);
    }
    try {
      const params = request.params ?? {};
      const result =
        request.method === "dataset.import"
          ? await this.datasets.import({
              path: String(params.path),
              id: String(params.id),
              version: String(params.version),
              actor: String(params.actor || userInfo().username),
              ...(params.title === undefined
                ? {}
                : { title: String(params.title) })
            })
          : request.method === "dataset.import.staged"
            ? await this.#importStagedDataset(params)
          : await this.#dispatchAssistance(request, params);
      return { id: request.id, ok: true, result };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          code:
            error instanceof Error && error.name
              ? error.name.toUpperCase()
              : "CORE_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async #importStagedDataset(
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.stagingTransfers) {
      throw new Error("Staging transfer service is unavailable");
    }
    const upload = this.stagingTransfers.resolveDatasetUpload({
      leaseId: String(params.leaseId),
      digest: String(params.digest)
    });
    return this.datasets.importBytes({
      bytes: upload.bytes,
      fileName: upload.fileName,
      id: String(params.id),
      version: String(params.version),
      actor: String(params.actor || userInfo().username),
      ...(params.title === undefined
        ? {}
        : { title: String(params.title) })
    });
  }

  async #dispatchAssistance(
    request: ControlRequest,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const requestId = String(params.operationId ?? request.id);
    const now = new Date().toISOString();
    switch (request.method) {
      case "assistance.task.list":
        return this.assistance.list({
          ...(Array.isArray(params.statuses)
            ? {
                statuses: params.statuses.map(String) as NonNullable<
                  TaskQueueFilter["statuses"]
                >
              }
            : {}),
          ...(Array.isArray(params.modes)
            ? {
                modes: params.modes.map(String) as NonNullable<
                  TaskQueueFilter["modes"]
                >
              }
            : {}),
          ...(params.ownerType === "ai" || params.ownerType === "human"
            ? { ownerType: params.ownerType }
            : {}),
          ...(params.limit === undefined
            ? {}
            : { limit: Number(params.limit) })
        });
      case "assistance.task.claim":
        return this.assistance.claim({
          taskId: String(params.taskId),
          requestId,
          leaseId: String(params.leaseId),
          actorId: String(params.actorId),
          actorType: params.actorType === "human" ? "human" : "ai",
          now,
          leaseDurationMs: Number(params.leaseDurationMs)
        });
      case "assistance.task.start":
        return this.assistance.start({
          taskId: String(params.taskId),
          requestId,
          proof: {
            leaseId: String(params.leaseId),
            ownerId: String(params.actorId),
            fencingToken: Number(params.fencingToken)
          },
          now
        });
      case "assistance.task.heartbeat":
        return this.assistance.heartbeat({
          taskId: String(params.taskId),
          requestId,
          proof: {
            leaseId: String(params.leaseId),
            ownerId: String(params.actorId),
            fencingToken: Number(params.fencingToken)
          },
          now,
          leaseDurationMs: Number(params.leaseDurationMs)
        });
      case "assistance.task.release":
        return this.assistance.release({
          taskId: String(params.taskId),
          requestId,
          proof: {
            leaseId: String(params.leaseId),
            ownerId: String(params.actorId),
            fencingToken: Number(params.fencingToken)
          },
          now
        });
      case "assistance.task.submit": {
        const resolverType =
          params.resolverType === "human" ||
          params.resolverType === "human_ai"
            ? params.resolverType
            : "ai";
        return this.assistance.submit({
          taskId: String(params.taskId),
          requestId,
          proof: {
            leaseId: String(params.leaseId),
            ownerId: String(params.actorId),
            fencingToken: Number(params.fencingToken)
          },
          now,
          output: params.output,
          resolverType,
          resolverId: String(params.actorId),
          ...(params.provider === undefined
            ? {}
            : { provider: String(params.provider) }),
          ...(params.model === undefined
            ? {}
            : { model: String(params.model) }),
          ...(params.confidence === undefined
            ? {}
            : { confidence: Number(params.confidence) })
        });
      }
      default:
        throw new Error(`Unknown control method: ${request.method}`);
    }
  }

  #dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "doctor":
        return {
          status: "ok",
          persistence: this.persistence.health(),
          protocol: "bpa.browser/2",
          browser: this.browserGateway?.status() ?? {
            connected: false,
            ready: false
          },
          pid: process.pid
        };
      case "catalog.list":
        return this.persistence.listPublished(
          params.assetType as ArtifactType | undefined
        );
      case "catalog.search.v2":
        return this.authoring.catalogSearch({
          ...(params.query === undefined
            ? {}
            : { query: String(params.query) }),
          ...(params.assetType === undefined
            ? {}
            : { assetType: String(params.assetType) }),
          ...(Array.isArray(params.capabilityIds)
            ? { capabilityIds: params.capabilityIds.map(String) }
            : {}),
          ...(params.platform === undefined
            ? {}
            : { platform: String(params.platform) }),
          ...(params.runtime === undefined
            ? {}
            : {
                runtime: params.runtime as
                  | "builtin"
                  | "browser"
                  | "team"
                  | "assistance"
                  | "composite"
              }),
          ...(Array.isArray(params.availableInputTypes)
            ? {
                availableInputTypes:
                  params.availableInputTypes.map(String)
              }
            : {}),
          ...(Array.isArray(params.requiredOutputTypes)
            ? {
                requiredOutputTypes:
                  params.requiredOutputTypes.map(String)
              }
            : {}),
          ...(params.maximumRisk === undefined
            ? {}
            : {
                maximumRisk: params.maximumRisk as
                  | "R0"
                  | "R1"
                  | "R2"
                  | "R3"
                  | "R4"
              }),
          ...(Array.isArray(params.allowedPermissions)
            ? {
                allowedPermissions:
                  params.allowedPermissions.map(String)
              }
            : {}),
          ...(params.adapter &&
          typeof params.adapter === "object" &&
          !Array.isArray(params.adapter)
            ? {
                adapter: {
                  id: String(
                    (params.adapter as Record<string, unknown>).id
                  ),
                  version: String(
                    (params.adapter as Record<string, unknown>).version
                  )
                }
              }
            : {}),
          ...(params.limit === undefined
            ? {}
            : { limit: Number(params.limit) })
        });
      case "authoring.workflow-draft.create":
        return this.authoring.drafts.create({
          draftId: String(params.id ?? params.draftId),
          title: String(params.title),
          description: String(params.description),
          now: new Date().toISOString()
        });
      case "authoring.workflow-draft.get": {
        const draftId = String(params.draftId);
        const draft = this.authoring.drafts.get(draftId);
        if (!draft) throw new Error(`Workflow Draft not found: ${draftId}`);
        return draft;
      }
      case "authoring.workflow-draft.apply":
        return this.authoring.drafts.apply(
          String(params.draftId),
          Number(params.expectedRevision),
          params.operation as DraftOperation,
          new Date().toISOString()
        );
      case "authoring.workflow-draft.diff":
        return this.authoring.diff(
          String(params.draftId),
          Number(params.fromRevision),
          Number(params.toRevision),
          Number(params.limit ?? 200)
        );
      case "authoring.workflow-draft.validate-candidate":
        return this.authoring.validate(
          String(params.draftId),
          Number(params.expectedRevision)
        );
      case "authoring.workflow-candidate.save":
        return this.authoring.saveCandidate({
          draftId: String(params.draftId),
          expectedRevision: Number(params.expectedRevision),
          candidateId: String(params.candidateId),
          now: new Date().toISOString()
        });
      case "authoring.session.create":
        return this.authoring.createSession({
          sessionId: String(params.sessionId),
          scenario: params.scenario as ScenarioSpecDefinition,
          actor: params.actor as AuthoringSessionDefinition["actor"],
          now: String(params.occurredAt ?? new Date().toISOString())
        });
      case "authoring.session.get":
        return this.authoring.getSession(String(params.sessionId));
      case "authoring.session.apply":
        return this.authoring.applySession({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          operation: params.operation as AuthoringSessionOperation,
          actor: String(params.actor),
          occurredAt: String(params.occurredAt)
        });
      case "authoring.design-mode.request":
        return this.authoring.requestDesignMode({
          grantId: String(params.grantId),
          authoringSessionId: String(params.authoringSessionId),
          approvedBy: String(params.approvedBy),
          browserSessionId: String(params.browserSessionId),
          profileId: String(params.profileId),
          tabId: Number(params.tabId),
          origin: String(params.origin),
          pageEpoch: String(params.pageEpoch),
          screenshotApproved: params.screenshotApproved === true,
          issuedAt: String(params.issuedAt),
          expiresAt: String(params.expiresAt)
        });
      case "authoring.design-mode.get":
        return this.authoring.getDesignMode(String(params.grantId));
      case "authoring.design-mode.activate":
        return this.authoring.activateDesignMode({
          grantId: String(params.grantId),
          expectedRevision: Number(params.expectedRevision),
          actor: String(params.actor),
          occurredAt: String(params.occurredAt)
        });
      case "authoring.design-mode.stop":
        return this.authoring.stopDesignMode({
          grantId: String(params.grantId),
          expectedRevision: Number(params.expectedRevision),
          actor: String(params.actor),
          occurredAt: String(params.occurredAt),
          ...(params.reason === undefined
            ? {}
            : { reason: String(params.reason) })
        });
      case "authoring.snapshot.attach":
        return this.authoring.attachSnapshot({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          operationId: String(params.operationId),
          actor: String(params.actor),
          occurredAt: String(params.occurredAt),
          snapshot: params.snapshot as PageSnapshotDefinition
        });
      case "authoring.snapshot.complete":
        return this.authoring.completeSnapshot({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          operationId: String(params.operationId),
          actor: String(params.actor),
          occurredAt: String(params.occurredAt),
          runId: String(params.runId),
          snapshotId: String(params.snapshotId)
        });
      case "authoring.snapshot.query":
        return this.authoring.querySnapshot({
          snapshotId: String(params.snapshotId),
          ...(params.offset === undefined
            ? {}
            : { offset: Number(params.offset) }),
          ...(params.limit === undefined
            ? {}
            : { limit: Number(params.limit) }),
          ...(params.role === undefined
            ? {}
            : { role: String(params.role) }),
          ...(params.text === undefined
            ? {}
            : { text: String(params.text) })
        });
      case "authoring.page-candidate.validate":
        return this.authoring.validatePageCandidate({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          candidate: params.candidate as PageAssetCandidate
        });
      case "authoring.page-candidate.save":
        return this.authoring.savePageCandidate({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          actor: String(params.actor),
          candidate: params.candidate as PageAssetCandidate
        });
      case "authoring.candidate-bundle.validate":
        return this.authoring.validateCandidateBundle({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          bundle: params.bundle as CandidateBundleDefinition
        });
      case "authoring.candidate-bundle.save":
        return this.authoring.saveCandidateBundle({
          sessionId: String(params.sessionId),
          expectedRevision: Number(params.expectedRevision),
          operationId: String(params.operationId),
          actor: String(params.actor),
          occurredAt: String(params.occurredAt),
          bundle: params.bundle as CandidateBundleDefinition
        });
      case "authoring.candidate-bundle.get":
        return this.authoring.getCandidateBundle(String(params.bundleId));
      case "authoring.candidate-bundle.inspect":
        return this.#candidateArchives().inspect(
          String(params.bundleId)
        );
      case "authoring.candidate-bundle.export":
        return this.#candidateArchives().export({
          bundleId: String(params.bundleId),
          actor: String(params.actor),
          occurredAt: String(
            params.occurredAt ?? new Date().toISOString()
          )
        });
      case "dataset.inspect":
        return this.datasets.get(String(params.id), String(params.version));
      case "dataset.read":
        return this.datasets.readPage({
          id: String(params.id),
          version: String(params.version),
          ...(params.afterRecordKey === undefined
            ? {}
            : { afterRecordKey: String(params.afterRecordKey) }),
          ...(params.limit === undefined
            ? {}
            : { limit: Number(params.limit) })
        });
      case "audit.list":
        return this.persistence.listAudit(
          params.target == null ? undefined : String(params.target)
        );
      case "trigger.put": {
        if (!validateTriggerSpec(params.spec)) {
          throw new Error(
            `TriggerSpec is invalid: ${formatValidationErrors(validateTriggerSpec.errors).join("; ")}`
          );
        }
        const spec = params.spec as TriggerSpecDefinition;
        if (!this.persistence.getPublished("workflow",spec.workflow.id,spec.workflow.version)) {
          throw new Error(
            `Published workflow not found: ${spec.workflow.id}@${spec.workflow.version}`
          );
        }
        return this.persistence.putTriggerSpec({
          spec,actor:String(params.actor || userInfo().username),
          occurredAt:new Date().toISOString()
        });
      }
      case "trigger.list":
        return this.persistence.listTriggerSpecs();
      case "trigger.runs":
        return this.persistence.listTriggerRuns(
          params.triggerId === undefined ? undefined : String(params.triggerId)
        );
      case "trigger.enable":
        return this.persistence.setTriggerEnabled({
          id:String(params.id),expectedRevision:Number(params.expectedRevision),
          enabled:params.enabled === true,
          actor:String(params.actor || userInfo().username),
          occurredAt:new Date().toISOString()
        });
      case "trigger.fire": {
        const trigger = this.persistence.getTriggerSpec(String(params.id));
        if (!trigger) throw new Error(`Trigger not found: ${String(params.id)}`);
        if (!trigger.spec.enabled) throw new Error("TRIGGER_DISABLED");
        if (trigger.spec.kind !== "manual") {
          throw new Error("Only Manual Triggers accept an explicit fire request");
        }
        const requestKey = String(params.requestKey ?? "").trim();
        if (!requestKey) throw new Error("Manual Trigger requires requestKey");
        return this.triggers.fire({ trigger,occurrenceKey:`manual:${requestKey}` });
      }
      case "browser.control-lease.acquire":
        return this.persistence.acquireBrowserControlLease({
          resourceId:String(params.resourceId),ownerId:String(params.ownerId),
          now:new Date().toISOString(),ttlSeconds:Number(params.ttlSeconds ?? 120)
        });
      case "browser.control-lease.renew":
        return this.persistence.renewBrowserControlLease({
          resourceId:String(params.resourceId),ownerId:String(params.ownerId),
          fencingToken:Number(params.fencingToken),now:new Date().toISOString(),
          ttlSeconds:Number(params.ttlSeconds ?? 120)
        });
      case "browser.control-lease.release":
        return {
          released:this.persistence.releaseBrowserControlLease({
            resourceId:String(params.resourceId),ownerId:String(params.ownerId),
            fencingToken:Number(params.fencingToken),releasedAt:new Date().toISOString()
          })
        };
      case "browser.control-lease.list":
        return this.persistence.listBrowserControlLeases(new Date().toISOString());
      case "browser.session.list":
        return this.persistence.listBrowserSessions({
          limit: Math.min(
            200,
            Math.max(1, Number(params.limit) || 100)
          )
        }).records.map((session) => ({
          ...session,
          capabilities: this.persistence
            .listBrowserCapabilities(session.id)
            .map((capability) => ({
              nodeId: capability.nodeId,
              nodeVersion: capability.nodeVersion,
              permissions: capability.permissions
            }))
        }));
      case "browser.page-observation.list":
        {
          const pages = this.persistence.listBrowserPageObservations({
            limit: Math.min(200, Math.max(1, Number(params.limit) || 200)),
            ...(params.sessionId === undefined
              ? {}
              : { sessionId: String(params.sessionId) }),
            ...(params.browserInstanceId === undefined
              ? {}
              : { browserInstanceId: String(params.browserInstanceId) })
          });
          if (params.includeDisconnected === true) return pages;
          return pages.filter((page) => {
            const session = this.persistence.getBrowserSession(page.sessionId);
            return session !== undefined && !session.disconnectedAt;
          });
        }
      case "browser.page-observation.probe":
        if (!this.browserGateway) {
          throw new Error("BROWSER_BRIDGE_DISCONNECTED");
        }
        return this.browserGateway.requestPageProbe({
          sessionId: String(params.sessionId),
          browserInstanceId: String(params.browserInstanceId),
          tabId: Number(params.tabId),
          ...(params.windowId === undefined
            ? {}
            : { windowId: Number(params.windowId) }),
          origin: String(params.origin),
          ...(params.timeoutMs === undefined
            ? {}
            : { timeoutMs: Number(params.timeoutMs) })
        });
      case "browser.resource-binding.resolve":
        return this.#resolveWorkflowResources(
          String(params.workflowId),
          String(params.workflowVersion),
          params.browserInstanceId === undefined
            ? undefined
            : String(params.browserInstanceId)
        );
      case "staging.lease.create":
        if (!this.stagingTransfers) {
          throw new Error("Staging transfer service is unavailable");
        }
        return this.stagingTransfers.issue(
          params as unknown as StagingLeaseRequest
        );
      case "evidence.lineage.get":
        return this.#trustedEvidence.lineage(String(params.runId));
      case "download.list":
        return this.#trustedEvidence.listDownloads(
          params.runId === undefined ? undefined : String(params.runId)
        );
      case "download.get":
        return this.#trustedEvidence.download(String(params.downloadId));
      case "asset.validate":
        return this.#validateAsset(
          String(params.assetType),
          params.content
        );
      case "asset.publish":
        return this.#publishAsset(
          String(params.assetType),
          params.content,
          String(params.actor || userInfo().username)
        );
      case "asset.candidate":
        return this.#saveCandidate(
          String(params.assetType),
          params.content,
          String(params.actor || userInfo().username)
        );
      case "run.create":
        this.#assertRuntimeAvailable();
        return this.#createRun(
          String(params.workflowId),
          String(params.workflowVersion),
          params.input ?? {},
          params.resourceBindings,
          String(params.actor || userInfo().username)
        );
      case "run.node.preview":
        return this.#previewSingleNode(
          String(params.nodeId),
          String(params.nodeVersion),
          params.input ?? {}
        );
      case "run.node.create":
        this.#assertRuntimeAvailable();
        return this.#createSingleNodeRun({
          nodeId: String(params.nodeId),
          nodeVersion: String(params.nodeVersion),
          input: params.input ?? {},
          expectedPreviewDigest: String(params.expectedPreviewDigest),
          confirmed: params.confirmed === true,
          actor: String(params.actor || userInfo().username),
          resourceBindings: params.resourceBindings
        });
      case "run.inspect": {
        const runId = String(params.runId);
        const run = this.persistence.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        return run;
      }
      case "run.events":
        return this.persistence.listEvents(String(params.runId));
      case "run.human.complete":
        this.#assertRuntimeAvailable();
        return this.#completeHumanStep(
          String(params.nodeExecutionId),
          params.approved === true,
          params.output
        );
      case "run.cancel":
        {
          this.#assertRuntimeAvailable();
          const runId = String(params.runId);
          const actor = String(params.actor || userInfo().username);
          if (
            this.persistence.getRunPlanSnapshot(runId) &&
            this.persistence.getEngineCheckpoint(runId)
          ) {
            return this.ir2Runtime.cancel(runId, actor).run;
          }
          const run = this.persistence.requestCancel(
            runId,
            actor
          );
          this.browserGateway?.requestCancel(runId);
          return this.persistence.getRun(runId) ?? run;
        }
      default:
        throw new Error(`Unknown control method: ${method}`);
    }
  }

  #candidateArchives(): LocalCandidateArchiveService {
    if (!this.candidateArchives) {
      throw new Error(
        "Candidate archive service is unavailable in this Core process"
      );
    }
    return this.candidateArchives;
  }

  #validateAsset(assetType: string, content: unknown): unknown {
    if (assetType === "node") {
      const isV1Alpha2 =
        content !== null &&
        typeof content === "object" &&
        (content as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha2";
      const validatePublishedNode = isV1Alpha2
        ? validateNodeV1Alpha2
        : validateNode;
      if (!validatePublishedNode(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validatePublishedNode.errors)
        };
      }
      const node = content as PublishedNodeDefinition;
      const schemaErrors: string[] = [];
      for (const [name, schema] of [
        ["inputSchema", node.inputSchema],
        ["outputSchema", node.outputSchema],
        ...(node.configSchema
          ? ([["configSchema", node.configSchema]] as const)
          : [])
      ] as const) {
        const schemaValidation = validateJsonSchemaDefinition(schema);
        if (!schemaValidation.valid) {
          schemaErrors.push(
            ...schemaValidation.errors.map(
              (issue) => `/${name}${issue}`
            )
          );
          continue;
        }
        try {
          compileDataValidator(schema);
        } catch (error) {
          schemaErrors.push(
            `/${name} cannot be compiled: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (schemaErrors.length > 0) {
        return { valid: false, errors: schemaErrors };
      }
      return {
        valid: true,
        digest: contentDigest(node),
        identity: `${node.metadata.id}@${node.metadata.version}`
      };
    }
    if (assetType === "workflow") {
      const apiVersion =
        content !== null &&
        typeof content === "object" &&
        typeof (content as { apiVersion?: unknown }).apiVersion === "string"
          ? (content as { apiVersion: string }).apiVersion
          : undefined;
      const isCanonical =
        apiVersion === "bpa/v1alpha2" || apiVersion === "bpa/v1alpha3";
      if (
        apiVersion === "bpa/v1alpha3" &&
        !validateWorkflowV1Alpha3(content)
      ) {
        return {
          valid: false,
          errors: formatValidationErrors(validateWorkflowV1Alpha3.errors)
        };
      }
      if (!isCanonical && !validateWorkflow(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateWorkflow.errors)
        };
      }
      const compiled = isCanonical
        ? compileCanonicalWorkflow(content, this.#ir2Catalog())
        : compileWorkflow(content, this.#nodeCatalog());
      return {
        valid: true,
        digest:
          "workflowDigest" in compiled
            ? compiled.workflowDigest
            : compiled.workflow.digest,
        identity:
          "workflowId" in compiled
            ? `${compiled.workflowId}@${compiled.workflowVersion}`
            : `${compiled.workflow.id}@${compiled.workflow.version}`,
        compiled
      };
    }
    if (assetType === "adapter") {
      if (!validateAdapterManifest(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateAdapterManifest.errors)
        };
      }
      const issues = this.#adapterManifestIssues(content);
      return issues.length > 0
        ? { valid: false, errors: issues }
        : {
            valid: true,
            digest: contentDigest(content),
            identity: `${content.metadata.id}@${content.metadata.version}`
          };
    }
    if (assetType === "assistance_profile") {
      if (!validateAssistanceProfile(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateAssistanceProfile.errors)
        };
      }
      const issues: string[] = [];
      const schemaValidation = validateJsonSchemaDefinition(
        content.outputSchema
      );
      if (!schemaValidation.valid) {
        issues.push(
          ...schemaValidation.errors.map(
            (issue) => `/outputSchema${issue}`
          )
        );
      } else {
        try {
          compileDataValidator(content.outputSchema);
        } catch (error) {
          issues.push(
            `/outputSchema cannot be compiled: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (
        content.taskKind !== "ai_review" &&
        content.policySnapshot.autoContinue
      ) {
        issues.push("Human assistance Profiles cannot auto-continue");
      }
      if (
        content.riskLevel === "R1" &&
        content.policySnapshot.autoContinue &&
        !content.policySnapshot.deterministicValidator
      ) {
        issues.push(
          "R1 automatic continuation requires a deterministic validator"
        );
      }
      const validatorRef =
        content.policySnapshot.deterministicValidator;
      if (validatorRef) {
        const validator = this.persistence.getPublished(
          "policy",
          validatorRef.id,
          validatorRef.version
        );
        if (!validator || validator.digest !== validatorRef.digest) {
          issues.push(
            "Deterministic validator must reference an exact published Policy"
          );
        }
      }
      return issues.length > 0
        ? { valid: false, errors: issues }
        : {
            valid: true,
            digest: contentDigest(content),
            identity: `${content.metadata.id}@${content.metadata.version}`
          };
    }
    if (assetType === "element_contract") {
      if (!validateElementContract(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateElementContract.errors)
        };
      }
      const issues = validateElementContractDefinition(content);
      return issues.length > 0
        ? {
            valid: false,
            errors: issues.map(
              (issue) => `${issue.path} ${issue.code}: ${issue.message}`
            )
          }
        : {
            valid: true,
            digest: contentDigest(content),
            identity: `${content.metadata.id}@${content.metadata.version}`
          };
    }
    if (assetType === "page_model") {
      if (!validatePageModel(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validatePageModel.errors)
        };
      }
      const issues = validatePageModelDefinition(content);
      const adapter = this.persistence.getPublished(
        "adapter",
        content.adapter.id,
        content.adapter.version
      );
      if (!adapter || adapter.digest !== content.adapter.digest) {
        issues.push({
          code: "INVALID_IDENTITY",
          path: "/adapter",
          message: "PageModel must pin an exact published Adapter"
        });
      }
      for (const [index, element] of content.elements.entries()) {
        const contract = this.persistence.getPublished(
          "element_contract",
          element.contract.id,
          element.contract.version
        );
        if (!contract || contract.digest !== element.contract.digest) {
          issues.push({
            code: "INVALID_IDENTITY",
            path: `/elements/${index}/contract`,
            message: "PageModel must pin exact published ElementContracts"
          });
        }
      }
      return issues.length > 0
        ? {
            valid: false,
            errors: issues.map(
              (issue) => `${issue.path} ${issue.code}: ${issue.message}`
            )
          }
        : {
            valid: true,
            digest: contentDigest(content),
            identity: `${content.metadata.id}@${content.metadata.version}`
          };
    }
    if (assetType === "policy") {
      if (!validateDeterministicResultValidatorPolicy(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(
            validateDeterministicResultValidatorPolicy.errors
          )
        };
      }
      return {
        valid: true,
        digest: contentDigest(content),
        identity: `${content.metadata.id}@${content.metadata.version}`
      };
    }
    throw new Error(`Unsupported asset type: ${assetType}`);
  }

  #adapterManifestIssues(
    manifest: AdapterManifestDefinition
  ): string[] {
    const issues: string[] = [];
    const identities = new Set<string>();
    const origins = new Set(manifest.origins);
    for (const capability of manifest.capabilities) {
      for (const version of capability.nodeVersions) {
        const identity = `${capability.nodeId}@${version}`;
        if (identities.has(identity)) {
          issues.push(`Duplicate Adapter capability: ${identity}`);
          continue;
        }
        identities.add(identity);
        const published = this.persistence.getPublished(
          "node",
          capability.nodeId,
          version
        );
        const node = published?.content as
          | PublishedNodeDefinition
          | undefined;
        if (!node || node.runtime !== "browser") {
          issues.push(`Published Browser Node is missing: ${identity}`);
          continue;
        }
        if (
          node.adapter?.id !== manifest.metadata.id ||
          !node.adapter.versions.includes(manifest.metadata.version)
        ) {
          issues.push(
            `Browser Node ${identity} does not pin Adapter ${manifest.metadata.id}@${manifest.metadata.version}`
          );
        }
        const expectedPermissions = [...node.risk.permissions].sort();
        const reportedPermissions = [...capability.permissions].sort();
        if (
          JSON.stringify(expectedPermissions) !==
          JSON.stringify(reportedPermissions)
        ) {
          issues.push(
            `Adapter capability permissions differ from Node ${identity}`
          );
        }
        for (const origin of node.risk.domains ?? []) {
          if (!origins.has(origin)) {
            issues.push(
              `Adapter origin allowlist is missing ${origin} for ${identity}`
            );
          }
        }
      }
    }
    return issues;
  }

  #publishAsset(
    assetType: string,
    content: unknown,
    actor: string
  ): unknown {
    const validation = this.#validateAsset(assetType, content) as {
      valid: boolean;
      errors?: string[];
      digest?: string;
    };
    if (!validation.valid || !validation.digest) {
      throw new Error(
        `Asset validation failed: ${(validation.errors ?? []).join("; ")}`
      );
    }
    const typed = content as {
      metadata: { id: string; version: string };
    };
    const input = {
      assetType: assetType as ArtifactType,
      assetId: typed.metadata.id,
      version: typed.metadata.version,
      digest: validation.digest,
      content,
      actor
    };
    this.persistence.saveCandidate(input);
    return this.persistence.publish(input);
  }

  #saveCandidate(
    assetType: string,
    content: unknown,
    actor: string
  ): unknown {
    if (
      assetType === "workflow" ||
      assetType === "node" ||
      assetType === "adapter" ||
      assetType === "assistance_profile" ||
      assetType === "policy" ||
      assetType === "element_contract" ||
      assetType === "page_model"
    ) {
      const validation = this.#validateAsset(assetType, content) as {
        valid: boolean;
        errors?: string[];
        digest?: string;
      };
      if (!validation.valid || !validation.digest) {
        throw new Error(
          `Asset validation failed: ${(validation.errors ?? []).join("; ")}`
        );
      }
      const typed = content as
        | NodeDefinition
        | NodeDefinitionV1Alpha2
        | WorkflowDefinition
        | WorkflowDefinitionV1Alpha2
        | WorkflowDefinitionV1Alpha3
        | AdapterManifestDefinition
        | AssistanceProfileDefinition
        | DeterministicResultValidatorPolicyDefinition
        | ElementContractDefinition
        | PageModelDefinition;
      return this.persistence.saveCandidate({
        assetType,
        assetId: typed.metadata.id,
        version: typed.metadata.version,
        digest: validation.digest,
        content,
        actor
      });
    }
    throw new Error(`Unsupported candidate type: ${assetType}`);
  }

  #createRun(
    workflowId: string,
    workflowVersion: string,
    input: unknown,
    resourceBindings: unknown,
    actor: string
  ): unknown {
    const artifact = this.persistence.getPublished(
      "workflow",
      workflowId,
      workflowVersion
    );
    if (!artifact) {
      throw new Error(
        `Published workflow not found: ${workflowId}@${workflowVersion}`
      );
    }
    const safeInput = JSON.parse(JSON.stringify(input)) as JsonValue;
    const workflowInputSchema = (
      artifact.content as {
        spec?: { inputSchema?: Record<string, unknown> };
      }
    ).spec?.inputSchema;
    if (!workflowInputSchema) {
      throw new Error("Published Workflow has no frozen input Schema");
    }
    const validateInput = compileDataValidator(workflowInputSchema);
    if (!validateInput(safeInput)) {
      throw new Error(
        `Workflow input is invalid: ${formatValidationErrors(
          validateInput.errors
        ).join("; ")}`
      );
    }
    const isCanonical =
      artifact.content !== null &&
      typeof artifact.content === "object" &&
      ["bpa/v1alpha2", "bpa/v1alpha3"].includes(
        String((artifact.content as { apiVersion?: unknown }).apiVersion)
      );
    if (isCanonical) {
      const plan = compileCanonicalWorkflow(
        artifact.content,
        this.#ir2Catalog()
      );
      const bindResources = this.#resourceBindings.prepare(
        plan,
        resourceBindings,
        actor
      );
      return this.ir2Runtime.start(
        plan,
        safeInput,
        {
          actor,
          resourceSlots: Object.keys(plan.resourceSlots ?? {}).sort()
        },
        bindResources
      );
    }
    if (
      resourceBindings !== undefined &&
      resourceBindings !== null &&
      (typeof resourceBindings !== "object" ||
        Array.isArray(resourceBindings) ||
        Object.keys(resourceBindings).length > 0)
    ) {
      throw new Error(
        "Legacy Workflows do not accept Browser Resource Bindings"
      );
    }
    const compiled = compileWorkflow(artifact.content, this.#nodeCatalog());
    const run = this.engine.start(compiled, safeInput);
    this.browserGateway?.dispatchPending();
    return run;
  }

  #assertRuntimeAvailable(): void {
    if (
      this.runtimeMaintenancePath &&
      existsSync(this.runtimeMaintenancePath)
    ) {
      throw new Error("BPA_RUNTIME_MAINTENANCE");
    }
  }

  #resolveWorkflowResources(
    workflowId: string,
    workflowVersion: string,
    browserInstanceId?: string
  ): unknown {
    const artifact = this.persistence.getPublished(
      "workflow",
      workflowId,
      workflowVersion
    );
    if (!artifact) {
      throw new Error(
        `Published workflow not found: ${workflowId}@${workflowVersion}`
      );
    }
    if (
      artifact.content === null ||
      typeof artifact.content !== "object" ||
      !["bpa/v1alpha2", "bpa/v1alpha3"].includes(
        String((artifact.content as { apiVersion?: unknown }).apiVersion)
      )
    ) {
      throw new Error("BROWSER_RESOURCE_RESOLUTION_REQUIRES_IR2");
    }
    const plan = compileCanonicalWorkflow(
      artifact.content,
      this.#ir2Catalog()
    );
    return this.#resourceBindings.resolveForPlan(
      plan,
      browserInstanceId
    );
  }

  #singleNodePlan(
    nodeId: string,
    nodeVersion: string,
    input: unknown
  ): {
    node: PublishedNodeDefinition;
    input: JsonValue;
    plan: ReturnType<typeof compileCanonicalWorkflow>;
    previewDigest: string;
  } {
    const artifact = this.persistence.getPublished(
      "node",
      nodeId,
      nodeVersion
    );
    if (!artifact) {
      throw new Error(`Published Node not found: ${nodeId}@${nodeVersion}`);
    }
    const node = artifact.content as PublishedNodeDefinition;
    if (
      node.risk.level === "R2" ||
      node.risk.level === "R3" ||
      node.risk.level === "R4"
    ) {
      throw new Error(
        "SingleNodeRun is limited to R0/R1; use a published Workflow with the formal approval path for R2+"
      );
    }
    const safeInput = JSON.parse(JSON.stringify(input)) as JsonValue;
    const validateInput = compileDataValidator(node.inputSchema);
    if (!validateInput(safeInput)) {
      throw new Error(
        `SingleNodeRun input is invalid: ${formatValidationErrors(
          validateInput.errors
        ).join("; ")}`
      );
    }
    const identityDigest = contentDigest({
      node: {
        id: node.metadata.id,
        version: node.metadata.version,
        digest: artifact.digest
      },
      input: safeInput
    }).slice("sha256:".length, "sha256:".length + 32);
    const resourceSlots =
      node.apiVersion === "bpa/v1alpha2" && node.resources
        ? Object.fromEntries(
            Object.entries(node.resources).map(
              ([name, requirement]) => [
                name,
                structuredClone(requirement)
              ]
            )
          )
        : undefined;
    const workflow:
      | WorkflowDefinitionV1Alpha2
      | WorkflowDefinitionV1Alpha3 = {
      apiVersion: resourceSlots ? "bpa/v1alpha3" : "bpa/v1alpha2",
      kind: "Workflow",
      metadata: {
        id: `single-node.${identityDigest}`,
        version: "1.0.0",
        title: `Single Node: ${node.metadata.title}`,
        description:
          "Core-generated bounded wrapper for one exact published Node."
      },
      spec: {
        riskLevel: node.risk.level,
        inputSchema: node.inputSchema,
        outputSchema: node.outputSchema,
        // The compiler closes every call outcome with deterministic fallback
        // terminals, so the bounded wrapper contains more than its two authored
        // steps even though only one Node invocation can occur.
        limits: { maxDepth: 1, maxStepExecutions: 8 },
        ...(resourceSlots ? { resourceSlots } : {}),
        root: {
          kind: "sequence",
          steps: [
            {
              key: "invoke",
              kind: "call",
              use: `${node.metadata.id}@${node.metadata.version}`,
              with: "${input}",
              ...(resourceSlots
                ? {
                    resourceMappings: Object.fromEntries(
                      Object.keys(resourceSlots).map((name) => [
                        name,
                        name
                      ])
                    )
                  }
                : {}),
              retry: { maxAttempts: 1 }
            },
            {
              key: "done",
              kind: "terminal",
              status: "succeeded",
              output: "${steps.invoke.output}"
            }
          ]
        }
      }
    };
    const plan = compileCanonicalWorkflow(workflow, this.#ir2Catalog());
    return {
      node,
      input: safeInput,
      plan,
      previewDigest: contentDigest({
        mode: "single_node",
        planDigest: contentDigest(plan),
        inputDigest: contentDigest(safeInput)
      })
    };
  }

  #previewSingleNode(
    nodeId: string,
    nodeVersion: string,
    input: unknown
  ): unknown {
    const prepared = this.#singleNodePlan(nodeId, nodeVersion, input);
    return {
      mode: "single_node",
      node: {
        id: prepared.node.metadata.id,
        version: prepared.node.metadata.version
      },
      riskLevel: prepared.node.risk.level,
      permissions: [...prepared.node.risk.permissions],
      domains: [...(prepared.node.risk.domains ?? [])],
      resourceSlots: prepared.plan.resourceSlots ?? {},
      artifactClosure: prepared.plan.artifactClosure,
      riskSnapshot: prepared.plan.riskSnapshot,
      previewDigest: prepared.previewDigest,
      requiresConfirmation: prepared.node.risk.level === "R1"
    };
  }

  #createSingleNodeRun(input: {
    nodeId: string;
    nodeVersion: string;
    input: unknown;
    expectedPreviewDigest: string;
    confirmed: boolean;
    actor: string;
    resourceBindings: unknown;
  }): unknown {
    const prepared = this.#singleNodePlan(
      input.nodeId,
      input.nodeVersion,
      input.input
    );
    if (input.expectedPreviewDigest !== prepared.previewDigest) {
      throw new Error(
        "SingleNodeRun preview is stale; inspect the exact Node, permissions, and input again"
      );
    }
    if (prepared.node.risk.level === "R1" && !input.confirmed) {
      throw new Error("R1 SingleNodeRun requires explicit human confirmation");
    }
    const bindResources = this.#resourceBindings.prepare(
      prepared.plan,
      input.resourceBindings,
      input.actor
    );
    return this.ir2Runtime.start(
      prepared.plan,
      prepared.input,
      {
        mode: "single_node",
        actor: input.actor,
        nodeId: prepared.node.metadata.id,
        nodeVersion: prepared.node.metadata.version,
        previewDigest: prepared.previewDigest,
        confirmed: input.confirmed,
        resourceSlots: Object.keys(
          prepared.plan.resourceSlots ?? {}
        ).sort()
      },
      bindResources
    );
  }

  #completeHumanStep(
    nodeExecutionId: string,
    approved: boolean,
    output: unknown
  ): unknown {
    const execution = this.persistence.getNodeExecution(nodeExecutionId);
    if (!execution) {
      throw new Error(`Node execution not found: ${nodeExecutionId}`);
    }
    const run = this.persistence.getRun(execution.runId);
    if (!run) throw new Error(`Run not found: ${execution.runId}`);
    if (run.status !== "waiting_human" || execution.status !== "accepted") {
      throw new Error("Human step is not waiting for a decision");
    }
    const artifact = this.persistence.getPublished(
      "workflow",
      run.workflowId,
      run.workflowVersion
    );
    if (!artifact) {
      throw new Error(
        `Published workflow not found: ${run.workflowId}@${run.workflowVersion}`
      );
    }
    return this.engine.acceptHumanResult(
      compileWorkflow(artifact.content, this.#nodeCatalog()),
      nodeExecutionId,
      approved,
      output
    );
  }

  #nodeCatalog(): MemoryNodeCatalog {
    return new MemoryNodeCatalog(
      this.persistence
        .listPublished("node")
        .filter(
          (artifact) =>
            (artifact.content as { apiVersion?: unknown }).apiVersion ===
            "bpa/v1alpha1"
        )
        .map((artifact) => artifact.content as NodeDefinition)
    );
  }

  #ir2Catalog(): CatalogResolver {
    const nodes = new Map(
      this.persistence.listPublished("node").map((artifact) => [
        `${artifact.assetId}@${artifact.version}`,
        artifact.content as PublishedNodeDefinition
      ])
    );
    const adapters = this.persistence.listPublished("adapter");
    const policies = this.persistence.listPublished("policy");
    const assistanceProfiles = this.persistence.listPublished(
      "assistance_profile"
    );
    return {
      getNode: (id, version) => nodes.get(`${id}@${version}`),
      getNodeExecution: (id, version) => {
        const definition = nodes.get(`${id}@${version}`);
        if (!definition) return undefined;
        const adapter = definition.adapter
          ? adapters
              .filter(
                (artifact) =>
                  artifact.assetId === definition.adapter?.id &&
                  definition.adapter.versions.includes(artifact.version)
              )
              .sort((left, right) =>
                right.version.localeCompare(left.version, undefined, {
                  numeric: true
                })
              )[0]
          : undefined;
        return {
          providerId:
            id === "dataset.records.read"
              ? "dataset"
              : definition.runtime.replace(/^engine_/, ""),
          adapters: adapter
            ? [
                {
                  kind: "adapter" as const,
                  id: adapter.assetId,
                  version: adapter.version,
                  digest: adapter.digest
                }
              ]
            : [],
          policies: [],
          datasetProfiles:
            id === "dataset.records.read"
              ? [
                  {
                    kind: "dataset_profile" as const,
                    id: PACKAGING_DATASET_PROFILE.id,
                    version: PACKAGING_DATASET_PROFILE.version,
                    digest: contentDigest(PACKAGING_DATASET_PROFILE)
                  }
                ]
              : []
        };
      },
      getAssistanceProfile: (id, version) => {
        const artifact = [...assistanceProfiles, ...policies].find(
          (candidate) =>
            candidate.assetId === id && candidate.version === version
        );
        if (!artifact) return undefined;
        const taskKind = (artifact.content as { taskKind?: unknown }).taskKind;
        if (
          taskKind !== "ai_review" &&
          taskKind !== "human_confirm" &&
          taskKind !== "human_action"
        ) {
          return undefined;
        }
        return {
          artifact: {
            kind: "assistance_profile",
            id,
            version,
            digest: artifact.digest
          },
          taskKind
        };
      }
    };
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > CONTROL_MAX_MESSAGE_BYTES) {
    throw new Error(`Control message exceeds ${CONTROL_MAX_MESSAGE_BYTES} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function attachFrameDecoder(
  socket: Socket,
  onMessage: (message: unknown) => void
): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (size > CONTROL_MAX_MESSAGE_BYTES) {
        socket.destroy(
          new Error(`Control frame exceeds ${CONTROL_MAX_MESSAGE_BYTES} bytes`)
        );
        return;
      }
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch {
        socket.destroy(new Error("Control frame is not valid JSON"));
      }
    }
  });
}

type ControlTransportMode = "legacy-frame" | "control-v1";

/**
 * The native host still uses the historical length framing on the same
 * user-only socket. CLI/MCP use bpa.control/1 newline envelopes. The first byte
 * is unambiguous because a valid v1 envelope begins with "{" while legacy
 * frames begin with a four-byte length bounded below 1 MiB.
 */
export function attachControlDecoder(
  socket: Socket,
  onMessage: (message: unknown, mode: ControlTransportMode) => void
): void {
  let buffered = Buffer.alloc(0);
  let mode: ControlTransportMode | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!mode && buffered.length > 0) {
      mode = buffered[0] === 0x7b ? "control-v1" : "legacy-frame";
    }
    if (mode === "control-v1") {
      if (buffered.length > CONTROL_V1_MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("Control v1 envelope exceeds maximum size"));
        return;
      }
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const body = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        try {
          onMessage(JSON.parse(body.toString("utf8")), mode);
        } catch {
          socket.destroy(new Error("Control v1 envelope is not valid JSON"));
          return;
        }
        newline = buffered.indexOf(0x0a);
      }
      return;
    }
    if (mode !== "legacy-frame") return;
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (size > CONTROL_MAX_MESSAGE_BYTES) {
        socket.destroy(
          new Error(`Control frame exceeds ${CONTROL_MAX_MESSAGE_BYTES} bytes`)
        );
        return;
      }
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      try {
        onMessage(JSON.parse(body.toString("utf8")), mode);
      } catch {
        socket.destroy(new Error("Control frame is not valid JSON"));
        return;
      }
    }
  });
}

const CONTROL_V1_ERROR_CODES = new Set<ControlErrorCode>([
  "INVALID_REQUEST",
  "UNKNOWN_METHOD",
  "DEADLINE_EXCEEDED",
  "CONFLICT",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "INTERNAL"
]);

function controlV1Error(
  requestId: string,
  code: ControlErrorCode,
  message: string
): ControlResponseEnvelope {
  return {
    version: "bpa.control/1",
    kind: "error",
    requestId,
    error: { code, message }
  };
}

function writeControlV1Response(
  socket: Socket,
  requestId: string,
  response: ControlResponseEnvelope
): void {
  try {
    socket.write(Buffer.from(encodeControlEnvelope(response)));
  } catch (error) {
    if (socket.destroyed) return;
    const message =
      error instanceof Error && /maximum size/iu.test(error.message)
        ? "Control response exceeds the negotiated maximum size"
        : "Control response encoding failed";
    socket.write(
      Buffer.from(
        encodeControlEnvelope(controlV1Error(requestId, "INTERNAL", message))
      )
    );
  }
}

function mapLegacyErrorCode(response: ControlResponse): ControlErrorCode {
  const code = response.error?.code;
  if (code && CONTROL_V1_ERROR_CODES.has(code as ControlErrorCode)) {
    return code as ControlErrorCode;
  }
  if (response.error?.message.startsWith("Unknown control method:")) {
    return "UNKNOWN_METHOD";
  }
  if (/not found/iu.test(response.error?.message ?? "")) return "NOT_FOUND";
  return "INTERNAL";
}

export class LocalControlServer {
  #server: Server | undefined;

  constructor(
    readonly socketPath: string,
    readonly service: LocalCoreService
  ) {}

  async start(): Promise<void> {
    if (this.#server) throw new Error("Control server already started");
    if (!isWindowsNamedPipe(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
    const server = createServer((socket) => {
      let nativeConnectionId: string | undefined;
      let negotiatedControl:
        | {
            maxFrameBytes: number;
            features: readonly string[];
          }
        | undefined;
      let applicationControlSeen = false;
      // Decoder failures are scoped to this connection. They must never
      // surface as an unhandled socket error that terminates the daemon.
      socket.on("error", () => undefined);
      attachControlDecoder(socket, (message, mode) => {
        if (mode === "control-v1") {
          if (
            (message as { version?: unknown })?.version ===
            CONTROL_HELLO_PROTOCOL_VERSION
          ) {
            if (negotiatedControl || applicationControlSeen) {
              const response: ControlHelloErrorEnvelope = {
                version: CONTROL_HELLO_PROTOCOL_VERSION,
                kind: "error",
                requestId: null,
                error: {
                  code: "MALFORMED_HELLO",
                  message:
                    "Control Hello must be the first and only negotiation envelope"
                },
                connection: "close"
              };
              socket.end(Buffer.from(encodeControlEnvelope(response)));
              return;
            }
            try {
              const hello = parseControlHelloRequest(message);
              const response = negotiateControlHello(hello, {
                supportedApplicationProtocols: [CONTROL_PROTOCOL_VERSION],
                runtime: { name: "bpa-core", version: "0.6.0" },
                maxFrameBytes: CONTROL_V1_MAX_MESSAGE_BYTES,
                features: [
                  "control_error_isolation",
                  "evidence_refs",
                  "resource_bindings",
                  "staging_leases"
                ]
              });
              socket.write(Buffer.from(encodeControlEnvelope(response)));
              if (response.kind === "error") {
                socket.end();
                return;
              }
              negotiatedControl = {
                maxFrameBytes: response.maxFrameBytes,
                features: response.features
              };
            } catch (error) {
              const response: ControlHelloErrorEnvelope = {
                version: CONTROL_HELLO_PROTOCOL_VERSION,
                kind: "error",
                requestId: null,
                error: {
                  code: "MALFORMED_HELLO",
                  message:
                    error instanceof Error ? error.message : String(error)
                },
                connection: "close"
              };
              socket.end(Buffer.from(encodeControlEnvelope(response)));
            }
            return;
          }
          applicationControlSeen = true;
          if (
            negotiatedControl &&
            Buffer.byteLength(JSON.stringify(message), "utf8") + 1 >
              negotiatedControl.maxFrameBytes
          ) {
            socket.end();
            return;
          }
          let request: ControlRequestEnvelope;
          try {
            request = parseControlRequest(message);
          } catch (error) {
            const requestId =
              typeof (message as { requestId?: unknown })?.requestId ===
                "string" &&
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(
                (message as { requestId: string }).requestId
              )
                ? (message as { requestId: string }).requestId
                : "invalid";
            socket.write(
              Buffer.from(
                encodeControlEnvelope(
                  controlV1Error(
                    requestId,
                    "INVALID_REQUEST",
                    error instanceof Error ? error.message : String(error)
                  )
                )
              )
            );
            return;
          }
          if (Date.parse(request.deadline) <= Date.now()) {
            socket.write(
              Buffer.from(
                encodeControlEnvelope(
                  controlV1Error(
                    request.requestId,
                    "DEADLINE_EXCEEDED",
                    "Control request deadline has elapsed"
                  )
                )
              )
            );
            return;
          }
          void this.service
            .handleAsync({
              id: request.requestId,
              method: request.method,
              params: request.params
            })
            .then((legacyResponse) => {
              if (socket.destroyed) return;
              const response: ControlResponseEnvelope = legacyResponse.ok
                ? {
                    version: "bpa.control/1",
                    kind: "result",
                    requestId: request.requestId,
                    result: legacyResponse.result ?? null
                  }
                : controlV1Error(
                    request.requestId,
                    mapLegacyErrorCode(legacyResponse),
                    legacyResponse.error?.message ?? "Core request failed"
                  );
              writeControlV1Response(socket, request.requestId, response);
            })
            .catch(() => {
              if (socket.destroyed) return;
              writeControlV1Response(
                socket,
                request.requestId,
                controlV1Error(
                  request.requestId,
                  "INTERNAL",
                  "Control request failed"
                )
              );
            });
          return;
        }
        if (nativeConnectionId) {
          this.service.browserGateway?.handle(
            message,
            nativeConnectionId
          );
          return;
        }
        const request = message as Partial<ControlRequest>;
        if (
          typeof request.id !== "string" ||
          typeof request.method !== "string"
        ) {
          socket.write(
            encodeFrame({
              id: typeof request.id === "string" ? request.id : "invalid",
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "id and method are required"
              }
            } satisfies ControlResponse)
          );
          return;
        }
        const legacyRequestId = request.id;
        const legacyMethod = request.method;
        if (request.method === "native.attach") {
          if (!this.service.browserGateway) {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: false,
                error: {
                  code: "GATEWAY_DISABLED",
                  message: "Browser Gateway is not configured"
                }
              } satisfies ControlResponse)
            );
            return;
          }
          try {
            nativeConnectionId = this.service.browserGateway.attach(
              String(request.params?.origin),
              (browserMessage) => socket.write(encodeFrame(browserMessage))
            );
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { attached: true }
              } satisfies ControlResponse)
            );
          } catch (error) {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: false,
                error: {
                  code: "NATIVE_ATTACH_REJECTED",
                  message:
                    error instanceof Error ? error.message : String(error)
                }
              } satisfies ControlResponse)
            );
          }
          return;
        }
        void this.service
          .handleAsync({
              id: legacyRequestId,
              method: legacyMethod,
              ...(request.params ? { params: request.params } : {})
            })
          .then((response) => {
            if (socket.destroyed) return;
            try {
              socket.write(encodeFrame(response));
            } catch {
              socket.write(
                encodeFrame({
                  id: legacyRequestId,
                  ok: false,
                  error: {
                    code: "INTERNAL",
                    message: "Control response exceeds the maximum size"
                  }
                } satisfies ControlResponse)
              );
            }
          })
          .catch(() => {
            if (socket.destroyed) return;
            socket.write(
              encodeFrame({
                id: legacyRequestId,
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: "Control request failed"
                }
              } satisfies ControlResponse)
            );
          });
      });
      socket.once("close", () => {
        if (nativeConnectionId) {
          this.service.browserGateway?.detach(nativeConnectionId);
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });
    if (!isWindowsNamedPipe(this.socketPath)) {
      await import("node:fs/promises").then(({ chmod }) =>
        chmod(this.socketPath, 0o600)
      );
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    this.#server = undefined;
    if (!isWindowsNamedPipe(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
  }
}

export function sendControlRequest(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = randomUUID();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Control request timed out: ${method}`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    attachFrameDecoder(socket, (message) => {
      const response = message as ControlResponse;
      if (response.id !== id) return;
      clearTimeout(timeout);
      socket.end();
      if (response.ok) {
        resolve(response.result);
      } else {
        reject(
          new Error(
            `${response.error?.code ?? "CORE_ERROR"}: ${
              response.error?.message ?? "Unknown error"
            }`
          )
        );
      }
    });
    socket.once("connect", () => {
      socket.write(
        encodeFrame({
          id,
          method,
          ...(params ? { params } : {})
        } satisfies ControlRequest)
      );
    });
  });
}
