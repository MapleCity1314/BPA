import { createHash } from "node:crypto";
import type { DecisionReuseContext } from "@bpa/dataset-core";

export const PACKAGING_MATCHER_VERSION = "packaging-smart-v1";

export interface PackagingMasterRecord {
  readonly id: string;
  readonly sourceRow: number;
  readonly productName: string;
  readonly brand: string;
  readonly weight: string;
  readonly packagingShape: string;
  readonly recordDigest: string;
  readonly normalizedName: string;
  readonly normalizedBrand: string;
  readonly weightSignature: string;
  readonly matchKey: string;
}

export interface PackagingProduct {
  readonly shopId: string;
  readonly productId: string;
  readonly title: string;
}

export interface PackagingBinding {
  readonly masterRecordId: string;
  readonly reuse: DecisionReuseContext;
}

export interface PackagingCandidateScore {
  readonly record: PackagingMasterRecord;
  readonly score: number;
  readonly evidence: readonly string[];
}

interface ResolvedPackagingMatchBase {
  readonly record: PackagingMasterRecord;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly candidates: readonly PackagingCandidateScore[];
}

export type ResolvedPackagingMatch =
  | (ResolvedPackagingMatchBase & { readonly status: "matched" })
  | (ResolvedPackagingMatchBase & { readonly status: "smart_matched" })
  | (ResolvedPackagingMatchBase & { readonly status: "bound" });

export interface AmbiguousPackagingMatch {
  readonly status: "ambiguous";
  readonly score?: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly candidates: readonly PackagingCandidateScore[];
}

export interface UnmatchedPackagingMatch {
  readonly status: "unmatched";
  readonly score?: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly candidates: readonly PackagingCandidateScore[];
}

export type PackagingMatchOutcome =
  | ResolvedPackagingMatch
  | AmbiguousPackagingMatch
  | UnmatchedPackagingMatch;

export interface PackagingBatchResult {
  readonly matcherVersion: string;
  readonly matched: readonly {
    product: PackagingProduct;
    outcome: Extract<
      PackagingMatchOutcome,
      { status: "matched" | "smart_matched" | "bound" }
    >;
  }[];
  readonly ambiguous: readonly {
    product: PackagingProduct;
    outcome: Extract<PackagingMatchOutcome, { status: "ambiguous" }>;
  }[];
  readonly unmatched: readonly {
    product: PackagingProduct;
    outcome: Extract<PackagingMatchOutcome, { status: "unmatched" }>;
  }[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function comparable(value: string): string {
  return normalizeWhitespace(value.normalize("NFKC"))
    .toLowerCase()
    .replace(/[（）()[\]【】《》「」『』]/gu, "")
    .replace(/[，。、“”‘’：:；;·_\-\s]/gu, "");
}

function normalizedNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

export function extractWeightSignatures(value: string): string[] {
  const normalized = normalizeWhitespace(value.normalize("NFKC"))
    .toLowerCase()
    .replace(/[xX＊*]/gu, "×");
  const signatures = new Set<string>();
  const pattern =
    /(\d+(?:\.\d+)?)\s*(千克|公斤|kg|克|g|斤|毫升|ml|升|l)(?:\s*×\s*(\d+))?/gu;
  for (const match of normalized.matchAll(pattern)) {
    let amount = Number(match[1]);
    let unit = match[2]!;
    if (["千克", "公斤", "kg"].includes(unit)) {
      amount *= 1_000;
      unit = "g";
    } else if (unit === "克") {
      unit = "g";
    } else if (unit === "斤") {
      amount *= 500;
      unit = "g";
    } else if (unit === "毫升") {
      unit = "ml";
    } else if (unit === "升" || unit === "l") {
      amount *= 1_000;
      unit = "ml";
    }
    signatures.add(
      `${normalizedNumber(amount)}${unit}${match[3] ? `×${Number(match[3])}` : ""}`
    );
  }
  return [...signatures];
}

export function extractWeightSignature(value: string): string {
  return extractWeightSignatures(value)[0] ?? "";
}

export function normalizeBrand(value: string): string {
  return comparable(value);
}

export function normalizeProductTitleIdentity(value: string): string {
  return comparable(value);
}

export function normalizeProductName(value: string, brand = ""): string {
  const normalizedBrand = normalizeBrand(brand);
  let next = value
    .normalize("NFKC")
    .replace(/^【([^】]+)】/u, (_, candidate: string) =>
      !normalizedBrand || normalizeBrand(candidate) === normalizedBrand
        ? ""
        : candidate
    )
    .replace(/\[([^\]]+)\]$/u, (_, candidate: string) =>
      !normalizedBrand || normalizeBrand(candidate) === normalizedBrand
        ? ""
        : candidate
    )
    .replace(
      /\d+(?:\.\d+)?\s*(?:千克|公斤|kg|克|g|斤|毫升|ml|升|l)(?:\s*[xX×＊*]\s*\d+\s*(?:袋|盒|包|瓶|罐|枚|个)?)?/giu,
      ""
    );
  if (brand) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(escaped, "giu"), "");
  }
  return comparable(next);
}

