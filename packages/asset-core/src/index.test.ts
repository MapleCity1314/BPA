import { describe, expect, it } from "vitest";
import {
  assertAssetRecord,
  defaultRetention,
  storageRefForDigest
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("Asset records", () => {
  it("derives bounded retention from classification", () => {
    const now = new Date("2026-07-30T00:00:00.000Z");
    expect(defaultRetention("restricted", now)).toEqual({
      policy: "restricted_24h",
      retainUntil: "2026-07-31T00:00:00.000Z"
    });
    expect(defaultRetention("public", now)).toEqual({
      policy: "public_30d",
      retainUntil: "2026-08-29T00:00:00.000Z"
    });
  });

  it("requires an existing exact Blob and Source", () => {
    const asset = {
      apiVersion: "bpa.asset/v1alpha1",
      kind: "AssetRecord",
      assetId: "asset:test:1",
      digest,
      size: 4,
      mediaType: "image/jpeg",
      storageRef: storageRefForDigest(digest),
      classification: "public",
      sourceIds: ["source:test:1"],
      createdAt: "2026-07-30T00:00:00.000Z",
      retention: {
        policy: "public_30d",
        retainUntil: "2026-08-29T00:00:00.000Z"
      }
    };
    expect(() =>
      assertAssetRecord(asset, {
        blob: {
          digest,
          size: 4,
          mediaType: "image/jpeg",
          storageRef: storageRefForDigest(digest),
          createdAt: asset.createdAt
        },
        sourceExists: (id) => id === "source:test:1",
        assetExists: () => false
      })
    ).not.toThrow();
    expect(() =>
      assertAssetRecord(
        {
          ...asset,
          classification: "restricted",
          retention: asset.retention
        },
        {
          blob: undefined,
          sourceExists: () => false,
          assetExists: () => false
        }
      )
    ).toThrow("sensitive Assets cannot use public_30d");
  });
});
