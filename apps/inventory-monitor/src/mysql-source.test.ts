import { describe, expect, it, vi } from "vitest";
import {
  MysqlSalesDemandSync,
  mysqlOptionsFromEnvironment,
  salesDemandSyncFailure,
  type MysqlSalesSourceOptions,
  type WdtCoverageRow,
  type WdtSourceRow
} from "./mysql-source.js";

const mysqlOptions: MysqlSalesSourceOptions = {
  host: "127.0.0.1",
  port: 3306,
  user: "test",
  password: "test",
  database: "test"
};

function wdtRow(id: number): WdtSourceRow {
  return {
    id,
    source_shop_name: "一号店",
    child_order_id: `order-${id}`,
    product_id: "80001",
    merchant_code: "TEST-001",
    specification: "默认",
    source_quantity: 1,
    submitted_at: "2026-08-09 07:00:00",
    paid_at: "2026-08-09 07:01:00",
    shipped_at: null,
    refund_status: "",
    source_loaded_at: "2026-08-09 08:00:00",
    query_end_time: "2026-08-09 08:00:00"
  } as WdtSourceRow;
}

class ControlledWdtSync extends MysqlSalesDemandSync {
  constructor(
    repository: never,
    readonly pages: Array<WdtSourceRow[] | Error>,
    readonly maximumRows = 1_000_000,
    readonly coverage = {
      query_end_time: "2026-08-09 08:00:00" as string | null,
      source_loaded_at: "2026-08-09 08:00:00" as string | null
    }
  ) {
    super(mysqlOptions, repository);
  }

  protected override maximumRowsPerSync(): number {
    return this.maximumRows;
  }

  protected override async readWdtPage(): Promise<WdtSourceRow[]> {
    const next = this.pages.shift() ?? [];
    if (next instanceof Error) throw next;
    return next;
  }

  protected override async readWdtCoverage(_shopName: string): Promise<WdtCoverageRow> {
    return this.coverage as WdtCoverageRow;
  }
}

function chunkRepository() {
  return {
    currentWatermark: vi.fn(async () => undefined),
    beginOrderSync: vi.fn(async () => undefined),
    upsertOrderChunk: vi.fn(async (input: { rows: readonly unknown[] }) => ({
      inserted: input.rows.length,
      updated: 0
    })),
    completeOrderSync: vi.fn(async () => ({ inserted: 0, updated: 0 })),
    completeNoChangeOrderSync: vi.fn(async () => undefined),
    failOrderSync: vi.fn(async () => undefined)
  };
}

const lease = {
  leaseKey: "inventory-production-cycle",
  holderId: "trigger-attempt:test",
  fencingToken: 7
} as const;
const effect = {
  effectId:`inventory-effect:sha256:${"a".repeat(64)}`,
  inputDigest:`sha256:${"b".repeat(64)}`,
  identityDigest:`sha256:${"c".repeat(64)}`,
  runId:"run:test",invocationId:"invocation:test",
  idempotencyKey:"idempotency:test",leaseRequestId:"lease-request:test"
} as const;

