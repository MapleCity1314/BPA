import type { Readable } from "node:stream";

export const NATIVE_HOST_MAX_MESSAGE_BYTES = 512 * 1024;

export function encodeNativeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > NATIVE_HOST_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Native message exceeds ${NATIVE_HOST_MAX_MESSAGE_BYTES} bytes`
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function encodeCoreFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > NATIVE_HOST_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Core message exceeds ${NATIVE_HOST_MAX_MESSAGE_BYTES} bytes`
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function attachJsonFrameDecoder(
  stream: Readable,
  byteOrder: "LE" | "BE",
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void
): void {
  let buffered = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size =
        byteOrder === "LE"
          ? buffered.readUInt32LE(0)
          : buffered.readUInt32BE(0);
      if (size > NATIVE_HOST_MAX_MESSAGE_BYTES) {
        onError(
          new Error(
            `Frame length ${size} exceeds ${NATIVE_HOST_MAX_MESSAGE_BYTES}`
          )
        );
        return;
      }
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch {
        onError(new Error("Frame body is not valid JSON"));
        return;
      }
    }
  });
}
