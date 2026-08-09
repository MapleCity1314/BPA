import {
  buildCategorySpace,
  buildComparablePool,
  buildDiscoveryCategorySpace,
  buildDiscoveryComparablePool,
  buildDiscoveryReferencePack,
  buildReferencePack,
  evaluateDiscoveryEvidence,
  evaluateViralEvidence,
  mergeMarketplaceProbes,
  normalizeProductIntent
} from "@bpa/ecommerce-evidence-domain";
import {
  buildDeterministicIssueReport,
  MAX_RECONCILE_PRODUCTS,
  PACKAGING_MATCHER_VERSION,
  matchPackagingBatch,
  matchPackagingInspectionBatch,
  normalizePackagingProducts,
  reconcilePriorityInspectionResults,
  type PackagingBinding,
  type CollectedPackagingProduct,
  type PackagingInspectionProduct,
  type PackagingMasterRecord,
  type PackagingProduct
} from "@bpa/packaging-domain";
import { parsePackagingDataset } from "@bpa/packaging-dataset";
import {
  TeamHandlerError,
  TeamHandlerRegistry
} from "@bpa/team-runtime";
import type { DecisionReuseContext } from "@bpa/dataset-core";
import {
  estimateChannelShares,
  evaluateInventoryRisk,
  forecastDemand,
  type ChannelStockPoint,
  type ChannelShareEstimate,
  type DemandForecast,
  type DemandObservation,
  type FactEnvelope,
  type InventoryProductFact
} from "@bpa/inventory-domain";
import type { JsonValue } from "@bpa/workflow-ir";
import { invokeInventoryService } from "./inventory-service-client.js";
import {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_MANIFEST,
  TEAM_WORKER_HANDLER_REFS,
  TEAM_WORKER_VERSION
} from "./manifest.js";

export const PACKAGING_MATCH_HANDLER_REF =
  "packaging.master.match.batch@1.0.0";
export const PACKAGING_INSPECTION_MATCH_HANDLER_REF =
  "packaging.master.match.batch@1.1.0";
export const PACKAGING_PRODUCTS_NORMALIZE_HANDLER_REF =
  "packaging.products.normalize@1.0.0";
export const PACKAGING_DATASET_PARSE_HANDLER_REF =
  "packaging.dataset.parse@1.0.0";
export const ISSUES_RECONCILE_HANDLER_REF =
  "issues.reconcile@1.0.0";
export const REPORT_ISSUE_BUILD_HANDLER_REF =
  "report.issue.build@1.0.0";
export const ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF =
  "ecommerce.intent.normalize@1.0.0";
export const ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF =
  "ecommerce.category-space.build@1.0.0";
export const ECOMMERCE_COMPARABLE_POOL_BUILD_HANDLER_REF =
  "ecommerce.comparable-pool.build@1.0.0";
export const ECOMMERCE_EVIDENCE_EVALUATE_HANDLER_REF =
  "ecommerce.evidence.evaluate@1.0.0";
export const ECOMMERCE_REFERENCE_PACK_BUILD_HANDLER_REF =
  "ecommerce.reference-pack.build@1.0.0";
export const ECOMMERCE_DISCOVERY_MERGE_HANDLER_REF =
  "ecommerce.discovery.merge@1.0.0";
export const ECOMMERCE_DISCOVERY_CATEGORY_SPACE_BUILD_HANDLER_REF =
  "ecommerce.discovery.category-space.build@1.0.0";
export const ECOMMERCE_DISCOVERY_COMPARABLE_POOL_BUILD_HANDLER_REF =
  "ecommerce.discovery.comparable-pool.build@1.0.0";
export const ECOMMERCE_DISCOVERY_EVIDENCE_EVALUATE_HANDLER_REF =
  "ecommerce.discovery.evidence.evaluate@1.0.0";
export const ECOMMERCE_DISCOVERY_REFERENCE_PACK_BUILD_HANDLER_REF =
  "ecommerce.discovery.reference-pack.build@1.0.0";