describe("MySQL WDT sales source", () => {
  it("does not guess missing credentials", () => {
    expect(mysqlOptionsFromEnvironment({})).toBeUndefined();
  });

  it("accepts explicit loopback configuration without obsolete manual options", () => {
    expect(mysqlOptionsFromEnvironment({
      BPA_MYSQL_HOST: "127.0.0.1",
      BPA_MYSQL_PORT: "3306",
      BPA_MYSQL_USER: "bpa_sales_reader",
      BPA_MYSQL_PASSWORD: "redacted-test-value",
      BPA_MYSQL_DATABASE: "ecom_profit",
      BPA_MYSQL_MANUAL_SKIP_SHOP_IDS: "10461048,200"
    })).toEqual({
      host: "127.0.0.1",
      port: 3306,
      user: "bpa_sales_reader",
      password: "redacted-test-value",
      database: "ecom_profit"
    });
  });

  it("scopes coverage to the same three exact shop aliases as WDT rows", async () => {
    const query = vi.fn(async (sqlValue: unknown) =>
      String(sqlValue).includes("MAX(query_end_time)")
        ? [[{ query_end_time: null, source_loaded_at: null }], []]
        : [[], []]
    );
    const repository = chunkRepository();
    const sync = new MysqlSalesDemandSync(mysqlOptions, repository as never);
    Object.defineProperty(sync, "pool", {
      value: { query, end: vi.fn(async () => undefined) }
    });
    await expect(sync.sync({
      shopName: "一号店",
      expectedShopId: "10461048",
      lease,effect
    })).resolves.toMatchObject({ status: "no_changes", processed: 0 });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("shop_name IN (?,?,?)"),
      ["一号店", "抖音-一号店", "抖音-享乐东一号店"]
    );
    expect(repository.completeNoChangeOrderSync).toHaveBeenCalledOnce();
    expect(repository.completeOrderSync).not.toHaveBeenCalled();
  });

  it.each([
    ["row normalization", new Error("WDT_ORDER_ROW_INVALID"), "WDT_ORDER_ROW_INVALID"],
    ["row limit", new Error("WDT_SYNC_ROW_LIMIT_EXCEEDED"), "WDT_SYNC_ROW_LIMIT_EXCEEDED"],
    [
      "next-page transport",
      Object.assign(new Error("MySQL connection timed out"), { code: "ETIMEDOUT" }),
      "ETIMEDOUT"
    ]
  ])(
    "classifies %s as uncertain only when staged progress cannot be cleaned",
    (_label, error, causeCode) => {
      expect(salesDemandSyncFailure(error, {
        committedChunks: 1,
        committedRows: 5_000
      })).toMatchObject({
        code: "SALES_DEMAND_PARTIAL_COMMIT",
        causeCode,
        progress: { committedChunks: 1, committedRows: 5_000 },
        message: "SALES_DEMAND_PARTIAL_COMMIT"
      });
    }
  );

  it("preserves a pre-staging failure as definitive", () => {
    const error = new Error("WDT_ORDER_ROW_INVALID");
    expect(salesDemandSyncFailure(error, {
      committedChunks: 0,
      committedRows: 0
    })).toBe(error);
  });

  it("returns a definite data-quality error after fenced staging cleanup", async () => {
    const repository = chunkRepository();
    const sync = new ControlledWdtSync(repository as never, [
      Array.from({ length: 5_000 }, (_, index) => wdtRow(index + 1)),
      [{ ...wdtRow(5_001), submitted_at: null, paid_at: null } as unknown as WdtSourceRow]
    ]);
    try {
      await expect(sync.sync({
        shopName: "一号店",
        expectedShopId: "10461048",
        lease,effect
      })).rejects.toThrow("WDT_DATA_QUALITY_INVALID");
      expect(repository.upsertOrderChunk).toHaveBeenCalledOnce();
      expect(repository.failOrderSync).toHaveBeenCalledOnce();
    } finally {
      await sync.close();
    }
  });

  it("reports partial commit when fenced cleanup outcome is unknown", async () => {
    const repository = chunkRepository();
    repository.failOrderSync.mockRejectedValueOnce(
      Object.assign(new Error("PostgreSQL connection lost"), { code: "57P01" })
    );
    const sync = new ControlledWdtSync(repository as never, [
      Array.from({ length: 5_000 }, (_, index) => wdtRow(index + 1)),
      Object.assign(new Error("MySQL connection timed out"), { code: "ETIMEDOUT" })
    ]);
    try {
      await expect(sync.sync({
        shopName: "一号店",
        expectedShopId: "10461048",
        lease,effect
      })).rejects.toMatchObject({
        code: "SALES_DEMAND_PARTIAL_COMMIT",
        causeCode: "ETIMEDOUT",
        progress: { committedChunks: 1, committedRows: 5_000 }
      });
      expect(repository.upsertOrderChunk).toHaveBeenCalledOnce();
    } finally {
      await sync.close();
    }
  });

  it("preserves lease loss when cleanup cannot fence even before staging", async () => {
    const repository = chunkRepository();
    repository.failOrderSync.mockRejectedValueOnce(
      new Error("SCHEDULER_LEASE_LOST")
    );
    const sync = new ControlledWdtSync(repository as never, [
      [{ ...wdtRow(1), paid_at: null, submitted_at: null } as unknown as WdtSourceRow]
    ]);
    try {
      await expect(sync.sync({
        shopName: "一号店",
        expectedShopId: "10461048",
        lease,effect
      })).rejects.toThrow("SCHEDULER_LEASE_LOST");
      expect(repository.upsertOrderChunk).not.toHaveBeenCalled();
    } finally {
      await sync.close();
    }
  });

  it("returns a definite source-unavailable error after transport failure is fenced and cleaned", async () => {
    const repository = chunkRepository();
    const sync = new ControlledWdtSync(repository as never, [
      Array.from({ length: 5_000 }, (_, index) => wdtRow(index + 1)),
      Object.assign(new Error("MySQL connection timed out"), { code: "ETIMEDOUT" })
    ]);
    try {
      await expect(sync.sync({
        shopName: "一号店",
        expectedShopId: "10461048",
        lease,effect
      })).rejects.toThrow("WDT_SOURCE_UNAVAILABLE");
      expect(repository.failOrderSync).toHaveBeenCalledOnce();
    } finally {
      await sync.close();
    }
  });
});
