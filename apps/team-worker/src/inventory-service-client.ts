import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { TeamHandlerError } from "@bpa/team-runtime";
import type { JsonValue } from "@bpa/workflow-ir";

const MAX_FRAME_BYTES = 1024 * 1024;

interface ServiceResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function configuredSocketPath(): string {
  const socketPath = process.env.BPA_INVENTORY_SOCKET;
  if (!socketPath || !isAbsolute(socketPath) || socketPath.length > 500) {
    throw new TeamHandlerError(
      "INVENTORY_SERVICE_NOT_CONFIGURED",
      "The trusted inventory service socket is not configured"
    );
  }
  return socketPath;
}

function requestId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function invokeInventoryService(
  operation: string,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<JsonValue> {
  if (signal.aborted) {
    throw new TeamHandlerError("TEAM_HANDLER_CANCELLED", "Inventory service request was cancelled");
  }
  const payload = Buffer.from(JSON.stringify({ id: requestId(), operation, input }), "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new TeamHandlerError("TEAM_HANDLER_INPUT_INVALID", "Inventory service request exceeds 1 MiB");
  }

  return new Promise<JsonValue>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let body = Buffer.alloc(0);
    const finish = (error?: Error, result?: JsonValue): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      if (error) reject(error);
      else resolve(result ?? null);
    };
    const abort = (): void =>
      finish(new TeamHandlerError("TEAM_HANDLER_CANCELLED", "Inventory service request was cancelled"));
    signal.addEventListener("abort", abort, { once: true });

    socket = createConnection(configuredSocketPath());
    socket.once("connect", () => socket?.end(payload));
    socket.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
      if (body.byteLength > MAX_FRAME_BYTES) {
        finish(new TeamHandlerError("INVENTORY_SERVICE_PROTOCOL_ERROR", "Inventory service response exceeds 1 MiB"));
      }
    });
    socket.once("error", (error) =>
      finish(new TeamHandlerError("INVENTORY_SERVICE_UNAVAILABLE", error.message, true))
    );
    socket.once("end", () => {
      if (settled) return;
      try {
        const response = JSON.parse(body.toString("utf8")) as ServiceResponse;
        if (!response.ok) {
          const code = typeof response.error?.code === "string"
            ? response.error.code
            : "INVENTORY_SERVICE_FAILED";
          const message = typeof response.error?.message === "string"
            ? response.error.message
            : "Inventory service request failed";
          finish(new TeamHandlerError(code, message, false));
          return;
        }
        finish(undefined, JSON.parse(JSON.stringify(response.result ?? null)) as JsonValue);
      } catch (error) {
        finish(new TeamHandlerError(
          "INVENTORY_SERVICE_PROTOCOL_ERROR",
          error instanceof Error ? error.message : String(error)
        ));
      }
    });
  });
}
