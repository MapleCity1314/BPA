import { readDoudianVisibleShopIdentity } from "./shop-context.js";

const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
const EXPERIENCE_PATH = "/ffa/eco/experience-score";
const SCORE_PATTERN = /(-?\d+(?:\.\d+)?)\s*分/u;
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/u;

export const DOUDIAN_EXPERIENCE_ADAPTER_VERSION = "2.0.3";

export type DoudianExperienceErrorCode =
  | "EXPERIENCE_DIMENSION_INCOMPLETE"
  | "EXPERIENCE_TOTAL_SCORE_MISSING"
  | "PAGE_LOADING"
  | "PAGE_MISMATCH"
  | "PAGE_URL_INVALID"
  | "SHOP_IDENTITY_MISMATCH"
  | "SHOP_IDENTITY_UNCERTAIN";

export class DoudianExperienceError extends Error {
  constructor(
    readonly code: DoudianExperienceErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, string>>
  ) {
    super(message);
    this.name = "DoudianExperienceError";
  }
}

export interface DoudianExperienceErrorPayload {
  readonly code: DoudianExperienceErrorCode | "EXPERIENCE_STAGE_FAILED";
  readonly message: string;
  readonly detail?: Readonly<Record<string, string>>;
}

export function doudianExperienceErrorPayload(
  error: unknown
): DoudianExperienceErrorPayload {
  if (error instanceof DoudianExperienceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {})
    };
  }
  return {
    code: "EXPERIENCE_STAGE_FAILED",
    message: "体验分页面读取失败。"
  };
}

export interface ExperienceShop {
  readonly id?: string;
  readonly name: string;
  readonly status: "active" | "blocked";
  readonly statusText: string;
}

export interface ExperienceMetric {
  readonly key: string;
  readonly label: string;
  readonly rawValue: string;
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly score: number | null;
  readonly scoreRaw: string | null;
  readonly weight: number | null;
  readonly weightRaw: string | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly change: number | string | null;
  readonly note: string | null;
}

export interface ExperienceSnapshot {
  readonly status: "complete" | "no_score";
  readonly observedAt: string;
  readonly sourceUpdatedAt: string | null;
  readonly shop: { readonly id: string; readonly name: string };
  readonly summary: {
    readonly totalScore: number | null;
    readonly totalScoreRaw: string | null;
    readonly level: string | null;
    readonly industry: string | null;
    readonly orders30d: number | null;
    readonly orders30dRaw: string | null;
  };
  readonly dimensions: readonly {
    readonly key: "goods" | "logistics" | "service";
    readonly label: string;
    readonly score: number | null;
    readonly scoreRaw: string | null;
    readonly metrics: readonly ExperienceMetric[];
  }[];
  readonly evidence: {
    readonly pageUrl: string;
    readonly capturedAt: string;
    readonly structuredSnapshotRef: string;
  };
  readonly diagnostics: readonly string[];
  readonly formMutations: 0;
}

const DIMENSIONS = [
  {
    key: "goods" as const,
    label: "商品体验",
    scoreLabels: ["商品体验得分"],
    metrics: [
      { key: "goods.composite_rating", label: "商品综合评分" },
      { key: "goods.quality_return_rate", label: "商品品质退货率" },
      {
        key: "goods.quality_issue_orders_30d",
        label: "近30天物流签收订单中因商品品质原因产生的订单数"
      },
      { key: "goods.signed_orders_30d", label: "近30日物流签收订单量" }
    ]
  },
  {
    key: "logistics" as const,
    label: "物流体验",
    scoreLabels: ["物流体验得分"],
    metrics: [
      { key: "logistics.pickup_duration_average", label: "揽收时长平均" },
      { key: "logistics.delivery_sla_rate", label: "运单配送时效达成率" },
      {
        key: "logistics.quality_return_rate",
        label: "发货物流品退率"
      },
      {
        key: "logistics.delivery_sla_met_waybills_30d",
        label: "近30天达成配送线路时效要求的运单数"
      },
      {
        key: "logistics.delivery_sla_expected_waybills_30d",
        label: "近30天应达成配送线路时效要求运单数"
      },
      {
        key: "logistics.first_quality_after_sale_orders_30d",
        label: "近30天支付订单中首次因物流品质原因售后的订单数"
      },
      { key: "logistics.paid_orders_30d", label: "近30天支付订单数" }
    ]
  },
  {
    key: "service" as const,
    label: "服务体验",
    scoreLabels: ["服务体验得分"],
    metrics: [
      {
        key: "service.im_response_duration_average",
        label: "飞鸽平均响应时长"
      },
      {
        key: "service.after_sale_review_duration_average",
        label: "售后平均审核时长"
      },
      {
        key: "service.im_dissatisfaction_rate",
        label: "飞鸽会话不满意率"
      },
      { key: "service.platform_assistance_rate", label: "平台求助率" },
      {
        key: "service.refund_review_duration_total_30d",
        label: "近30天退款成功售后单的售后审核总时长"
      },
      {
        key: "service.refund_after_sale_orders_30d",
        label: "近30天退款成功售后单数"
      },
      {
        key: "service.dissatisfied_agent_sessions_30d",
        label: "近30天消费者评价人工客服为不满意（1-3星）的会话数"
      },
      {
        key: "service.rated_agent_sessions_30d",
        label: "近30天有人工客服评价会话数"
      },
      {
        key: "service.platform_escalation_orders_30d",
        label: "近30天消费者升级求助平台订单数"
      },
      {
        key: "service.merchant_assistance_orders_30d",
        label: "近30天消费者求助商家订单数"
      }
    ]
  }
] as const;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function compactText(value: string | null | undefined): string {
  return normalizeText(value).replace(/\s+/gu, "");
}

function finiteNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/gu, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parsedPageUrl(pageUrl: string): URL {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new DoudianExperienceError("PAGE_URL_INVALID", "体验分页地址无效。");
  }
  if (url.origin !== DOUDIAN_ORIGIN || url.pathname !== EXPERIENCE_PATH) {
    throw new DoudianExperienceError("PAGE_MISMATCH", "当前页面不是抖店体验分页。");
  }
  return url;
}

function bodyText(doc: Document): string {
  return normalizeText(doc.body?.textContent).slice(0, 200_000);
}

function bestBlock(doc: Document, label: string): string {
  const annotated = Array.from(
    doc.querySelectorAll<HTMLElement>("[data-bpa-label]")
  ).find((element) => element.getAttribute("data-bpa-label") === label);
  if (annotated) return normalizeText(annotated.textContent);
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>("body *"))
    .filter((element) => compactText(element.textContent).includes(compactText(label)))
    .filter((element) => element.children.length <= 12)
    .map((element) => normalizeText(element.textContent))
    .filter((text) => text.length <= 800)
    .sort((left, right) => left.length - right.length);
  return candidates[0] ?? "";
}

function scoreFromBlock(text: string): { raw: string | null; value: number | null } {
  const match = /得分\s*(-?\d+(?:\.\d+)?)\s*分/u.exec(text) ??
    SCORE_PATTERN.exec(text);
  return {
    raw: match?.[0] ?? null,
    value: finiteNumber(match?.[1])
  };
}

function rawMetricValue(text: string, label: string): string {
  const compact = compactText(text).replace(compactText(label), "");
  const withoutMeta = compact
    .replace(/得分-?\d+(?:\.\d+)?分/gu, "")
    .replace(/(?:权重|x)-?\d+(?:\.\d+)?%/giu, "")
    .replace(/较前(?:1日|一天)?[^\s]{0,24}/gu, "")
    .trim();
  return withoutMeta.slice(0, 200);
}

function metricFromBlock(
  key: string,
  label: string,
  text: string
): ExperienceMetric {
  const score = scoreFromBlock(text);
  const weightMatch = /(?:权重|x)\s*(-?\d+(?:\.\d+)?)\s*%/iu.exec(text);
  const ratioMatch = /(-?[\d,]+)\s*[／/]\s*(-?[\d,]+)/u.exec(text);
  const changeMatch = /较前(?:1日|一天)?\s*([^\s]{1,40})/u.exec(text);
  const rawValue = rawMetricValue(text, label);
  const percent = /(-?\d+(?:\.\d+)?)\s*%/u.exec(rawValue);
  const duration = /(-?\d+(?:\.\d+)?)\s*(秒|分钟|小时|天)/u.exec(rawValue);
  const rating = /(-?\d+(?:\.\d+)?)\s*分/u.exec(rawValue);
  const plain = NUMBER_PATTERN.exec(rawValue);
  const value = percent
    ? finiteNumber(percent[1])
    : duration
      ? finiteNumber(duration[1])
      : rating
        ? finiteNumber(rating[1])
        : plain
        ? finiteNumber(plain[0])
        : rawValue || null;
  return {
    key,
    label,
    rawValue,
    value,
    unit: percent?.[0]
      ? "%"
      : duration?.[2] ?? (rating ? "分" : null),
    score: score.value,
    scoreRaw: score.raw,
    weight: finiteNumber(weightMatch?.[1]),
    weightRaw: weightMatch?.[0] ?? null,
    numerator: finiteNumber(ratioMatch?.[1]),
    denominator: finiteNumber(ratioMatch?.[2]),
    change: changeMatch?.[1] ?? null,
    note: null
  };
}

