import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { isAbsolute } from "node:path";
import { FeishuOperatorNotificationChannel } from "@bpa/adapter-feishu-notification";
import type { Persistence } from "@bpa/persistence";
import { AttentionDeliveryDispatcher } from "./attention-delivery-dispatcher.js";

export interface OperatorNotificationRuntimeOptions {
  readonly persistence: Persistence;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly id?: () => string;
}

function loadConfig(path: string, currentUid: number | undefined): {
  provider: "feishu-webhook";
  webhookUrl: string;
} {
  if (!isAbsolute(path)) {
    throw new Error("Operator notification config path must be absolute");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      (stats.mode & 0o777) !== 0o600 ||
      (currentUid !== undefined && stats.uid !== currentUid) ||
      stats.size > 8_192
    ) {
      throw new Error("Operator notification config is not a private regular file");
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Operator notification config is invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Operator notification config is invalid");
  }
  const source = parsed as Record<string, unknown>;
  if (
    Object.keys(source).length !== 2 ||
    source.provider !== "feishu-webhook" ||
    typeof source.webhookUrl !== "string" ||
    !source.webhookUrl.trim()
  ) {
    throw new Error("Operator notification config shape is invalid");
  }
  return { provider: "feishu-webhook", webhookUrl: source.webhookUrl };
}

/**
 * Notification delivery is disabled unless an explicit private config file is
 * supplied. Invalid explicit configuration fails closed during Core startup.
 */
export function createOperatorNotificationDispatcher(
  options: OperatorNotificationRuntimeOptions
): AttentionDeliveryDispatcher | undefined {
  const path = options.environment?.BPA_OPERATOR_NOTIFICATION_CONFIG?.trim();
  if (!path) return undefined;
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Operator notification delivery is supported on macOS only");
  }
  const config = loadConfig(
    path,
    options.currentUid ?? process.getuid?.()
  );
  return new AttentionDeliveryDispatcher({
    persistence: options.persistence,
    channel: new FeishuOperatorNotificationChannel({
      webhookUrl: config.webhookUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    }),
    workerId: `core:${process.pid}`,
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {})
  });
}