export const SALES_DEMAND_FORECAST_HANDLER_REF =
  "sales-demand.forecast@1.0.0";
export const INVENTORY_CHANNEL_ESTIMATE_HANDLER_REF =
  "inventory.channel-consumption.estimate@1.0.0";
export const INVENTORY_RISK_EVALUATE_HANDLER_REF =
  "inventory.risk.evaluate@1.0.0";
export const SALES_DEMAND_SYNC_HANDLER_REF = "ecom.sales-demand.sync@1.0.0";
export const SALES_DEMAND_RECENT_PERSIST_HANDLER_REF = "ecom.sales-demand.recent.persist@1.0.0";
export const INVENTORY_FORECAST_INPUT_READ_HANDLER_REF = "inventory.forecast-input.read@1.0.0";
export const INVENTORY_FORECAST_INPUT_READ_V101_HANDLER_REF = "inventory.forecast-input.read@1.0.1";
export const INVENTORY_FORECAST_PERSIST_HANDLER_REF = "inventory.forecast.persist@1.0.0";
export const INVENTORY_RISK_PERSIST_HANDLER_REF = "inventory.risk.persist@1.0.0";
export const INVENTORY_SHADOW_PRODUCT_COMPUTE_HANDLER_REF = "inventory.shadow.product.compute@1.0.0";

const MAX_TEAM_DATASET_BYTES = 512 * 1024;
const MAX_TEAM_DATASET_BASE64_LENGTH = 700_000;
const MAX_TEAM_DATASET_RECORDS = 500;
const MAX_TEAM_DATASET_MESSAGES = 200;
const MAX_TEAM_HANDLER_OUTPUT_BYTES = 800 * 1024;

if (PACKAGING_MATCHER_VERSION !== "packaging-smart-v1") {
  throw new Error("Team Worker manifest must be updated for the new matcher");
}

function objectMap<T>(
  value: unknown,
  label: string
): ReadonlyMap<string, T> {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      `${label} must be an object`
    );
  }
  return new Map(Object.entries(value as Record<string, T>));
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function inputObject(input: JsonValue, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      `${label} must be an object`
    );
  }
  return input as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum
  ) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      `${label} must be a 1-${maximum} character string`
    );
  }
  return value;
}

function ensureActive(signal: AbortSignal, label: string): void {
  if (signal.aborted) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_CANCELLED",
      `${label} was cancelled`
    );
  }
}

function boundedOutput(value: unknown): JsonValue {
  const output = asJsonValue(value);
  if (
    Buffer.byteLength(JSON.stringify(output), "utf8") >
    MAX_TEAM_HANDLER_OUTPUT_BYTES
  ) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_RESULT_LIMIT_EXCEEDED",
      "Team Handler output exceeds the trusted result limit"
    );
  }
  return output;
}

function domainResult(
  label: string,
  signal: AbortSignal,
  operation: () => unknown
): JsonValue {
  ensureActive(signal, label);
  try {
    const result = operation();
    ensureActive(signal, label);
    return boundedOutput(result);
  } catch (error) {
    if (error instanceof TeamHandlerError) throw error;
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function decodeDatasetBytes(value: unknown): Uint8Array {
  const content = boundedString(
    value,
    "contentBase64",
    MAX_TEAM_DATASET_BASE64_LENGTH
  );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      content
    )
  ) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      "contentBase64 must use canonical base64 encoding"
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_TEAM_DATASET_BYTES ||
    bytes.toString("base64") !== content
  ) {
    throw new TeamHandlerError(
      "TEAM_HANDLER_INPUT_INVALID",
      `Decoded dataset must be 1-${MAX_TEAM_DATASET_BYTES} bytes`
    );
  }
  return bytes;
}

const manifestDigest = (ref: string): string => {
  const entry = TEAM_WORKER_HANDLER_MANIFEST.find(
    (candidate) => candidate.ref === ref
  );
  if (!entry) throw new Error(`Team Handler manifest entry is missing: ${ref}`);
  return entry.implementationDigest;
};

