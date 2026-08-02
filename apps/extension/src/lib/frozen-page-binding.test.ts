import { describe, expect, it } from "vitest";
import { matchesFrozenPageBinding } from "./frozen-page-binding.js";

const frozen = {
  browserInstanceId: "browser-1",
  tabId: 42,
  windowId: 7,
  origin: "https://fxg.jinritemai.com",
  pageEpoch: "tab-42:epoch",
  observationRevision: 9,
  authenticationContextRef: "auth-context-a"
};

const live = {
  browserInstanceId: "browser-1",
  tabId: 42,
  windowId: 7,
  url: "https://fxg.jinritemai.com/ffa/g/list",
  pageEpoch: "tab-42:epoch",
  revision: 9,
  authenticationContextRef: "auth-context-a",
  contentScriptReady: true,
  observationState: "ready"
};

describe("frozen page binding", () => {
  it("accepts only the exact ready observation", () => {
    expect(matchesFrozenPageBinding(frozen, live)).toBe(true);
  });

  it.each([
    ["revision", { revision: 10 }],
    ["authentication context", { authenticationContextRef: "auth-context-b" }],
    ["page epoch", { pageEpoch: "tab-42:new" }],
    ["content script", { contentScriptReady: false }],
    ["readiness", { observationState: "stale" }]
  ])("rejects changed %s", (_label, patch) => {
    expect(matchesFrozenPageBinding(frozen, { ...live, ...patch })).toBe(false);
  });
});
