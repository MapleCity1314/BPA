import { describe, expect, it } from "vitest";
import { normalizeProductIntent } from "./index.js";

describe("ecommerce product intent", () => {
  it("normalizes only the explicit research boundary", () => {
    expect(normalizeProductIntent({
      intentId: "intent-jianbing",
      platform: "抖音电商、淘宝、京东",
      seedQuery: "预包装煎饼",
      researchGoal: "形成内部参考图片包",
      workingBoundary: {
        productForm: "独立预包装、开袋即食煎饼",
        targetPeople: ["早餐人群"],
        usageScenes: ["早餐"],
        confidence: "MEDIUM"
      }
    })).toMatchObject({
      schemaVersion: "product-intent/v0.2",
      intentId: "intent-jianbing",
      researchObject: {
        workingBoundary: {
          productForm: "独立预包装、开袋即食煎饼"
        }
      }
    });
  });
});
