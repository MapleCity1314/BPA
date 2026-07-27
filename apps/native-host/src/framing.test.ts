import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  attachJsonFrameDecoder,
  encodeCoreFrame,
  encodeNativeFrame
} from "./framing.js";

describe("native messaging framing", () => {
  it("uses Chrome little-endian and Core network byte order", () => {
    const value = { hello: "世界" };
    const native = encodeNativeFrame(value);
    const core = encodeCoreFrame(value);
    expect(native.readUInt32LE(0)).toBe(native.length - 4);
    expect(core.readUInt32BE(0)).toBe(core.length - 4);
  });

  it("decodes fragmented frames", async () => {
    const stream = new PassThrough();
    const decoded: unknown[] = [];
    attachJsonFrameDecoder(
      stream,
      "LE",
      (message) => decoded.push(message),
      (error) => {
        throw error;
      }
    );
    const frame = encodeNativeFrame({ ok: true });
    stream.write(frame.subarray(0, 2));
    stream.write(frame.subarray(2));
    expect(decoded).toEqual([{ ok: true }]);
  });
});
