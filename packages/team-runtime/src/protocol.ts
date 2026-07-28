import type { RuntimeOutcome } from "@bpa/node-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

export const TEAM_PROTOCOL_VERSION = "bpa.team/1" as const;
export const TEAM_MAX_FRAME_BYTES = 1024 * 1024;

export interface TeamHello {
  readonly type: "hello";
  readonly protocolVersion: typeof TEAM_PROTOCOL_VERSION;
  readonly expectedCodeDigest: string;
}

export interface TeamHelloAck {
  readonly type: "hello.ack";
  readonly protocolVersion: typeof TEAM_PROTOCOL_VERSION;
  readonly codeDigest: string;
  readonly handlers: readonly string[];
}

export interface TeamInvoke {
  readonly type: "invoke";
  readonly requestId: string;
  readonly node: ArtifactRef & { readonly kind: "node" };
  readonly input: JsonValue;
  readonly deadlineAt: number;
  readonly fencingToken: number;
}

export interface TeamCancel {
  readonly type: "cancel";
  readonly requestId: string;
  readonly fencingToken: number;
}

export interface TeamResult {
  readonly type: "result";
  readonly requestId: string;
  readonly fencingToken: number;
  readonly outcome: RuntimeOutcome;
}

export interface TeamProtocolError {
  readonly type: "error";
  readonly requestId?: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type TeamClientMessage = TeamHello | TeamInvoke | TeamCancel;
export type TeamWorkerMessage =
  | TeamHelloAck
  | TeamResult
  | TeamProtocolError;

function jsonBytes(message: unknown): Buffer {
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch (error) {
    throw new TeamProtocolViolation(
      "FRAME_JSON_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }
  return Buffer.from(serialized, "utf8");
}

export class TeamProtocolViolation extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TeamProtocolViolation";
  }
}

export function encodeTeamFrame(message: unknown): Buffer {
  const payload = jsonBytes(message);
  if (payload.length === 0 || payload.length > TEAM_MAX_FRAME_BYTES) {
    throw new TeamProtocolViolation(
      "FRAME_LENGTH_INVALID",
      `Frame payload must be 1-${TEAM_MAX_FRAME_BYTES} bytes`
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeTeamJson<T>(payload: Buffer): T {
  try {
    return JSON.parse(payload.toString("utf8")) as T;
  } catch {
    throw new TeamProtocolViolation(
      "FRAME_JSON_INVALID",
      "Frame payload is not valid JSON"
    );
  }
}

export class TeamFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength === 0) return [];
    this.#buffer = Buffer.concat([
      this.#buffer,
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    ]);
    const frames: Buffer[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > TEAM_MAX_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new TeamProtocolViolation(
          "FRAME_LENGTH_INVALID",
          `Frame declares invalid payload length ${length}`
        );
      }
      if (this.#buffer.length < 4 + length) break;
      frames.push(this.#buffer.subarray(4, 4 + length));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return frames;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

export function teamNodeRef(node: {
  readonly id: string;
  readonly version: string;
}): string {
  return `${node.id}@${node.version}`;
}
