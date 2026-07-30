import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDocuments, rawUrl, repoRoot } from "./docs-catalog.mjs";

const defaultOutputDir = join(repoRoot, "apps/docs/public");

function siteSettings() {
  const repository = process.env.GITHUB_REPOSITORY ?? "MapleCity1314/BPA";
  const [owner, repositoryName] = repository.split("/");
  const isUserSite =
    repositoryName?.toLowerCase() === `${owner?.toLowerCase()}.github.io`;
  return {
    site:
      process.env.DOCS_SITE ??
      (owner ? `https://${owner.toLowerCase()}.github.io` : "http://localhost:4321"),
    base:
      process.env.DOCS_BASE ??
      (process.env.GITHUB_ACTIONS === "true" && repositoryName && !isUserSite
        ? `/${repositoryName}`
        : "/BPA")
  };
}

function absoluteUrl(site, path) {
  return new URL(path.replace(/^\/+/, ""), `${site.replace(/\/+$/, "")}/`).toString();
}

function markdownBody(markdown) {
  return markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
    .replace(/^import\s+.+?;\s*$/gm, "")
    .replace(/^\s*\{["']\s+["']\}\s*$/gm, "")
    .replace(/^\s*<[A-Z][A-Za-z0-9]*\b[^>]*\/>\s*$/gm, "")
    .replace(/<\/?[a-z][^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function machineMarkdown(document, site, base) {
  const routeUrl = absoluteUrl(
    site,
    `${base.replace(/\/+$/, "")}/${document.route ? `${document.route}/` : ""}`
  );
  const raw = absoluteUrl(site, rawUrl(base, document.route));
  return [
    `# ${document.title}`,
    "",
    `> Authority: ${document.authority}`,
    `> Implementation: ${document.implementation}`,
    `> Canonical: ${routeUrl}`,
    `> Raw: ${raw}`,
    `> Digest: ${document.digest}`,
    "",
    markdownBody(document.markdown),
    ""
  ].join("\n");
}

export async function generatePublicDocumentation({
  outputDir = defaultOutputDir,
  site,
  base
} = {}) {
  const defaults = siteSettings();
  const resolvedSite = site ?? defaults.site;
  const resolvedBase = base ?? defaults.base;
  const documents = await publicDocuments();
  const indexEntries = documents.map((document) => {
    const urlPath = `${resolvedBase.replace(/\/+$/, "")}/${
      document.route ? `${document.route}/` : ""
    }`;
    return {
      id: document.id,
      title: document.title,
      summary: document.summary,
      url: absoluteUrl(resolvedSite, urlPath),
      rawUrl: absoluteUrl(resolvedSite, rawUrl(resolvedBase, document.route)),
      authority: document.authority,
      implementation: document.implementation,
      audience: document.audience,
      ...(document.since ? { since: document.since } : {}),
      digest: document.digest
    };
  });

  await Promise.all([
    rm(join(outputDir, "raw"), { recursive: true, force: true }),
    ...["llms.txt", "llms-full.txt", "docs-index.json", "robots.txt"].map((file) =>
      rm(join(outputDir, file), { force: true })
    )
  ]);

  for (const document of documents) {
    const target = join(
      outputDir,
      "raw",
      document.route ? `${document.route}.md` : "index.md"
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      machineMarkdown(document, resolvedSite, resolvedBase),
      "utf8"
    );
  }

  const index = {
    schemaVersion: "bpa.docs-index/1",
    siteVersion: "0.4.0",
    authorityOrder: [
      "current-state",
      "normative",
      "architecture",
      "operations",
      "tutorial",
      "plan",
      "research",
      "historical"
    ],
    entries: indexEntries
  };
  await writeFile(
    join(outputDir, "docs-index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8"
  );

  const llms = [
    "# BPA",
    "",
    "> BPA is a governed local browser workflow platform. Prefer verified current",
    "> state and normative contracts over plans, research, or historical notes.",
    "",
    "## Reading order",
    "",
    "1. Current state",
    "2. Normative protocols and models",
    "3. Architecture",
    "4. Operations and tutorials",
    "",
    "## Documents",
    "",
    ...indexEntries.map(
      (entry) =>
        `- [${entry.title}](${entry.rawUrl}): ${entry.summary} ` +
        `(${entry.authority}; ${entry.implementation})`
    ),
    "",
    "## Machine-readable index",
    "",
    `- ${absoluteUrl(resolvedSite, `${resolvedBase}/docs-index.json`)}`,
    `- ${absoluteUrl(resolvedSite, `${resolvedBase}/llms-full.txt`)}`,
    ""
  ].join("\n");
  await writeFile(join(outputDir, "llms.txt"), llms, "utf8");

  const full = [
    "# BPA Public Documentation",
    "",
    "Authority order: current state → normative → architecture → operations → tutorial.",
    "Plans, research, historical notes, private business sources, and local paths are excluded.",
    "",
    ...documents.map((document) =>
      machineMarkdown(document, resolvedSite, resolvedBase)
    )
  ].join("\n");
  await writeFile(join(outputDir, "llms-full.txt"), full, "utf8");

  const sitemapUrl = absoluteUrl(
    resolvedSite,
    `${resolvedBase.replace(/\/+$/, "")}/sitemap-index.xml`
  );
  const robots = [
    "User-agent: *",
    `Allow: ${resolvedBase.replace(/\/+$/, "")}/`,
    `Sitemap: ${sitemapUrl}`,
    "",
    "# This project-level file is not the host-root robots policy.",
    `# AI index: ${absoluteUrl(resolvedSite, `${resolvedBase}/llms.txt`)}`,
    ""
  ].join("\n");
  await writeFile(join(outputDir, "robots.txt"), robots, "utf8");

  return { documents, index, outputDir };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await generatePublicDocumentation();
  console.log(`Prepared ${result.documents.length} machine-readable documents.`);
}
