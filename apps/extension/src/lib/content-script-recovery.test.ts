import { describe, expect, it, vi } from "vitest";
import { ContentScriptRecovery } from "./content-script-recovery";

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
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce("first");
    const secondProbe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("missing"))
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

  it("keeps the original probe error when recovery injection is unavailable", async () => {
    const recovery = new ContentScriptRecovery();
    const initialError = new Error("content script missing");

    await expect(
      recovery.probe({
        tabId: 31,
        probe: vi.fn().mockRejectedValue(initialError),
        inject: vi.fn().mockRejectedValue(new Error("injection denied"))
      })
    ).rejects.toBe(initialError);
  });
});
