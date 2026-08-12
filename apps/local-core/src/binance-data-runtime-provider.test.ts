import type {
  BinanceCollectionRunRecord,
  BinanceCopyTradingStore,
  PersistBinanceCopyTradingCaptureInput
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import { describe, expect, it } from "vitest";
import { BinanceDataRuntimeProvider } from "./binance-data-runtime-provider.js";

const capturedAt = "2026-08-12T04:30:00.000Z";

class MemoryBinanceStore implements BinanceCopyTradingStore {
  calls: PersistBinanceCopyTradingCaptureInput[] = [];

  persistBinanceCopyTradingCapture(input: PersistBinanceCopyTradingCaptureInput) {
    this.calls.push(structuredClone(input));
    const run: BinanceCollectionRunRecord = {
      collectionRunId: input.collectionRunId,
      workflowRunId: input.workflowRunId,
      sourceUrl: input.sourceUrl,
      attemptAt: input.attemptAt,
      captureAt: input.captureAt,
      status: input.status,
      contentDigest: input.contentDigest,
      projectCount: input.projectCount,
      pageCount: input.pageCount,
      recordCount: input.recordCount,
      ...(input.oldestEventTimeUtc === undefined
        ? {}
        : { oldestEventTimeUtc: input.oldestEventTimeUtc }),
      ...(input.newestEventTimeUtc === undefined
        ? {}
        : { newestEventTimeUtc: input.newestEventTimeUtc }),
      lastSuccessAt: input.captureAt,
      createdAt: input.attemptAt
    };
    return {
      status: "accepted" as const,
      run,
      newCurrentRecordCount: input.rawRecords.length
    };
  }

  getBinanceCollectionRun() { return undefined; }
  getLatestSuccessfulBinanceCollectionRun() { return undefined; }
  listBinanceRawRecords() { return []; }
  listBinanceCurrentRecords() { return []; }
}

function invocation(projects: unknown): RuntimeInvocation {
  return {
    invocationId: "invocation:binance:persist",
    identity: {
      runId: "run:binance",
      scopePath: [],
      iterationKey: "root",
      stepKey: "persist_capture",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "binance.copy-trading.capture.persist",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`
    },
    providerId: "binance-data",
    input: {
      pageTimeZone: "Asia/Shanghai",
      management: {
        schemaVersion: "binance-copy-trading/v0.1",
        status: "complete",
        observedAt: capturedAt,
        pageUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
        accountSummary: { 净利润: "1.00 USDT" },
        activeTab: "ongoing",
        projects: [
          {
            projectId: "project_1001",
            status: "ongoing",
            summary: { 净利润: "1.00 USDT" },
            currentPositions: []
          }
        ],
        warnings: [],
        formMutations: 0
      },
      projects
    } as RuntimeInvocation["input"],
    permissionSnapshot: {
      riskLevel: "R1",
      permissions: ["binance.copy-trading.capture.write"],
      domains: []
    },
    deadlineAt: Date.parse("2026-08-12T05:00:00.000Z"),
    idempotencyKey: "run:binance:root:persist_capture:1",
    fencingToken: 7,
    traceId: "trace:binance"
  };
}

function completeProjects() {
  const fields = {
    时间: "2026-08-12 12:00:00",
    合约: "BTCUSDT",
    方向: "买入",
    价格: "120000",
    数量: "0.01",
    手续费: "-0.48 USDT"
  };
  return {
    total: 1,
    succeeded: {
      count: 1,
      items: [
        {
          itemKey: "project_1001",
          output: {
            schemaVersion: "binance-copy-trading/v0.1",
            status: "complete",
            projectId: "project_1001",
            observedAt: capturedAt,
            pageUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
            tabs: [
              {
                sourceTab: "交易历史",
                pageCount: 1,
                records: [
                  {
                    recordKey: "page-row-1",
                    projectId: "project_1001",
                    sourceTab: "交易历史",
                    page: 1,
                    rowOrdinal: 1,
                    fields
                  },
                  {
                    recordKey: "page-row-2",
                    projectId: "project_1001",
                    sourceTab: "交易历史",
                    page: 1,
                    rowOrdinal: 2,
                    fields
                  }
                ]
              }
            ],
            formMutations: 0
          }
        }
      ]
    },
    failed: { count: 0, items: [] },
    unresolved: { count: 0, items: [] }
  };
}

describe("BinanceDataRuntimeProvider", () => {
  it("preserves identical legitimate trades and normalizes page time to UTC", async () => {
    const store = new MemoryBinanceStore();
    const result = await new BinanceDataRuntimeProvider(
      store,
      () => new Date("2026-08-12T04:31:00.000Z")
    ).invoke(invocation(completeProjects()), new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.rawRecords).toHaveLength(2);
    expect(store.calls[0]!.rawRecords[0]!.currentRecordKey).not.toBe(
      store.calls[0]!.rawRecords[1]!.currentRecordKey
    );
    expect(store.calls[0]!.rawRecords.map((record) => record.eventTimeUtc)).toEqual([
      "2026-08-12T04:00:00Z",
      "2026-08-12T04:00:00Z"
    ]);
    expect(store.calls[0]!.pageCount).toBe(2);
  });

  it("fails closed without a store call when foreach coverage is incomplete", async () => {
    const store = new MemoryBinanceStore();
    const incomplete = completeProjects() as unknown as {
      total: number;
      succeeded: { count: number; items: unknown[] };
      failed: { count: number; items: unknown[] };
      unresolved: { count: number; items: unknown[] };
    };
    incomplete.succeeded = { count: 0, items: [] };
    incomplete.failed = {
      count: 1,
      items: [{ itemKey: "project_1001", error: { code: "PAGINATION_FAILED" } }]
    };
    const result = await new BinanceDataRuntimeProvider(store).invoke(
      invocation(incomplete),
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "BINANCE_CAPTURE_PERSIST_FAILED" }
    });
    expect(store.calls).toHaveLength(0);
  });
});