export function buildMasterMatchKey(input: {
  readonly productName: string;
  readonly brand: string;
  readonly weight: string;
}): string {
  return [
    normalizeProductName(input.productName, input.brand),
    normalizeBrand(input.brand),
    extractWeightSignature(input.weight) ||
      extractWeightSignature(input.productName)
  ].join("|");
}

export function createPackagingMasterRecord(input: {
  readonly id: string;
  readonly sourceRow: number;
  readonly productName: string;
  readonly brand: string;
  readonly weight: string;
  readonly packagingShape: string;
  readonly recordDigest: string;
}): PackagingMasterRecord {
  const matchKey = buildMasterMatchKey(input);
  const [normalizedName = "", normalizedBrand = "", weightSignature = ""] =
    matchKey.split("|");
  if (
    !input.id ||
    !Number.isSafeInteger(input.sourceRow) ||
    input.sourceRow < 1 ||
    !normalizedName ||
    !normalizedBrand ||
    !weightSignature ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.recordDigest)
  ) {
    throw new Error("Packaging master record cannot produce a stable match identity");
  }
  return Object.freeze({
    ...input,
    normalizedName,
    normalizedBrand,
    weightSignature,
    matchKey
  });
}

function bigrams(value: string): Set<string> {
  const characters = [...value];
  return new Set(
    characters.length < 2
      ? characters
      : characters.slice(0, -1).map((value, index) => value + characters[index + 1])
  );
}

function nameScore(
  title: string,
  record: PackagingMasterRecord
): { score: number; evidence: string } {
  const product = normalizeProductName(title, record.brand);
  const master = record.normalizedName;
  if (!product || !master) return { score: 0, evidence: "名称不可比较" };
  if (product === master) return { score: 60, evidence: "标准化名称完全一致" };
  if (product.includes(master)) {
    return {
      score: Math.min(60, 50 + Math.min(10, master.length * 2)),
      evidence: `商品标题包含主数据名称“${record.productName}”`
    };
  }
  if (master.includes(product) && product.length >= 3) {
    const ratio = product.length / master.length;
    return {
      score: Math.round(45 * ratio),
      evidence: `商品核心词覆盖主数据 ${Math.round(ratio * 100)}%`
    };
  }
  const productBigrams = bigrams(product);
  const masterBigrams = bigrams(master);
  const common = [...masterBigrams].filter((part) => productBigrams.has(part)).length;
  const dice =
    productBigrams.size + masterBigrams.size > 0
      ? (2 * common) / (productBigrams.size + masterBigrams.size)
      : 0;
  const masterCharacters = new Set([...master]);
  const productCharacters = new Set([...product]);
  const coverage =
    [...masterCharacters].filter((value) => productCharacters.has(value)).length /
    Math.max(1, masterCharacters.size);
  return {
    score: Math.round(42 * dice + 18 * coverage),
    evidence: `名称相似度 ${Math.round(dice * 100)}%，核心字覆盖 ${Math.round(coverage * 100)}%`
  };
}

