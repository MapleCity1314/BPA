import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_SCOPE_RECONCILIATION_ROUNDS,
  createScopeFingerprint,
  reconcileProductScope,
  type ProductCandidate,
  type ScopeCollectionReplay,
  type ScopeCollectionRound,
  type ScopeFingerprintInput
} from "./scope-collector.js";

interface CompactScopeFixture {
  initialLocation: { page: number; scrollTop: number };
  scope: ScopeFingerprintInput;
  rounds: Array<{
    topTotal: number;
    bottomTotal: number;
    productCount: number;
    pageSize: number;
    firstProductId: number;
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/scope-105-to-106.replay.json", import.meta.url),
    "utf8"
  )
) as CompactScopeFixture;

function product(id: number): ProductCandidate {
  return {
    id: String(id),
    title: `脱敏商品 ${id} 500g`
  };
}

function expandRound(
  compact: CompactScopeFixture["rounds"][number],
  fingerprint = createScopeFingerprint(fixture.scope)
): ScopeCollectionRound {
  const products = Array.from({ length: compact.productCount }, (_, index) =>
    product(compact.firstProductId + index)
  );
  const totalPages = Math.ceil(compact.productCount / compact.pageSize);
  return {
    fingerprint,
    topTotal: compact.topTotal,
    bottomTotal: compact.bottomTotal,
    pages: Array.from({ length: totalPages }, (_, pageIndex) => {
      const pageProducts = products.slice(
        pageIndex * compact.pageSize,
        (pageIndex + 1) * compact.pageSize
      );
      return {
        page: pageIndex + 1,
        totalPages,
        views: [
          { scrollTop: 0, products: pageProducts.slice(0, 30) },
          {
            scrollTop: 600,
            products: pageProducts.slice(Math.min(20, pageProducts.length))
          }
        ]
      };
    })
  };
}

function replay(
  rounds = fixture.rounds.map((round) => expandRound(round))
): ScopeCollectionReplay {
  return {
    initialLocation: fixture.initialLocation,
    rounds
  };
}

describe("doudian product scope deterministic replay", () => {
  it("reconciles a 105→106 change, merges virtual views, and restores location", () => {
    const result = reconcileProductScope(replay());
    expect(result).toMatchObject({
      status: "complete",
      expectedCount: 106,
      scanRounds: 2,
      restore: { page: 3, scrollTop: 438, required: true },
      diagnostics: [
        { collected: 105, reconciled: true },
        { collected: 106, reconciled: true }
      ]
    });
    expect(result.products).toHaveLength(106);
    expect(result.inspectionQueue).toEqual(result.products);
    expect(result.products[0]).toMatchObject({
      id: "400001",
      editorUrl:
        "https://fxg.jinritemai.com/ffa/g/create?product_id=400001&entrance=edit"
    });
    expect(result.products.at(-1)?.id).toBe("400106");
  });

  it("never produces an inspection queue for final count mismatch", () => {
    const incomplete = expandRound(fixture.rounds[1]!);
    const pages = incomplete.pages.map((page, index) =>
      index === incomplete.pages.length - 1
        ? {
            ...page,
            views: page.views.map((view) => ({
              ...view,
              products: view.products.filter(
                (candidate) => candidate.id !== "400106"
              )
            }))
          }
        : page
    );
    const result = reconcileProductScope(
      replay([{ ...incomplete, pages }])
    );
    expect(result).toMatchObject({
      status: "inconsistent",
      error: { code: "COUNT_MISMATCH" }
    });
    expect(result.products).toEqual([]);
    expect(result.inspectionQueue).toEqual([]);
  });

  it("blocks changed scope fingerprints and platform risk signals", () => {
    const changed = createScopeFingerprint({
      ...fixture.scope,
      statusTab: { id: "sold-out", label: "已售罄" }
    });
    expect(
      reconcileProductScope(
        replay([
          expandRound(fixture.rounds[0]!),
          expandRound(fixture.rounds[1]!, changed)
        ])
      )
    ).toMatchObject({
      status: "blocked",
      inspectionQueue: [],
      error: { code: "PAGE_CONTEXT_CHANGED" }
    });

    const risky = expandRound(fixture.rounds[0]!);
    expect(
      reconcileProductScope(
        replay([
          {
            ...risky,
            riskSignals: [
              { code: "CAPTCHA_REQUIRED", severity: "blocking" }
            ]
          }
        ])
      )
    ).toMatchObject({
      status: "blocked",
      inspectionQueue: [],
      error: { code: "RISK_SIGNAL_BLOCKED" }
    });
  });

  it("rejects missing or excessive reconciliation rounds", () => {
    expect(reconcileProductScope(replay([]))).toMatchObject({
      error: { code: "NO_COLLECTION_ROUND" },
      scanRounds: 0
    });
    const round = expandRound(fixture.rounds[0]!);
    expect(
      reconcileProductScope(
        replay(
          Array.from(
            { length: MAX_SCOPE_RECONCILIATION_ROUNDS + 1 },
            () => round
          )
        )
      )
    ).toMatchObject({
      error: { code: "ROUND_LIMIT_EXCEEDED" },
      inspectionQueue: []
    });
  });

  it.each([
    {
      name: "invalid total",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        topTotal: -1
      }),
      code: "TOTAL_INVALID"
    },
    {
      name: "total changed during round",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        bottomTotal: round.bottomTotal + 1
      }),
      code: "TOTAL_CHANGED_DURING_ROUND"
    },
    {
      name: "missing page",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        pages: round.pages.slice(1)
      }),
      code: "PAGINATION_INCOMPLETE"
    },
    {
      name: "invalid product id",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        pages: [
          {
            ...round.pages[0]!,
            views: [
              {
                scrollTop: 0,
                products: [{ id: "bad", title: "有效标题" }]
              }
            ]
          }
        ],
        topTotal: 1,
        bottomTotal: 1
      }),
      code: "PRODUCT_ID_INVALID"
    },
    {
      name: "invalid title",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        pages: [
          {
            ...round.pages[0]!,
            totalPages: 1,
            views: [
              {
                scrollTop: 0,
                products: [{ id: "400001", title: "商品图片" }]
              }
            ]
          }
        ],
        topTotal: 1,
        bottomTotal: 1
      }),
      code: "PRODUCT_TITLE_INVALID"
    },
    {
      name: "conflicting duplicate",
      mutate: (round: ScopeCollectionRound) => ({
        ...round,
        pages: [
          {
            page: 1,
            totalPages: 1,
            views: [
              { scrollTop: 0, products: [product(400001)] },
              {
                scrollTop: 100,
                products: [{ id: "400001", title: "另一个有效标题" }]
              }
            ]
          }
        ],
        topTotal: 1,
        bottomTotal: 1
      }),
      code: "PRODUCT_CONFLICT"
    }
  ])("fails closed for $name", ({ mutate, code }) => {
    const base = expandRound({
      ...fixture.rounds[0]!,
      topTotal: 1,
      bottomTotal: 1,
      productCount: 1,
      pageSize: 1
    });
    expect(reconcileProductScope(replay([mutate(base)]))).toMatchObject({
      status: "inconsistent",
      inspectionQueue: [],
      error: { code }
    });
  });
});
