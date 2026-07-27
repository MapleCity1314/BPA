import { describe, expect, it } from "vitest";
import {
  normalizePendingResultForReplay,
  type PendingResult
} from "./pending-results.js";

const pending: PendingResult = {
  commandId: "command-1",
  commandSeq: 7,
  traceId: "trace-1",
  payload: {
    command_id: "command-1",
    page_epoch: "tab-42:123:nonce"
  }
};

describe("pending result replay migration", () => {
  it("preserves a protocol-safe page epoch", () => {
    expect(normalizePendingResultForReplay(pending)).toBe(pending);
  });

  it("normalizes legacy URL-bearing page epochs before replay", () => {
    expect(
      normalizePendingResultForReplay({
        ...pending,
        payload: {
          ...pending.payload,
          page_epoch: "42:https://fxg.jinritemai.com/ffa/g/list:123"
        }
      }).payload.page_epoch
    ).toBe("replay-7:command-1");
  });
});