function parsedWeight(value: string):
  | { amount: number; unit: "g" | "ml"; count: number }
  | undefined {
  const match = /^(\d+(?:\.\d+)?)(g|ml)(?:×(\d+))?$/u.exec(value);
  return match
    ? {
        amount: Number(match[1]),
        unit: match[2] as "g" | "ml",
        count: match[3] ? Number(match[3]) : 1
      }
    : undefined;
}

function weightScore(
  productWeights: readonly string[],
  masterWeight: string
): { score: number; evidence: string } {
  if (productWeights.length === 0) {
    return { score: 0, evidence: "标题未标出克重，按中性处理" };
  }
  if (productWeights.includes(masterWeight)) {
    return { score: 25, evidence: `克重完全一致：${masterWeight}` };
  }
  const master = parsedWeight(masterWeight);
  if (!master) return { score: -20, evidence: "主数据克重不可比较" };
  for (const signature of productWeights) {
    const product = parsedWeight(signature);
    if (!product || product.unit !== master.unit) continue;
    if (product.amount === master.amount) {
      return {
        score: 18,
        evidence: `单件克重一致：标题 ${signature}，主数据 ${masterWeight}`
      };
    }
    if (product.amount * product.count === master.amount * master.count) {
      return {
        score: 16,
        evidence: `总净含量等价：标题 ${signature}，主数据 ${masterWeight}`
      };
    }
  }
  return {
    score: -20,
    evidence: `克重不一致：标题 ${productWeights.join("、")}，主数据 ${masterWeight}`
  };
}

function exactReuse(
  left: DecisionReuseContext,
  right: DecisionReuseContext
): boolean {
  const equal = (
    a: Readonly<Record<string, string>>,
    b: Readonly<Record<string, string>>
  ): boolean => {
    const keys = Object.keys(a).sort();
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => a[key] === b[key])
    );
  };
  return equal(left.scope, right.scope) && equal(left.preconditions, right.preconditions);
}

export function matchPackagingProduct(
  product: PackagingProduct,
  records: readonly PackagingMasterRecord[],
  binding?: PackagingBinding,
  currentReuse?: DecisionReuseContext
): PackagingMatchOutcome {
  if (binding && currentReuse && exactReuse(binding.reuse, currentReuse)) {
    const bound = records.find((record) => record.id === binding.masterRecordId);
    if (bound) {
      const evidence = ["使用仍满足精确前置条件的人工绑定"];
      return {
        status: "bound",
        record: bound,
        score: 100,
        evidence,
        candidates: [{ record: bound, score: 100, evidence }]
      };
    }
  }
  const weight = extractWeightSignature(product.title);
  const exact = records.filter(
    (record) =>
      weight === record.weightSignature &&
      comparable(product.title).includes(record.normalizedBrand) &&
      normalizeProductName(product.title, record.brand) === record.normalizedName
  );
  if (exact.length === 1) {
    const evidence = ["名称、品牌、克重严格一致"];
    return {
      status: "matched",
      record: exact[0]!,
      score: 100,
      evidence,
      candidates: [{ record: exact[0]!, score: 100, evidence }]
    };
  }
  if (exact.length > 1) {
    return {
      status: "ambiguous",
      score: 100,
      reason: `严格匹配到 ${exact.length} 条主数据`,
      evidence: ["严格匹配结果不唯一"],
      candidates: exact.map((record) => ({
        record,
        score: 100,
        evidence: ["名称、品牌、克重严格一致"]
      }))
    };
  }
  const comparableTitle = comparable(product.title);
  const detectedBrands = new Set(
    records
      .map((record) => record.normalizedBrand)
      .filter((brand) => brand.length >= 2 && comparableTitle.includes(brand))
  );
  const productWeights = extractWeightSignatures(product.title);
  const scored = records
    .map((record): PackagingCandidateScore | undefined => {
      if (
        detectedBrands.size > 0 &&
        !detectedBrands.has(record.normalizedBrand)
      ) {
        return undefined;
      }
      const name = nameScore(product.title, record);
      if (name.score < 12) return undefined;
      const brandDetected = detectedBrands.has(record.normalizedBrand);
      const weightResult = weightScore(productWeights, record.weightSignature);
      return {
        record,
        score: Math.max(
          0,
          Math.min(
            100,
            name.score + (brandDetected ? 16 : 0) + weightResult.score
          )
        ),
        evidence: [
          name.evidence,
          brandDetected
            ? `标题识别到品牌“${record.brand}”`
            : "标题未识别到明确品牌，按中性处理",
          weightResult.evidence
        ]
      };
    })
    .filter((value): value is PackagingCandidateScore => Boolean(value))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.sourceRow - right.record.sourceRow
    )
    .slice(0, 5);
  const top = scored[0];
  const margin = top ? top.score - (scored[1]?.score ?? 0) : 0;
  if (top && top.score >= 72 && margin >= 10) {
    return {
      status: "smart_matched",
      record: top.record,
      score: top.score,
      evidence: top.evidence,
      candidates: scored
    };
  }
  if (top && top.score >= 72) {
    return {
      status: "ambiguous",
      score: top.score,
      reason: `最高候选 ${top.score} 分，但仅领先下一候选 ${margin} 分`,
      evidence: top.evidence,
      candidates: scored
    };
  }
  return {
    status: "unmatched",
    ...(top ? { score: top.score } : {}),
    reason: top
      ? `最佳候选仅 ${top.score} 分，低于自动匹配阈值 72 分`
      : "没有找到具备有效名称关联的主数据候选",
    evidence: top?.evidence ?? [],
    candidates: scored
  };
}