function sourceUpdatedAt(text: string): string | null {
  const match = /(?:更新于|更新)\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{2}:\d{2}:\d{2})/u.exec(
    text
  );
  if (!match) return null;
  const [, year, month, day, time] = match;
  const instant = new Date(
    `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T${time}+08:00`
  );
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function actualShopId(doc: Document, fallback: string): string {
  const match = /店铺\s*ID[：:\s]*(\d{5,30})/iu.exec(bodyText(doc));
  return match?.[1] ?? fallback;
}

export function readDoudianExperienceSnapshot(
  doc: Document,
  pageUrl: string,
  expectedShop: Pick<ExperienceShop, "id" | "name">,
  observedAt = new Date()
): ExperienceSnapshot {
  const url = parsedPageUrl(pageUrl);
  const text = bodyText(doc);
  if (!compactText(text).includes("商家体验分")) {
    throw new DoudianExperienceError("PAGE_LOADING", "体验分页仍在加载。");
  }
  let identity: ReturnType<typeof readDoudianVisibleShopIdentity>;
  try {
    identity = readDoudianVisibleShopIdentity(doc);
  } catch (error) {
    if (error instanceof Error && error.message === "PAGE_LOADING") {
      throw new DoudianExperienceError("PAGE_LOADING", "体验分页仍在加载。");
    }
    throw new DoudianExperienceError(
      "SHOP_IDENTITY_UNCERTAIN",
      "无法确认当前体验分页的店铺身份。"
    );
  }
  if (!identity.identityConfirmed) {
    throw new DoudianExperienceError(
      "SHOP_IDENTITY_UNCERTAIN",
      "无法确认当前体验分页的店铺身份。"
    );
  }
  const shopId = actualShopId(doc, identity.id);
  if (
    compactText(identity.name) !== compactText(expectedShop.name) ||
    (expectedShop.id && shopId !== expectedShop.id)
  ) {
    throw new DoudianExperienceError(
      "SHOP_IDENTITY_MISMATCH",
      "当前体验分页店铺与目标店铺不一致。"
    );
  }
  const noScore = /(?:暂无体验分|订单达到30单后.*展示体验分|订单不足30单)/u.test(text);
  const totalBlock = bestBlock(doc, "我的体验分");
  const total = scoreFromBlock(totalBlock);
  if (!noScore && total.value === null) {
    throw new DoudianExperienceError(
      "EXPERIENCE_TOTAL_SCORE_MISSING",
      "体验分总分缺失。"
    );
  }
  const ordersMatch = /近30天有效订单数\s*[：:]?\s*([\d,]+)/u.exec(text);
  const industryMatch = /考核行业\s*[：:]?\s*([^\s]{1,80})/u.exec(text);
  const levelMatch = /体验分等级\s*[：:]?\s*([^\s]{1,40})/u.exec(text);
  const dimensions = noScore
    ? []
    : DIMENSIONS.map((definition) => {
        const score = scoreFromBlock(bestBlock(doc, definition.scoreLabels[0]));
        const metrics = definition.metrics.flatMap((metric) => {
          const block = bestBlock(doc, metric.label);
          return block
            ? [metricFromBlock(metric.key, metric.label, block)]
            : [];
        });
        if (score.value === null || metrics.length === 0) {
          throw new DoudianExperienceError(
            "EXPERIENCE_DIMENSION_INCOMPLETE",
            `体验分维度数据不完整：${definition.label}。`,
            { dimension: definition.key }
          );
        }
        return {
          key: definition.key,
          label: definition.label,
          score: score.value,
          scoreRaw: score.raw,
          metrics
        };
      });
  const capturedAt = observedAt.toISOString();
  const signature = stableHash(
    JSON.stringify({ shopId, total: total.raw, dimensions, capturedAt })
  );
  return {
    status: noScore ? "no_score" : "complete",
    observedAt: capturedAt,
    sourceUpdatedAt: sourceUpdatedAt(text),
    shop: { id: shopId, name: identity.name },
    summary: {
      totalScore: noScore ? null : total.value,
      totalScoreRaw: noScore ? null : total.raw,
      level: levelMatch?.[1] ?? null,
      industry: industryMatch?.[1] ?? null,
      orders30d: finiteNumber(ordersMatch?.[1]),
      orders30dRaw: ordersMatch?.[1] ?? null
    },
    dimensions,
    evidence: {
      pageUrl: url.href,
      capturedAt,
      structuredSnapshotRef: `inline:${signature}`
    },
    diagnostics: noScore ? ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"] : [],
    formMutations: 0
  };
}
