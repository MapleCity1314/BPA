import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type {
  RuntimeInvocation,
  RuntimeOutcome,
  RuntimeProvider
} from "@bpa/node-runtime";
import type {
  BinanceCopyTradingStore,
  OperationalExecutionContext
} from "@bpa/persistence";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";

const NODE_ID = "binance.copy-trading.capture.persist";
const NODE_VERSION = "1.0.0";
const PERMISSION = "binance.copy-trading.capture.write";
const TIME_FIELDS = ["时间", "成交时间", "资金费时间", "Time"] as const;
const SYMBOL_FIELDS = ["合约", "交易对", "Symbol"] as const;
const SIDE_FIELDS = ["方向", "买卖/多空方向", "买卖", "Side"] as const;

type JsonObject = Record<string, JsonValue>;

function object(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(",")}}`;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function stableId(prefix: string, value: JsonValue): string {
  return `${prefix}:${digest(value).slice("sha256:".length)}`;
}

function exactPermission(invocation: RuntimeInvocation): boolean {
  return (
    invocation.permissionSnapshot.riskLevel === "R1" &&
    invocation.permissionSnapshot.domains.length === 0 &&
    invocation.permissionSnapshot.permissions.length === 1 &&
    invocation.permissionSnapshot.permissions[0] === PERMISSION
  );
}

function executionContext(
  invocation: RuntimeInvocation
): OperationalExecutionContext {
  return {
    invocationId: invocation.invocationId,
    identity: invocation.identity,
    node: invocation.node,
    idempotencyKey: invocation.idempotencyKey,
    fencingToken: invocation.fencingToken
  };
}

function firstString(
  fields: JsonObject,
  candidates: readonly string[]
): string | undefined {
  for (const candidate of candidates) {
    const value = fields[candidate];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function eventTimeUtc(
  original: string | undefined,
  pageTimeZone: string
): string | undefined {
  if (!original) return undefined;
  try {
    return Temporal.Instant.from(original).toString();
  } catch {
    // Binance zh-CN renders local wall-clock time without an offset.
  }
  const match = original.match(
    /^(\d{4})[-\/]([01]\d)[-\/]([0-3]\d)[ T]([0-2]\d):([0-5]\d):([0-5]\d)$/u
  );
  if (!match) return undefined;
  try {
    return Temporal.PlainDateTime.from({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6])
    }).toZonedDateTime(pageTimeZone).toInstant().toString();
  } catch {
    return undefined;
  }
}

interface SucceededItem {
  itemKey: string;
  output: JsonObject;
}

function successfulProjectOutputs(value: JsonValue): SucceededItem[] {
  const outcome = object(value, "projects");
  const total = integer(outcome.total, "projects.total");
  const succeeded = object(outcome.succeeded ?? null, "projects.succeeded");
  const failed = object(outcome.failed ?? null, "projects.failed");
  const unresolved = object(outcome.unresolved ?? null, "projects.unresolved");
  const succeededItems = array(succeeded.items, "projects.succeeded.items");
  const failedItems = array(failed.items, "projects.failed.items");
  const unresolvedItems = array(unresolved.items, "projects.unresolved.items");
  if (
    integer(succeeded.count, "projects.succeeded.count") !== succeededItems.length ||
    integer(failed.count, "projects.failed.count") !== failedItems.length ||
    integer(unresolved.count, "projects.unresolved.count") !== unresolvedItems.length ||
    succeededItems.length + failedItems.length + unresolvedItems.length !== total ||
    failedItems.length > 0 ||
    unresolvedItems.length > 0
  ) {
    throw new Error("Project collection is not complete");
  }
  const result = succeededItems.map((item, index) => {
    const envelope = object(item, `projects.succeeded.items[${index}]`);
    return {
      itemKey: text(envelope.itemKey, "project itemKey"),
      output: object(envelope.output ?? null, "project output")
    };
  });
  if (new Set(result.map((item) => item.itemKey)).size !== result.length) {
    throw new Error("Project collection contains duplicate item keys");
  }
  return result;
}

function succeeded(output: JsonValue): RuntimeOutcome {
  return { status: "succeeded", output, evidence: [], riskSignals: [] };
}

function rejected(code: string, message: string): RuntimeOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

function failed(code: string, message: string): RuntimeOutcome {
  return {
    status: "failed",
    error: { code, message, retryable: false },
    evidence: [],
    riskSignals: []
  };
}

export function isBinanceDataNode(id: string, version: string): boolean {
  return id === NODE_ID && version === NODE_VERSION;
}

export class BinanceDataRuntimeProvider implements RuntimeProvider {
  readonly id = "binance-data";

  constructor(
    readonly store: BinanceCopyTradingStore,
    readonly now: () => Date = () => new Date()
  ) {}

  supports(node: ArtifactRef & { readonly kind: "node" }): boolean {
    return isBinanceDataNode(node.id, node.version);
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal
  ): Promise<RuntimeOutcome> {
    if (signal.aborted) {
      return rejected("CANCELLED", "Binance persistence was cancelled before commit.");
    }
    if (!this.supports(invocation.node)) {
      return rejected(
        "BINANCE_DATA_NODE_UNSUPPORTED",
        "Binance data Node id and version are not exact."
      );
    }
    if (!exactPermission(invocation)) {
      return rejected(
        "BINANCE_DATA_PERMISSION_MISMATCH",
        "Binance data permission snapshot is not exact."
      );
    }
    try {
      const input = object(invocation.input, "Binance persist input");
      const management = object(input.management ?? null, "management");
      const managementProjects = array(management.projects, "management.projects");
      const projectOutputs = successfulProjectOutputs(input.projects ?? null);
      const pageTimeZone = text(input.pageTimeZone, "pageTimeZone");
      Temporal.Now.zonedDateTimeISO(pageTimeZone);
      const captureAt = text(management.observedAt, "management.observedAt");
      Temporal.Instant.from(captureAt);
      const sourceUrl = text(management.pageUrl, "management.pageUrl");
      const status = text(management.status, "management.status");
      if (!new Set(["complete", "empty_confirmed"]).has(status)) {
        throw new Error("Management status is invalid");
      }
      const projectsById = new Map<string, JsonObject>();
      for (const projectValue of managementProjects) {
        const project = object(projectValue, "management project");
        const projectId = text(project.projectId, "management projectId");
        if (projectsById.has(projectId)) {
          throw new Error("Management project ids are not unique");
        }
        projectsById.set(projectId, project);
      }
      if (
        projectOutputs.length !== projectsById.size ||
        projectOutputs.some((item) => !projectsById.has(item.itemKey))
      ) {
        throw new Error("Project detail coverage does not match management");
      }
      const collectionRunId = stableId("binance-collection", {
        workflowRunId: invocation.identity.runId,
        idempotencyKey: invocation.idempotencyKey
      });
      const sourceCaptures: Parameters<
        BinanceCopyTradingStore["persistBinanceCopyTradingCapture"]
      >[0]["sourceCaptures"][number][] = [];
      sourceCaptures.push({
        captureId: stableId("binance-capture", {
          collectionRunId,
          sourceKind: "management"
        }),
        sourceKind: "management",
        sourceUrl,
        captureAt,
        recordCount: managementProjects.length,
        payloadDigest: digest(management),
        payload: management
      });
      const projectSnapshots: Parameters<
        BinanceCopyTradingStore["persistBinanceCopyTradingCapture"]
      >[0]["projects"][number][] = [];
      const positions: Parameters<
        BinanceCopyTradingStore["persistBinanceCopyTradingCapture"]
      >[0]["positions"][number][] = [];
      for (const [projectId, project] of projectsById) {
        const projectStatus = text(project.status, "project.status");
        if (projectStatus !== "ongoing" && projectStatus !== "ended") {
          throw new Error("Project status is invalid");
        }
        projectSnapshots.push({
          projectId,
          projectStatus,
          sourceUrl,
          capturedAt: captureAt,
          summary: object(project.summary ?? null, "project.summary")
        });
        const currentPositions = array(
          project.currentPositions,
          "project.currentPositions"
        );
        currentPositions.forEach((positionValue, index) => {
          const position = object(positionValue, "project position");
          const fields = object(position.values ?? null, "project position values");
          positions.push({
            snapshotId: stableId("binance-position", {
              collectionRunId,
              projectId,
              ordinal: index + 1
            }),
            projectId,
            symbol: firstString(fields, SYMBOL_FIELDS) ?? "unknown",
            positionSide: firstString(fields, SIDE_FIELDS) ?? "unknown",
            ordinal: index + 1,
            capturedAt: captureAt,
            fields
          });
        });
      }
      const rawRecords: Parameters<
        BinanceCopyTradingStore["persistBinanceCopyTradingCapture"]
      >[0]["rawRecords"][number][] = [];
      const eventTimes: string[] = [];
      const duplicateOrdinals = new Map<string, number>();
      let projectPageCount = 0;
      for (const item of projectOutputs) {
        const output = item.output;
        if (text(output.projectId, "detail projectId") !== item.itemKey) {
          throw new Error("Detail project id does not match foreach item key");
        }
        const detailCaptureAt = text(output.observedAt, "detail observedAt");
        Temporal.Instant.from(detailCaptureAt);
        const detailUrl = text(output.pageUrl, "detail pageUrl");
        for (const tabValue of array(output.tabs, "detail tabs")) {
          const tab = object(tabValue, "detail tab");
          const sourceTab = text(tab.sourceTab, "detail sourceTab");
          const pageCount = integer(tab.pageCount, "detail pageCount");
          if (pageCount < 1) throw new Error("Detail pageCount must be positive");
          const records = array(tab.records, "detail records");
          const byPage = new Map<number, JsonObject[]>();
          for (const recordValue of records) {
            const record = object(recordValue, "detail record");
            const page = integer(record.page, "detail record page");
            const rowOrdinal = integer(
              record.rowOrdinal,
              "detail record rowOrdinal"
            );
            if (page < 1 || page > pageCount || rowOrdinal < 1) {
              throw new Error("Detail record pagination identity is invalid");
            }
            const fields = object(record.fields ?? null, "detail record fields");
            const fieldsDigest = digest(fields);
            const duplicateBase = `${item.itemKey}\u0000${sourceTab}\u0000${fieldsDigest}`;
            const duplicateOrdinal = (duplicateOrdinals.get(duplicateBase) ?? 0) + 1;
            duplicateOrdinals.set(duplicateBase, duplicateOrdinal);
            const currentRecordKey = stableId("binance-current", {
              projectId: item.itemKey,
              sourceTab,
              fieldsDigest,
              duplicateOrdinal
            });
            const originalEventTime = firstString(fields, TIME_FIELDS);
            const normalizedEventTime = eventTimeUtc(originalEventTime, pageTimeZone);
            if (normalizedEventTime) eventTimes.push(normalizedEventTime);
            rawRecords.push({
              rawRecordId: stableId("binance-raw", {
                collectionRunId,
                projectId: item.itemKey,
                sourceTab,
                page,
                rowOrdinal
              }),
              currentRecordKey,
              projectId: item.itemKey,
              sourceTab,
              page,
              rowOrdinal,
              captureAt: detailCaptureAt,
              ...(originalEventTime ? { originalEventTime } : {}),
              ...(normalizedEventTime ? { eventTimeUtc: normalizedEventTime } : {}),
              pageTimeZoneAssumption: pageTimeZone,
              fields,
              fieldsDigest
            });
            const pageRecords = byPage.get(page) ?? [];
            pageRecords.push(record);
            byPage.set(page, pageRecords);
          }
          for (let page = 1; page <= pageCount; page += 1) {
            const payload: JsonValue = {
              projectId: item.itemKey,
              sourceTab,
              page,
              records: byPage.get(page) ?? []
            };
            sourceCaptures.push({
              captureId: stableId("binance-capture", {
                collectionRunId,
                projectId: item.itemKey,
                sourceTab,
                page
              }),
              sourceKind: "project_tab",
              projectId: item.itemKey,
              sourceTab,
              page,
              sourceUrl: detailUrl,
              captureAt: detailCaptureAt,
              recordCount: byPage.get(page)?.length ?? 0,
              payloadDigest: digest(payload),
              payload
            });
            projectPageCount += 1;
          }
        }
      }
      eventTimes.sort();
      const contentDigest = digest({
        management,
        projects: projectOutputs.map((item) => item.output)
      });
      const persisted = this.store.persistBinanceCopyTradingCapture({
        collectionRunId,
        workflowRunId: invocation.identity.runId,
        sourceUrl,
        attemptAt: this.now().toISOString(),
        captureAt,
        status:
          status === "empty_confirmed"
            ? "authenticated_but_no_data"
            : "success",
        contentDigest,
        projectCount: projectsById.size,
        pageCount: 1 + projectPageCount,
        recordCount: rawRecords.length,
        ...(eventTimes[0] === undefined
          ? {}
          : { oldestEventTimeUtc: eventTimes[0] }),
        ...(eventTimes.at(-1) === undefined
          ? {}
          : { newestEventTimeUtc: eventTimes.at(-1)! }),
        executionContext: executionContext(invocation),
        sourceCaptures,
        projects: projectSnapshots,
        positions,
        rawRecords
      });
      return succeeded({
        status: persisted.run.status,
        collectionRunId: persisted.run.collectionRunId,
        captureAt: persisted.run.captureAt,
        lastSuccessAt: persisted.run.lastSuccessAt ?? null,
        collectedProjectCount: persisted.run.projectCount,
        pageCount: persisted.run.pageCount,
        recordCount: persisted.run.recordCount,
        newRecordCount: persisted.newCurrentRecordCount,
        oldestEventTimeUtc: persisted.run.oldestEventTimeUtc ?? null,
        newestEventTimeUtc: persisted.run.newestEventTimeUtc ?? null,
        duplicate: persisted.status === "duplicate"
      });
    } catch (error) {
      return failed(
        "BINANCE_CAPTURE_PERSIST_FAILED",
        error instanceof Error
          ? `Binance capture was not committed: ${error.message}`
          : "Binance capture was not committed."
      );
    }
  }
}
