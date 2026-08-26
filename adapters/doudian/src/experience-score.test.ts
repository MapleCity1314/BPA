import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseWorkflowYaml } from "@bpa/compiler";
import { compileDataValidator } from "@bpa/schemas";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  DOUDIAN_EXPERIENCE_ADAPTER_VERSION,
  DoudianExperienceError,
  doudianExperienceErrorPayload,
  readDoudianExperienceSnapshot
} from "./experience-score.js";

function page(content: string): Document {
  const dom = new JSDOM(`<!doctype html><body>
    <header id="fxg-pc-header">
      <div class="headerShopName" data-shop-id="12345678">
        <span class="shopName">测试食品旗舰店</span>
      </div>
    </header>
    <main><h1>商家体验分</h1>${content}</main>
  </body>`, {
    url: "https://fxg.jinritemai.com/ffa/eco/experience-score"
  });
  const element = dom.window.document.querySelector(".shopName")!;
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ width: 120, height: 24, top: 20, left: 1200 })
  });
  return dom.window.document;
}

function nodeSchema(
  fileName: string,
  side: "inputSchema" | "outputSchema"
): Parameters<typeof compileDataValidator>[0] {
  const definition = parseWorkflowYaml(
    readFileSync(
      new URL(`../../../nodes/core/${fileName}`, import.meta.url),
      "utf8"
    )
  ) as Record<string, unknown>;
  return definition[side] as Parameters<typeof compileDataValidator>[0];
}

