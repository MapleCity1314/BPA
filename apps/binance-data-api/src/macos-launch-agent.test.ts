import { describe, expect, it } from "vitest";
import { BINANCE_DATA_LAUNCH_AGENT_LABEL, renderBinanceDataLaunchAgent } from "./macos-launch-agent.js";

describe("Binance Data API macOS LaunchAgent", () => {
  it("renders one loopback read-only service without embedding credentials", () => {
    const source = renderBinanceDataLaunchAgent({
      repoRoot: "/Users/test/BPA",
      bpaHome: "/Users/test/Library/Application Support/BPA",
      nodePath: "/Users/test/node24/bin/node",
      envFile: "/Users/test/.config/bpa/binance.env",
      logRoot: "/Users/test/Library/Logs/BPA"
    });
    expect(source).toContain(`<string>${BINANCE_DATA_LAUNCH_AGENT_LABEL}</string>`);
    expect(source).toContain("<key>BINANCE_DATA_HOST</key><string>127.0.0.1</string>");
    expect(source).toContain("<key>BINANCE_DATA_PORT</key><string>43124</string>");
    expect(source).toContain("<key>BINANCE_DATA_ALLOWED_ORIGIN</key><string>zero://app</string>");
    expect(source).toContain("/Users/test/.config/bpa/binance.env");
    expect(source).not.toMatch(/BINANCE_API_KEY|BINANCE_SECRET_KEY|cookie|secret=/iu);
  });

  it("escapes paths and rejects relative input", () => {
    const source = renderBinanceDataLaunchAgent({
      repoRoot: "/Users/a&b/BPA",
      bpaHome: "/Users/a&b/BPA Home",
      nodePath: "/Users/a&b/node",
      envFile: "/Users/a&b/.env",
      logRoot: "/Users/a&b/Logs"
    });
    expect(source).toContain("/Users/a&amp;b/BPA");
    expect(() => renderBinanceDataLaunchAgent({ repoRoot: "relative", bpaHome: "/tmp", nodePath: "/tmp/node", envFile: "/tmp/env", logRoot: "/tmp/log" })).toThrow(/absolute/u);
  });
});
