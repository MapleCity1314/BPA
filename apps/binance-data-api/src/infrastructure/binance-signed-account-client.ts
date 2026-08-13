import { createHmac } from "node:crypto";

export interface DirectBinancePosition {
  symbol: string;
  positionSide: string;
  positionAmount: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  leverage: string;
  notional: string;
  updateTime: string;
}

export interface DirectBinanceAccount {
  available: boolean;
  observedAt: string;
  reason: "ok" | "not-configured" | "upstream-unavailable";
  balances: {
    totalMarginBalance: string | null;
    walletBalance: string | null;
    unrealizedPnl: string | null;
    availableBalance: string | null;
    asset: "USDT";
  };
  positions: readonly DirectBinancePosition[];
}

interface SignedAccountClientOptions {
  apiKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const decimal = (value: unknown): string | null =>
  typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/u.test(value) ? value.replace(/^\+/u, "") : null;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export class BinanceSignedAccountClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #cached: DirectBinanceAccount | null = null;
  #cacheExpiresAt = 0;
  #inFlight: Promise<DirectBinanceAccount> | null = null;

  constructor(private readonly options: SignedAccountClientOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async load(signal?: AbortSignal): Promise<DirectBinanceAccount> {
    const now = this.#now();
    if (this.#cached && now.getTime() < this.#cacheExpiresAt) return this.#cached;
    if (this.#inFlight) return this.#inFlight;
    const pending = this.#load(now, signal);
    this.#inFlight = pending;
    try {
      const result = await pending;
      this.#cached = result;
      this.#cacheExpiresAt = now.getTime() + (result.available ? 4_000 : 30_000);
      return result;
    } finally {
      if (this.#inFlight === pending) this.#inFlight = null;
    }
  }

  async #load(now: Date, signal?: AbortSignal): Promise<DirectBinanceAccount> {
    const observedAt = now.toISOString();
    const requestSignal = signal ?? AbortSignal.timeout(3_000);
    try {
      const [accountValue, positionsValue] = await Promise.all([
        this.#get("/fapi/v3/account", requestSignal),
        this.#get("/fapi/v3/positionRisk", requestSignal)
      ]);
      const account = object(accountValue);
      if (!account || !Array.isArray(positionsValue)) throw new Error("BINANCE_ACCOUNT_CONTRACT_CHANGED");
      const positions = positionsValue.flatMap((value): DirectBinancePosition[] => {
        const item = object(value);
        if (!item) return [];
        const positionAmount = decimal(item.positionAmt);
        if (!positionAmount || /^-?0(?:\.0+)?$/u.test(positionAmount)) return [];
        const values = {
          symbol: typeof item.symbol === "string" ? item.symbol : "",
          positionSide: typeof item.positionSide === "string" ? item.positionSide : "BOTH",
          positionAmount,
          entryPrice: decimal(item.entryPrice),
          markPrice: decimal(item.markPrice),
          unrealizedPnl: decimal(item.unRealizedProfit),
          liquidationPrice: decimal(item.liquidationPrice),
          leverage: decimal(item.leverage),
          notional: decimal(item.notional)
        };
        if (!values.symbol || Object.values(values).some((entry) => entry === null)) return [];
        const updateTime = typeof item.updateTime === "number" && Number.isSafeInteger(item.updateTime)
          ? new Date(item.updateTime).toISOString() : observedAt;
        return [{ ...values as Omit<DirectBinancePosition, "updateTime">, updateTime }];
      });
      return {
        available: true,
        observedAt,
        reason: "ok",
        balances: {
          totalMarginBalance: decimal(account.totalMarginBalance),
          walletBalance: decimal(account.totalWalletBalance),
          unrealizedPnl: decimal(account.totalUnrealizedProfit),
          availableBalance: decimal(account.availableBalance),
          asset: "USDT"
        },
        positions
      };
    } catch {
      return unavailableDirectAccount(observedAt, "upstream-unavailable");
    }
  }

  async #get(path: string, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ recvWindow: "5000", timestamp: String(this.#now().getTime()) });
    query.set("signature", createHmac("sha256", this.options.secretKey).update(query.toString()).digest("hex"));
    const response = await this.#fetch(`https://fapi.binance.com${path}?${query}`, {
      method: "GET", headers: { "X-MBX-APIKEY": this.options.apiKey },
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw new Error(`BINANCE_HTTP_${response.status}`);
    return response.json();
  }
}

export function unavailableDirectAccount(
  observedAt: string,
  reason: DirectBinanceAccount["reason"] = "not-configured"
): DirectBinanceAccount {
  return {
    available: false, observedAt, reason,
    balances: {
      totalMarginBalance: null, walletBalance: null, unrealizedPnl: null,
      availableBalance: null, asset: "USDT"
    },
    positions: []
  };
}
