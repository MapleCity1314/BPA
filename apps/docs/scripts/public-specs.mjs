import { loadCatalog } from "./docs-catalog.mjs";
import {
  publicExamples,
  publicSchemas as publicSchemaRecords,
  publicStaticAssets
} from "../src/data/public-artifacts.mjs";

export const publicSchemas = publicSchemaRecords.map(([file]) => file);
export { publicExamples, publicStaticAssets };

const catalog = await loadCatalog();

export const expectedRoutes = [
  ...catalog.entries
    .filter((entry) => entry.public)
    .map((entry) => (entry.route ? `${entry.route}/index.html` : "index.html")),
  "404.html"
];
