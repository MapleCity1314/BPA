export type FeishuNotificationResult =
  | { readonly status: "delivered" }
  | { readonly status: "failed"; readonly errorCode: string }
  | { readonly status: "uncertain"; readonly errorCode: string };

export interface FeishuOperatorNotificationChannelOptions {
  readonly webhookUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface TerminalAttentionPayload {
  readonly attentionId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly severity: "information" | "review" | "action" | "approval" | "blocking";
  readonly title: string;
  readonly requestedAction: string;
  readonly occurredAt: string;
}

const FEISHU_WEBHOOK_HOSTS = new Set([
  "open.feishu.cn",
  "open.larksuite.com"
]);

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum
  ) {
    throw new Error(`Attention notification ${label} is invalid`);
  }
  return value;
}

function parsePayload(value: unknown): TerminalAttentionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Attention notification payload is invalid");
  }
  const source = value as Record<string, unknown>;
  const expectedKeys = [
    "attentionId",
    "runId",
    "workflowId",
    "workflowVersion",
    "severity",
    "title",
    "requestedAction",
    "occurredAt"
  ];
  if (
    Object.keys(source).some((key) => !expectedKeys.includes(key)) ||
    Object.keys(source).length !== expectedKeys.length
  ) {
    throw new Error("Attention notification payload shape is invalid");
  }
  const severity = boundedText(source.severity, "severity", 32);
  if (
    ![
      "information",
      "review",
      "action",
      "approval",
      "blocking"
    ].includes(severity)
  ) {
    throw new Error("Attention notification severity is invalid");
  }
  const occurredAt = boundedText(source.occurredAt, "occurredAt", 64);
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Attention notification occurredAt is invalid");
  }
  return {
    attentionId: boundedText(source.attentionId, "attentionId", 256),
    runId: boundedText(source.runId, "runId", 256),
    workflowId: boundedText(source.workflowId, "workflowId", 256),
    workflowVersion: boundedText(
      source.workflowVersion,
      "workflowVersion",
      128
    ),
    severity: severity as TerminalAttentionPayload["severity"],
    title: boundedText(source.title, "title", 256),
    requestedAction: boundedText(
      source.requestedAction,
      "requestedAction",
      1_000
    ),
    occurredAt
  };
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Feishu notification webhook URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    !FEISHU_WEBHOOK_HOSTS.has(url.hostname) ||
    !url.pathname.startsWith("/open-apis/bot/v2/hook/") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Feishu notification webhook URL is not allowlisted");
  }
  return url.href;
}

function message(payload: TerminalAttentionPayload): Record<string, unknown> {
  const severity = {
    information: "信息",
    review: "需复核",
    action: "需处理",
    approval: "需审批",
    blocking: "已阻断"
  }[payload.severity];
  return {
    msg_type: "text",
    content: {
      text: [
        `[BPA ${severity}] ${payload.title}`,
        `工作流：${payload.workflowId}@${payload.workflowVersion}`,
        `Run：${payload.runId}`,
        `发生时间：${payload.occurredAt}`,
        `下一步：${payload.requestedAction}`
      ].join("\n")
    }
  };
}

/** Sends one immutable operator notification and never retries internally. */
export class FeishuOperatorNotificationChannel {
  readonly #webhookUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: FeishuOperatorNotificationChannelOptions) {
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("Feishu notification timeout is invalid");
    }
    this.#webhookUrl = validateWebhookUrl(options.webhookUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async deliver(input: {
    readonly payload: unknown;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<FeishuNotificationResult> {
    const payload = parsePayload(input.payload);
    const response = await this.#fetch(this.#webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(message(payload)),
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
    const raw = await response.text();
    if (response.status >= 500) {
      return {
        status: "uncertain",
        errorCode: `FEISHU_HTTP_${response.status}`
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        errorCode: `FEISHU_HTTP_${response.status}`
      };
    }
    if (raw.length > 16_384) {
      return { status: "uncertain", errorCode: "FEISHU_RESPONSE_INVALID" };
    }
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid response");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return { status: "uncertain", errorCode: "FEISHU_RESPONSE_INVALID" };
    }
    const code = Number(parsed.code ?? parsed.StatusCode);
    if (!Number.isSafeInteger(code)) {
      return { status: "uncertain", errorCode: "FEISHU_RESPONSE_INVALID" };
    }
    return code === 0
      ? { status: "delivered" }
      : { status: "failed", errorCode: `FEISHU_REJECTED_${code}` };
  }
}
