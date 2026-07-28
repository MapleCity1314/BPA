import { describe, expect, it } from "vitest";
import {
  encodeTeamFrame,
  TEAM_MAX_FRAME_BYTES,
  TeamFrameDecoder,
  TeamProtocolViolation
} from "./protocol.js";

describe("Team 4-byte big-endian framing", () => {
  it("decodes fragmented and coalesced frames", () => {
    const first = encodeTeamFrame({ type: "first" });
    const second = encodeTeamFrame({ type: "second" });
    expect(first.readUInt32BE(0)).toBe(first.length - 4);
    const decoder = new TeamFrameDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(
      Buffer.concat([first.subarray(3), second])
    );
    expect(frames.map((frame) => JSON.parse(frame.toString("utf8")))).toEqual([
      { type: "first" },
      { type: "second" }
    ]);
  });

  it.each([0, TEAM_MAX_FRAME_BYTES + 1])(
    "rejects malformed declared length %s",
    (length) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length, 0);
      expect(() => new TeamFrameDecoder().push(header)).toThrow(
        TeamProtocolViolation
      );
    }
  );

  it("rejects encoded payloads larger than 1 MiB", () => {
    expect(() =>
      encodeTeamFrame({ value: "x".repeat(TEAM_MAX_FRAME_BYTES) })
    ).toThrow(/1-1048576/);
  });
});
