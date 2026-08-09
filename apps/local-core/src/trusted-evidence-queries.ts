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
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
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
    const exports = this.persistence.listExportRecordsForRun({
      runId,
      limit: 100
    }).records;
    for (const record of exports) {
      if (record.status !== "ready") continue;
      const exportedAssets = this.persistence.getAssetRecords(record.assetIds);
      for (const asset of exportedAssets) {
        assetById.set(asset.assetId, asset);
        for (const source of this.persistence.getSourceRecords(asset.sourceIds)) {
          sourceById.set(source.sourceId, source);
        }
      }
      if (
        (record.exportType === "evidence_bundle" ||
          record.exportType === "reference_asset_pack") &&
        record.metadata &&
        typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
      ) {
        const exportedMetadata = record.metadata as Record<string, JsonValue>;
        if (Array.isArray(exportedMetadata.assets)) {
          for (const value of exportedMetadata.assets) {
            if (!value || typeof value !== "object" || Array.isArray(value)) continue;
            const item = value as Record<string, JsonValue>;
            if (
              typeof item.assetId === "string" &&
              typeof item.sourceEvidenceId === "string"
            ) {
              const ids = assetEvidence.get(item.assetId) ?? new Set<string>();
              ids.add(item.sourceEvidenceId);
              assetEvidence.set(item.assetId, ids);
              const sourceIds =
                evidenceSources.get(item.sourceEvidenceId) ?? new Set<string>();
              for (const sourceId of assetById.get(item.assetId)?.sourceIds ?? []) {
                sourceIds.add(sourceId);
              }
              evidenceSources.set(item.sourceEvidenceId, sourceIds);
            }
          }
        }
      }
    }
    return {
      runId,
      sources: [...sourceById.values()].map((source) => ({
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
      assets: [...assetById.values()].map((asset) => ({
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
    const view = this.downloadView(record) as Record<string, unknown>;
    const fetchedAssets = this.persistence.getAssetRecords(record.assetIds);
    const assetsById = new Map(
      fetchedAssets.map((asset) => [asset.assetId, asset])
    );
    const assets = record.assetIds.flatMap((assetId) => {
      const asset = assetsById.get(assetId);
      return asset ? [asset] : [];
    });
    if (assets.length !== record.assetIds.length) {
      throw new Error("Download assets are incomplete");
    }
    return {
      manifestVersion: "bpa.download-manifest/1",
      ...view,
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        digest: asset.digest,
        sizeBytes: asset.size,
        mediaType: asset.mediaType,
        storageRef: asset.storageRef
      })),
      ...(record.exportType === "reference_asset_pack"
        ? { referencePack: this.referencePackManifest(record, assets) }
        : {})
    };
  }

  downloadAsset(downloadId: string, assetId: string): unknown {
    const manifest = this.download(downloadId) as {
      kind: string;
      assets: Array<Record<string, unknown>>;
    };
    if (
      manifest.kind !== "reference_pack" &&
      manifest.kind !== "reference_candidates"
    ) {
      throw new Error("Asset preview is unavailable");
    }
    const asset = manifest.assets.find((candidate) =>
      candidate.assetId === assetId
    );
    if (
      !asset ||
      !["image/jpeg", "image/png", "image/webp"].includes(
        String(asset.mediaType)
      )
    ) {
      throw new Error("Asset preview is unavailable");
    }
    return {
      manifestVersion: "bpa.download-asset/1",
      downloadId,
      ...asset
    };
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
        ? `${record.exportId}.zip`
        : record.exportType === "evidence_bundle"
          ? `${record.exportId}.zip`
        : `${record.exportId}.html`;
    return {
      id: record.exportId,
      runId: record.runId,
      kind:
        record.exportType === "reference_asset_pack"
          ? "reference_pack"
          : record.exportType === "evidence_bundle"
            ? "reference_candidates"
          : "report",
      title:
        typeof metadata.title === "string"
          ? metadata.title
          : record.exportType === "reference_asset_pack"
            ? "参考资产包"
            : record.exportType === "evidence_bundle"
              ? "待策展参考图片"
            : "业务报告",
      fileName:
        typeof metadata.fileName === "string"
          ? metadata.fileName
          : defaultFileName,
      sizeBytes: assets.reduce((total, asset) => total + asset.size, 0),
      createdAt: record.createdAt,
      assetIds: [...record.assetIds],
      ...(record.exportType === "reference_asset_pack" ||
      record.exportType === "evidence_bundle"
        ? {
            rightsStatus: "not_assessed",
            allowedUse: "internal_reference_only",
            blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
          }
        : {})
    };
  }

  private referencePackManifest(
    record: ExportRecord,
    assets: ReturnType<Persistence["getAssetRecords"]>
  ): unknown {
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Reference pack metadata is invalid");
    }
    const value = metadata as Record<string, JsonValue>;
    if (
      value.schemaVersion !== "reference-asset-pack/v1" ||
      value.exportId !== record.exportId ||
      value.sourceRunId !== record.runId ||
      value.status !== "ready_internal_reference" ||
      value.rightsStatus !== "not_assessed" ||
      value.allowedUse !== "internal_reference_only" ||
      value.assetCount !== record.assetIds.length ||
      !Array.isArray(value.assets) ||
      value.assets.length !== record.assetIds.length ||
      JSON.stringify(value.blockers) !== JSON.stringify([
        "SOURCE_RIGHTS_NOT_ASSESSED"
      ])
    ) {
      throw new Error("Reference pack metadata is invalid");
    }
    const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
    const safeAssets = value.assets.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Reference pack metadata is invalid");
      }
      const item = entry as Record<string, JsonValue>;
      const assetId = typeof item.assetId === "string" ? item.assetId : "";
      const asset = byId.get(assetId);
      if (
        !asset ||
        item.digest !== asset.digest ||
        item.sizeBytes !== asset.size ||
        item.mediaType !== asset.mediaType ||
        item.rightsStatus !== "not_assessed" ||
        item.allowedUse !== "internal_reference_only" ||
        typeof item.sourceEvidenceId !== "string" ||
        typeof item.role !== "string" ||
        typeof item.reason !== "string" ||
        !Array.isArray(item.allowedTransferDimensions) ||
        !Array.isArray(item.prohibitedInferences)
      ) {
        throw new Error("Reference pack metadata is invalid");
      }
      return {
        assetId,
        digest: asset.digest,
        sizeBytes: asset.size,
        mediaType: asset.mediaType,
        platform: item.platform,
        discoveryId: item.discoveryId,
        sourceUrl: item.sourceUrl,
        sourcePageUrl: item.sourcePageUrl,
        sourceEvidenceId: item.sourceEvidenceId,
        role: item.role,
        reason: item.reason,
        allowedTransferDimensions: item.allowedTransferDimensions,
        prohibitedInferences: item.prohibitedInferences,
        rightsStatus: "not_assessed",
        allowedUse: "internal_reference_only"
      };
    });
    if (
      JSON.stringify(safeAssets.map((asset) => asset.assetId)) !==
      JSON.stringify(record.assetIds)
    ) {
      throw new Error("Reference pack metadata is invalid");
    }
    return {
      schemaVersion: "reference-asset-pack/v1",
      exportId: record.exportId,
      packId: value.packId,
      sourceRunId: record.runId,
      status: "ready_internal_reference",
      rightsStatus: "not_assessed",
      allowedUse: "internal_reference_only",
      assetCount: safeAssets.length,
      assets: safeAssets,
      blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
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
