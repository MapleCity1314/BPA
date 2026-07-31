import { describe, expect, it } from "vitest";
import { projectOperatorHome } from "./index.js";

describe("operator home projection", () => {
  it("puts business work before healthy infrastructure", () => {
    const projected = projectOperatorHome({
      systemReady: true,
      availableAutomationCount: 3,
      runs: [
        {
          id: "run-1",
          title: "重点项检查",
          status: "running",
          businessSummary: "已检查 35 / 100 件商品",
          updatedAt: "2026-07-31T01:00:00.000Z"
        }
      ],
      attentionItems: [],
      results: [
        {
          id: "result-1",
          runId: "run-0",
          title: "商品检查报告",
          summary: "发现 2 个真实缺项",
          createdAt: "2026-07-31T00:00:00.000Z"
        }
      ]
    });
    expect(projected).toMatchObject({
      readiness: "ready",
      readinessMessage: "BPA 已准备好",
      availableAutomationCount: 3
    });
    expect(projected.running[0]?.businessSummary).toBe(
      "已检查 35 / 100 件商品"
    );
    expect(projected.recentResults[0]?.title).toBe("商品检查报告");
  });
});