export const teamHandlerRegistry = new TeamHandlerRegistry([
  {
    node: { id: "ecom.sales-demand.sync", version: "1.0.0" },
    implementationDigest: manifestDigest(SALES_DEMAND_SYNC_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Sales demand sync input");
      return invokeInventoryService("sales-demand.sync", {
        shopId: boundedString(candidate.shopId, "shopId", 200),
        shopName: boundedString(candidate.shopName, "shopName", 200),
        lease:inputObject(candidate.lease as JsonValue,"lease")
      }, signal);
    }
  },
  {
    node: { id: "ecom.sales-demand.recent.persist", version: "1.0.0" },
    implementationDigest: manifestDigest(SALES_DEMAND_RECENT_PERSIST_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input,"Recent sales demand persist input");
      return invokeInventoryService("sales-demand.recent.persist",{
        snapshot:inputObject(candidate.snapshot as JsonValue,"snapshot"),
        lease:inputObject(candidate.lease as JsonValue,"lease")
      },signal);
    }
  },
  {
    node: { id: "inventory.forecast-input.read", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_FORECAST_INPUT_READ_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory forecast input read");
      return invokeInventoryService("inventory.forecast-input.read", {
        shopId: boundedString(candidate.shopId, "shopId", 200),
        productId: boundedString(candidate.productId, "productId", 200),
        asOf: boundedString(candidate.asOf, "asOf", 100)
      }, signal);
    }
  },
  {
    node: { id: "inventory.forecast-input.read", version: "1.0.1" },
    implementationDigest: manifestDigest(INVENTORY_FORECAST_INPUT_READ_V101_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory forecast input read");
      return invokeInventoryService("inventory.forecast-input.read", {
        shopId: boundedString(candidate.shopId, "shopId", 200),
        productId: boundedString(candidate.productId, "productId", 200),
        asOf: boundedString(candidate.asOf, "asOf", 100)
      }, signal);
    }
  },
  {
    node: { id: "inventory.forecast.persist", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_FORECAST_PERSIST_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory forecast persist input");
      return invokeInventoryService("inventory.forecast.persist", candidate, signal);
    }
  },
  {
    node: { id: "inventory.risk.persist", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_RISK_PERSIST_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory risk persist input");
      return invokeInventoryService("inventory.risk.persist", candidate, signal);
    }
  },
  {
    node: { id: "inventory.shadow.product.compute", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_SHADOW_PRODUCT_COMPUTE_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory shadow product input");
      const envelope = candidate.envelope as FactEnvelope<InventoryProductFact>;
      const inputs = candidate.inputs;
      if (!Array.isArray(inputs) || inputs.length > 500) {
        throw new TeamHandlerError("TEAM_HANDLER_INPUT_INVALID", "Inventory product computation requires at most 500 SKU inputs");
      }
      return domainResult("Inventory shadow product computation", signal, () => {
        const forecasts: Record<string, DemandForecast> = {};
        const channelEstimates: Record<string, ChannelShareEstimate> = {};
        const persistableForecasts: Record<string, unknown>[] = [];
        for (const raw of inputs) {
          const item = raw as Record<string, unknown>;
          const platformSkuId = boundedString(item.platformSkuId, "platformSkuId", 200);
          const merchantCode = boundedString(item.merchantCode, "merchantCode", 200);
          const observations = Array.isArray(item.observations)
            ? item.observations as DemandObservation[]
            : [];
          const channelPoints = Array.isArray(item.channelPoints)
            ? item.channelPoints as ChannelStockPoint[]
            : [];
          const forecast = forecastDemand({
            asOf: boundedString(candidate.evaluatedAt, "evaluatedAt", 100),
            observations,
            ...(item.fallbackHourlyRate === undefined ? {} : {
              fallbackHourlyRate:Number(item.fallbackHourlyRate)
            }),
            ...(item.fallbackReason === undefined ? {} : {
              fallbackReason:boundedString(item.fallbackReason,"fallbackReason",500)
            })
          });
          const cutoff = Date.parse(forecast.asOf) - 3 * 24 * 60 * 60 * 1000;
          const observedSkuDemand = observations.reduce((sum, point) =>
            Date.parse(point.at) >= cutoff ? sum + point.quantity : sum, 0);
          forecasts[platformSkuId] = forecast;
          channelEstimates[platformSkuId] = estimateChannelShares({
            asOf: forecast.asOf,
            points: channelPoints,
            observedSkuDemand
          });
          persistableForecasts.push({
            shopId: envelope.scope.shopId,
            productId: envelope.facts.productId,
            platformSkuId,
            merchantCode,
            sourceDataset: item.sourceDataset,
            forecast,
            lease:inputObject(candidate.lease as JsonValue,"lease")
          });
        }
        const demandQuality = (
          inputs[0] as Record<string, unknown> | undefined
        )?.demandQuality as
          | {
              recentObservedAt?: string;
              historicalCompleteThrough?: string;
            }
          | undefined;
        return {
          forecasts,
          channelEstimates,
          persistableForecasts,
          evaluation: evaluateInventoryRisk({
            evaluatedAt: boundedString(candidate.evaluatedAt, "evaluatedAt", 100),
            envelope,
            forecasts,
            channelEstimates,
            ...(demandQuality === undefined ? {} : { demandQuality })
          })
        };
      });
    }
  },
  {
    node: { id: "sales-demand.forecast", version: "1.0.0" },
    implementationDigest: manifestDigest(SALES_DEMAND_FORECAST_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Sales demand forecast input");
      if (!Array.isArray(candidate.observations) || candidate.observations.length > 2_160) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          "Sales demand forecast requires at most 2160 hourly observations"
        );
      }
      return domainResult("Sales demand forecast", signal, () =>
        forecastDemand({
          asOf: boundedString(candidate.asOf, "asOf", 100),
          observations: candidate.observations as DemandObservation[],
          ...(candidate.fallbackHourlyRate === undefined
            ? {}
            : { fallbackHourlyRate: Number(candidate.fallbackHourlyRate) }),
          ...(candidate.fallbackReason === undefined
            ? {}
            : { fallbackReason:boundedString(candidate.fallbackReason,"fallbackReason",500) })
        })
      );
    }
  },
  {
    node: { id: "inventory.channel-consumption.estimate", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_CHANNEL_ESTIMATE_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Channel consumption input");
      if (!Array.isArray(candidate.points) || candidate.points.length > 20_000) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          "Channel consumption estimation requires at most 20000 stock points"
        );
      }
      return domainResult("Channel consumption estimation", signal, () =>
        estimateChannelShares({
          asOf: boundedString(candidate.asOf, "asOf", 100),
          points: candidate.points as ChannelStockPoint[],
          ...(candidate.observedSkuDemand === undefined
            ? {}
            : { observedSkuDemand: Number(candidate.observedSkuDemand) })
        })
      );
    }
  },
  {
    node: { id: "inventory.risk.evaluate", version: "1.0.0" },
    implementationDigest: manifestDigest(INVENTORY_RISK_EVALUATE_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Inventory risk input");
      return domainResult("Inventory risk evaluation", signal, () =>
        evaluateInventoryRisk({
          evaluatedAt: boundedString(candidate.evaluatedAt, "evaluatedAt", 100),
          envelope: candidate.envelope as FactEnvelope<InventoryProductFact>,
          forecasts: candidate.forecasts as Readonly<Record<string, DemandForecast>>,
          channelEstimates: candidate.channelEstimates as Readonly<Record<string, ChannelShareEstimate>>,
          ...(candidate.demandQuality === undefined ? {} : {
            demandQuality:candidate.demandQuality as { recentObservedAt?: string; historicalCompleteThrough?: string }
          })
        })
      );
    }
  },
  {
    node: { id: "ecommerce.intent.normalize", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Ecommerce product intent normalization", signal, () =>
        normalizeProductIntent(input)
      );
    }
  },
  {
    node: { id: "ecommerce.category-space.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Ecommerce category-space building", signal, () =>
        buildCategorySpace(input)
      );
    }
  },
  {
    node: { id: "ecommerce.comparable-pool.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_COMPARABLE_POOL_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Ecommerce comparable-pool building", signal, () =>
        buildComparablePool(input)
      );
    }
  },
  {
    node: { id: "ecommerce.evidence.evaluate", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_EVIDENCE_EVALUATE_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Ecommerce evidence evaluation", signal, () =>
        evaluateViralEvidence(input)
      );
    }
  },
  {
    node: { id: "ecommerce.reference-pack.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_REFERENCE_PACK_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Ecommerce reference-pack building", signal, () =>
        buildReferencePack(input)
      );
    }
  },
  {
    node: { id: "ecommerce.discovery.merge", version: "1.0.0" },
    implementationDigest: manifestDigest(ECOMMERCE_DISCOVERY_MERGE_HANDLER_REF),
    invoke(input, signal) {
      return domainResult("Marketplace probe merge", signal, () =>
        mergeMarketplaceProbes(input)
      );
    }
  },
  {
    node: { id: "ecommerce.discovery.category-space.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_DISCOVERY_CATEGORY_SPACE_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Discovery category-space building", signal, () =>
        buildDiscoveryCategorySpace(input)
      );
    }
  },
  {
    node: { id: "ecommerce.discovery.comparable-pool.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_DISCOVERY_COMPARABLE_POOL_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Discovery comparable-pool building", signal, () =>
        buildDiscoveryComparablePool(input)
      );
    }
  },
  {
    node: { id: "ecommerce.discovery.evidence.evaluate", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_DISCOVERY_EVIDENCE_EVALUATE_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Discovery evidence evaluation", signal, () =>
        evaluateDiscoveryEvidence(input)
      );
    }
  },
  {
    node: { id: "ecommerce.discovery.reference-pack.build", version: "1.0.0" },
    implementationDigest: manifestDigest(
      ECOMMERCE_DISCOVERY_REFERENCE_PACK_BUILD_HANDLER_REF
    ),
    invoke(input, signal) {
      return domainResult("Discovery reference-pack building", signal, () =>
        buildDiscoveryReferencePack(input)
      );
    }
  },
  {
    node: {
      id: "packaging.products.normalize",
      version: "1.0.0"
    },
    implementationDigest: manifestDigest(
      PACKAGING_PRODUCTS_NORMALIZE_HANDLER_REF
    ),
    invoke(input, signal) {
      const candidate = inputObject(input, "Packaging products input");
      if (
        !Array.isArray(candidate.products) ||
        candidate.products.length > MAX_RECONCILE_PRODUCTS
      ) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          `Packaging product normalization requires at most ${MAX_RECONCILE_PRODUCTS} products`
        );
      }
      return domainResult("Packaging product normalization", signal, () =>
        normalizePackagingProducts(
          boundedString(candidate.shopId, "shopId", 200),
          candidate.products as unknown as CollectedPackagingProduct[]
        )
      );
    }
  },
  {
    node: {
      id: "packaging.master.match.batch",
      version: "1.0.0"
    },
    implementationDigest: manifestDigest(PACKAGING_MATCH_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Packaging match input");
      if (
        !Array.isArray(candidate.products) ||
        !Array.isArray(candidate.records) ||
        candidate.products.length > MAX_RECONCILE_PRODUCTS ||
        candidate.records.length > MAX_TEAM_DATASET_RECORDS
      ) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          `Packaging match requires at most ${MAX_RECONCILE_PRODUCTS} products and ${MAX_TEAM_DATASET_RECORDS} records`
        );
      }
      return domainResult("Packaging match", signal, () =>
        matchPackagingBatch(
          candidate.products as PackagingProduct[],
          candidate.records as PackagingMasterRecord[],
          objectMap<PackagingBinding>(candidate.bindings, "bindings"),
          objectMap<DecisionReuseContext>(
            candidate.reuseContexts,
            "reuseContexts"
          )
        )
      );
    }
  },
  {
    node: {
      id: "packaging.master.match.batch",
      version: "1.1.0"
    },
    implementationDigest: manifestDigest(
      PACKAGING_INSPECTION_MATCH_HANDLER_REF
    ),
    invoke(input, signal) {
      const candidate = inputObject(input, "Packaging inspection match input");
      if (
        !Array.isArray(candidate.products) ||
        !Array.isArray(candidate.records) ||
        candidate.products.length > MAX_RECONCILE_PRODUCTS ||
        candidate.records.length > MAX_TEAM_DATASET_RECORDS
      ) {
        throw new TeamHandlerError(
          "TEAM_HANDLER_INPUT_INVALID",
          `Packaging inspection match requires at most ${MAX_RECONCILE_PRODUCTS} products and ${MAX_TEAM_DATASET_RECORDS} records`
        );
      }
      return domainResult("Packaging inspection match", signal, () =>
        matchPackagingInspectionBatch(
          candidate.products as PackagingInspectionProduct[],
          candidate.records as PackagingMasterRecord[],
          objectMap<PackagingBinding>(candidate.bindings, "bindings"),
          objectMap<DecisionReuseContext>(
            candidate.reuseContexts,
            "reuseContexts"
          )
        )
      );
    }
  },
  {
    node: { id: "packaging.dataset.parse", version: "1.0.0" },
    implementationDigest: manifestDigest(PACKAGING_DATASET_PARSE_HANDLER_REF),
    invoke(input, signal) {
      const candidate = inputObject(input, "Packaging dataset input");
      return domainResult("Packaging dataset parse", signal, () => {
        const imported = parsePackagingDataset({
          bytes: decodeDatasetBytes(candidate.contentBase64),
          fileName: boundedString(candidate.fileName, "fileName", 500),
          version: boundedString(candidate.version, "version", 100),
          ...(candidate.datasetId === undefined
            ? {}
            : {
                datasetId: boundedString(
                  candidate.datasetId,
                  "datasetId",
                  200
                )
              }),
          ...(candidate.title === undefined
            ? {}
            : { title: boundedString(candidate.title, "title", 200) })
        });
        if (
          imported.records.length > MAX_TEAM_DATASET_RECORDS ||
          imported.errors.length > MAX_TEAM_DATASET_MESSAGES ||
          imported.warnings.length > MAX_TEAM_DATASET_MESSAGES
        ) {
          throw new TeamHandlerError(
            "TEAM_HANDLER_RESULT_LIMIT_EXCEEDED",
            "Packaging dataset result exceeds the trusted import limit"
          );
        }
        return imported;
      });
    }
  },
  {
    node: { id: "issues.reconcile", version: "1.0.0" },
    implementationDigest: manifestDigest(ISSUES_RECONCILE_HANDLER_REF),
    invoke(input, signal) {
      return domainResult("Issue reconciliation", signal, () =>
        reconcilePriorityInspectionResults(input)
      );
    }
  },
  {
    node: { id: "report.issue.build", version: "1.0.0" },
    implementationDigest: manifestDigest(REPORT_ISSUE_BUILD_HANDLER_REF),
    invoke(input, signal) {
      return domainResult("Issue report build", signal, () =>
        buildDeterministicIssueReport(input)
      );
    }
  }
]);

if (
  JSON.stringify(teamHandlerRegistry.manifest()) !==
  JSON.stringify(
    [...TEAM_WORKER_HANDLER_MANIFEST].sort((left, right) =>
      left.ref.localeCompare(right.ref)
    )
  )
) {
  throw new Error("Team Worker Handler registry does not match its manifest");
}

export {
  TEAM_WORKER_CODE_DIGEST,
  TEAM_WORKER_HANDLER_REFS,
  TEAM_WORKER_VERSION
};
