import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import {
  AssistanceTaskService,
  type AssistanceResultValidator,
  type TaskQueueFilter
} from "@bpa/assistance-core";
import {
  compileCanonicalWorkflow,
  compileWorkflow,
  contentDigest,
  MemoryNodeCatalog,
  type CatalogResolver
} from "@bpa/compiler";
import {
  CONTROL_MAX_MESSAGE_BYTES as CONTROL_V1_MAX_MESSAGE_BYTES,
  encodeControlEnvelope,
  parseControlRequest,
  type ControlErrorCode,
  type ControlRequestEnvelope,
  type ControlResponseEnvelope
} from "@bpa/control-protocol";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import type { ArtifactType, Persistence } from "@bpa/persistence";
import {
  BuiltinRuntimeProvider,
  RuntimeProviderRegistry
} from "@bpa/node-runtime";
import { registerTeamRuntimeProvider } from "@bpa/team-runtime";
import {
  compileDataValidator,
  formatValidationErrors,
  validateJsonSchemaDefinition,
  validateNode,
  validateWorkflow,
  type NodeDefinition,
  type WorkflowDefinition
} from "@bpa/schemas";
import type { LocalBrowserGateway } from "./browser-gateway.js";
import { Ir2WorkflowRuntime } from "./ir2-workflow-runtime.js";
import { PersistenceTaskQueue } from "./persistence-task-queue.js";
import {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS
} from "../../team-worker/src/manifest.js";

