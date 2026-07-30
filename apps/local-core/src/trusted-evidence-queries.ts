import type { ExportRecord, Persistence } from "@bpa/persistence";
import type { JsonValue } from "@bpa/workflow-ir";

export class TrustedEvidenceQueryService {
  constructor(private readonly persistence: Persistence) {}

  lineage(runId: string): unknown {
    if (!this.persistence.getRun(runId)) {
      throw new Error(`Run not found: ${runId}`);
    }
    const evidence = this.persistence.listEvidenceTransfersForRun({
      runId,
      limit: 200
    }).records;
    const links = this.persistence.listEvidenceLinksForRun({
      runId,
      limit: 200
    }).records;
    const sources = this.persistence.listSourceRecordsForRun({
      runId,
      limit: 200
    }).records;
    const assets = this.persistence.listAssetRecordsForRun({
      runId,
      limit: 200
    }).records;
    const evidenceSources = new Map<string, Set<string>>();
    const assetEvidence = new Map<string, Set<string>>();
    for (const link of links) {
      const sourceIds =
        evidenceSources.get(link.evidenceId) ?? new Set<string>();
      link.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
      evidenceSources.set(link.evidenceId, sourceIds);
      for (const assetId of link.assetIds ?? []) {
        const evidenceIds =
          assetEvidence.get(assetId) ?? new Set<string>();
        evidenceIds.add(link.evidenceId);
        assetEvidence.set(assetId, evidenceIds);
      }
    }
    return {
      runId,
      sources: sources.map((source) => ({
        id: source.sourceId,
        label: source.title ?? source.sourceType,
        origin: sourceOrigin(source.locator),
        observedAt: source.observedAt
      })),
      evidence: evidence.map((item) => ({
        id: item.evidenceId,
        label: item.kind.replaceAll("_", " "),
        classification:
          item.classification === "confidential"
            ? "confidential"
            : item.classification === "public"
              ? "public"
              : "restricted",
        digest: item.digest,
        sourceIds: [...(evidenceSources.get(item.evidenceId) ?? [])].sort()
      })),
      assets: assets.map((asset) => ({
        id: asset.assetId,
        label: asset.mediaType,
        digest: asset.digest,
        evidenceIds: [...(assetEvidence.get(asset.assetId) ?? [])].sort()
      }))
    };
  }

  listDownloads(runId: string | undefined): unknown[] {
    if (!runId) return [];
    return this.persistence
      .listExportRecordsForRun({ runId, limit: 100 })
      .records
      .filter(
        (record) =>
          record.status === "ready" &&
          (record.exportType === "issue_report" ||
            record.exportType === "reference_asset_pack")
      )
      .map((record) => this.downloadView(record));
  }

  download(downloadId: string): unknown {
    const record = this.persistence.getExportRecord(downloadId);
    if (!record || record.status !== "ready") {
      throw new Error("Download is unavailable");
    }
    return this.downloadView(record);
  }

  private downloadView(record: ExportRecord): unknown {
    const metadata =
      record.metadata &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, JsonValue>)
        : {};
    const assets = this.persistence.getAssetRecords(record.assetIds);
    const defaultFileName =
      record.exportType === "reference_asset_pack"
        ? `${record.exportId}.json`
        : `${record.exportId}.html`;
    return {
      id: record.exportId,
      runId: record.runId,
      kind:
        record.exportType === "reference_asset_pack"
          ? "reference_pack"
          : "report",
      title:
        typeof metadata.title === "string"
          ? metadata.title
          : record.exportType === "reference_asset_pack"
            ? "参考资产包"
            : "业务报告",
      fileName:
        typeof metadata.fileName === "string"
          ? metadata.fileName
          : defaultFileName,
      sizeBytes: assets.reduce((total, asset) => total + asset.size, 0),
      createdAt: record.createdAt,
      assetIds: [...record.assetIds]
    };
  }
}

function sourceOrigin(locator: Record<string, unknown>): string {
  const url = locator.url;
  if (typeof url === "string") {
    try {
      return new URL(url).origin;
    } catch {
      return "来源已脱敏";
    }
  }
  return typeof locator.provider === "string"
    ? locator.provider
    : "来源已脱敏";
}
