import { describe, expect, it } from "vitest";
import {
  PROFILE_TAB_COUNT_LIMIT,
  measureProfileTabCount
} from "./profile-tab-usage.js";

describe("Profile tab usage", () => {
  it("counts every tab visible to the Extension profile", async () => {
    await expect(
      measureProfileTabCount(async () => [{}, {}, {}])
    ).resolves.toBe(3);
  });

  it("fails closed before publishing an over-limit count", async () => {
    await expect(
      measureProfileTabCount(async () =>
        Array.from({ length: PROFILE_TAB_COUNT_LIMIT + 1 })
      )
    ).rejects.toThrow("BROWSER_PROFILE_TAB_LIMIT_EXCEEDED");
  });

  it("does not turn a failed tabs query into a zero count", async () => {
    await expect(
      measureProfileTabCount(async () => {
        throw new Error("tabs query failed");
      })
    ).rejects.toThrow("tabs query failed");
  });
});
