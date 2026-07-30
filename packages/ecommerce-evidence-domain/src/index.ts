export type EcommerceEvidenceObject = Record<string, unknown>;
type JsonObject = EcommerceEvidenceObject;

const DEFAULT_EXCLUSIONS = [
  "与目标商品形态无关的糕点",
  "需要完整加工的粉料或原料",
  "酱料、包装袋或设备",
  "仅关键词命中但食用任务和交付形态不同的商品"
] as const;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string, maximum = 100): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array with at most ${maximum} items`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = 2_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function stringArray(
  value: unknown,
  label: string,
  maximum = 50
): string[] {
  return array(value, label, maximum).map((entry, index) =>
    text(entry, `${label}[${index}]`, 500)
  );
}

interface EvidenceProduct {
  readonly productId: string;
  readonly title: string;
  readonly brand?: string;
  readonly platformCategory: string;
  readonly firstListedAt: string;
  readonly metrics: JsonObject;
  readonly attributes: readonly string[];
  readonly comparisonSignals: {
    readonly productForm: string;
    readonly readyToEat: boolean;
    readonly individualPack: boolean;
    readonly unitWeightG?: number;
    readonly functions: readonly string[];
    readonly scenes: readonly string[];
  };
  readonly assets: {
    readonly source: string;
    readonly carouselCount: number;
    readonly detailSliceCount: number;
    readonly sourceManifest: string;
    readonly selectedMain: {
      readonly path: string;
      readonly sha256: string;
    };
  };
}

function products(value: unknown): EvidenceProduct[] {
  return array(value, "products", 100).map((entry, index) => {
    const candidate = object(entry, `products[${index}]`);
    const signals = object(
      candidate.comparisonSignals,
      `products[${index}].comparisonSignals`
    );
    const assets = object(candidate.assets, `products[${index}].assets`);
    const selectedMain = object(
      assets.selectedMain,
      `products[${index}].assets.selectedMain`
    );
    const unitWeightG = signals.unitWeightG;
    if (
      unitWeightG !== undefined &&
      (!Number.isFinite(unitWeightG) || Number(unitWeightG) <= 0)
    ) {
      throw new Error(
        `products[${index}].comparisonSignals.unitWeightG must be positive`
      );
    }
    const sha256 = text(
      selectedMain.sha256,
      `products[${index}].assets.selectedMain.sha256`,
      64
    );
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(
        `products[${index}].assets.selectedMain.sha256 is invalid`
      );
    }
    const brand = optionalText(
      candidate.brand,
      `products[${index}].brand`
    );
    return {
      productId: text(candidate.productId, `products[${index}].productId`, 200),
      title: text(candidate.title, `products[${index}].title`, 1_000),
      ...(brand ? { brand } : {}),
      platformCategory: text(
        candidate.platformCategory,
        `products[${index}].platformCategory`,
        1_000
      ),
      firstListedAt: text(
        candidate.firstListedAt,
        `products[${index}].firstListedAt`,
        20
      ),
      metrics: object(candidate.metrics, `products[${index}].metrics`),
      attributes: stringArray(
        candidate.attributes,
        `products[${index}].attributes`
      ),
      comparisonSignals: {
        productForm: text(
          signals.productForm,
          `products[${index}].comparisonSignals.productForm`,
          200
        ),
        readyToEat: flag(
          signals.readyToEat,
          `products[${index}].comparisonSignals.readyToEat`
        ),
        individualPack: flag(
          signals.individualPack,
          `products[${index}].comparisonSignals.individualPack`
        ),
        ...(unitWeightG === undefined
          ? {}
          : { unitWeightG: Number(unitWeightG) }),
        functions: stringArray(
          signals.functions,
          `products[${index}].comparisonSignals.functions`
        ),
        scenes: stringArray(
          signals.scenes,
          `products[${index}].comparisonSignals.scenes`
        )
      },
      assets: {
        source: text(
          assets.source,
          `products[${index}].assets.source`,
          200
        ),
        carouselCount: count(
          assets.carouselCount,
          `products[${index}].assets.carouselCount`
        ),
        detailSliceCount: count(
          assets.detailSliceCount,
          `products[${index}].assets.detailSliceCount`
        ),
        sourceManifest: text(
          assets.sourceManifest,
          `products[${index}].assets.sourceManifest`,
          1_000
        ),
        selectedMain: {
          path: text(
            selectedMain.path,
            `products[${index}].assets.selectedMain.path`,
            1_000
          ),
          sha256
        }
      }
    };
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function eligible(product: EvidenceProduct): boolean {
  return (
    product.comparisonSignals.readyToEat &&
    product.comparisonSignals.individualPack
  );
}

function categoryCounts(
  input: readonly EvidenceProduct[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const product of input.filter(eligible)) {
    counts.set(
      product.platformCategory,
      (counts.get(product.platformCategory) ?? 0) + 1
    );
  }
  return counts;
}

function primaryCategory(input: readonly EvidenceProduct[]): string {
  const ranked = [...categoryCounts(input).entries()].sort(
    ([leftCategory, leftCount], [rightCategory, rightCount]) =>
      rightCount - leftCount || leftCategory.localeCompare(rightCategory)
  );
  if (!ranked[0]) {
    throw new Error("No eligible product remains for category-space building");
  }
  return ranked[0][0];
}

function numericAmount(value: string): number {
  const normalized = value.trim().toLowerCase();
  const match = /^([0-9]+(?:\.[0-9]+)?)(w)?$/u.exec(normalized);
  if (!match) throw new Error(`Unsupported metric amount: ${value}`);
  return Number(match[1]) * (match[2] ? 10_000 : 1);
}

function range(value: unknown): readonly [number, number] {
  const source = text(value, "sales range", 100);
  const parts = source.split("~");
  if (parts.length !== 2) {
    const amount = numericAmount(source);
    return [amount, amount];
  }
  return [numericAmount(parts[0]!), numericAmount(parts[1]!)];
}

function daysBetween(left: string, right: string): number {
  const start = Date.parse(`${left}T00:00:00Z`);
  const end = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("Observed and listing dates must use YYYY-MM-DD");
  }
  return Math.floor((end - start) / 86_400_000);
}

export function normalizeProductIntent(input: unknown): JsonObject {
  const candidate = object(input, "Product intent input");
  const boundary = object(candidate.workingBoundary, "workingBoundary");
  return {
    schemaVersion: "product-intent/v0.2",
    intentId: text(candidate.intentId, "intentId", 200),
    researchObject: {
      confirmed: [
        {
          field: "platform",
          value: text(candidate.platform, "platform", 100),
          source: "WORKFLOW_INPUT"
        },
        {
          field: "seed_query",
          value: text(candidate.seedQuery, "seedQuery", 300),
          source: "WORKFLOW_INPUT"
        },
        {
          field: "research_goal",
          value: text(candidate.researchGoal, "researchGoal", 2_000),
          source: "WORKFLOW_INPUT"
        }
      ],
      workingBoundary: {
        productForm: text(boundary.productForm, "workingBoundary.productForm"),
        targetPeople: stringArray(
          boundary.targetPeople,
          "workingBoundary.targetPeople"
        ),
        usageScenes: stringArray(
          boundary.usageScenes,
          "workingBoundary.usageScenes"
        ),
        confidence: text(
          boundary.confidence ?? "MEDIUM",
          "workingBoundary.confidence",
          20
        )
      }
    }
  };
}

export function buildCategorySpace(input: unknown): JsonObject {
  const candidate = object(input, "Category-space input");
  const intent = object(candidate.intent, "intent");
  const researchObject = object(intent.researchObject, "intent.researchObject");
  const boundary = object(
    researchObject.workingBoundary,
    "intent.researchObject.workingBoundary"
  );
  const candidates = products(candidate.products);
  const primary = primaryCategory(candidates);
  const categories = unique(
    candidates.filter(eligible).map((product) => product.platformCategory)
  );
  return {
    schemaVersion: "category-space/v0.2",
    intentId: text(intent.intentId, "intent.intentId", 200),
    principle:
      "以消费者需求和使用场景建立入口，再用平台官方类目约束可检索范围。",
    consumerNeedSpace: {
      coreNeed: text(boundary.productForm, "workingBoundary.productForm"),
      functions: unique(
        candidates.flatMap((product) => product.comparisonSignals.functions)
      ),
      scenes: unique([
        ...stringArray(boundary.usageScenes, "workingBoundary.usageScenes"),
        ...candidates.flatMap((product) => product.comparisonSignals.scenes)
      ])
    },
    primaryCategory: primary,
    platformCategoryBranches: categories.map((category) => ({
      path: category,
      role:
        category === primary
          ? "PRIMARY_DIRECT_BOUNDARY"
          : "SCENE_AND_CONTENT_REFERENCE",
      observedProducts: candidates
        .filter((product) => product.platformCategory === category)
        .map((product) => product.productId)
    })),
    exclusionRules:
      candidate.exclusionRules === undefined
        ? [...DEFAULT_EXCLUSIONS]
        : stringArray(candidate.exclusionRules, "exclusionRules")
  };
}

export function buildComparablePool(input: unknown): JsonObject {
  const candidate = object(input, "Comparable-pool input");
  const categorySpace = object(candidate.categorySpace, "categorySpace");
  const primary = text(
    categorySpace.primaryCategory,
    "categorySpace.primaryCategory",
    1_000
  );
  const candidates = products(candidate.products);
  const direct = candidates
    .filter(
      (product) =>
        eligible(product) && product.platformCategory === primary
    )
    .map((product) => product.productId);
  const references = candidates
    .filter(
      (product) =>
        eligible(product) && product.platformCategory !== primary
    )
    .map((product) => product.productId);
  const rejected = candidates
    .filter((product) => !eligible(product))
    .map((product) => product.productId);
  if (direct.length === 0) {
    throw new Error("Comparable pool has no direct competitor");
  }
  return {
    schemaVersion: "comparable-pool/v0.2",
    poolId: text(candidate.poolId, "poolId", 200),
    comparisonRule: {
      required: [
        "核心食用任务相同",
        "商品形态和食用方式相近",
        "规格与购买决策可相互替代"
      ],
      preferred: [
        "平台官方类目相同",
        "目标人群与使用场景相近",
        "同一时间窗存在可对照表现数据"
      ],
      notSufficient: "仅搜索关键词相同不构成可比关系"
    },
    tiers: [
      {
        tier: "DIRECT_COMPETITOR",
        products: direct,
        reason: "满足预包装即食边界，且属于样本中的主要平台官方类目。"
      },
      {
        tier: "SUBSTITUTE_AND_CONTENT_REFERENCE",
        products: references,
        reason: "满足核心食用任务，但平台官方类目不同，仅用于场景和内容参考。"
      }
    ],
    rejectedProducts: rejected
  };
}

export function evaluateViralEvidence(input: unknown): JsonObject {
  const candidate = object(input, "Evidence-evaluation input");
  const pool = object(candidate.comparablePool, "comparablePool");
  const tiers = array(pool.tiers, "comparablePool.tiers", 10).map((entry) =>
    object(entry, "comparablePool.tiers[]")
  );
  const candidates = products(candidate.products);
  const observedAt = text(candidate.observedAt, "observedAt", 20);
  const ranked = [...candidates].sort((left, right) => {
    const [leftLow, leftHigh] = range(left.metrics.sales);
    const [rightLow, rightHigh] = range(right.metrics.sales);
    return rightHigh - leftHigh || rightLow - leftLow;
  });
  const strongest = ranked[0];
  if (!strongest) throw new Error("Evidence evaluation requires products");
  const direct =
    (tiers.find((tier) => tier.tier === "DIRECT_COMPETITOR")
      ?.products as unknown[]) ?? [];
  const references =
    (tiers.find(
      (tier) => tier.tier === "SUBSTITUTE_AND_CONTENT_REFERENCE"
    )?.products as unknown[]) ?? [];
  const newProducts = candidates
    .filter((product) => {
      const age = daysBetween(product.firstListedAt, observedAt);
      return age >= 0 && age <= 60;
    })
    .map((product) => product.productId);
  return {
    schemaVersion: "evidence-claims/v0.2",
    observedAt,
    levels: {
      E1: "可追溯的商品、图片和页面来源事实",
      E2: "同一商品、同一时间窗的表现关联",
      E3: "经过对照或重复观察支持的内容机制",
      E4: "本业务复现实验验证"
    },
    claims: [
      {
        id: "DIRECT-COMPARABILITY",
        level: "E1",
        subjectProducts: direct,
        statement: "这些商品满足本轮直接可比边界。"
      },
      {
        id: "CONTENT-REFERENCE",
        level: "E1",
        subjectProducts: references,
        statement: "这些商品仅作为替代品和内容参考。"
      },
      {
        id: "STRONGEST-OBSERVED-SALES",
        level: "E2",
        subjectProducts: [strongest.productId],
        statement: "该商品是统一观察窗口中销量区间最强的样本。",
        supports: {
          sales: strongest.metrics.sales,
          salesAmountCny: strongest.metrics.salesAmountCny,
          views: strongest.metrics.views,
          conversionRate: strongest.metrics.conversionRate
        }
      },
      {
        id: "NEW-PRODUCT-SAMPLE",
        level: "E2",
        subjectProducts: newProducts,
        statement: "这些商品在观察日之前六十天内首次上架，可作为新品样本。"
      }
    ],
    notEstablished: [
      "某种颜色、排版或卖点文案直接导致销量提升",
      "单张主图优于同商品其他轮播图",
      "某达人、直播间或短视频是主要成交来源"
    ]
  };
}

export function buildReferencePack(input: unknown): JsonObject {
  const candidate = object(input, "Reference-pack input");
  const pool = object(candidate.comparablePool, "comparablePool");
  const evidence = object(candidate.evidence, "evidence");
  const tiers = array(pool.tiers, "comparablePool.tiers", 10).map((entry) =>
    object(entry, "comparablePool.tiers[]")
  );
  const tierByProduct = new Map<string, string>();
  for (const tier of tiers) {
    const tierName = text(tier.tier, "tier.tier", 100);
    for (const productId of stringArray(tier.products, "tier.products", 100)) {
      tierByProduct.set(productId, tierName);
    }
  }
  const candidates = products(candidate.products);
  const assetGroups = candidates.map((product) => ({
    productId: product.productId,
    comparisonTier: tierByProduct.get(product.productId) ?? "REJECTED",
    carouselCount: product.assets.carouselCount,
    detailSliceCount: product.assets.detailSliceCount,
    source: product.assets.source,
    sourceManifest: product.assets.sourceManifest
  }));
  return {
    schemaVersion: "reference-asset-pack/v0.2",
    packId: text(candidate.packId, "packId", 200),
    sourceRunId: text(candidate.sourceRunId, "sourceRunId", 200),
    status: "READY_WITH_E1_E2_LIMIT",
    usage:
      "供美工和后续图片生成任务作为参考图使用；不得把表现关联误写为因果结论。",
    evidenceSchemaVersion: text(
      evidence.schemaVersion,
      "evidence.schemaVersion",
      100
    ),
    summary: {
      productCount: candidates.length,
      directCompetitorCount: candidates.filter(
        (product) =>
          tierByProduct.get(product.productId) === "DIRECT_COMPETITOR"
      ).length,
      carouselCount: assetGroups.reduce(
        (total, group) => total + group.carouselCount,
        0
      ),
      detailSliceCount: assetGroups.reduce(
        (total, group) => total + group.detailSliceCount,
        0
      )
    },
    assetGroups,
    selectedAssets: candidates.map((product) => ({
      productId: product.productId,
      role: "MAIN_IMAGE",
      path: product.assets.selectedMain.path,
      sha256: product.assets.selectedMain.sha256,
      evidenceLevel: ["E1", "E2"],
      observedExpression: product.attributes
    }))
  };
}
