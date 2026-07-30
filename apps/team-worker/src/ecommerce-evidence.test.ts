import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@bpa/workflow-ir";
import {
  ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF,
  ECOMMERCE_COMPARABLE_POOL_BUILD_HANDLER_REF,
  ECOMMERCE_EVIDENCE_EVALUATE_HANDLER_REF,
  ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF,
  ECOMMERCE_REFERENCE_PACK_BUILD_HANDLER_REF,
  TEAM_WORKER_HANDLER_REFS,
  teamHandlerRegistry
} from "./handlers.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/ecommerce-evidence-domain/src/fixtures/prepackaged-jianbing.input.json",
      import.meta.url
    ),
    "utf8"
  )
) as Record<string, JsonValue>;

async function invoke(ref: string, input: JsonValue): Promise<JsonValue> {
  const [id, version] = ref.split("@");
  return teamHandlerRegistry
    .get({ id: id!, version: version! })
    .invoke(input, new AbortController().signal);
}

async function replay(): Promise<Record<string, JsonValue>> {
  const productIntent = await invoke(
    ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF,
    fixture.intent!
  );
  const categorySpace = await invoke(
    ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF,
    {
      intent: productIntent,
      products: fixture.products!,
      exclusionRules: fixture.exclusionRules!
    }
  );
  const comparablePool = await invoke(
    ECOMMERCE_COMPARABLE_POOL_BUILD_HANDLER_REF,
    {
      poolId: fixture.poolId!,
      categorySpace,
      products: fixture.products!
    }
  );
  const evidenceClaims = await invoke(
    ECOMMERCE_EVIDENCE_EVALUATE_HANDLER_REF,
    {
      observedAt: fixture.observedAt!,
      comparablePool,
      products: fixture.products!
    }
  );
  const referencePack = await invoke(
    ECOMMERCE_REFERENCE_PACK_BUILD_HANDLER_REF,
    {
      packId: fixture.packId!,
      sourceRunId: fixture.sourceRunId!,
      comparablePool,
      evidence: evidenceClaims,
      products: fixture.products!
    }
  );
  return {
    productIntent,
    categorySpace,
    comparablePool,
    evidenceClaims,
    referencePack
  };
}

describe("ecommerce evidence-chain Team Handlers", () => {
  it("reconstructs the prepackaged-jianbing evidence decisions", async () => {
    const output = await replay();
    expect(output.productIntent).toMatchObject({
      schemaVersion: "product-intent/v0.2",
      intentId: "intent-prepackaged-jianbing-01"
    });
    expect(output.categorySpace).toMatchObject({
      schemaVersion: "category-space/v0.2",
      primaryCategory:
        "食品饮料/粮油调味/速食冻品/方便速食/冷藏食品/方便面/拉面/面皮/面饼"
    });
    expect(output.comparablePool).toMatchObject({
      tiers: [
        {
          tier: "DIRECT_COMPETITOR",
          products: ["heda", "chubei"]
        },
        {
          tier: "SUBSTITUTE_AND_CONTENT_REFERENCE",
          products: ["viji"]
        }
      ]
    });
    const claims = (
      output.evidenceClaims as Record<string, JsonValue>
    ).claims as Array<Record<string, JsonValue>>;
    expect(
      claims.find((claim) => claim.id === "STRONGEST-OBSERVED-SALES")
    ).toMatchObject({
      level: "E2",
      subjectProducts: ["viji"]
    });
    expect(
      claims.find((claim) => claim.id === "NEW-PRODUCT-SAMPLE")
    ).toMatchObject({
      level: "E2",
      subjectProducts: ["chubei"]
    });
    expect(output.referencePack).toMatchObject({
      status: "READY_WITH_E1_E2_LIMIT",
      summary: {
        productCount: 3,
        directCompetitorCount: 2,
        carouselCount: 15,
        detailSliceCount: 21
      }
    });
    expect(TEAM_WORKER_HANDLER_REFS).toEqual(
      expect.arrayContaining([
        ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF,
        ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF,
        ECOMMERCE_COMPARABLE_POOL_BUILD_HANDLER_REF,
        ECOMMERCE_EVIDENCE_EVALUATE_HANDLER_REF,
        ECOMMERCE_REFERENCE_PACK_BUILD_HANDLER_REF
      ])
    );
  });

  it("is deterministic for the same frozen product snapshots", async () => {
    await expect(replay()).resolves.toEqual(await replay());
  });

  it("rejects malformed product asset digests", async () => {
    const products = structuredClone(fixture.products) as Array<
      Record<string, unknown>
    >;
    (
      (products[0]!.assets as Record<string, unknown>)
        .selectedMain as Record<string, unknown>
    ).sha256 = "not-a-digest";
    await expect(
      invoke(ECOMMERCE_CATEGORY_SPACE_BUILD_HANDLER_REF, {
        intent: await invoke(
          ECOMMERCE_INTENT_NORMALIZE_HANDLER_REF,
          fixture.intent!
        ),
        products,
        exclusionRules: fixture.exclusionRules!
      } as JsonValue)
    ).rejects.toMatchObject({ code: "TEAM_HANDLER_INPUT_INVALID" });
  });
});
