import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { compileWorkflow, contentDigest, MemoryNodeCatalog } from "@bpa/compiler";
import { LocalWorkflowEngine } from "@bpa/engine";
import type { ArtifactType, Persistence } from "@bpa/persistence";
import {
  formatValidationErrors,
  validateNode,
  validateWorkflow,
  type NodeDefinition,
  type WorkflowDefinition
} from "@bpa/schemas";
import type { LocalBrowserGateway } from "./browser-gateway.js";

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

  constructor(
    readonly persistence: Persistence,
    readonly browserGateway?: LocalBrowserGateway
  ) {
    this.engine = new LocalWorkflowEngine(persistence);
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
      return {
        valid: true,
        digest: contentDigest(content),
        identity: `${content.metadata.id}@${content.metadata.version}`
      };
    }
    if (assetType === "workflow") {
      if (!validateWorkflow(content)) {
        return {
          valid: false,
          errors: formatValidationErrors(validateWorkflow.errors)
        };
      }
      const compiled = compileWorkflow(content, this.#nodeCatalog());
      return {
        valid: true,
        digest: compiled.workflowDigest,
        identity: `${compiled.workflowId}@${compiled.workflowVersion}`,
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
    const typed =
      assetType === "node"
        ? (content as NodeDefinition)
        : (content as WorkflowDefinition);
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
      attachFrameDecoder(socket, (message) => {
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
        socket.write(
          encodeFrame(
            this.service.handle({
              id: request.id,
              method: request.method,
              ...(request.params ? { params: request.params } : {})
            })
          )
        );
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
