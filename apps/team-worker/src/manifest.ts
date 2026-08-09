import { createHash } from "node:crypto";
import {
  TEAM_PROTOCOL_VERSION,
  teamCodeDigest
} from "@bpa/team-runtime";

export const TEAM_WORKER_VERSION = "0.6.1";

function implementationDigest(ref: string, implementation: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ ref, implementation }))
    .digest("hex")}`;
}

export const TEAM_WORKER_HANDLER_MANIFEST = [
  {
    ref: "inventory.forecast-input.read@1.0.0",
    implementationDigest: implementationDigest(
      "inventory.forecast-input.read@1.0.0",
      "inventory-service-uds:forecast-input:repeatable-read:v1"
    )
  },
  {
    ref: "inventory.forecast-input.read@1.0.1",
    implementationDigest: implementationDigest(
      "inventory.forecast-input.read@1.0.1",
      "inventory-service-uds:forecast-input:quality-fallback:repeatable-read:v2"
    )
  },
  {
    ref: "sales-demand.forecast@1.0.0",
    implementationDigest: implementationDigest(
      "sales-demand.forecast@1.0.0",
      "inventory-demand-ensemble-conformal:hierarchical-fallback:bounded-pure:v2"
    )
  },
  {
    ref: "inventory.channel-consumption.estimate@1.0.0",
    implementationDigest: implementationDigest(
      "inventory.channel-consumption.estimate@1.0.0",
      "channel-negative-delta-share:cold-start-3d:v1"
    )
  },
  {
    ref: "inventory.risk.evaluate@1.0.0",
    implementationDigest: implementationDigest(
      "inventory.risk.evaluate@1.0.0",
      "inventory-balanced-shadow:p90-2h-6h-reserve-24h:freshness-gates:v2"
    )
  },
  {
    ref: "ecommerce.intent.normalize@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.intent.normalize@1.0.0",
      "ecommerce-product-intent-v1:bounded-pure"
    )
  },
  {
    ref: "ecommerce.category-space.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.category-space.build@1.0.0",
      "ecommerce-category-space-v1:modal-platform-category"
    )
  },
  {
    ref: "ecommerce.comparable-pool.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.comparable-pool.build@1.0.0",
      "ecommerce-comparable-pool-v1:ready-pack-category"
    )
  },
  {
    ref: "ecommerce.evidence.evaluate@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.evidence.evaluate@1.0.0",
      "ecommerce-evidence-v1:range-preserving-e1-e2"
    )
  },
  {
    ref: "ecommerce.reference-pack.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.reference-pack.build@1.0.0",
      "ecommerce-reference-pack-v1:asset-ref-only"
    )
  },
  {
    ref: "ecommerce.discovery.merge@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.discovery.merge@1.0.0",
      "marketplace-three-probe-merge:bounded-visible-facts:v1"
    )
  },
  {
    ref: "ecommerce.discovery.category-space.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.discovery.category-space.build@1.0.0",
      "consumer-need-first:platform-discovery-branches:v1"
    )
  },
  {
    ref: "ecommerce.discovery.comparable-pool.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.discovery.comparable-pool.build@1.0.0",
      "explicit-core-packaging-exclusion-terms:v1"
    )
  },
  {
    ref: "ecommerce.discovery.evidence.evaluate@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.discovery.evidence.evaluate@1.0.0",
      "visible-search-facts-only:maximum-e1:v1"
    )
  },
  {
    ref: "ecommerce.discovery.reference-pack.build@1.0.0",
    implementationDigest: implementationDigest(
      "ecommerce.discovery.reference-pack.build@1.0.0",
      "remote-main-image-candidates:pending-download:v1"
    )
  },
  {
    ref: "packaging.products.normalize@1.0.0",
    implementationDigest: implementationDigest(
      "packaging.products.normalize@1.0.0",
      "scope-products-to-packaging-input:v1"
    )
  },
  {
    ref: "packaging.master.match.batch@1.0.0",
    implementationDigest: implementationDigest(
      "packaging.master.match.batch@1.0.0",
      "packaging-smart-v1:trusted-static-v1"
    )
  },
  {
    ref: "packaging.master.match.batch@1.1.0",
    implementationDigest: implementationDigest(
      "packaging.master.match.batch@1.1.0",
      "packaging-smart-v1:ordered-inspection-queue:opaque-review-batch:v2"
    )
  },
  {
    ref: "packaging.dataset.parse@1.0.0",
    implementationDigest: implementationDigest(
      "packaging.dataset.parse@1.0.0",
      "packaging-master-v1:base64-512k:result-500:v1"
    )
  },
  {
    ref: "issues.reconcile@1.0.0",
    implementationDigest: implementationDigest(
      "issues.reconcile@1.0.0",
      "priority-page-findings-only:diagnostics-not-business-issues:v2"
    )
  },
  {
    ref: "report.issue.build@1.0.0",
    implementationDigest: implementationDigest(
      "report.issue.build@1.0.0",
      "deterministic-report:match-and-diagnostics-not-business-issues:v2"
    )
  }
] as const;

export const TEAM_WORKER_HANDLER_REFS = TEAM_WORKER_HANDLER_MANIFEST.map(
  ({ ref }) => ref
);

export const TEAM_WORKER_CODE_DIGEST = teamCodeDigest({
  protocolVersion: TEAM_PROTOCOL_VERSION,
  workerVersion: TEAM_WORKER_VERSION,
  handlers: TEAM_WORKER_HANDLER_MANIFEST
});
