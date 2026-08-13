import { describe, expect, it, vi } from "vitest";
import { BinanceSignedAccountClient } from "./binance-signed-account-client.js";

describe("BinanceSignedAccountClient", () => {
  it("returns only non-zero read-only positions and exact decimal strings", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        totalMarginBalance: "10.10000000", totalWalletBalance: "10.00000000",
        totalUnrealizedProfit: "0.10000000", availableBalance: "8.00000000"
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "0.00100000", entryPrice: "60000.00000000", markPrice: "60100.00000000", unRealizedProfit: "0.10000000", liquidationPrice: "30000.00000000", leverage: "2", notional: "60.10000000", updateTime: 1_786_572_000_000 },
        { symbol: "ETHUSDT", positionSide: "BOTH", positionAmt: "0.000", entryPrice: "0", markPrice: "3000", unRealizedProfit: "0", liquidationPrice: "0", leverage: "1", notional: "0", updateTime: 0 }
      ]), { status: 200 }));
    const client = new BinanceSignedAccountClient({
      apiKey: "key", secretKey: "secret", fetchImpl,
      now: () => new Date("2026-08-13T12:00:00.000Z")
    });
    const result = await client.load();
    expect(result).toMatchObject({
      available: true,
      balances: { totalMarginBalance: "10.10000000" },
      positions: [{ symbol: "BTCUSDT", positionAmount: "0.00100000" }]
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toContain("signature=");
      expect(call[1]).toMatchObject({ method: "GET", headers: { "X-MBX-APIKEY": "key" } });
    }
  });

  it("fails closed without leaking upstream errors", async () => {
    const client = new BinanceSignedAccountClient({
      apiKey: "key", secretKey: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive")),
      now: () => new Date("2026-08-13T12:00:00.000Z")
    });
    await expect(client.load()).resolves.toMatchObject({
      available: false, reason: "upstream-unavailable", positions: []
    });
  });

  it("deduplicates concurrent requests and caches an unavailable upstream for 30 seconds", async () => {
    let now = new Date("2026-08-13T12:00:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const client = new BinanceSignedAccountClient({
      apiKey: "key", secretKey: "secret", fetchImpl, now: () => now
    });

    await Promise.all([client.load(), client.load(), client.load()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await client.load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now = new Date("2026-08-13T12:00:31.000Z");
    await client.load();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
