export const publicSchemas = [
  "browser-protocol-v1.schema.json",
  "permission.schema.json",
  "timing-policy.schema.json",
  "risk-signal.schema.json",
  "workflow.schema.json",
  "workflow-v1alpha2.schema.json",
  "workflow-v1alpha3.schema.json",
  "node.schema.json",
  "node-v1alpha2.schema.json",
  "event.schema.json",
  "evidence.schema.json",
  "source-record.schema.json",
  "asset-record.schema.json",
  "evidence-link.schema.json",
  "assistance-task.schema.json",
  "dataset.schema.json",
  "decision-record.schema.json",
  "page-model.schema.json",
  "element-contract.schema.json"
];

export const publicExamples = [
  "browser-protocol-v1.messages.json",
  "control-hello-v1.example.json"
];

export const publicStaticAssets = ["og-v2.png"];

const catalog = await loadCatalog();

export const expectedRoutes = [
  ...catalog.entries
    .filter((entry) => entry.public)
    .map((entry) => (entry.route ? `${entry.route}/index.html` : "index.html")),
  "404.html"
];
import { loadCatalog } from "./docs-catalog.mjs";