export const CONTROL_MAX_MESSAGE_BYTES = 512 * 1024;

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

  constructor(
    readonly persistence: Persistence,
    readonly browserGateway?: LocalBrowserGateway,
    runtimeProviders?: RuntimeProviderRegistry
  ) {
    this.engine = new LocalWorkflowEngine(persistence);
    const providers = runtimeProviders ?? new RuntimeProviderRegistry();
    if (!providers.list().includes("builtin")) {
      providers.register(new BuiltinRuntimeProvider());
    }
    if (browserGateway && !providers.list().includes("browser")) {
      providers.register(browserGateway);
    }
    if (!providers.list().includes("team")) {
      registerTeamRuntimeProvider(providers, {
        process: {
          command: process.execPath,
          args: [
            "--import",
            "tsx",
            resolve(
              import.meta.dirname,
              "../../team-worker/src/main.ts"
            )
          ],
          cwd: resolve(import.meta.dirname, "../../.."),
          env: {}
        },
        expectedCodeDigest: TEAM_WORKER_CODE_DIGEST,
        expectedHandlerRefs: TEAM_WORKER_HANDLER_REFS
      });
    }
    this.ir2Runtime = new Ir2WorkflowRuntime(persistence, providers);
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
      // R1 automatic continuation is denied until the referenced, audited
      // deterministic validator is installed in a dedicated registry.
      validateDeterministicResult() {
        return {
          valid: false,
          errors: ["No audited deterministic validator is registered"]
        };
      }
    };
    this.assistance = new AssistanceTaskService({
      queue: new PersistenceTaskQueue(persistence, this.ir2Runtime),
      validator: assistanceValidator,
      profilePublished: (profile) => {
        const published = persistence.getPublished(
          "policy",
          profile.id,
          profile.version
        );
        return published?.digest === profile.digest;
      }
    });
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
    if (!request.method.startsWith("assistance.task.")) {
      return this.handle(request);
    }
    try {
      const result = await this.#dispatchAssistance(
        request,
        request.params ?? {}
      );
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
          protocol: "bpa.browser/1",
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
      case "audit.list":
        return this.persistence.listAudit(
          params.target == null ? undefined : String(params.target)
        );
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
        return this.#createRun(
          String(params.workflowId),
          String(params.workflowVersion),
          params.input ?? {}
        );
      case "run.inspect": {
        const runId = String(params.runId);
        const run = this.persistence.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        return run;
      }
      case "run.events":
        return this.persistence.listEvents(String(params.runId));
      case "run.human.complete":
        return this.#completeHumanStep(
          String(params.nodeExecutionId),
          params.approved === true,
          params.output
        );
      case "run.cancel":
        {
          const runId = String(params.runId);
          const run = this.persistence.requestCancel(
            runId,
            String(params.actor || userInfo().username)
          );
          this.browserGateway?.requestCancel(runId);
          return this.persistence.getRun(runId) ?? run;
        }
      default:
        throw new Error(`Unknown control method: ${method}`);
    }
  }

  #validateAsset(assetType: string, content: unknown): unknown {
    if (assetType === "node") {
      if (!validateNode(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateNode.errors)
        };
      }
      const schemaErrors: string[] = [];
      for (const [name, schema] of [
        ["inputSchema", content.inputSchema],
        ["outputSchema", content.outputSchema],
        ...(content.configSchema
          ? ([["configSchema", content.configSchema]] as const)
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
        digest: contentDigest(content),
        identity: `${content.metadata.id}@${content.metadata.version}`
      };
    }
    if (assetType === "workflow") {
      const isV1Alpha2 =
        content !== null &&
        typeof content === "object" &&
        (content as { apiVersion?: unknown }).apiVersion === "bpa/v1alpha2";
      if (!isV1Alpha2 && !validateWorkflow(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateWorkflow.errors)
        };
      }
      const compiled = isV1Alpha2
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
    throw new Error(`Unsupported asset type: ${assetType}`);
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
    if (assetType === "workflow" || assetType === "node") {
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
      const typed =
        assetType === "node"
          ? (content as NodeDefinition)
          : (content as WorkflowDefinition);
      return this.persistence.saveCandidate({
        assetType,
        assetId: typed.metadata.id,
        version: typed.metadata.version,
        digest: validation.digest,
        content,
        actor
      });
    }
    if (!["adapter", "policy"].includes(assetType)) {
      throw new Error(`Unsupported candidate type: ${assetType}`);
    }
    const assetId = String(
      (content as { metadata?: { id?: string } })?.metadata?.id
    );
    const version = String(
      (content as { metadata?: { version?: string } })?.metadata?.version
    );
    if (!assetId || assetId === "undefined" || !version || version === "undefined") {
      throw new Error("Candidate metadata.id and metadata.version are required");
    }
    return this.persistence.saveCandidate({
      assetType: assetType as ArtifactType,
      assetId,
      version,
      digest: contentDigest(content),
      content,
      actor
    });
  }

  #createRun(
    workflowId: string,
    workflowVersion: string,
    input: unknown
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
    const isV1Alpha2 =
      artifact.content !== null &&
      typeof artifact.content === "object" &&
      (artifact.content as { apiVersion?: unknown }).apiVersion ===
        "bpa/v1alpha2";
    if (isV1Alpha2) {
      return this.ir2Runtime.start(
        compileCanonicalWorkflow(artifact.content, this.#ir2Catalog()),
        JSON.parse(JSON.stringify(input))
      );
    }
    const compiled = compileWorkflow(artifact.content, this.#nodeCatalog());
    const run = this.engine.start(compiled, input);
    this.browserGateway?.dispatchPending();
    return run;
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
        .map((artifact) => artifact.content as NodeDefinition)
    );
  }

  #ir2Catalog(): CatalogResolver {
    const nodes = new Map(
      this.persistence.listPublished("node").map((artifact) => [
        `${artifact.assetId}@${artifact.version}`,
        artifact.content as NodeDefinition
      ])
    );
    const adapters = this.persistence.listPublished("adapter");
    const policies = this.persistence.listPublished("policy");
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
          providerId: definition.runtime.replace(/^engine_/, ""),
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
          datasetProfiles: []
        };
      },
      getAssistanceProfile: (id, version) => {
        const artifact = policies.find(
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
    rmSync(this.socketPath, { force: true });
    const server = createServer((socket) => {
      let nativeConnectionId: string | undefined;
      attachControlDecoder(socket, (message, mode) => {
        if (mode === "control-v1") {
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
                    result: legacyResponse.result
                  }
                : controlV1Error(
                    request.requestId,
                    mapLegacyErrorCode(legacyResponse),
                    legacyResponse.error?.message ?? "Core request failed"
                  );
              socket.write(Buffer.from(encodeControlEnvelope(response)));
            });
          return;
        }
        if (nativeConnectionId) {
          this.service.browserGateway?.handle(message);
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
              id: request.id,
              method: request.method,
              ...(request.params ? { params: request.params } : {})
            })
          .then((response) => {
            if (!socket.destroyed) socket.write(encodeFrame(response));
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
    await import("node:fs/promises").then(({ chmod }) =>
      chmod(this.socketPath, 0o600)
    );
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    this.#server = undefined;
    rmSync(this.socketPath, { force: true });
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
