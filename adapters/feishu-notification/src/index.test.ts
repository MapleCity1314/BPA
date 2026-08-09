import { describe, expect, it, vi } from "vitest";
import { FeishuOperatorNotificationChannel } from "./index.js";

const payload = {
  attentionId: "run-terminal:run-1",
  runId: "run-1",
  workflowId: "doudian.inventory.refresh",
  workflowVersion: "1.0.0",
  severity: "blocking",
  title: "浏览器登录或验证需要处理",
  requestedAction: "在受管 Chrome Profile 中完成登录后重新发起。",
  occurredAt: "2026-08-09T06:00:00.000Z"
};

function channel(fetchImpl: typeof fetch): FeishuOperatorNotificationChannel {
  return new FeishuOperatorNotificationChannel({
    webhookUrl:
      "https://open.feishu.cn/open-apis/bot/v2/hook/example",
    fetchImpl
  });
}

describe("Feishu operator notification channel", () => {
  it("maps an accepted response to delivered and sends only controlled fields", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, msg: "success" }), {
          status: 200
        })
    );
    await expect(
      channel(fetchImpl as typeof fetch).deliver({
        payload,
        idempotencyKey: "attention:run-1",
        requestDigest: "sha256:test"
      })
    ).resolves.toEqual({ status: "delivered" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = fetchImpl.mock.calls[0]![1]!;
    const body = String(request.body);
    expect(body).toContain("run-1");
    expect(body).toContain("浏览器登录或验证需要处理");
    expect(body).not.toContain("/open-apis/bot/v2/hook/example");
    expect(body).not.toContain("requestDigest");
    expect(body).not.toContain("idempotencyKey");
  });

  it.each([
    [400, { status: "failed", errorCode: "FEISHU_HTTP_400" }],
    [500, { status: "uncertain", errorCode: "FEISHU_HTTP_500" }]
  ] as const)("classifies HTTP %s conservatively", async (status, expected) => {
    const fetchImpl = vi.fn(async () => new Response("rejected", { status }));
    await expect(
      channel(fetchImpl as typeof fetch).deliver({
        payload,
        idempotencyKey: "attention:run-1",
        requestDigest: "sha256:test"
      })
    ).resolves.toEqual(expected);
  });

  it("treats malformed success and provider rejection separately", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(
      channel(malformed as typeof fetch).deliver({
        payload,
        idempotencyKey: "attention:run-1",
        requestDigest: "sha256:test"
      })
    ).resolves.toEqual({
      status: "uncertain",
      errorCode: "FEISHU_RESPONSE_INVALID"
    });

    const rejected = vi.fn(async () =>
      new Response(JSON.stringify({ code: 19021, msg: "rejected details" }), {
        status: 200
      })
    );
    await expect(
      channel(rejected as typeof fetch).deliver({
        payload,
        idempotencyKey: "attention:run-1",
        requestDigest: "sha256:test"
      })
    ).resolves.toEqual({
      status: "failed",
      errorCode: "FEISHU_REJECTED_19021"
    });
  });

  it("rejects non-allowlisted webhook URLs and payload extension fields", async () => {
    expect(
      () =>
        new FeishuOperatorNotificationChannel({
          webhookUrl: "https://example.com/open-apis/bot/v2/hook/secret"
        })
    ).toThrow(/not allowlisted/u);
    const fetchImpl = vi.fn();
    await expect(
      channel(fetchImpl as typeof fetch).deliver({
        payload: { ...payload, rawError: "secret diagnostic" },
        idempotencyKey: "attention:run-1",
        requestDigest: "sha256:test"
      })
    ).rejects.toThrow(/payload shape/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
