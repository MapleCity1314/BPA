import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePublicDocumentation } from "./prepare-public-docs.mjs";

describe("public documentation artifacts", () => {
  it("generates deterministic, public-only machine indexes and raw Markdown", async () => {
    const first = await mkdtemp(join(tmpdir(), "bpa-docs-first-"));
    const second = await mkdtemp(join(tmpdir(), "bpa-docs-second-"));
    const options = {
      site: "https://example.test",
      base: "/BPA"
    };

    const firstResult = await generatePublicDocumentation({
      ...options,
      outputDir: first
    });
    await generatePublicDocumentation({ ...options, outputDir: second });

    expect(firstResult.documents.length).toBeGreaterThan(20);
    for (const file of [
      "llms.txt",
      "llms-full.txt",
      "docs-index.json",
      "robots.txt",
      "raw/index.md",
      "raw/browser/v2.md"
    ]) {
      const [left, right] = await Promise.all([
        readFile(join(first, file), "utf8"),
        readFile(join(second, file), "utf8")
      ]);
      expect(left).toBe(right);
      expect(left).not.toContain("/Users/");
      expect(left).not.toContain("chanmama");
      expect(left).not.toContain("douyin");
      expect(left).not.toContain("docs/archive/");
    }

    const rawHome = await readFile(join(first, "raw/index.md"), "utf8");
    expect(rawHome).not.toMatch(/^---$/m);
    expect(rawHome).not.toMatch(/^import\s/m);
    expect(rawHome).not.toContain("<HomeMetrics");
    expect(rawHome).toContain("Authority: tutorial");
    expect(rawHome).toContain("一条不会在重启后失忆的执行链");

    const index = JSON.parse(
      await readFile(join(first, "docs-index.json"), "utf8")
    ) as {
      schemaVersion: string;
      entries: Array<{ url: string; rawUrl: string; digest: string }>;
    };
    expect(index.schemaVersion).toBe("bpa.docs-index/1");
    expect(index.entries).toHaveLength(firstResult.documents.length);
    expect(index.entries.every((entry) => entry.url.includes("/BPA/"))).toBe(true);
    expect(index.entries.every((entry) => entry.rawUrl.includes("/BPA/raw/"))).toBe(
      true
    );
    expect(
      index.entries.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest))
    ).toBe(true);
    expect(new Set(index.entries.map((entry) => entry.url)).size).toBe(
      index.entries.length
    );
  });
});
