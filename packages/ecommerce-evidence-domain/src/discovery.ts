type JsonObject = Record<string, unknown>;

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
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum = 2_000) {
  return value === undefined ? undefined : text(value, label, maximum);
}

function stringArray(value: unknown, label: string, maximum = 50): string[] {
  return array(value, label, maximum).map((entry, index) =>
    text(entry, `${label}[${index}]`, 300)
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function confirmedValue(intent: JsonObject, field: string): string {
  const researchObject = object(intent.researchObject, "intent.researchObject");
  const confirmed = array(researchObject.confirmed, "intent.researchObject.confirmed", 20);
  const entry = confirmed
    .map((candidate) => object(candidate, "confirmed[]"))
    .find((candidate) => candidate.field === field);
  if (!entry) throw new Error(`Confirmed intent field is missing: ${field}`);
  return text(entry.value, `confirmed.${field}`, 2_000);
}

function workingBoundary(intent: JsonObject): JsonObject {
  return object(
    object(intent.researchObject, "intent.researchObject").workingBoundary,
    "intent.researchObject.workingBoundary"
  );
}

interface DiscoveryProduct {
  readonly discoveryId: string;
  readonly platform: string;
  readonly productId: string;
  readonly title: string;
  readonly productUrl: string;
  readonly mainImageUrl?: string;
  readonly priceText?: string;
  readonly salesText?: string;
  readonly shopName?: string;
  readonly sourcePageUrl: string;
  readonly observedAt: string;
  readonly position: number;
}

function discoveryProducts(value: unknown): DiscoveryProduct[] {
  return array(value, "discovery.products", 150).map((entry, index) => {
    const product = object(entry, `discovery.products[${index}]`);
    const mainImageUrl = optionalText(
      product.mainImageUrl,
      `discovery.products[${index}].mainImageUrl`
    );
    const priceText = optionalText(
      product.priceText,
      `discovery.products[${index}].priceText`,
      200
    );
    const salesText = optionalText(
      product.salesText,
      `discovery.products[${index}].salesText`,
      200
    );
    const shopName = optionalText(
      product.shopName,
      `discovery.products[${index}].shopName`,
      200
    );
    const position = Number(product.position);
    if (!Number.isSafeInteger(position) || position < 1) {
      throw new Error(`discovery.products[${index}].position is invalid`);
    }
    return {
      discoveryId: text(product.discoveryId, `discovery.products[${index}].discoveryId`, 300),
      platform: text(product.platform, `discovery.products[${index}].platform`, 30),
      productId: text(product.productId, `discovery.products[${index}].productId`, 200),
      title: text(product.title, `discovery.products[${index}].title`, 1_000),
      productUrl: text(product.productUrl, `discovery.products[${index}].productUrl`, 2_000),
      ...(mainImageUrl ? { mainImageUrl } : {}),
      ...(priceText ? { priceText } : {}),
      ...(salesText ? { salesText } : {}),
      ...(shopName ? { shopName } : {}),
      sourcePageUrl: text(product.sourcePageUrl, `discovery.products[${index}].sourcePageUrl`, 2_000),
      observedAt: text(product.observedAt, `discovery.products[${index}].observedAt`, 100),
      position
    };
  });
}

export function mergeMarketplaceProbes(input: unknown): JsonObject {
  const candidate = object(input, "Marketplace probe merge input");
  const intent = object(candidate.intent, "intent");
  const probes = array(candidate.probes, "probes", 3).map((entry, index) =>
    object(entry, `probes[${index}]`)
  );
  if (probes.length !== 3) throw new Error("Exactly three probes are required");
  const products = new Map<string, DiscoveryProduct>();
  const coverage = probes.map((probe, probeIndex) => {
    const platform = text(probe.platform, `probes[${probeIndex}].platform`, 30);
    const observedAt = text(probe.observedAt, `probes[${probeIndex}].observedAt`, 100);
    const sourcePageUrl = text(probe.pageUrl, `probes[${probeIndex}].pageUrl`, 2_000);
    const items = array(probe.items, `probes[${probeIndex}].items`, 50);
    const status = text(probe.status, `probes[${probeIndex}].status`, 30);
    if (!["READY", "PARTIAL", "EMPTY_CONFIRMED"].includes(status)) {
      throw new Error(`probes[${probeIndex}] has an unsupported status`);
    }
    if (
      (status === "EMPTY_CONFIRMED" && items.length !== 0) ||
      (status !== "EMPTY_CONFIRMED" && items.length === 0)
    ) {
      throw new Error(`probes[${probeIndex}] status contradicts its items`);
    }
    for (const [positionIndex, itemValue] of items.entries()) {
      const item = object(itemValue, `probes[${probeIndex}].items[${positionIndex}]`);
      const productId = text(item.productId, "probe item productId", 200);
      const discoveryId = `${platform}:${productId}`;
      const mainImageUrl = optionalText(item.mainImageUrl, "probe item mainImageUrl");
      const priceText = optionalText(item.priceText, "probe item priceText", 200);
      const salesText = optionalText(item.salesText, "probe item salesText", 200);
      const shopName = optionalText(item.shopName, "probe item shopName", 200);
      products.set(discoveryId, {
        discoveryId,
        platform,
        productId,
        title: text(item.title, "probe item title", 1_000),
        productUrl: text(item.productUrl, "probe item productUrl", 2_000),
        ...(mainImageUrl ? { mainImageUrl } : {}),
        ...(priceText ? { priceText } : {}),
        ...(salesText ? { salesText } : {}),
        ...(shopName ? { shopName } : {}),
        sourcePageUrl,
        observedAt,
        position: Number(item.position ?? positionIndex + 1)
      });
    }
    return {
      platform,
      sourcePageUrl,
      status,
      resultCount: items.length,
      warnings: stringArray(probe.warnings, `probes[${probeIndex}].warnings`, 50)
    };
  });
  return {
    schemaVersion: "discovery-product-set/v0.1",
    intentId: text(intent.intentId, "intent.intentId", 200),
    seedQuery: confirmedValue(intent, "seed_query"),
    coverage,
    products: [...products.values()],
    limitations: [
      "搜索页可见字段不等于平台官方类目或统一销量口径",
      "远程主图地址尚未下载，不能作为已归档图片资产",
      "进入直接竞品层仍需满足显式商品词、包装词和排除规则"
    ]
  };
}

export function buildDiscoveryCategorySpace(input: unknown): JsonObject {
  const candidate = object(input, "Discovery category-space input");
  const intent = object(candidate.intent, "intent");
  const discovery = object(candidate.discovery, "discovery");
  const boundary = workingBoundary(intent);
  const coverage = array(discovery.coverage, "discovery.coverage", 3).map((entry) =>
    object(entry, "discovery.coverage[]")
  );
  return {
    schemaVersion: "category-space/v0.3",
    intentId: text(intent.intentId, "intent.intentId", 200),
    principle: "消费者需求与使用场景先确定研究入口；搜索平台只作为探查分支，不能替代官方类目确认。",
    consumerNeedSpace: {
      coreNeed: text(boundary.productForm, "workingBoundary.productForm", 500),
      functions: ["解决与种子商品相同的核心购买任务"],
      scenes: stringArray(boundary.usageScenes, "workingBoundary.usageScenes", 50),
      targetPeople: stringArray(boundary.targetPeople, "workingBoundary.targetPeople", 50)
    },
    platformBranches: coverage.map((entry) => ({
      platform: text(entry.platform, "coverage.platform", 30),
      role: "DISCOVERY_SOURCE",
      resultCount: Number(entry.resultCount),
      status: text(entry.status, "coverage.status", 30)
    })),
    officialCategoryStatus: "UNCONFIRMED",
    exclusionRules:
      candidate.exclusionRules === undefined
        ? []
        : stringArray(candidate.exclusionRules, "exclusionRules", 50)
  };
}

function matches(title: string, terms: readonly string[]): string[] {
  const normalized = title.normalize("NFKC").toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}

export function buildDiscoveryComparablePool(input: unknown): JsonObject {
  const candidate = object(input, "Discovery comparable-pool input");
  const discovery = object(candidate.discovery, "discovery");
  const rules = object(candidate.rules, "rules");
  const coreTerms = stringArray(rules.coreTerms, "rules.coreTerms", 30);
  const packagingTerms = stringArray(rules.packagingTerms, "rules.packagingTerms", 30);
  const excludeTerms = stringArray(rules.excludeTerms ?? [], "rules.excludeTerms", 50);
  if (coreTerms.length === 0 || packagingTerms.length === 0) {
    throw new Error("Comparable rules require core and packaging terms");
  }
  const tiers = {
    DIRECT_COMPETITOR: [] as JsonObject[],
    SUBSTITUTE_AND_CONTENT_REFERENCE: [] as JsonObject[],
    REJECTED: [] as JsonObject[]
  };
  for (const product of discoveryProducts(discovery.products)) {
    const excludedBy = matches(product.title, excludeTerms);
    const coreMatched = matches(product.title, coreTerms);
    const packagingMatched = matches(product.title, packagingTerms);
    const tier =
      excludedBy.length > 0 || coreMatched.length === 0
        ? "REJECTED"
        : packagingMatched.length > 0
          ? "DIRECT_COMPETITOR"
          : "SUBSTITUTE_AND_CONTENT_REFERENCE";
    tiers[tier].push({
      discoveryId: product.discoveryId,
      platform: product.platform,
      title: product.title,
      confidence: tier === "DIRECT_COMPETITOR" ? "MEDIUM" : "LOW",
      matched: {
        coreTerms: coreMatched,
        packagingTerms: packagingMatched,
        excludeTerms: excludedBy
      },
      reason:
        tier === "DIRECT_COMPETITOR"
          ? "标题同时命中核心商品词与包装/即食边界，可进入直接竞品候选。"
          : tier === "SUBSTITUTE_AND_CONTENT_REFERENCE"
            ? "标题命中核心商品词，但包装边界尚未确认，仅作替代或内容参考。"
            : "标题未满足核心商品词，或命中明确排除词。"
    });
  }
  return {
    schemaVersion: "comparable-pool/v0.3",
    poolId: text(candidate.poolId, "poolId", 200),
    comparisonRule: {
      coreTerms,
      packagingTerms,
      excludeTerms,
      notSufficient: "搜索排名、标题相似或单个平台出现，均不能单独证明直接可比。"
    },
    tiers: [
      { tier: "DIRECT_COMPETITOR", products: tiers.DIRECT_COMPETITOR },
      {
        tier: "SUBSTITUTE_AND_CONTENT_REFERENCE",
        products: tiers.SUBSTITUTE_AND_CONTENT_REFERENCE
      }
    ],
    rejectedProducts: tiers.REJECTED
  };
}

export function evaluateDiscoveryEvidence(input: unknown): JsonObject {
  const candidate = object(input, "Discovery evidence input");
  const discovery = object(candidate.discovery, "discovery");
  const pool = object(candidate.comparablePool, "comparablePool");
  const products = discoveryProducts(discovery.products);
  const directIds = new Set(
    array(pool.tiers, "comparablePool.tiers", 10)
      .map((entry) => object(entry, "comparablePool.tiers[]"))
      .filter((entry) => entry.tier === "DIRECT_COMPETITOR")
      .flatMap((entry) =>
        array(entry.products, "tier.products", 150).map((product) =>
          text(object(product, "tier.product").discoveryId, "tier.product.discoveryId", 300)
        )
      )
  );
  return {
    schemaVersion: "evidence-claims/v0.3",
    observedAt: text(candidate.observedAt, "observedAt", 100),
    maximumEstablishedLevel: "E1",
    claims: products.map((product) => ({
      id: `SOURCE-${product.discoveryId}`,
      level: "E1",
      discoveryId: product.discoveryId,
      comparisonTier: directIds.has(product.discoveryId)
        ? "DIRECT_COMPETITOR"
        : "REFERENCE_OR_REJECTED",
      facts: {
        platform: product.platform,
        title: product.title,
        productUrl: product.productUrl,
        sourcePageUrl: product.sourcePageUrl,
        observedAt: product.observedAt,
        ...(product.mainImageUrl ? { mainImageUrl: product.mainImageUrl } : {}),
        ...(product.priceText ? { visiblePriceText: product.priceText } : {}),
        ...(product.salesText ? { visibleSalesText: product.salesText } : {})
      }
    })),
    notEstablished: [
      "搜索页销量原文已经换算为统一销量或 GMV",
      "商品已经确认属于同一平台官方类目",
      "某张主图、颜色、构图或文案直接带来销量",
      "远程图片已经完成下载、内容摘要和版权边界确认"
    ]
  };
}

export function buildDiscoveryReferencePack(input: unknown): JsonObject {
  const candidate = object(input, "Discovery reference-pack input");
  const discovery = object(candidate.discovery, "discovery");
  const pool = object(candidate.comparablePool, "comparablePool");
  const products = discoveryProducts(discovery.products);
  const tierById = new Map<string, string>();
  for (const tierValue of array(pool.tiers, "comparablePool.tiers", 10)) {
    const tier = object(tierValue, "comparablePool.tiers[]");
    const tierName = text(tier.tier, "tier.tier", 100);
    for (const productValue of array(tier.products, "tier.products", 150)) {
      const product = object(productValue, "tier.products[]");
      tierById.set(text(product.discoveryId, "tier.product.discoveryId", 300), tierName);
    }
  }
  const selectedAssets = products
    .filter((product) => product.mainImageUrl && tierById.has(product.discoveryId))
    .map((product) => ({
      discoveryId: product.discoveryId,
      platform: product.platform,
      role: "REMOTE_MAIN_IMAGE_CANDIDATE",
      remoteUrl: product.mainImageUrl,
      sourcePageUrl: product.sourcePageUrl,
      comparisonTier: tierById.get(product.discoveryId),
      downloadStatus: "PENDING",
      evidenceLevel: "E1",
      useBoundary: "仅作为待下载参考图候选；完成内容摘要、去重和人工精选前不能进入生成任务。"
    }))
    .slice(0, 20);
  return {
    schemaVersion: "reference-asset-pack/v0.4",
    packId: text(candidate.packId, "packId", 200),
    status: selectedAssets.length > 0 ? "PROVISIONAL_REMOTE_ASSETS" : "NO_REMOTE_ASSET",
    summary: {
      discoveredProductCount: products.length,
      remoteMainImageCount: selectedAssets.length,
      downloadedAssetCount: 0
    },
    selectedAssets,
    nextRequiredAction: "下载远程图片并生成 SHA-256 内容摘要，再按竞品层级、用途与使用边界进行精选。"
  };
}
