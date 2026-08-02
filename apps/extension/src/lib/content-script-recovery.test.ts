import { describe, expect, it, vi } from "vitest";
import {
  ContentScriptRecovery
} from "./content-script-recovery";

describe("ContentScriptRecovery", () => {
  it("injects a packaged content script and probes the already-open tab again", async () => {
    const recovery = new ContentScriptRecovery();
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce("ready");
    const inject = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      recovery.probe({ tabId: 17, probe, inject })
    ).resolves.toBe("ready");
    expect(inject).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent recovery for the same tab", async () => {
    const recovery = new ContentScriptRecovery();
    let releaseInjection: (() => void) | undefined;
    const injection = new Promise<void>((resolve) => {
      releaseInjection = resolve;
    });
    const inject = vi.fn(() => injection);
    const firstProbe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce("first");
    const secondProbe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce("second");

    const first = recovery.probe({ tabId: 23, probe: firstProbe, inject });
    const second = recovery.probe({ tabId: 23, probe: secondProbe, inject });
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1));
    releaseInjection?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second"
    ]);
  });

  it("does not inject after an unrelated page probe failure", async () => {
    const recovery = new ContentScriptRecovery();
    const initialError = new Error("CONTENT_PROBE_INVALID");
    const inject = vi.fn().mockResolvedValue(undefined);

    await expect(
      recovery.probe({
        tabId: 31,
        probe: vi.fn().mockRejectedValue(initialError),
        inject
      })
    ).rejects.toBe(initialError);
    expect(inject).not.toHaveBeenCalled();
  });

  it("reports a closed or inaccessible tab instead of content script missing", async () => {
    const recovery = new ContentScriptRecovery();

    await expect(
      recovery.probe({
        tabId: 32,
        probe: vi.fn().mockRejectedValue(
          new Error("Could not establish connection. Receiving end does not exist.")
        ),
        inject: vi.fn().mockRejectedValue(new Error("No tab with id: 32"))
      })
    ).rejects.toMatchObject({
      reasonCode: "BROWSER_TAB_INACCESSIBLE"
    });
  });
});
