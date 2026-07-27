/* Generated from canonical JSON Schema. Do not edit manually. */

export interface BPARiskSignalV1 {
  code:
    "CAPTCHA_REQUIRED" | "RATE_LIMITED" | "RISK_CONTROL" | "SESSION_EXPIRED" | "AUTH_REQUIRED" | "PAGE_CONTEXT_CHANGED";
  category: "challenge" | "throttle" | "session" | "page_context";
  severity: "warning" | "blocking";
  source: "page" | "adapter" | "bridge";
  detected_at: string;
  retry_after_ms?: number;
  detail?: string;
}
