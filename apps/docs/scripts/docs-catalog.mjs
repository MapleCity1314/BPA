import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname, join, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const catalogPath = join(repoRoot, "docs/catalog.json");
export const catalogSchemaPath = join(repoRoot, "docs/catalog.schema.json");
export const publicContentRoot = join(repoRoot, "apps/docs/src/content/docs");

const authorityRank = new Map(
  [
    "current-state",
    "normative",
    "architecture",
    "operations",
    "tutorial",
    "plan",
    "research",
    "historical"
  ].map((value, index) => [value, index])
);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function titleFromMarkdown(markdown) {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatterTitle = frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1];
  if (frontmatterTitle) return frontmatterTitle.trim().replace(/^["']|["']$/g, "");
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function stableCompare(left, right) {
  const rank =
    (authorityRank.get(left.authority) ?? 99) -
    (authorityRank.get(right.authority) ?? 99);
  if (rank !== 0) return rank;
  const group = (left.navigationGroup ?? "").localeCompare(
    right.navigationGroup ?? "",
    "en"
  );
  if (group !== 0) return group;
  const order = (left.navigationOrder ?? 9999) - (right.navigationOrder ?? 9999);
  if (order !== 0) return order;
  return left.id.localeCompare(right.id, "en");
}

export function publicUrl(base, route) {
  const normalizedBase = `/${base.replace(/^\/+|\/+$/g, "")}`;
  if (!route) return `${normalizedBase}/`;
  return `${normalizedBase}/${route.replace(/^\/+|\/+$/g, "")}/`;
}

export function rawUrl(base, route) {
  const normalizedBase = `/${base.replace(/^\/+|\/+$/g, "")}`;
  const file = route ? `${route}.md` : "index.md";
  return `${normalizedBase}/raw/${file}`;
}

export async function loadCatalog({ validateFiles = true } = {}) {
  const [catalogText, schemaText] = await Promise.all([
    readFile(catalogPath, "utf8"),
    readFile(catalogSchemaPath, "utf8")
  ]);
  const catalog = JSON.parse(catalogText);
  const schema = JSON.parse(schemaText);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(catalog)) {
    throw new Error(
      `Invalid docs catalog:\n${ajv.errorsText(validate.errors, {
        separator: "\n"
      })}`
    );
  }

  const ids = new Set();
  const sources = new Set();
  const publicRoutes = new Set();
  for (const entry of catalog.entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate catalog id: ${entry.id}`);
    if (sources.has(entry.source)) {
      throw new Error(`Duplicate catalog source: ${entry.source}`);
    }
    ids.add(entry.id);
    sources.add(entry.source);

    if (entry.public) {
      if (entry.route === undefined) {
        throw new Error(`Public entry is missing route: ${entry.id}`);
      }
      if (!entry.source.startsWith("apps/docs/src/content/docs/")) {
        throw new Error(`Public entry uses a non-public source: ${entry.id}`);
      }
      if (!entry.navigationGroup || entry.navigationOrder === undefined) {
        throw new Error(`Public entry is missing navigation metadata: ${entry.id}`);
      }
      if (publicRoutes.has(entry.route)) {
        throw new Error(`Duplicate public route: ${entry.route}`);
      }
      publicRoutes.add(entry.route);
    } else if (entry.route !== undefined) {
      throw new Error(`Private entry declares a public route: ${entry.id}`);
    }

    if (
      entry.authority === "historical" &&
      !["deprecated", "superseded"].includes(entry.implementation)
    ) {
      throw new Error(`Historical entry is not deprecated: ${entry.id}`);
    }
  }

  for (const entry of catalog.entries) {
    for (const supersededId of entry.supersedes ?? []) {
      if (!ids.has(supersededId)) {
        throw new Error(
          `Catalog entry ${entry.id} supersedes missing entry ${supersededId}`
        );
      }
    }
  }

  if (validateFiles) {
    const catalogedMarkdown = new Set(
      catalog.entries.map((entry) => normalizePath(entry.source))
    );
    const markdownFiles = (
      await Promise.all(
        ["docs", "apps/docs/src/content/docs"].map(async (directory) =>
          (await walk(join(repoRoot, directory)))
            .filter((file) => [".md", ".mdx"].includes(extname(file)))
            .map((file) => normalizePath(relative(repoRoot, file)))
        )
      )
    ).flat();
    const uncataloged = markdownFiles.filter((file) => !catalogedMarkdown.has(file));
    const missing = [...catalogedMarkdown].filter(
      (file) => !markdownFiles.includes(file)
    );
    if (uncataloged.length || missing.length) {
      throw new Error(
        [
          uncataloged.length
            ? `Uncataloged Markdown:\n${uncataloged.join("\n")}`
            : "",
          missing.length ? `Missing Markdown:\n${missing.join("\n")}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    for (const entry of catalog.entries) {
      const markdown = await readFile(resolve(repoRoot, entry.source), "utf8");
      const sourceTitle = titleFromMarkdown(markdown);
      if (sourceTitle !== entry.title) {
        throw new Error(
          `Catalog title differs from source for ${entry.id}: ${JSON.stringify(
            entry.title
          )} !== ${JSON.stringify(sourceTitle)}`
        );
      }
    }
  }

  return {
    ...catalog,
    entries: [...catalog.entries].sort(stableCompare)
  };
}

export async function publicDocuments() {
  const catalog = await loadCatalog();
  return Promise.all(
    catalog.entries
      .filter((entry) => entry.public)
      .map(async (entry) => {
        const markdown = await readFile(resolve(repoRoot, entry.source), "utf8");
        return {
          ...entry,
          markdown,
          digest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`
        };
      })
  );
}
