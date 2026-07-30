import { loadCatalog } from "./docs-catalog.mjs";

const catalog = await loadCatalog();
const publicCount = catalog.entries.filter((entry) => entry.public).length;
const privateCount = catalog.entries.length - publicCount;

console.log(
  `Validated ${catalog.entries.length} documentation entries (${publicCount} public, ${privateCount} internal).`
);