export function matchPackagingBatch(
  products: readonly PackagingProduct[],
  records: readonly PackagingMasterRecord[],
  bindings: ReadonlyMap<string, PackagingBinding> = new Map(),
  reuseContexts: ReadonlyMap<string, DecisionReuseContext> = new Map()
): PackagingBatchResult {
  const matched: PackagingBatchResult["matched"][number][] = [];
  const ambiguous: PackagingBatchResult["ambiguous"][number][] = [];
  const unmatched: PackagingBatchResult["unmatched"][number][] = [];
  for (const product of products) {
    const outcome = matchPackagingProduct(
      product,
      records,
      bindings.get(product.productId),
      reuseContexts.get(product.productId)
    );
    if (
      outcome.status === "matched" ||
      outcome.status === "smart_matched" ||
      outcome.status === "bound"
    ) {
      matched.push({ product, outcome });
    } else if (outcome.status === "ambiguous") {
      ambiguous.push({ product, outcome });
    } else {
      unmatched.push({ product, outcome });
    }
  }
  return Object.freeze({
    matcherVersion: PACKAGING_MATCHER_VERSION,
    matched,
    ambiguous,
    unmatched
  });
}

export function digestPackagingValue(value: unknown): string {
  const canonical = (current: unknown): string => {
    if (current === null || typeof current !== "object") {
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) return `[${current.map(canonical).join(",")}]`;
    return `{${Object.entries(current as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function packagingDecisionReuseContext(input: {
  readonly product: PackagingProduct;
  readonly targetRecord: PackagingMasterRecord;
  readonly matcherVersion?: string;
  readonly ruleVersion: string;
}): DecisionReuseContext {
  return Object.freeze({
    scope: Object.freeze({
      shop_id: input.product.shopId,
      product_id: input.product.productId
    }),
    preconditions: Object.freeze({
      normalized_title: digestPackagingValue(
        normalizeProductTitleIdentity(input.product.title)
      ),
      target_record: input.targetRecord.recordDigest,
      matcher: digestPackagingValue(
        input.matcherVersion ?? PACKAGING_MATCHER_VERSION
      ),
      rules: digestPackagingValue(input.ruleVersion)
    })
  });
}

export * from "./issue-report.js";
