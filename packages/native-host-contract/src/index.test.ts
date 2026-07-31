import { describe, expect, it } from "vitest";
import {
  DEFAULT_BPA_EXTENSION_ID,
  assertNativeHostOrigin
} from "./index.js";

describe("Native Host origin contract", () => {
  it("accepts only the exact fixed Extension origin", () => {
    expect(() =>
      assertNativeHostOrigin(
        `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}/`,
        DEFAULT_BPA_EXTENSION_ID
      )
    ).not.toThrow();
    expect(() =>
      assertNativeHostOrigin(
        `chrome-extension://${DEFAULT_BPA_EXTENSION_ID}`,
        DEFAULT_BPA_EXTENSION_ID
      )
    ).toThrow(/rejected/u);
  });
});
