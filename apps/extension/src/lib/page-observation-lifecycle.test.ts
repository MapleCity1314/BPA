import { describe, expect, it } from "vitest";
import {
  shouldForgetTrackedObservation,
  shouldForceNewPageEpoch,
  shouldPreserveTrackedAuthentication,
  shouldReusePageEpoch
} from "./page-observation-lifecycle";

describe("page observation lifecycle", () => {
  const ready = {
    url: "https://fxg.jinritemai.com/ffa/g/list",
    pageEpoch: "tab-42:old",
    observationState: "ready"
  } as const;

  it("reuses an epoch only for the same live document", () => {
    expect(shouldReusePageEpoch(ready, ready.url, false)).toBe(true);
    expect(shouldReusePageEpoch(ready, ready.url, true)).toBe(false);
    expect(
      shouldReusePageEpoch(
        { ...ready, observationState: "departed" },
        ready.url,
        false
      )
    ).toBe(false);
    expect(
      shouldReusePageEpoch(
        ready,
        "https://fxg.jinritemai.com/ffa/g/create",
        false
      )
    ).toBe(false);
  });

  it("preserves revision history across temporary navigation only", () => {
    expect(shouldForgetTrackedObservation("PAGE_LEFT_SUPPORTED_SCOPE")).toBe(
      false
    );
    expect(shouldForgetTrackedObservation("PAGE_OBSERVER_NOT_FOUND")).toBe(
      false
    );
    expect(shouldForgetTrackedObservation("TAB_CLOSED")).toBe(true);
  });

  it("keeps the epoch for same-url reloads while rotating it for navigation", () => {
    expect(shouldForceNewPageEpoch(ready, { status: "loading" })).toBe(false);
    expect(
      shouldForceNewPageEpoch(ready, {
        status: "loading",
        url: ready.url
      })
    ).toBe(false);
    expect(
      shouldForceNewPageEpoch(ready, {
        status: "loading",
        url: "https://fxg.jinritemai.com/ffa/g/create"
      })
    ).toBe(true);
    expect(
      shouldForceNewPageEpoch(ready, {
        status: "complete",
        url: "https://fxg.jinritemai.com/ffa/g/list"
      })
    ).toBe(false);
  });

  it("preserves verified authentication only through transient loading", () => {
    expect(shouldPreserveTrackedAuthentication("loading", "unknown")).toBe(
      true
    );
    expect(shouldPreserveTrackedAuthentication("probing", "unknown")).toBe(
      true
    );
    expect(shouldPreserveTrackedAuthentication("ready", "authenticated")).toBe(
      false
    );
    expect(shouldPreserveTrackedAuthentication("auth_required", "unknown")).toBe(
      false
    );
  });
});
