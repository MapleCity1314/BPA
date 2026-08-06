import { describe,expect,it } from "vitest";
import { buildInventoryCollectionSummary } from "./collection-summary.js";

describe("inventory collection summary",() => {
  it("counts already fresh facts as coverage without reporting new persistence",() => {
    expect(buildInventoryCollectionSummary({
      discovered:10,alreadyFresh:8,attempted:2,persisted:2,failedProducts:[]
    })).toMatchObject({ outcome:"complete",coverage:1,persisted:2,failed:0 });
  });

  it("preserves usable partial output",() => {
    expect(buildInventoryCollectionSummary({
      discovered:10,alreadyFresh:0,attempted:10,persisted:9,
      failedProducts:[{ productId:"p10",stage:"snapshot_read",errorCode:"timed_out",evidenceId:"run-10" }]
    })).toMatchObject({ outcome:"partial",coverage:0.9,failed:1 });
  });

  it("blocks when no product produced a usable fact",() => {
    expect(buildInventoryCollectionSummary({
      discovered:2,alreadyFresh:0,attempted:2,persisted:0,
      failedProducts:[
        { productId:"p1",stage:"snapshot_read",errorCode:"failed",evidenceId:"run-1" },
        { productId:"p2",stage:"snapshot_read",errorCode:"failed",evidenceId:"run-2" }
      ]
    }).outcome).toBe("blocked");
  });
});