function asset(path: string): Record<string, unknown> {
  return parseWorkflowYaml(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

describe("Doudian experience-score adapter", () => {
  it("publishes only the exact v2 browser Node and Adapter implementation", () => {
    const adapter = asset("adapters/doudian/doudian-experience.adapter.yaml") as {
      metadata: { version: string };
      capabilities: Array<{
        nodeVersions: string[];
        handlerVersion: string;
        implementationDigest: string;
      }>;
    };
    expect(adapter.metadata.version).toBe("2.0.5");
    expect(DOUDIAN_EXPERIENCE_ADAPTER_VERSION).toBe(
      adapter.metadata.version
    );
    expect(adapter.capabilities).toHaveLength(2);
    const implementationDigest = `sha256:${createHash("sha256")
      .update([
        "apps/extension/src/entrypoints/content.ts",
        "apps/extension/src/lib/adapter-node-registry.ts",
        "apps/extension/src/lib/experience-score-background.ts",
        "apps/extension/src/lib/experience-score-content.ts",
        "adapters/doudian/src/experience-score.ts",
        "adapters/doudian/src/shop-context.ts"
      ].map((path) => readFileSync(new URL(`../../../${path}`,import.meta.url)))
        .join("\n"))
      .digest("hex")}`;
    for (const capability of adapter.capabilities) {
      expect(capability).toMatchObject({
        nodeVersions: ["2.0.5"],
        handlerVersion: "2.0.5",
        implementationDigest
      });
    }
    for (const path of [
      "nodes/core/doudian.experience.shops.discover.node.yaml",
      "nodes/core/doudian.experience.shop.snapshot.read.node.yaml"
    ]) {
      expect(asset(path)).toMatchObject({
        metadata: { version: "2.0.5" },
        adapter: { id: "doudian-experience", versions: ["2.0.5"] }
      });
    }
    const discoverNode = asset(
      "nodes/core/doudian.experience.shops.discover.node.yaml"
    ) as { execution: { retryableErrors: string[] }; errors: string[] };
    const snapshotNode = asset(
      "nodes/core/doudian.experience.shop.snapshot.read.node.yaml"
    ) as { execution: { retryableErrors: string[] }; errors: string[] };
    expect(discoverNode.execution.retryableErrors).toEqual([
      "PAGE_LOADING",
      "BROWSER_DISCONNECTED"
    ]);
    expect(snapshotNode.execution.retryableErrors).toEqual([
      "PAGE_LOADING",
      "BROWSER_DISCONNECTED",
      "EXPERIENCE_PAGE_TIMEOUT",
      "EXPERIENCE_CONTENT_RESPONSE_TIMEOUT"
    ]);
    expect(discoverNode.errors).toEqual(
      expect.arrayContaining(discoverNode.execution.retryableErrors)
    );
    expect(snapshotNode.errors).toEqual(
      expect.arrayContaining(snapshotNode.execution.retryableErrors)
    );
    const workflowSource = readFileSync(
        new URL(
          "../../../workflows/examples/doudian.experience-score.daily.workflow.yaml",
          import.meta.url
        ),
        "utf8"
      );
    expect(workflowSource).not.toContain(
      "doudian.experience.shops.discover@1.0.0"
    );
    expect(workflowSource).not.toContain("EXPERIENCE_PAGE_LOADING");
    expect(workflowSource).toContain(
      "retryableErrors: [PAGE_LOADING, BROWSER_DISCONNECTED, EXPERIENCE_PAGE_TIMEOUT, EXPERIENCE_CONTENT_RESPONSE_TIMEOUT]"
    );
  });

  it("normalizes a complete three-dimension snapshot", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div>考核行业：方便食品</div>
      <div>近30天有效订单数：1,234</div>
      <div>更新于 2026/08/07 12:34:56</div>
      <div data-bpa-label="我的体验分">我的体验分 96.5分</div>
      <div data-bpa-label="商品体验得分">商品体验得分 98分</div>
      <div data-bpa-label="商品综合评分">商品综合评分 4.8分 得分98分</div>
      <div data-bpa-label="物流体验得分">物流体验得分 94分</div>
      <div data-bpa-label="揽收时长平均">揽收时长平均 3.2小时 得分94分 权重40%</div>
      <div data-bpa-label="服务体验得分">服务体验得分 97分</div>
      <div data-bpa-label="飞鸽会话不满意率">飞鸽会话不满意率 1.2% 得分97分 12/1000</div>
    `);
    const snapshot = readDoudianExperienceSnapshot(
      doc,
      doc.defaultView!.location.href,
      { id: "12345678", name: "测试食品旗舰店" },
      new Date("2026-08-07T05:00:00.000Z")
    );
    expect(snapshot).toMatchObject({
      status: "complete",
      shop: { id: "12345678", name: "测试食品旗舰店" },
      summary: { totalScore: 96.5, orders30d: 1234 },
      dimensions: [
        { key: "goods", score: 98 },
        { key: "logistics", score: 94 },
        { key: "service", score: 97 }
      ],
      formMutations: 0
    });
    expect(snapshot.dimensions[1]!.metrics[0]).toMatchObject({
      key: "logistics.pickup_duration_average",
      label: "揽收时长平均",
      unit: "小时",
      value: 3.2,
      score: 94,
      weight: 40
    });
    expect(snapshot.dimensions[0]!.metrics[0]).toMatchObject({
      key: "goods.composite_rating",
      label: "商品综合评分",
      unit: "分",
      value: 4.8,
      score: 98
    });
  });

  it("keeps low-order no-score separate from collection failure", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div>近30天有效订单数：12</div>
      <div>参与分数计算的订单达到30单后向您展示体验分</div>
    `);
    const snapshot = readDoudianExperienceSnapshot(
      doc,
      doc.defaultView!.location.href,
      {
        id: "12345678",
        name: "测试食品旗舰店"
      }
    );
    expect(snapshot).toMatchObject({
      status: "no_score",
      summary: { totalScore: null, orders30d: 12 },
      diagnostics: ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"]
    });

    const readOutput = compileDataValidator(
      nodeSchema(
        "doudian.experience.shop.snapshot.read.node.yaml",
        "outputSchema"
      )
    );
    const persistInput = compileDataValidator(
      nodeSchema(
        "doudian.experience.shop.fact.persist.node.yaml",
        "inputSchema"
      )
    );
    expect(readOutput(snapshot)).toBe(true);
    expect(persistInput({ snapshot })).toBe(true);
    expect(persistInput({ snapshot: { ...snapshot, status: "skipped" } })).toBe(
      false
    );
  });

  it("allows complete and partial Dataset intents but rejects zero-fact runs", () => {
    const prepareInput = compileDataValidator(
      nodeSchema(
        "doudian.experience.daily.dataset.prepare.node.yaml",
        "inputSchema"
      )
    );
    const prepareOutput = compileDataValidator(
      nodeSchema(
        "doudian.experience.daily.dataset.prepare.node.yaml",
        "outputSchema"
      )
    );
    const daily = {
      status: "partial",
      businessDate: "2026-08-09",
      observedAt: "2026-08-09T05:00:00.000Z",
      discoveredCount: 2,
      collectableCount: 2,
      attemptedCount: 2,
      persistedCount: 1,
      failedCount: 1,
      skippedCount: 0,
      factRefs: [
        {
          factKey: "operational-fact:doudian-experience:run-1:shop-10001",
          businessDate: "2026-08-09",
          subjectId: "10001",
          recordDigest: `sha256:${"a".repeat(64)}`
        }
      ],
      foreachOutcome: {}
    };
    expect(prepareInput({ daily })).toBe(true);
    expect(prepareInput({ daily: { ...daily, status: "complete" } })).toBe(true);
    expect(
      prepareInput({
        daily: {
          ...daily,
          status: "failed",
          persistedCount: 0,
          factRefs: []
        }
      })
    ).toBe(false);
    expect(
      prepareOutput({
        status: "prepared",
        datasetStatus: "partial",
        publicationIntentId: "dataset-intent:run-abc12345",
        datasetId: "doudian-experience-daily",
        version: "2026.8.9-run.abc12345",
        recordCount: 1,
        recordsDigest: `sha256:${"b".repeat(64)}`
      })
    ).toBe(true);
    expect(
      prepareOutput({
        status: "prepared",
        datasetStatus: "partial",
        publicationIntentId: "dataset-intent:run-abc12345",
        datasetId: "doudian-experience-daily",
        version: "2026.8.9",
        recordCount: 1,
        recordsDigest: `sha256:${"b".repeat(64)}`
      })
    ).toBe(false);
  });

  it("fails closed on shop mismatch and incomplete dimensions", () => {
    const doc = page(`
      <div>店铺ID：12345678</div>
      <div data-bpa-label="我的体验分">我的体验分 96分</div>
    `);
    let mismatch: unknown;
    try {
      readDoudianExperienceSnapshot(doc, doc.defaultView!.location.href, {
        id: "87654321",
        name: "测试食品旗舰店"
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(DoudianExperienceError);
    expect(mismatch).toMatchObject({ code: "SHOP_IDENTITY_MISMATCH" });

    let incomplete: unknown;
    try {
      readDoudianExperienceSnapshot(doc, doc.defaultView!.location.href, {
        id: "12345678",
        name: "测试食品旗舰店"
      });
    } catch (error) {
      incomplete = error;
    }
    expect(incomplete).toBeInstanceOf(DoudianExperienceError);
    expect(doudianExperienceErrorPayload(incomplete)).toEqual({
      code: "EXPERIENCE_DIMENSION_INCOMPLETE",
      message: "体验分维度数据不完整：商品体验。",
      detail: { dimension: "goods" }
    });
  });

  it("never promotes an arbitrary Error message to a protocol code", () => {
    expect(
      doudianExperienceErrorPayload(new Error("SECRET_OR_DYNAMIC_TEXT"))
    ).toEqual({
      code: "EXPERIENCE_STAGE_FAILED",
      message: "体验分页面读取失败。"
    });
  });
});
