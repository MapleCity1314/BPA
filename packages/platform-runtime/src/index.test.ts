import { describe, expect, it } from "vitest";
import {
  isWindowsNamedPipe,
  resolveDefaultBpaHome,
  resolveDefaultBpaLogRoot,
  resolveLocalIpcEndpoint
} from "./index.js";

describe("desktop runtime paths", () => {
  it("rejects unsafe local IPC channel names", () => {
    expect(() =>
      resolveLocalIpcEndpoint("/tmp/bpa", "../core", "darwin")
    ).toThrow(/channel is invalid/u);
  });

  it("preserves the existing macOS layout", () => {
    expect(
      resolveDefaultBpaHome({
        platform: "darwin",
        homeDirectory: "/Users/operator"
      })
    ).toBe("/Users/operator/Library/Application Support/BPA");
    expect(
      resolveDefaultBpaLogRoot({
        platform: "darwin",
        homeDirectory: "/Users/operator"
      })
    ).toBe("/Users/operator/Library/Logs/BPA");
    expect(
      resolveLocalIpcEndpoint("/Users/operator/BPA", "core", "darwin")
    ).toBe("/Users/operator/BPA/run/core.sock");
  });

  it("uses LOCALAPPDATA and stable per-install named pipes on Windows", () => {
    const root = resolveDefaultBpaHome({
      platform: "win32",
      homeDirectory: "C:\\Users\\operator",
      localAppData: "C:\\Users\\operator\\AppData\\Local"
    });
    expect(root.replaceAll("\\", "/")).toContain(
      "C:/Users/operator/AppData/Local/BPA"
    );
    expect(
      resolveDefaultBpaLogRoot({
        platform: "win32",
        localAppData: "C:\\Users\\operator\\AppData\\Local"
      }).replaceAll("\\", "/")
    ).toContain("C:/Users/operator/AppData/Local/BPA/logs");
    const core = resolveLocalIpcEndpoint(root, "core", "win32");
    const staging = resolveLocalIpcEndpoint(root, "staging", "win32");
    expect(core).toMatch(/^\\\\\.\\pipe\\bpa-[a-f0-9]{16}-core$/u);
    expect(staging).toMatch(/^\\\\\.\\pipe\\bpa-[a-f0-9]{16}-staging$/u);
    expect(core).not.toBe(staging);
    expect(isWindowsNamedPipe(core)).toBe(true);
  });

  it("rejects unsupported desktop platforms and missing Windows state", () => {
    expect(() =>
      resolveDefaultBpaHome({ platform: "linux" })
    ).toThrow(/does not support linux/u);
    expect(() =>
      resolveDefaultBpaHome({
        platform: "win32",
        localAppData: ""
      })
    ).toThrow(/LOCALAPPDATA/u);
  });
});
