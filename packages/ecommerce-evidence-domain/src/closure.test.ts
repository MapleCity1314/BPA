import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEcommerceEvidenceClosure } from "./closure.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bpa-evidence-closure-"));
  roots.push(root);
  mkdirSync(join(root, "reference-pack", "assets", "product-1"), {
    recursive: true
  });
  mkdirSync(join(root, "raw", "products", "product-1", "assets"), {
    recursive: true
  });
  const body = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from("WEBP", "ascii"),
    Buffer.from("test", "ascii")
  ]);
  const digest = createHash("sha256").update(body).digest("hex");
  const assetPath = join(
    root,
    "reference-pack",
    "assets",
    "product-1",
    "selected.webp"
  );
  writeFileSync(assetPath, body);
  writeFileSync(
    join(root, "raw", "products", "product-1", "assets", "manifest.json"),
    JSON.stringify({
      assets: [
        {
          id: "selected",
          contentType: "image/webp",
          url: "https://p26-item.ecombdimg.com/img/example.webp"
        }
      ],
      failures: []
    })
  );
  const input = {
    packId: "pack-test",
    sourceRunId: "source-run-test",
    observedAt: "2026-07-28",
    products: [
      {
        productId: "product-1",
        assets: {
          source: "DOUYIN_PUBLIC_PRODUCT_PAGE",
          sourceManifest: "raw/products/product-1/assets/manifest.json",
          selectedMain: {
            path: "reference-pack/assets/product-1/selected.webp",
            sha256: digest
          }
        }
      }
    ]
  };
  return { root, input, assetPath };
}

describe("ecommerce evidence closure", () => {
  it("verifies the selected source asset without claiming usage rights", () => {
    const { root, input } = fixture();
    expect(
      verifyEcommerceEvidenceClosure({
        replayInput: input,
        runRoot: root,
        verifiedAt: "2026-08-07T06:00:00.000Z"
      })
    ).toEqual({
      schemaVersion: "ecommerce-evidence-closure/v1",
      status: "source_verified_rights_pending",
      packId: "pack-test",
      sourceRunId: "source-run-test",
      verifiedAt: "2026-08-07T06:00:00.000Z",
      assetCount: 1,
      assets: [
        {
          productId: "product-1",
          sourceUrl: "https://p26-item.ecombdimg.com/img/example.webp",
          mediaType: "image/webp",
          digest: `sha256:${input.products[0]!.assets.selectedMain.sha256}`,
          sizeBytes: 16,
          observedAt: "2026-07-28T00:00:00.000Z",
          accessScope: "public",
          rightsStatus: "not_assessed",
          allowedUse: "internal_reference_only"
        }
      ],
      blockers: ["SOURCE_RIGHTS_NOT_ASSESSED"]
    });
  });

  it("rejects digest drift, unapproved origins and symlinked evidence", () => {
    const first = fixture();
    first.input.products[0]!.assets.selectedMain.sha256 = "0".repeat(64);
    expect(() =>
      verifyEcommerceEvidenceClosure({
        replayInput: first.input,
        runRoot: first.root,
        verifiedAt: "2026-08-07T06:00:00.000Z"
      })
    ).toThrow(/digest mismatch/);

    const second = fixture();
    const manifestPath = join(
      second.root,
      "raw",
      "products",
      "product-1",
      "assets",
      "manifest.json"
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        assets: [
          {
            id: "selected",
            contentType: "image/webp",
            url: "https://example.com/image.webp"
          }
        ],
        failures: []
      })
    );
    expect(() =>
      verifyEcommerceEvidenceClosure({
        replayInput: second.input,
        runRoot: second.root,
        verifiedAt: "2026-08-07T06:00:00.000Z"
      })
    ).toThrow(/approved Douyin item CDN/);

    const third = fixture();
    const linkedPath = join(
      third.root,
      "reference-pack",
      "assets",
      "product-1",
      "linked.webp"
    );
    symlinkSync(third.assetPath, linkedPath);
    third.input.products[0]!.assets.selectedMain.path =
      "reference-pack/assets/product-1/linked.webp";
    expect(() =>
      verifyEcommerceEvidenceClosure({
        replayInput: third.input,
        runRoot: third.root,
        verifiedAt: "2026-08-07T06:00:00.000Z"
      })
    ).toThrow(/regular file/);
  });
});
