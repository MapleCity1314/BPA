import type {
  EngineCheckpointRecord,
  ExecutionEventRecord,
  OperationalExecutionContext,
  RunPlanSnapshotRecord,
  RunRecord
} from "@bpa/persistence";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "./index.js";

const timestamp = "2026-08-12T04:30:00.000Z";

function context(runId: string): OperationalExecutionContext {
  return {
    invocationId: `invocation:${runId}:persist`,
    identity: {
      runId,
      scopePath: [],
      iterationKey: "root",
      stepKey: "persist_capture",
      attempt: 1
    },
    node: {
      kind: "node",
      id: "binance.copy-trading.capture.persist",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`
    },
    idempotencyKey: `${runId}:root:persist_capture:1`,
    fencingToken: 1
  };
}

function createRun(
  store: SqlitePersistence,
  runId: string,
  execution: OperationalExecutionContext
): void {
  const run: RunRecord = {
    id: runId,
    workflowId: "binance.copy-trading.management.snapshot",
    workflowVersion: "3.0.0",
    workflowDigest: "sha256:workflow",
    status: "waiting_browser",
    revision: 0,
    input: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const plan: RunPlanSnapshotRecord = {
    runId,
    irVersion: "bpa.workflow-ir/2",
    planDigest: "sha256:plan",
    workflowSourceDigest: "sha256:workflow",
    artifactClosureDigest: "sha256:closure",
    planJson: {
      irVersion: "bpa.workflow-ir/2",
      workflow: {
        id: run.workflowId,
        version: run.workflowVersion,
        digest: run.workflowDigest
      },
      artifactClosure: { entries: [] },
      riskSnapshot: [],
      limits: { maxDepth: 1, maxStepExecutions: 10 },
      entry: "done",
      steps: { done: { key: "done", kind: "terminal", status: "succeeded" } }
    },
    riskSnapshot: [],
    createdAt: timestamp
  };
  const checkpoint: EngineCheckpointRecord = {
    runId,
    stateVersion: "bpa.engine-state/2",
    stateRevision: 1,
    state: {
      stateVersion: "bpa.engine-state/2",
      runId,
      status: "waiting_runtime",
      revision: 1,
      active: { kind: "call", invocation: execution }
    } as unknown as EngineCheckpointRecord["state"],
    updatedAt: timestamp
  };
  const event: ExecutionEventRecord = {
    id: `event:${runId}:1`,
    runId,
    sequence: 1,
    type: "RUN_CREATED",
    payload: {},
    occurredAt: timestamp
  };
  store.createRecoverableRun({ run, planSnapshot: plan, checkpoint, event });
}

function capture(runId: string, execution: OperationalExecutionContext) {
  const contentDigest = `sha256:${"c".repeat(64)}`;
  return {
    collectionRunId: `binance-collection:${runId}`,
    workflowRunId: runId,
    sourceUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
    attemptAt: timestamp,
    captureAt: timestamp,
    status: "success" as const,
    contentDigest,
    projectCount: 1,
    pageCount: 2,
    recordCount: 2,
    oldestEventTimeUtc: "2026-08-12T04:00:00.000Z",
    newestEventTimeUtc: "2026-08-12T04:00:00.000Z",
    executionContext: execution,
    sourceCaptures: [
      {
        captureId: `capture:${runId}:management`,
        sourceKind: "management" as const,
        sourceUrl: "https://www.binance.com/zh-CN/copy-trading/copy-management",
        captureAt: timestamp,
        recordCount: 1,
        payloadDigest: contentDigest,
        payload: { projects: 1 }
      },
      {
        captureId: `capture:${runId}:trade:1`,
        sourceKind: "project_tab" as const,
        projectId: "project_1001",
        sourceTab: "交易历史",
        page: 1,
        sourceUrl:
          "https://www.binance.com/zh-CN/copy-trading/copy-management/project_1001",
        captureAt: timestamp,
        recordCount: 2,
        payloadDigest: contentDigest,
        payload: { page: 1 }
      }
    ],
    projects: [
      {
        projectId: "project_1001",
        projectStatus: "ongoing" as const,
        sourceUrl:
          "https://www.binance.com/zh-CN/copy-trading/copy-management/project_1001",
        capturedAt: timestamp,
        summary: { 净利润: "1.00 USDT" }
      }
    ],
    positions: [],
    rawRecords: [1, 2].map((ordinal) => ({
      rawRecordId: `raw:${runId}:${ordinal}`,
      currentRecordKey: `current:duplicate:${ordinal}`,
      projectId: "project_1001",
      sourceTab: "交易历史",
      page: 1,
      rowOrdinal: ordinal,
      captureAt: timestamp,
      originalEventTime: "2026-08-12 12:00:00",
      eventTimeUtc: "2026-08-12T04:00:00.000Z",
      pageTimeZoneAssumption: "Asia/Shanghai",
      fields: { 时间: "2026-08-12 12:00:00", 合约: "BTCUSDT" },
      fieldsDigest: contentDigest
    }))
  };
}

describe("Binance copy-trading SQLite v27", () => {
  it("atomically keeps duplicate rows and idempotently replays one capture", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const runId = "run:binance:1";
    const execution = context(runId);
    createRun(store, runId, execution);
    const input = capture(runId, execution);

    const first = store.persistBinanceCopyTradingCapture(input);
    const second = store.persistBinanceCopyTradingCapture(input);

    expect(first).toMatchObject({ status: "accepted", newCurrentRecordCount: 2 });
    expect(second).toMatchObject({ status: "duplicate", newCurrentRecordCount: 0 });
    expect(store.listBinanceRawRecords(input.collectionRunId)).toHaveLength(2);
    expect(store.listBinanceCurrentRecords("project_1001")).toHaveLength(2);
    expect(store.listBinanceProjects({ limit: 10 })).toMatchObject({
      items: [{ projectAlias: "leader-01", projectStatus: "ongoing" }],
      hasMore: false
    });
    expect(store.listBinanceRecords({
      projectAlias: "leader-01",
      limit: 10
    })).toMatchObject({
      items: [
        { projectAlias: "leader-01", sourceTab: "交易历史" },
        { projectAlias: "leader-01", sourceTab: "交易历史" }
      ],
      hasMore: false
    });
    expect(store.health().schemaVersion).toBe(27);
  });

  it("rolls back the whole capture when any raw identity conflicts", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const runId = "run:binance:rollback";
    const execution = context(runId);
    createRun(store, runId, execution);
    const input = capture(runId, execution);
    input.rawRecords[1]!.rawRecordId = input.rawRecords[0]!.rawRecordId;

    expect(() => store.persistBinanceCopyTradingCapture(input)).toThrow();
    expect(store.getBinanceCollectionRun(input.collectionRunId)).toBeUndefined();
    expect(store.listBinanceRawRecords(input.collectionRunId)).toEqual([]);
    expect(store.listBinanceCurrentRecords()).toEqual([]);
  });

  it("idempotently persists public market candles and funding", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const runId = "run:binance:market";
    const execution = context(runId);
    createRun(store, runId, execution);
    const input = {
      marketCaptureId: "market-capture:1",
      workflowRunId: runId,
      captureAt: timestamp,
      sourceUrl: "https://fapi.binance.com",
      symbolsPayload: { symbols: ["BTCUSDT"] },
      symbolsDigest: `sha256:${"d".repeat(64)}`,
      candlesPayload: { rows: 1 },
      candlesDigest: `sha256:${"e".repeat(64)}`,
      referencesPayload: { rows: 1 },
      referencesDigest: `sha256:${"f".repeat(64)}`,
      symbols: [{
        symbol: "BTCUSDT",
        pair: "BTCUSDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT"
      }],
      candles: [{
        symbol: "BTCUSDT",
        openTimeUtc: "2026-08-12T04:00:00.000Z",
        closeTimeUtc: "2026-08-12T04:00:59.999Z",
        open: "60000",
        high: "60100",
        low: "59900",
        close: "60050",
        volume: "10",
        quoteVolume: "600500",
        tradeCount: 20
      }],
      funding: [{
        symbol: "BTCUSDT",
        fundingTimeUtc: "2026-08-12T00:00:00.000Z",
        fundingRate: "0.0001",
        markPrice: "60000"
      }],
      references: [{
        symbol: "BTCUSDT",
        markPrice: "60001",
        indexPrice: "60000",
        lastFundingRate: "0.0001",
        openInterest: "12345",
        observedAt: timestamp
      }],
      executionContext: execution
    };
    const first = store.persistBinanceMarketCapture(input);
    const second = store.persistBinanceMarketCapture(input);
    expect(first).toMatchObject({
      status: "accepted",
      insertedCandleCount: 1,
      insertedFundingCount: 1
    });
    expect(second).toMatchObject({
      status: "duplicate",
      insertedCandleCount: 0,
      insertedFundingCount: 0
    });
    expect(store.getBinanceMarketCapture(input.marketCaptureId)).toMatchObject({
      candleCount: 1,
      fundingCount: 1,
      referenceCount: 1
    });
  });
});
